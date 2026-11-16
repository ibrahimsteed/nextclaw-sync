import "fake-indexeddb/auto";
import { strict as assert } from "assert";
import { SyncConflict } from "../../src/nextclaw/engine/versionGuard";
import { IdbStore, IdbConnectionPool } from "../../src/idbStore";
import { IdbContentCheckpoint, TableOperationRepository } from "../../src/nextclaw/content/repository";
import type { ContentOperation } from "../../src/nextclaw/content/operation";
import type { NextclawSyncRecord } from "../../src/localdb";
const scope = "idb-synthetic-scope", key = "v\tp\tnote.md";
const seed: NextclawSyncRecord = { v: 1, key: "note.md", keyRaw: "note.md", sizeRaw: 4, isFolder: false,
  local: { mtime: 1, size: 4 }, remote: { mtime: 1, size: 4, etag: "E1" }, remoteList: ["student-plugin"] };
const content = { version: 1 as const, scopeKey: scope, status: "unbased" as const };
function env(db = `p1-atomic-content-${crypto.randomUUID()}`) {
  const pool = new IdbConnectionPool(), records = new IdbStore(db, "prev", ["prev", "filecontenthistory"], pool),
    history = new IdbStore(db, "filecontenthistory", ["prev", "filecontenthistory"], pool);
  const guard = () => pool.assertOpen();
  return { db, pool, records, history, checkpoint: new IdbContentCheckpoint(pool, records, history, key, scope, seed, guard),
    operations: new TableOperationRepository(history, scope, guard) };
}
function operation(): ContentOperation {
  return { version: 1, id: "op-1", scope, path: "note.md", owner: "owner-1", phase: "inputs-durable", intentHash: "synthetic-hash", dispatchStarted: false,
    action: "upload", previous: { generation: "0", pendingLocalUpload: false }, outputRef: "synthetic-body-ref", outputHash: "0".repeat(64),
    outputKind: "clean", originalUpload: true };
}
describe("P1 repositories on actual existing IndexedDB implementation", () => {
  it("commits record and id atomically, preserves metadata and rejects a competing generation", async () => {
    const t = env(); try {
      await t.records.setItem(key, seed); const before = await t.checkpoint.read();
      const results = await Promise.allSettled([
        t.checkpoint.commit(before.generation, content, false, "one"), t.checkpoint.commit(before.generation, content, false, "two"),
      ]);
      assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
      assert.ok(results.some(x => x.status === "rejected" && x.reason instanceof SyncConflict));
      const after = await t.checkpoint.read(); assert.ok(["one", "two"].includes(after.commitId!));
      assert.notEqual(after.generation, before.generation);
      const raw = await t.records.getItem<NextclawSyncRecord>(key);
      assert.deepEqual(raw!.remoteList, seed.remoteList); assert.deepEqual(raw!.local, seed.local); assert.deepEqual(raw!.content, content);
    } finally { t.pool.dispose(); }
  });
  it("persists a dispatched operation across disposal/reload without advancing it or clearing any journal", async () => {
    const t = env(); const op = operation(); op.intentHash = await operationIntentHash(op); await t.operations.put(op); op.dispatchStarted = true; op.phase = "remote-dispatched"; await t.operations.put(op); t.pool.dispose();
    const next = env(t.db); try {
      const list = await next.operations.list(scope); assert.equal(list.length, 1); assert.equal(list[0].phase, "remote-dispatched");
      await assert.rejects(next.operations.put({ ...list[0], phase: "committed" }), /transition/);
      await assert.rejects(next.operations.put({ ...list[0], phase: "remote-acknowledged", intentHash: "other" }), /transition/);
      assert.equal((await next.operations.get(op.id))!.phase, "remote-dispatched");
    } finally { next.pool.dispose(); }
  });
  it("rejects retired owners, changed legacy records and unsupported capabilities without overwriting them", async () => {
    const t = env(); try {
      await t.records.setItem(key, seed); const before = await t.checkpoint.read();
      await t.records.setItem(key, { ...seed, local: { mtime: 2, size: 4 } });
      await assert.rejects(t.checkpoint.commit(before.generation, content, false, "wrong"), /generation/);
      await t.records.setItem(key, { ...seed, content: { version: 2 } });
      await assert.rejects(t.checkpoint.read(), /capability/);
      await assert.rejects(t.checkpoint.commit(before.generation, content, false, "wrong"), /capability/);
      assert.equal((await t.history.keys()).length, 0);
    } finally { t.pool.dispose(); }
    await assert.rejects(t.checkpoint.read(), /disposed/);
  });
  it("a failed publication cannot leave a commit id without its record", async () => {
    const t = env(); try {
      await t.records.setItem(key, seed); const before = await t.checkpoint.read();
      await assert.rejects(t.checkpoint.commit(before.generation, { ...content, scopeKey: "other" }, false, "wrong"), /content/);
      assert.equal((await t.history.keys()).length, 0); assert.deepEqual(await t.records.getItem(key), seed);
    } finally { t.pool.dispose(); }
  });
});

import { operationIntentHash } from "../../src/nextclaw/content/operation";
import { NativeWriteJournal } from "../../src/nextclaw/nativeWriteJournal";
import { ContentStore } from "../../src/nextclaw/content/store";
import { ContentExecutor, type ContentIO } from "../../src/nextclaw/content/operation";
import { planContent } from "../../src/nextclaw/content/decision";
import { hashBytes } from "../../src/nextclaw/content/identity";
it("P1 integrated durable execution: reload after commit failure commits once from stored ack, with zero PUT replay", async () => {
  const first = env(), guard = () => first.pool.assertOpen();
  const bodies = new ContentStore(first.history, scope, guard);
  const bytes = (s: string) => new TextEncoder().encode(s).buffer;
  const ref = await bodies.put("note.md", bytes("base\n"), "clean-base");
  await first.records.setItem(key, { ...seed, content: { ...content, status: "clean", cleanBaseRef: ref } });
  let local = bytes("local\n"), remote = bytes("base\n"), etag = "E1", puts = 0, failCommit = true;
  const entries = new Map<string, string>(), storage = { getItem: (k: string) => entries.get(k) ?? null,
    setItem: (k: string, v: string) => { entries.set(k, v); }, removeItem: (k: string) => { entries.delete(k); } };
  const journal = new NativeWriteJournal(storage, scope), endpoint = "https://synthetic.invalid/vault/note.md";
  const io: ContentIO = { scope, path: "note.md", endpoint,
    readLocal: async () => ({ bytes: local.slice(0) }), readRemote: async () => ({ bytes: remote.slice(0), etag }),
    putRemote: async (b, expected) => { assert.equal(expected, etag); assert.ok(entries.get(scope)); puts++; remote = b.slice(0); etag = "E2"; return { status: 201, etag }; },
    writeLocal: async (b, expected) => { assert.equal(await hashBytes(local), expected); local = b.slice(0); },
    checkpoint: () => first.checkpoint.read(), commit: async (...args) => {
      if (failCommit) { failCommit = false; throw Error("injected record failure"); }
      await first.checkpoint.commit(...args);
    }, requestRerun: () => {},
  };
  const plan = await planContent({ scope, path: "note.md", store: bodies, rawRecord: await first.records.getItem(key),
    mode: "B", configDir: ".obsidian", ownerActive: () => true, unknownWrite: false,
    local: { bytes: local }, remote: { bytes: remote, etag } });
  const writer = new ContentExecutor(scope, "note.md", bodies, first.operations, io, journal, endpoint, () => true, ".obsidian");
  assert.equal((await writer.execute(plan)).status, "failed");
  const operations = await first.operations.list(scope); assert.equal(operations[0].phase, "local-verified");
  assert.equal(entries.size, 0); assert.equal(puts, 1); journal.retire(); first.pool.dispose();
  const next = env(first.db), nextJournal = new NativeWriteJournal(storage, scope);
  try {
    const nextBodies = new ContentStore(next.history, scope, () => next.pool.assertOpen());
    const nextIO = { ...io, checkpoint: () => next.checkpoint.read(), commit: (...args: Parameters<ContentIO["commit"]>) => next.checkpoint.commit(...args) };
    const reloaded = new ContentExecutor(scope, "note.md", nextBodies, next.operations, nextIO, nextJournal, endpoint, () => true, ".obsidian");
    assert.equal((await reloaded.finish(operations[0].id)).status, "converged"); assert.equal(puts, 1);
    const saved = await next.checkpoint.read(); assert.equal(saved.commitId, operations[0].id);
    assert.equal(new TextDecoder().decode((await nextBodies.read(saved.content!.cleanBaseRef!, "note.md")).bytes), "local\n");
    assert.equal((await next.pool.database(next.db, ["prev", "filecontenthistory"])).version, 1);
  } finally { nextJournal.retire(); next.pool.dispose(); }
});
it("P1 checkpoint checks current lifecycle/global isolation after database open, before the atomic writes", async () => {
  const t = env(); try {
    await t.records.setItem(key, seed); const before = await t.checkpoint.read(); let blocked = false;
    const pending = t.checkpoint.commit(before.generation, content, false, "late", () => { if (blocked) throw Error("new isolation"); });
    blocked = true; await assert.rejects(pending, /new isolation/);
    assert.deepEqual(await t.records.getItem(key), seed); assert.equal((await t.history.keys()).length, 0);
  } finally { t.pool.dispose(); }
});

it("persistent dispatch cannot masquerade as committed or rejected after a phase-only corruption", async () => {
  const t=env(); try {
    const op=operation(); op.intentHash=await operationIntentHash(op); await t.operations.put(op);
    op.dispatchStarted=true; op.phase="remote-dispatched"; await t.operations.put(op);
    const slot=JSON.stringify(["nextclaw-content-operation",1,scope,op.id]);
    for(const phase of ["committed","rejected","archived"] as const){
      await t.history.setItem(slot,{...op,phase,retiredBy:op.id});
      await assert.rejects(t.operations.get(op.id),/proof/);
    }
    await t.history.setItem(slot,{...op,path:"other.md"});
    await assert.rejects(t.operations.get(op.id),/intent/);
  } finally {t.pool.dispose();}
});
