import "fake-indexeddb/auto";
import { IDBObjectStore } from "fake-indexeddb";
import { strict as assert } from "assert";
import type { Entity } from "../../src/baseTypes";
import { IdbConnectionPool, IdbStore } from "../../src/idbStore";
import type { InternalDBs, NextclawSyncRecord } from "../../src/localdb";
import { ContentMove, contentMoveKey } from "../../src/nextclaw/content/move";
import { checkVaultStages, ContentStagePaused } from "../../src/nextclaw/content/runtime";
import { ContentStore } from "../../src/nextclaw/content/store";
import { hashBytes } from "../../src/nextclaw/content/identity";
import { contentCommitKey } from "../../src/nextclaw/content/repository";
import { NativeWriteJournal, NativeWritePaused } from "../../src/nextclaw/nativeWriteJournal";

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const from = "old.md", to = "new.md";
const key = (path: string) => "vault\tprofile\t" + path;
function entity(path: string, text: string, remote = false): Entity {
  return { keyRaw: path, sizeRaw: bytes(text).byteLength, mtimeCli: 1, mtimeSvr: 1,
    ...(remote ? { etag: '"v1"', remoteFileId: "43" } : {}) };
}
function fixture() {
  const db = "p3-test-" + crypto.randomUUID();
  const local = new Map([[to, "base"]]), remote = new Map([[from, "base"]]);
  const registrations = new Map<string, string>();
  const storage = {
    getItem: (id: string) => registrations.get(id) ?? null,
    setItem: (id: string, v: string) => { registrations.set(id, v); },
    removeItem: (id: string) => { registrations.delete(id); },
  };
  let sends = 0, reply = 201;
  const files = (values: Map<string, string>, network: boolean) => ({
    async stat(path: string) {
      if (network && path === "/") return { keyRaw: "/", sizeRaw: 0, remoteFileId: "root" };
      const text = values.get(path);
      if (text === undefined) throw Object.assign(new Error("fixture absent"), network ? { status: 404 } : { code: "ENOENT" });
      return entity(path, text, network);
    },
    async readFile(path: string) { return bytes(values.get(path)!); },
  });
  function open() {
    const pool = new IdbConnectionPool();
    const stores = ["prev", "history"];
    const records = new IdbStore(db, "prev", stores, pool), history = new IdbStore(db, "history", stores, pool);
    const journal = new NativeWriteJournal(storage, "native-vault");
    let active = true;
    const guard = () => { if (!active) throw new Error("retired fixture"); pool.assertOpen(); };
    const move: ContentMove = new ContentMove({ pool, records, history, vault: "vault", profile: "profile", configDir: ".obsidian",
      rootId: "root", journal, assertActive: guard, local: files(local, false),
      remote: { ...files(remote, true),
        contentBinding: () => ({ origin: "https://fixture.invalid", account: "synthetic", remoteRoot: "/dav/synthetic/root",
          nativeManaged: true, journalToken: journal.token }),
        moveContent: (source, target, etag) => journal.send("MOVE", "https://fixture.invalid/dav/synthetic/root/" + source, etag, async () => {
          sends++;
          const stage = await history.getItem<{ phase: string; source: string; target: string }>(contentMoveKey(move.scope));
          assert.equal(stage?.phase, "dispatched");
          assert.equal(stage.source, source);
          assert.equal(stage.target, target);
          if (reply === 201 || reply === 504) {
            remote.set(target, remote.get(source)!);
            remote.delete(source);
          }
          return { status: reply };
        }, "https://fixture.invalid/dav/synthetic/root/" + target),
      },
    });
    const bodies = new ContentStore(history, move.scope, guard);
    return { records, history, move, bodies, journal, deactivate: () => { active = false; },
      close: () => { journal.retire(); pool.dispose(); } };
  }
  async function seed(t: ReturnType<typeof open>) {
    const ref = await t.bodies.prepareBase(from, bytes("base"), bytes("base"));
    const hash = await hashBytes(bytes("base"));
    const record: NextclawSyncRecord = { v: 1, key: from, keyRaw: from, sizeRaw: 4, isFolder: false,
      local: { mtime: 1, size: 4 }, remote: { mtime: 1, size: 4, etag: '"v1"' },
      content: { version: 1, scopeKey: t.move.scope, status: "clean", cleanBaseRef: ref,
        localHash: hash, remoteHash: hash, remoteEtag: '"v1"', remoteFileId: "43" } };
    await t.records.setItem(key(from), record);
    await t.history.setItem(contentCommitKey(t.move.scope, key(from)), { version: 1, id: "prior" });
    return record;
  }
  return { open, seed, local, remote, registrations, sends: () => sends, setReply: (status: number) => { reply = status; } };
}

describe("P3 protected MOVE and real IndexedDB checkpoint", () => {
  it("commits source removal, destination record, destination base and commit ID together", async () => {
    const f = fixture(), t = f.open();
    try {
      const original = await f.seed(t);
      const receipt = await t.move.send(from, to);
      assert.equal(receipt.status, 201);
      assert.deepEqual(await t.records.getItem(key(from)), original);
      assert.equal(await t.records.getItem(key(to)), null);
      await t.move.finish(receipt.id);
      assert.equal(await t.records.getItem(key(from)), null);
      assert.equal(await t.history.getItem(contentCommitKey(t.move.scope, key(from))), null);
      const target = await t.records.getItem<NextclawSyncRecord>(key(to));
      assert.equal(target?.key, to);
      assert.equal(target.content?.remoteFileId, "43");
      assert.equal((await t.bodies.read(target.content!.cleanBaseRef!, to)).hash, original.content?.remoteHash);
      assert.deepEqual(await t.history.getItem(contentCommitKey(t.move.scope, key(to))), { version: 1, id: receipt.id });
      await t.move.finish(receipt.id);
      assert.equal(f.sends(), 1);
    } finally { t.close(); }
  });

  for (const stop of ["transaction-abort", "committed-confirmation-lost"]) {
    it("recovers without sending again after " + stop, async () => {
      const f = fixture(), t = f.open();
      try {
        const original = await f.seed(t);
        const { id } = await t.move.send(from, to);
        const add = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (value, storedKey) {
          if (storedKey === key(to)) {
            if (stop === "transaction-abort") throw new Error(stop);
            const complete = this.transaction.oncomplete!;
            this.transaction.oncomplete = function (event) {
              t.deactivate();
              complete.call(this, event);
            };
          }
          return add.call(this, value, storedKey);
        };
        try { await assert.rejects(t.move.finish(id), new RegExp(stop === "transaction-abort" ? stop : "retired fixture")); }
        finally { IDBObjectStore.prototype.add = add; }
        t.close();
        const next = f.open();
        try {
          if (stop === "transaction-abort") {
            assert.deepEqual(await next.records.getItem(key(from)), original);
            assert.equal(await next.records.getItem(key(to)), null);
            assert.equal(await next.history.getItem(contentCommitKey(next.move.scope, key(to))), null);
            assert.equal((await next.move.pendingCommit())?.id, id);
          } else {
            assert.equal(await next.move.pendingCommit(), undefined);
          }
          await next.move.finish(id);
          assert.equal(await next.records.getItem(key(from)), null);
          assert.ok(await next.records.getItem(key(to)));
          assert.equal(f.sends(), 1);
        } finally { next.close(); }
      } finally { t.close(); }
    });
  }

  it("preserves later edits and does not apply a successful receipt to a competing target record", async () => {
    const f = fixture(), t = f.open();
    try {
      await f.seed(t);
      const { id } = await t.move.send(from, to);
      f.remote.set(to, "edit"); // Same length and metadata.
      await assert.rejects(t.move.finish(id), /content-changed/);
      assert.equal(f.remote.get(to), "edit");
      f.remote.set(to, "base");
      const competing = { key: to, marker: "new observation" };
      await t.records.setItem(key(to), competing);
      await assert.rejects(t.move.finish(id), /generation-changed/);
      assert.deepEqual(await t.records.getItem(key(to)), competing);
      assert.ok(await t.records.getItem(key(from)));
      assert.equal(f.sends(), 1);
    } finally { t.close(); }
  });

  it("settles a 412 without committing either path", async () => {
    const f = fixture(), t = f.open();
    try {
      const original = await f.seed(t);
      f.setReply(412);
      const { status, id } = await t.move.send(from, to);
      assert.equal(status, 412);
      assert.equal(await t.move.pendingCommit(), undefined);
      await assert.rejects(t.move.finish(id), NativeWritePaused);
      assert.deepEqual(await t.records.getItem(key(from)), original);
      assert.equal(await t.records.getItem(key(to)), null);
    } finally { t.close(); }
  });

  it("retains the dispatch if the successful receipt cannot be persisted", async () => {
    const f = fixture(), t = f.open();
    try {
      const source = await f.seed(t);
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, storedKey) {
        if (storedKey === contentMoveKey(t.move.scope) && value.phase === "acknowledged")
          throw new Error("receipt-write-failure");
        return put.call(this, value, storedKey);
      };
      try {
        await assert.rejects(t.move.send(from, to), (error: unknown) =>
          error instanceof NativeWritePaused && (error as Error & { cause: Error }).cause.message === "receipt-write-failure");
      }
      finally { IDBObjectStore.prototype.put = put; }
      assert.equal(f.registrations.size, 0);
      assert.equal(f.remote.get(to), "base");
      t.close();
      const next = f.open();
      try {
        await assert.rejects(next.move.pendingCommit(), NativeWritePaused);
        await assert.rejects(next.move.send(from, to), NativeWritePaused);
        assert.deepEqual(await next.records.getItem(key(from)), source);
        assert.equal(await next.records.getItem(key(to)), null);
        assert.equal(f.sends(), 1);
      } finally { next.close(); }
    } finally { t.close(); }
  });

  it("blocks a second dispatch on concurrent attempts", async () => {
    const f = fixture(), t = f.open();
    try {
      await f.seed(t);
      const outcomes = await Promise.allSettled([t.move.send(from, to), t.move.send(from, to)]);
      assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
      assert.equal(f.sends(), 1);
    } finally { t.close(); }
  });

  it("unknown success observed by reads cannot release either durable gate after reopening", async () => {
    const f = fixture(), t = f.open();
    try {
      await f.seed(t);
      f.setReply(504);
      await assert.rejects(t.move.send(from, to), NativeWritePaused);
      assert.equal(f.remote.get(from), undefined);
      assert.equal(f.remote.get(to), "base");
      t.close();
      const next = f.open();
      try {
        await assert.rejects(next.move.send(from, to), NativeWritePaused);
        await assert.rejects(next.move.pendingCommit(), NativeWritePaused);
        assert.equal(f.registrations.size, 1);
        // Even after a lost/cleared native receipt, the earlier IndexedDB dispatch is unresolved.
        f.registrations.clear();
        const db = { fileContentHistoryTbl: next.history } as InternalDBs;
        await assert.rejects(checkVaultStages(db, "vault", () => {}), ContentStagePaused);
        await assert.rejects(next.move.send(from, to), NativeWritePaused);
        assert.equal(f.sends(), 1);
      } finally { next.close(); }
    } finally { t.close(); }
  });

  it("refuses configuration paths, case-only changes and an occupied destination before sending", async () => {
    const f = fixture(), t = f.open();
    try {
      await f.seed(t);
      await assert.rejects(t.move.send(from, ".obsidian/plugins.json"), /invalid-move-paths/);
      await assert.rejects(t.move.send(from, "Old.md"), /invalid-move-paths/);
      f.remote.set(to, "peer");
      await assert.rejects(t.move.send(from, to), /move-target-occupied/);
      assert.equal(f.remote.get(to), "peer");
      assert.equal(f.sends(), 0);
    } finally { t.close(); }
  });
});
