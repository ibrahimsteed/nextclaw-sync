import { strict as assert } from "assert";
import { runSync } from "../../../src/nextclaw/syncEngine";
import { harness, record, text } from "./helpers";
const key = ".obsidian/community-plugins.json";
describe("§6.7 plugin list merge", () => {
  it("preserves custom ids in order, removes withdrawn delivery ids and missing manifests, deduplicates and adds self", async () => {
    const h = harness();
    h.local
      .put(
        key,
        JSON.stringify(["retired", "custom2", "missing", "custom1", "custom2"])
      )
      .put(".obsidian/plugins/custom1/manifest.json", "{}")
      .put(".obsidian/plugins/custom2/manifest.json", "{}")
      .put(".obsidian/plugins/retired/manifest.json", "{}");
    h.remote.put(
      key,
      JSON.stringify(["copilot", "copilot", "dataview"]),
      30000
    );
    h.seed(record(key, { remoteList: ["retired"] }));
    assert.equal((await runSync(h.input)).ok, true);
    assert.deepEqual(JSON.parse(text(await h.local.readFile(key))), [
      "copilot",
      "dataview",
      "custom2",
      "custom1",
      "nextclaw-sync",
    ]);
    assert.deepEqual(h.rec(key).remoteList, ["copilot", "copilot", "dataview"]);
    assert.equal(h.rec(key).local.mtime, 30000);
    assert.equal(
      h.rec(key).remote.size,
      JSON.stringify(["copilot", "copilot", "dataview"]).length
    );
    assert.deepEqual(h.remote.writes(), []);
    assert.deepEqual(
      h.local.calls.filter((c) => c.op === "rm"),
      []
    );
    h.local.calls = [];
    await runSync(h.input);
    assert.equal(
      Object.values(h.last()).some((p: any) => p.change),
      false
    );
    assert.deepEqual(h.local.writes(), []);
  });
  it("missing local file uses empty local list", async () => {
    const h = harness();
    h.remote.put(key, '["copilot"]');
    await runSync(h.input);
    assert.deepEqual(JSON.parse(text(await h.local.readFile(key))), [
      "copilot",
      "nextclaw-sync",
    ]);
  });
  for (const side of ["local", "remote"] as const)
    for (const invalid of ["broken", "{}", '["valid", 1]'])
      it(`invalid ${side} ${invalid}: raw fallback and warning, other files continue`, async () => {
        const h = harness();
        h.local.put(key, '["custom"]');
        h.remote.put(key, '["server"]', 30000).put("other.md");
        h[side].put(key, invalid, side === "remote" ? 30000 : 10000);
        const result = await runSync(h.input);
        assert.equal(result.errors.length, 1);
        assert.match(h.last()[key].reason, /格式错误/);
        assert.equal(
          text(await h.local.readFile(key)),
          text(await h.remote.readFile(key))
        );
        assert.ok(h.rec("other.md"));
        assert.ok(h.rec(key));
      });
  it("local enable/disable survives when remote unchanged", async () => {
    const h = harness();
    h.remote.put(key, '["copilot"]');
    await runSync(h.input);
    h.local.put(key, '["custom"]', 50000);
    h.local.calls = [];
    await runSync(h.input);
    assert.deepEqual(h.local.writes(), []);
    assert.deepEqual(h.remote.writes(), []);
  });
});
