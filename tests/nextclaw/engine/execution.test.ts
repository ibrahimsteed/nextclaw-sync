import { strict as assert } from "assert";
import { runSync } from "../../../src/nextclaw/syncEngine";
import { harness, record, text } from "./helpers";
import { buildPlan } from "../../../src/nextclaw/engine/plan";

describe("§4 filtering and paths", () => {
  const excluded = [
    "hidden/.secret/x.md",
    ".trash/x.md",
    "a/node_modules/x.md",
    "a/__MACOSX/x.md",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/workspace",
    "ignore.md",
    "_debug_remotely_save/x.md",
    "_nextclaw_debug/x.md",
    ".obsidian/plugins/nextclaw-sync/main.js",
  ];
  for (const key of excluded)
    for (const side of ["local", "remote", "record"] as const)
      it(`excluded ${side} ${key}`, async () => {
        const h = harness();
        h.input.ignorePaths.push("^ignore\\.md$", "  ");
        // Place an unchanged record and then independently remove either side. No destructive inference is allowed.
        h.seed(record(key));
        if (side !== "remote") h.local.put(key);
        if (side !== "local") h.remote.put(key);
        const before = structuredClone(h.records);
        await runSync(h.input);
        assert.equal(h.last()[key], undefined);
        assert.deepEqual(h.records, before);
        assert.deepEqual(h.local.writes(), []);
        assert.deepEqual(h.remote.writes(), []);
      });
  it("underscore is included; custom config directory works", async () => {
    const h = harness();
    h.input.configDir = ".custom";
    h.remote.put("_meta/x.md").put(".custom/x.json").put(".obsidian/x.json");
    await runSync(h.input);
    assert.equal(h.last()["_meta/x.md"].decision, "pull");
    assert.equal(h.last()[".custom/x.json"].decision, "pull");
    assert.equal(h.last()[".obsidian/x.json"], undefined);
  });
  it("syncConfigDir=false excludes hidden config on all three sides", async () => {
    const h = harness();
    h.input.syncConfigDir = false;
    const key = ".obsidian/x.json";
    h.local.put(key);
    h.seed(record(key));
    await runSync(h.input);
    assert.equal(h.last()[key], undefined);
    assert.ok(h.rec(key));
  });
  it("NFC comparison and remote original write spelling", async () => {
    const h = harness(),
      nfc = "café.md",
      nfd = nfc.normalize("NFD");
    h.local.put(nfc, "old", 10000);
    h.remote.put(nfd, "new", 30000);
    await runSync(h.input);
    assert.equal(h.local.writes().find((c) => c.op === "writeFile")!.key, nfd);
    assert.ok(h.rec(nfc));
    await runSync(h.input);
    assert.equal(
      Object.values(h.last()).some((p: any) => p.change),
      false
    );
  });
  for (const side of ["local", "remote"] as const)
    it(`case collisions on ${side} never operate`, async () => {
      const h = harness();
      h[side].put("Note.md").put("note.md");
      const r = await runSync(h.input);
      assert.equal(r.ok, false);
      assert.equal(r.errors.length, 2);
      assert.deepEqual(h.local.writes(), []);
      assert.deepEqual(h.remote.writes(), []);
      assert.equal(h.saved(), 0);
    });
  it("case-colliding directory descendants stay blocked", async () => {
    const h = harness();
    h.local.put("Notes/a.md").put("notes/b.md");
    await runSync(h.input);
    assert.deepEqual(h.remote.writes(), []);
  });
  it("invalid regex fails before any mutation", async () => {
    const h = harness();
    h.input.ignorePaths = ["["];
    h.remote.put("a.md");
    assert.equal((await runSync(h.input)).ok, false);
    assert.deepEqual(h.local.writes(), []);
  });
});

describe("§7 protection", () => {
  for (const changed of [49, 50])
    it(`${changed}% at threshold 50`, async () => {
      const h = harness();
      h.input.protectModifyPercentage = 50;
      for (let i = 0; i < 100; i++) {
        const key = `${i}.md`;
        h.local.put(key);
        h.remote.put(key, "x", i < changed ? 20000 : 10000);
        h.seed(record(key));
      }
      const before = structuredClone(h.records);
      const result = await runSync(h.input);
      assert.equal(result.ok, changed === 49);
      if (changed === 50) {
        assert.equal(h.last()["/$@meta"].aborted, "protect");
        assert.deepEqual(h.local.writes(), []);
        assert.deepEqual(h.remote.writes(), []);
        assert.deepEqual(h.records, before);
        assert.equal(h.saved(), 0);
      }
    });
  it("100 disables protection", async () => {
    const h = harness();
    h.local.put("note.md");
    h.remote.put("note.md", "new", 20000);
    assert.equal((await runSync(h.input)).ok, true);
  });
  it("zero total never aborts even at zero threshold", async () => {
    const h = harness();
    h.input.protectModifyPercentage = 0;
    assert.equal((await runSync(h.input)).ok, true);
  });
  it("new files and directories do not count as modifications", async () => {
    const h = harness();
    h.input.protectModifyPercentage = 50;
    h.remote.put("f/").put("f/a.md");
    assert.equal((await runSync(h.input)).ok, true);
  });
  it("record-only absent paths count in denominator; directories do not", async () => {
    const h = harness();
    h.input.protectModifyPercentage = 50;
    h.seed(record("gone.md"));
    h.seed(record("gone2.md"));
    h.local.put("note.md");
    h.remote.put("note.md", "new", 20000).put("folder/");
    assert.equal((await runSync(h.input)).ok, true);
  });
});

describe("§5.3 convergence and §8 execution", () => {
  it("measured remote upload and truncated local times converge", async () => {
    const h = harness();
    h.local.put("upload.md", "upload", 10099);
    h.remote.put("download.md", "download", 12345);
    await runSync(h.input);
    assert.equal(h.rec("upload.md").remote.mtime, 200000);
    assert.equal(h.rec("download.md").local.mtime, 12000);
    h.local.calls = [];
    h.remote.calls = [];
    await runSync(h.input);
    assert.equal(
      Object.values(h.last()).some((p: any) => p.change),
      false
    );
    assert.deepEqual(h.local.writes(), []);
    assert.deepEqual(h.remote.writes(), []);
  });
  it("legacy records are treated as absent", async () => {
    const h = harness();
    h.seed({ key: "note.md", mtimeCli: 10000 });
    h.local.put("note.md");
    await runSync(h.input);
    assert.equal(h.last()["note.md"].decision, "push");
    assert.equal(h.rec().v, 1);
  });
  it("single failure preserves its record; other success is immediate and retry only does remainder", async () => {
    const h = harness();
    h.local.put("bad.md").put("good.md");
    h.remote.put("bad.md", "updated", 30000).put("good.md", "updated", 30000);
    h.seed(record("bad.md"));
    h.seed(record("good.md"));
    h.local.fail = (op, key) => op === "writeFile" && key === "bad.md";
    const r = await runSync(h.input);
    assert.equal(r.ok, false);
    assert.ok(h.rec("bad.md"));
    assert.equal(h.rec("bad.md").remote.mtime, 10000);
    assert.equal(h.rec("good.md").remote.mtime, 30000);
    assert.equal(h.events.filter((x) => x[0] === "error").length, 1);
    assert.equal(h.last()["/$@meta"].aborted, "error");
    h.local.fail = () => false;
    h.local.calls = [];
    await runSync(h.input);
    assert.deepEqual(
      h.local.writes().map((c) => c.key),
      ["bad.md"]
    );
  });
  it("10 errors stop starting work and retry completes remaining", async () => {
    const h = harness();
    h.input.concurrency = 1;
    for (let i = 0; i < 15; i++)
      h.remote.put(`${i.toString().padStart(2, "0")}.md`);
    h.local.fail = (op) => op === "writeFile";
    const r = await runSync(h.input);
    assert.equal(r.errors.length, 10);
    assert.equal(h.local.writes().length, 10);
    assert.equal(h.saved(), 0);
    h.local.fail = () => false;
    assert.equal((await runSync(h.input)).ok, true);
    assert.equal(Object.keys(h.records).length, 15);
  });
  it("concurrent transfers respect limit and settle active workers after failures", async () => {
    const h = harness();
    h.input.concurrency = 3;
    h.local.latency = 5;
    for (let i = 0; i < 12; i++) h.remote.put(`${i}.md`);
    await runSync(h.input);
    assert.equal(h.local.peak, 3);
    assert.equal(h.local.active, 0);
  });
  it("remote delete failure is reported and record retained", async () => {
    const h = harness();
    h.remote.put("note.md");
    h.seed(record());
    h.remote.fail = (op) => op === "rm";
    assert.equal((await runSync(h.input)).ok, false);
    assert.ok(h.rec());
  });
  it("root absence aborts stage 2 without mkdir or local enumeration", async () => {
    const h = harness();
    h.remote.root = false;
    h.local.put("note.md");
    assert.equal((await runSync(h.input)).ok, false);
    assert.deepEqual(h.remote.writes(), []);
    assert.deepEqual(h.local.calls, []);
    assert.equal(h.last()["/$@meta"].aborted, "error");
  });
  it("dry run preserves files and records; callbacks include skip stage", async () => {
    const h = harness();
    h.input.triggerSource = "dry";
    h.local.put("note.md");
    h.remote.put("note.md", "updated", 30000);
    h.seed(record());
    const before = structuredClone(h.records);
    assert.equal((await runSync(h.input)).ok, true);
    assert.deepEqual(h.local.writes(), []);
    assert.deepEqual(h.remote.writes(), []);
    assert.deepEqual(h.records, before);
    assert.equal(h.saved(), 0);
    assert.deepEqual(
      h.events.filter((x) => x[0] === "notify").map((x) => x[1]),
      [0, 1, 2, 3, 4, 5, 6, 7, 8]
    );
  });
  it("dry run still applies protection", async () => {
    const h = harness();
    h.input.triggerSource = "dry";
    h.input.protectModifyPercentage = 50;
    h.local.put("note.md");
    h.remote.put("note.md", "new", 30000);
    assert.equal((await runSync(h.input)).ok, false);
    assert.equal(h.last()["/$@meta"].aborted, "protect");
  });
  for (const failing of ["stat", "walk", "db", "plan", "notify"])
    it(`finally resets syncing on ${failing} exception`, async () => {
      const h = harness();
      if (failing === "db")
        h.input.db.prevSyncRecordsTbl.getItems = async () => {
          throw Error("db");
        };
      else if (failing === "plan")
        h.input.db.syncPlansTbl.setItem = async () => {
          throw Error("plan");
        };
      else if (failing === "notify")
        h.input.callbacks.notify = async () => {
          throw Error("notify");
        };
      else h.remote.fail = (op) => op === failing;
      const result = await runSync(h.input);
      assert.equal(result.ok, false);
      assert.deepEqual(h.events[h.events.length - 1], ["mark", false]);
      assert.equal(h.events.filter((x) => x[0] === "error").length, 1);
    });
  it("invalid mode aborts", async () => {
    const h = harness();
    (h.input as any).mode = "C";
    assert.equal((await runSync(h.input)).ok, false);
    assert.deepEqual(h.remote.calls, []);
  });
});

describe("§6.5 directory planning and dependencies", () => {
  it("creates missing ancestors shallow first before files", async () => {
    const h = harness();
    h.remote.put("one/two/a.md");
    await runSync(h.input);
    assert.deepEqual(
      h.local.writes().map((c) => [c.op, c.key]),
      [
        ["mkdir", "one/"],
        ["mkdir", "one/two/"],
        ["writeFile", "one/two/a.md"],
      ]
    );
  });
  it("propagates deleted empty subtree deepest first", async () => {
    const h = harness();
    for (const key of ["a/", "a/b/", "a/b/x.md"]) {
      h.local.put(key);
      h.seed(record(key));
    }
    await runSync(h.input);
    assert.deepEqual(
      h.local.writes().map((c) => c.key),
      ["a/b/x.md", "a/b", "a"]
    );
    assert.equal(Object.keys(h.records).length, 0);
  });
  it("modified child restores a deleted directory", async () => {
    const h = harness();
    h.local.put("a/").put("a/x.md", "edited", 30000);
    h.seed(record("a/"));
    h.seed(record("a/x.md"));
    await runSync(h.input);
    assert.deepEqual(
      h.remote.writes().map((c) => c.op),
      ["mkdir", "writeFile"]
    );
    assert.deepEqual(h.local.writes(), []);
  });
  it("failed child delete blocks parent removal", async () => {
    const h = harness();
    h.local.put("a/").put("a/x.md");
    h.seed(record("a/"));
    h.seed(record("a/x.md"));
    h.local.fail = (op, key) => op === "rm" && key === "a/x.md";
    await runSync(h.input);
    assert.deepEqual(
      h.local.writes().map((c) => c.key),
      ["a/x.md"]
    );
    assert.ok(h.rec("a/"));
  });
});

describe("Binary attachments", () => {
  it("pulls and pushes arbitrary bytes without text conversion", async () => {
    const h = harness();
    const content = new Uint8Array([0, 255, 128, 192, 13, 10, 65]).buffer;
    await h.remote.writeFile("remote.bin", content, 10000, 10000);
    await h.local.writeFile("local.bin", content, 10000, 10000);
    assert.equal((await runSync(h.input)).ok, true);
    assert.deepEqual(
      new Uint8Array(await h.local.readFile("remote.bin")),
      new Uint8Array(content)
    );
    assert.deepEqual(
      new Uint8Array(await h.remote.readFile("local.bin")),
      new Uint8Array(content)
    );
    await runSync(h.input);
    assert.equal(
      Object.values(h.last()).some((p: any) => p.change),
      false
    );
  });
});
