import "fake-indexeddb/auto";
import { strict as assert } from "assert";
import { ContentStore, type ContentTable } from "../../src/nextclaw/content/store";
import { SyncQueue } from "../../src/nextclaw/syncQueue";
import { planContent } from "../../src/nextclaw/content/decision";
import { ContentExecutor, type ContentIO, type ContentOperation, type OperationRepository, type Checkpoint } from "../../src/nextclaw/content/operation";
import { NativeWriteJournal } from "../../src/nextclaw/nativeWriteJournal";
import { SyncConflict } from "../../src/nextclaw/engine/versionGuard";
import type { NextclawSyncRecord } from "../../src/localdb";
import { hashBytes, type ContentRecord } from "../../src/nextclaw/content/identity";
import { prepareLegacyExport, type RollbackSource } from "../../src/nextclaw/content/rollback";
const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const text = (b: ArrayBuffer) => new TextDecoder().decode(b);
const path = "note.md", scope = "synthetic-content-profile";
class Table implements ContentTable {
  values = new Map<string, unknown>(); fail = false;
  async keys() { return [...this.values.keys()]; }
  async getItem<T>(k: string) { return structuredClone(this.values.get(k) ?? null) as T | null; }
  async setItem<T>(k: string, value: T) { if (this.fail) throw Error("QuotaExceededError"); this.values.set(k, structuredClone(value)); }
}
class Operations implements OperationRepository {
  values = new Map<string, ContentOperation>(); hook: (o: ContentOperation) => void = () => {};
  async list(s: string) { return [...this.values.values()].filter(o => o.scope === s).map(o => structuredClone(o)); }
  async get(id: string) { return structuredClone(this.values.get(id)); }
  async put(o: ContentOperation) { this.values.set(o.id, structuredClone(o)); this.hook(o); }
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
async function setup(base = "a\nb\nc\n", initialL = "A\nb\nc\n", initialR = base) {
  const table = new Table(), operations = new Operations(), entries = new Map<string, string>(); let active = true;
  const storage = { getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string, v: string) => { entries.set(k, v); }, removeItem: (k: string) => { entries.delete(k); } };
  const journal = new NativeWriteJournal(storage, scope);
  const bodies = new ContentStore(table, scope, () => { if (!active) throw Error("retired-owner-no-write"); });
  const baseRef = await bodies.put(path, bytes(base), "clean-base");
  let slot: Checkpoint = { generation: "0", content: { version: 1, scopeKey: scope, status: "clean", cleanBaseRef: baseRef }, pendingLocalUpload: false };
  let local: ArrayBuffer | undefined = bytes(initialL), remote: ArrayBuffer | undefined = bytes(initialR), etag = "E1";
  let puts = 0, localWrites = 0, commits = 0, reruns = 0, status = 201, failCommit = false, throwAfterCommit = false;
  let beforePut: () => Promise<void> = async () => {}, afterPut: () => void = () => {};
  let beforeLocal: () => void = () => {}, afterCommit: () => void = () => {};
  const io: ContentIO = {
    scope, path, endpoint: "https://synthetic.invalid/vault/note.md",
    readLocal: async () => local ? { bytes: local.slice(0) } : undefined,
    readRemote: async () => remote ? { bytes: remote.slice(0), etag } : undefined,
    putRemote: async (b, expected) => {
      puts++; assert.ok(entries.get(scope), "real NativeWriteJournal registration precedes mutation"); await beforePut();
      if (expected === null ? remote !== undefined : etag !== expected) return { status: 412 };
      if (![200,201,204,504].includes(status)) return { status };
      remote = b.slice(0); etag = `E${puts + 1}`; afterPut(); return { status, etag };
    },
    writeLocal: async (b, expected, assertCurrent) => {
      beforeLocal(); if ((local ? await hashBytes(local) : undefined) !== expected) throw new SyncConflict("local CAS rejected");
      assertCurrent(); assert.ok(active); localWrites++; local = b.slice(0);
    },
    checkpoint: async () => structuredClone(slot),
    commit: async (generation, content, pending, id, assertCurrent) => {
      if (failCommit) { failCommit = false; throw Error("record commit unavailable"); }
      assertCurrent(); assert.equal(generation, slot.generation); assert.ok(active); commits++;
      slot = { generation: `${commits}`, content: structuredClone(content), pendingLocalUpload: pending, commitId: id }; afterCommit();
      if (throwAfterCommit) { throwAfterCommit = false; throw Error("commit acknowledgement lost"); }
    },
    requestRerun: () => { reruns++; },
  };
  const executor = new ContentExecutor(scope, path, bodies, operations, io, journal, "https://synthetic.invalid/vault/note.md", () => active, ".obsidian");
  const rawRecord = (): NextclawSyncRecord => ({ v: 1, keyRaw: path, sizeRaw: local?.byteLength ?? 0, key: path, isFolder: false, local: { mtime: 1, size: local?.byteLength ?? 0 },
    remote: { mtime: 1, size: remote?.byteLength ?? 0, etag }, content: slot.content, pendingLocalUpload: slot.pendingLocalUpload });
  const plan = (newPath = false) => planContent({ scope, path, store: bodies, mode: "B", configDir: ".obsidian", ownerActive: () => active,
    unknownWrite: journal.blocked(), rawRecord: newPath ? undefined : rawRecord(), local: local ? { bytes: local } : undefined,
    remote: remote ? { bytes: remote, etag } : undefined, readConflict: async id => (await operations.get(id))?.conflict });
  return { table, operations, bodies, storage, entries, journal, io, executor, plan, rawRecord,
    state: () => ({ local: local && text(local), remote: remote && text(remote), etag, slot: structuredClone(slot), puts, localWrites, commits, reruns }),
    clearLocal: () => { local = undefined; }, clearRemote: () => { remote = undefined; },
    clearIdentity: () => { slot = { generation: "0", pendingLocalUpload: false }; },
    setLocal: (s: string) => { local = bytes(s); }, setRemote: (s: string) => { remote = bytes(s); etag += "changed"; },
    beforePut: (hook: () => Promise<void>) => { beforePut = hook; }, afterPut: (hook: () => void) => { afterPut = hook; },
    beforeLocal: (hook: () => void) => { beforeLocal = hook; }, afterCommit: (hook: () => void) => { afterCommit = hook; },
    failCommit: () => { failCommit = true; }, loseCommitAck: () => { throwAfterCommit = true; },
    status: (s: number) => { status = s; }, retire: () => { active = false; journal.retire(); },
  };
}
describe("P1 opt-in execution, durable receipts and commits (not default engine)", () => {
  it("commits a verified clean merge, retaining the original durable inputs", async () => {
    const t = await setup("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
    assert.equal((await t.executor.execute(await t.plan())).status, "converged");
    assert.equal(t.state().local, "A\nb\nC\n"); assert.equal(t.state().remote, t.state().local);
    const op = [...t.operations.values.values()][0]; assert.equal(op.phase, "committed");
    assert.equal(text((await t.bodies.read(op.remoteRef!, path)).bytes), "a\nb\nC\n");
    assert.equal(text((await t.bodies.read(t.state().slot.content!.cleanBaseRef!, path)).bytes), t.state().local);
    t.retire();
  });
  it("N01/N02/Q04: guarded new uploads/downloads and ordinary pulls commit only verified content", async () => {
    for (const action of ["upload-create", "download-create", "download"]) {
      const t = await setup("base\n", action === "download" ? "base\n" : "local\n", "remote\n");
      if (action !== "download") { t.clearIdentity(); if (action === "upload-create") t.clearRemote(); else t.clearLocal(); }
      const plan = await t.plan(action !== "download"); assert.equal(plan.action, action);
      assert.equal((await t.executor.execute(plan)).status, "converged");
      assert.equal(t.state().local, t.state().remote); assert.equal(t.state().puts, action === "upload-create" ? 1 : 0); t.retire();
    }
  });
  it("rejects port/endpoint or configuration binding before touching any file", async () => {
    const t = await setup();
    assert.throws(() => new ContentExecutor(scope, path, t.bodies, t.operations, { ...t.io, path: "other.md" }, t.journal,
      t.io.endpoint, () => true, ".obsidian"), /binding/);
    const config = "private-config/community-plugins.json";
    assert.throws(() => new ContentExecutor(scope, config, t.bodies, t.operations, { ...t.io, path: config }, t.journal,
      t.io.endpoint, () => true, "private-config"), /binding/);
    assert.equal(t.state().puts, 0); assert.equal(t.state().commits, 0); t.retire();
  });
  it("registers a real whole-document conflict without making markers a clean base, then resolves a heading", async () => {
    const t = await setup("a\n", "left\n", "right\n");
    const initialBase = t.state().slot.content!.cleanBaseRef;
    assert.equal((await t.executor.execute(await t.plan())).status, "content-conflict");
    assert.equal(t.state().slot.content!.cleanBaseRef, initialBase);
    assert.ok(t.state().local!.startsWith("<<<<<<< Obsidian\n"));
    t.setLocal("学习计划\n=======\n正文\n"); const plan = await t.plan(); assert.equal(plan.action, "resolve-local");
    assert.equal((await t.executor.execute(plan)).status, "converged");
    assert.equal(t.state().remote, "学习计划\n=======\n正文\n"); assert.equal(t.state().slot.content!.conflictRef, undefined); t.retire();
  });
  it("R05: acknowledged resolution S followed by S2 preserves pending upload and uses the rerun path without conflict copies", async () => {
    const t = await setup("a\n", "left\n", "right\n"); await t.executor.execute(await t.plan()); t.setLocal("S\n");
    t.afterPut(() => t.setLocal("S2\n"));
    const out = await t.executor.execute(await t.plan()); assert.equal(out.reason, "pendingLocalUpload-existing-rerun");
    assert.equal(t.state().slot.pendingLocalUpload, true); assert.equal(t.state().reruns, 1); assert.equal(t.state().remote, "S\n");
    t.afterPut(() => {}); assert.equal((await t.plan()).reason, "acknowledged-upload-tail-edit");
    assert.equal((await t.executor.execute(await t.plan())).status, "converged");
    assert.equal(t.state().remote, "S2\n"); assert.equal(t.state().slot.pendingLocalUpload, false); t.retire();
  });
  it("F02: a local edit after durable input preparation stops dispatch and preserves all inputs", async () => {
    const t = await setup("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
    t.operations.hook = o => { if (o.phase === "inputs-durable") t.setLocal("newest\n"); };
    const out = await t.executor.execute(await t.plan()); assert.equal(out.reason, "local-cas-reject");
    assert.equal(t.state().puts, 0); assert.equal(t.state().commits, 0); assert.equal(t.operations.values.size, 1); t.retire();
  });
  it("F03: remote 412 preserves the competitor and old base; explicit permission errors remain failures", async () => {
    for (const permission of [false, true]) {
      const t = await setup(); const old = t.state().slot;
      if (permission) t.status(403); else t.beforePut(async () => t.setRemote("competitor\n"));
      const out = await t.executor.execute(await t.plan());
      assert.equal(out.reason, permission ? "remote-rejected-403" : "remote-rejected-412");
      assert.equal(out.status, permission ? "failed" : "pending"); assert.deepEqual(t.state().slot, old);
      assert.equal(t.journal.blocked(), false); t.retire();
    }
  });
  it("F04: quota failure keeps the old record and sends no remote mutation", async () => {
    const t = await setup(); const old = t.state().slot; t.table.fail = true;
    assert.equal((await t.executor.execute(await t.plan())).status, "failed");
    assert.equal(t.state().puts, 0); assert.deepEqual(t.state().slot, old); t.retire();
  });
  it("F05: a tail edit after generated merge keeps remote contributions and rediscovery stage, not ordinary F1", async () => {
    const t = await setup("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
    t.afterPut(() => t.setLocal("A2\nb\nc\n"));
    const out = await t.executor.execute(await t.plan()); assert.equal(out.reason, "keep-inputs-and-stage-rediscover");
    assert.equal(t.state().remote, "A\nb\nC\n"); assert.equal(t.state().reruns, 0);
    t.afterPut(() => {}); assert.equal((await t.plan()).action, "merge-three-way");
    assert.equal((await t.executor.execute(await t.plan())).status, "content-conflict");
    assert.ok(t.state().local!.includes("C\n")); assert.ok(t.state().local!.includes("A2\n")); t.retire();
  });
  it("F06: commit failure or lost commit acknowledgement retries only the same record commit, never PUT", async () => {
    for (const lost of [false, true]) {
      const t = await setup(); if (lost) t.loseCommitAck(); else t.failCommit();
      const out = await t.executor.execute(await t.plan()); assert.equal(out.status, "failed");
      const id = [...t.operations.values.keys()][0]; assert.equal(t.state().puts, 1);
      assert.equal((await t.executor.finish(id)).status, "converged"); assert.equal(t.state().puts, 1); assert.equal(t.state().commits, 1); t.retire();
    }
  });
  it("idempotent commit cannot report convergence with a corrupt published base reference", async () => {
    const t = await setup(); t.loseCommitAck(); await t.executor.execute(await t.plan());
    const read = t.io.checkpoint; t.io.checkpoint = async () => {
      const slot = await read(); return { ...slot, content: { ...slot.content!, cleanBaseRef: "corrupt" } };
    };
    const id = [...t.operations.values.keys()][0]; assert.equal((await t.executor.finish(id)).status, "failed");
    assert.equal(t.state().puts, 1); t.retire();
  });
  it("unknown result survives reads, reload and retry; F08 missing durable ack stays paused even with empty native journal", async () => {
    const t = await setup(); t.status(504);
    assert.equal((await t.executor.execute(await t.plan())).status, "blocked-unknown-write");
    const id = [...t.operations.values.keys()][0], original = t.entries.get(scope);
    await t.io.readRemote(); assert.equal((await t.executor.finish(id)).status, "blocked-unknown-write");
    const reloaded = new NativeWriteJournal(t.storage, scope); assert.equal(reloaded.blocked(), true);
    assert.equal(t.entries.get(scope), original); assert.equal(t.state().puts, 1); reloaded.retire(); t.retire();
  });
  it("unload during PUT permits only exact native settlement; no old local/record callback and no stage replay on reload", async () => {
    const t = await setup(); const gate = deferred<void>(); t.beforePut(() => gate.promise);
    const running = t.executor.execute(await t.plan());
    while (!t.state().puts) await new Promise(r => setTimeout(r, 0));
    t.retire(); gate.resolve(); assert.equal((await running).status, "pending");
    assert.equal(t.state().localWrites, 0); assert.equal(t.state().commits, 0); assert.equal(t.entries.has(scope), false);
    const journal = new NativeWriteJournal(t.storage, scope), bodies = new ContentStore(t.table, scope, () => {});
    const next = new ContentExecutor(scope, path, bodies, t.operations, t.io, journal, "https://synthetic.invalid/vault/note.md", () => true, ".obsidian");
    const id = [...t.operations.values.keys()][0]; assert.equal((await next.finish(id)).reason, "keep-unconfirmed-stage");
    assert.equal(t.state().puts, 1); journal.retire();
  });
  it("feeds acknowledged tail edits through the existing SyncQueue while overlapping triggers coalesce", async () => {
    const t = await setup(), gate = deferred<void>(); let delay = true, edited = false, active = false, peak = 0, writes = 0;
    t.beforePut(() => delay ? gate.promise : Promise.resolve());
    t.afterPut(() => { if (!edited) { edited = true; t.setLocal("last-edit\n"); } });
    let scheduled: (() => void) | undefined; const runs: Promise<"ok" | "failed" | "blocked">[] = [];
    const clock = { setTimeout: (fn: () => void) => { scheduled = fn; return 1; }, clearTimeout: () => { scheduled = undefined; } };
    const queue = new SyncQueue(() => {
      const run = (async (): Promise<"ok" | "failed" | "blocked"> => {
        if (active) return "blocked";
        active = true; writes++; peak = Math.max(peak, writes);
        const out = await t.executor.execute(await t.plan()); writes--; active = false;
        const result = out.status === "blocked-unknown-write" ? "blocked" : out.status === "failed" ? "failed" : "ok";
        queue.finished(result); return result;
      })(); runs.push(run); return run;
    }, clock);
    const original = t.io.requestRerun; t.io.requestRerun = () => { original(); queue.request(); };
    const fire = () => { const fn = scheduled; assert.ok(fn); scheduled = undefined; fn(); };
    try {
      queue.request(); fire(); while (!t.state().puts) await new Promise(r => setTimeout(r, 0));
      queue.request(); fire(); assert.equal(await runs[1], "blocked");
      delay = false; gate.resolve(); assert.equal(await runs[0], "ok");
      fire(); assert.equal(await runs[2], "ok");
      assert.equal(t.state().remote, "last-edit\n"); assert.equal(t.state().puts, 2); assert.equal(peak, 1);
      assert.equal(t.state().slot.pendingLocalUpload, false);
    } finally { queue.dispose(); t.retire(); }
  });
  it("overlapping triggers cannot start a second content writer", async () => {
    const t = await setup(); const gate = deferred<void>(); t.beforePut(() => gate.promise); const plan = await t.plan();
    const running = t.executor.execute(plan); while (!t.state().puts) await new Promise(r => setTimeout(r, 0));
    const wrapper: OperationRepository = { list: s => t.operations.list(s), get: id => t.operations.get(id), put: o => t.operations.put(o) };
    const other = new ContentExecutor(scope, path, t.bodies, wrapper, t.io, t.journal, t.io.endpoint, () => true, ".obsidian");
    assert.equal((await other.execute(plan)).reason, "content-owner-busy"); gate.resolve();
    assert.equal((await running).status, "converged"); assert.equal(t.state().puts, 1); t.retire();
  });
  it("rejects corrupted intent and receipt instead of using successful reads as proof", async () => {
    for (const receipt of [false, true]) {
      const t = await setup(); t.failCommit(); await t.executor.execute(await t.plan());
      const [id, op] = [...t.operations.values.entries()][0];
      if (receipt) op.receipt!.operation = "other-operation"; else op.expectedEtag = "unrelated-etag";
      assert.equal((await t.executor.finish(id)).status, "failed"); assert.equal(t.state().commits, 0); t.retire();
    }
  });
  it("local CAS race after remote ack does not overwrite newer local bytes", async () => {
    const t = await setup("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
    t.beforeLocal(() => t.setLocal("late-local\n"));
    assert.equal((await t.executor.execute(await t.plan())).status, "pending");
    assert.equal(t.state().local, "late-local\n"); assert.equal(t.state().commits, 0); t.retire();
  });
  it("new global isolation or owner retirement at local replacement prevents the admitted old callback", async () => {
    for (const retire of [false, true]) {
      const t = await setup("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
      t.beforeLocal(() => { if (retire) t.retire(); else t.entries.set(scope + ":recovery", "synthetic isolation"); });
      const out = await t.executor.execute(await t.plan());
      assert.equal(out.status, retire ? "pending" : "blocked-unknown-write");
      assert.equal(t.state().localWrites, 0); assert.equal(t.state().commits, 0); t.retire();
    }
  });
  it("an edit during record commit is reported pending and rerun, not fully converged", async () => {
    const t = await setup(); t.afterCommit(() => t.setLocal("latest\n"));
    assert.equal((await t.executor.execute(await t.plan())).reason, "changed-after-record-commit");
    assert.equal(t.state().local, "latest\n"); assert.equal(t.state().reruns, 1); t.retire();
  });
});

async function exportFixture() {
  const t = await setup("same\n", "same\n", "same\n"); await t.executor.execute(await t.plan());
  let value = t.rawRecord(), generation = "generation1", names = [path];
  const snapshot = async (remote: boolean) => {
    const view = await (remote ? t.io.readRemote() : t.io.readLocal());
    return { bytes: view!.bytes, hash: await hashBytes(view!.bytes), entity: { key: path, keyRaw: path, sizeRaw: view!.bytes.byteLength,
      mtimeCli: 1, mtimeSvr: 1, ...(remote ? { etag: view!.etag } : {}) } };
  };
  const source: RollbackSource = { enumerate: async () => [...names], record: async () => ({ generation, value: structuredClone(value) }),
    local: () => snapshot(false), remote: () => snapshot(true) };
  const guard = () => { if (t.journal.blocked()) throw Error("retain-native-journal"); };
  return { t, source, guard, setValue: (v: typeof value) => { value = v; }, value: () => value,
    changeGeneration: () => { generation += "changed"; }, changeNames: () => { names.push("extra.md"); } };
}
describe("P1 rollback preconditions and export only", () => {
  it("T03: prepares actual compatible metadata records only after full scope comparison; never enables the old writer", async () => {
    const f = await exportFixture(); const out = await prepareLegacyExport(scope, f.source, f.t.bodies, f.t.operations, f.guard);
    assert.equal(out.activateOldWriter, false); assert.equal(out.records.length, 1);
    assert.equal(out.records[0].content, undefined); assert.equal(out.records[0].v, 1); assert.equal(out.sha256.length, 64); f.t.retire();
  });
  it("T01/T02: refuses conflict or unknown writes without changing journal or records", async () => {
    const f = await exportFixture(); f.setValue({ ...f.value(), content: { ...f.value().content!, status: "content-conflict", conflictRef: "known" } });
    await assert.rejects(prepareLegacyExport(scope, f.source, f.t.bodies, f.t.operations, f.guard));
    const raw = f.t.rawRecord(); f.t.status(504); f.t.setLocal("edit\n"); await f.t.executor.execute(await f.t.plan());
    const before = f.t.entries.get(scope);
    await assert.rejects(prepareLegacyExport(scope, f.source, f.t.bodies, f.t.operations, f.guard), /retain-native-journal/);
    assert.equal(f.t.entries.get(scope), before); assert.equal(raw.content!.status, "clean"); f.t.retire();
  });
  it("rejects changed files, changing enumeration or generation while exporting", async () => {
    for (const what of ["file", "enumeration", "record"]) {
      const f = await exportFixture(); const local = f.source.local.bind(f.source); let count = 0;
      f.source.local = async p => { const v = await local(p); if (++count === 1) {
        if (what === "file") f.t.setLocal("new\n"); else if (what === "enumeration") f.changeNames(); else f.changeGeneration();
      } return v; };
      await assert.rejects(prepareLegacyExport(scope, f.source, f.t.bodies, f.t.operations, f.guard)); f.t.retire();
    }
  });
});
