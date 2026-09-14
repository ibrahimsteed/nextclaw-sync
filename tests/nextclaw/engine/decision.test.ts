import { strict as assert } from "assert";
import {
  state,
  decodeRecord,
  decideFile,
} from "../../../src/nextclaw/engine/model";
import { runSync } from "../../../src/nextclaw/syncEngine";
import { harness, record } from "./helpers";

describe("§5 单侧状态和版本", () => {
  for (const side of ["local", "remote"] as const) {
    for (const [label, exists, previous, time, size, expected] of [
      ["absent", false, false, 0, 0, "absent"],
      ["new", true, false, 10000, 1, "new"],
      ["deleted", false, true, 0, 0, "deleted"],
      ["unchanged", true, true, 10000, 1, "unchanged"],
      ["mtime", true, true, 20000, 1, "modified"],
      ["size", true, true, 10000, 2, "modified"],
    ] as const)
      it(`${side} ${label}`, () => {
        const e = exists
          ? {
              key: "note.md",
              keyRaw: "note.md",
              mtimeCli: side === "local" ? time : 999,
              mtimeSvr: side === "remote" ? time : 999,
              sizeRaw: size,
            }
          : undefined;
        assert.equal(state(e, previous ? record() : undefined, side), expected);
      });
    it(`${side} folder ignores timestamp and size`, () =>
      assert.equal(
        state(
          { key: "f/", keyRaw: "f/", sizeRaw: 333, mtimeCli: 8, mtimeSvr: 9 },
          record("f/"),
          side
        ),
        "unchanged"
      ));
  }
  for (const v of [undefined, 0, 2, "1"])
    it(`ignores record version ${v}`, () =>
      assert.equal(decodeRecord({ ...record(), v }), undefined));
  it("rejects malformed observations", () =>
    assert.equal(decodeRecord({ ...record(), local: {} }), undefined));
});

const rows = [
  ["unchanged", "unchanged", "none", "none"],
  ["unchanged", "modified", "pull", "pull"],
  ["unchanged", "deleted", "deleteLocal", "clear"],
  ["modified", "unchanged", "push", "none"],
  ["modified", "modified", "pull", "pull"],
  ["modified", "deleted", "push", "clear"],
  ["deleted", "unchanged", "deleteRemote", "none"],
  ["deleted", "modified", "pull", "pull"],
  ["deleted", "deleted", "clear", "clear"],
  ["new", "new", "pull", "pull"],
  ["new", "absent", "push", "none"],
  ["absent", "new", "pull", "pull"],
  ["absent", "absent", "none", "none"],
] as const;
describe("§6.1 §6.3 §6.6 reachable matrix cells", () => {
  for (const mode of ["A", "B"] as const)
    for (const config of [false, true])
      for (const [ls, rs, b, a] of rows) {
        it(`${mode} ${config ? "config" : "note"} ${ls}/${rs}`, async () => {
          const h = harness(mode),
            key = config ? ".obsidian/example.json" : "note.md";
          if (!["deleted", "absent"].includes(ls))
            h.local.put(key, "x", ls === "modified" ? 20000 : 10000);
          if (!["deleted", "absent"].includes(rs))
            h.remote.put(
              key,
              "x",
              rs === "modified" || rs === "new" ? 30000 : 10000
            );
          if (!["new", "absent"].includes(ls)) h.seed(record(key));
          const result = await runSync(h.input);
          assert.equal(result.ok, true);
          assert.equal(
            h.last()[key]?.decision ?? "none",
            mode === "A" || config ? a : b
          );
          if (mode === "A" || config) {
            assert.deepEqual(h.remote.writes(), []);
            assert.deepEqual(
              h.local.calls.filter((x) => x.op === "rm"),
              []
            );
          }
          if (rs === "absent" && (mode === "A" || config))
            assert.equal(h.rec(key), undefined);
          if (
            (mode === "A" || config) &&
            ls === "deleted" &&
            rs === "unchanged"
          )
            assert.deepEqual(h.rec(key), record(key));
        });
      }
});
describe("§6.2 conflict boundary and D3 D9", () => {
  for (const [delta, size, expected] of [
    [999, 1, "record"],
    [-999, 1, "record"],
    [1000, 1, "push"],
    [-1000, 1, "pull"],
    [999, 2, "pull"],
    [-999, 2, "pull"],
    [0, 2, "pull"],
  ] as const) {
    it(`delta ${delta} size ${size}`, async () => {
      const h = harness();
      h.local.put("note.md", "x".repeat(size), 10000 + delta);
      h.remote.put("note.md", "x", 10000);
      assert.equal((await runSync(h.input)).ok, true);
      assert.equal(h.last()["note.md"].decision, expected);
    });
  }
  for (const mode of ["A", "B"] as const)
    for (const config of [false, true])
      it(`loser ${mode} config=${config}`, async () => {
        const h = harness(mode),
          key = config ? ".obsidian/x.json" : "note.md";
        h.local.put(key, "old", 10000);
        h.remote.put(key, "winner", 30000);
        await runSync(h.input);
        assert.equal(
          h.local.calls.some((c) => c.op === "rm"),
          mode === "B" && !config
        );
        if (mode === "B" && !config)
          assert.equal(new TextDecoder().decode(h.local.trash.get(key)), "old");
      });
  it("D9 config wins even when local is newer; ordinary file uses mtime", async () => {
    const h = harness();
    for (const key of [".obsidian/x.json", "note.md"]) {
      h.local.put(key, "local", 90000);
      h.remote.put(key, "remote", 10000);
    }
    await runSync(h.input);
    assert.equal(h.last()[".obsidian/x.json"].decision, "pull");
    assert.equal(h.last()["note.md"].decision, "push");
  });
  it("A local conflict winner remains without a record", async () => {
    const h = harness("A");
    h.local.put("note.md", "local", 90000);
    h.remote.put("note.md", "remote", 10000);
    await runSync(h.input);
    assert.equal(h.last()["note.md"].decision, "none");
    assert.equal(h.rec(), undefined);
  });
});
