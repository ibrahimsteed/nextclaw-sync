import "fake-indexeddb/auto";
import { strict as assert } from "assert";
import { MemoryFs, bytes, record } from "./engine/helpers";
import { decodeRecord } from "../../src/nextclaw/engine/model";
import { hashBytes, scopeKey, decodeText, localSnapshot, remoteSnapshot,
  davContentProperties, validContentRecord } from "../../src/nextclaw/content/identity";
import { ContentStore, type ContentTable, type BodyObject } from "../../src/nextclaw/content/store";
const scope = (account = "student") => scopeKey({ vault: "v", profile: "p", origin: "https://test.invalid",
  account, remoteRoot: "leaf", configDir: ".obsidian", filterVersion: 1 });
const owner = () => {};
class Table implements ContentTable {
  map = new Map<string, unknown>();
  async keys() { return [...this.map.keys()]; }
  async getItem<T>(k: string) { return (this.map.get(k) ?? null) as T | null; }
  async setItem<T>(k: string, v: T) { this.map.set(k, structuredClone(v)); }
}
describe("P1 content foundation (not engine activation)", () => {
  it("hashes raw same-size edits, BOM and line endings independently", async () => {
    assert.notEqual(await hashBytes(bytes("cat\n")), await hashBytes(bytes("dog\n")));
    assert.notEqual(await hashBytes(bytes("x\n")), await hashBytes(bytes("\ufeffx\r\n")));
    assert.equal(decodeText(bytes("\ufeffx\r\n")), "\ufeffx\r\n");
    assert.throws(() => decodeText(new Uint8Array([255]).buffer));
  });
  it("binds account and rejects credential-bearing scope URLs", () => {
    assert.notEqual(scope(), scope("other"));
    assert.throws(() => scopeKey({ vault: "v", profile: "p", origin: "https://user:secret@test.invalid",
      account: "a", remoteRoot: "leaf", configDir: ".obsidian", filterVersion: 1 }));
  });
  it("never uses same-time same-size as proof of content identity", async () => {
    const fs = new MemoryFs().put("n.md", "cat\n"), e = await fs.stat("n.md");
    const a = await localSnapshot(fs, "n.md", e, owner); fs.put("n.md", "dog\n");
    assert.notEqual(a.hash, (await localSnapshot(fs, "n.md", e, owner)).hash);
    let reads = 0; const read = fs.readFile.bind(fs);
    fs.readFile = async k => { const v = await read(k); if (++reads === 1) fs.put(k, "cat\n"); return v; };
    await assert.rejects(localSnapshot(fs, "n.md", e, owner), /快照读取/);
  });
  it("rejects retired owners immediately after asynchronous I/O", async () => {
    const fs = new MemoryFs().put("n.md", "x"); let retired = false;
    const read = fs.readFile.bind(fs); fs.readFile = async k => { const x = await read(k); retired = true; return x; };
    await assert.rejects(localSnapshot(fs, "n.md", await fs.stat("n.md"), () => { if (retired) throw Error("retired"); }), /retired/);
    assert.equal(fs.calls.filter(x => x.op === "readFile").length, 1);
  });
  it("rejects oversized discovery before reading bytes", async () => {
    const fs = new MemoryFs().put("n.md", "large");
    await assert.rejects(localSnapshot(fs, "n.md", await fs.stat("n.md"), owner, 2), /content-limit/);
    assert.equal(fs.calls.filter(x => x.op === "readFile").length, 0);
  });
  it("requires strong remote validators and verifies checksum against body", async () => {
    const fs = new MemoryFs().put("n.md", "x"), e = await fs.stat("n.md");
    await assert.rejects(remoteSnapshot(fs, "n.md", e, owner), /ETag/);
    await assert.rejects(remoteSnapshot(fs, "n.md", { ...e, etag: "W/one" }, owner), /ETag/);
    fs.files.get("n.md")!.entity.etag = "one";
    await assert.rejects(remoteSnapshot(fs, "n.md", { ...e, etag: "one", remoteChecksum: "0".repeat(64) }, owner), /校验和/);
    assert.equal((await remoteSnapshot(fs, "n.md", { ...e, etag: "one" }, owner)).hash, await hashBytes(bytes("x")));
  });
  it("does not coerce IDs or SHA1 into content hashes", () => {
    const h = "a".repeat(64);
    assert.deepEqual(davContentProperties({ fileid: "000123", checksums: { checksum: ["SHA1:no", "SHA256:" + h] } }), { remoteFileId: "000123", remoteChecksum: h });
    assert.deepEqual(davContentProperties({ fileid: 123, checksums: "SHA1:no" }), { remoteFileId: "123" });
    for (const fileid of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      assert.deepEqual(davContentProperties({ fileid }), {});
    assert.deepEqual(davContentProperties({ checksums: ["SHA256:" + h, "SHA256:" + "b".repeat(64)] }), {});
  });
  it("legacy records remain valid; new capabilities validate separately", () => {
    assert.ok(decodeRecord(record()));
    assert.equal(validContentRecord({ version: 2, scopeKey: scope(), status: "clean" }), false);
    assert.equal(validContentRecord({ version: 1, scopeKey: scope(), status: "clean", localHash: "bad" }), false);
    assert.equal(validContentRecord({ version: 1, scopeKey: scope(), status: "unbased" }), true);
  });
  it("prepares immutable bases only from equal actual bytes", async () => {
    const table = new Table(), s = new ContentStore(table, scope(), owner);
    await assert.rejects(s.prepareBase("n.md", bytes("cat"), bytes("dog")), /different bytes/);
    assert.equal(table.map.size, 0);
    const input = bytes("cat"), promise = s.prepareBase("n.md", input, input); new Uint8Array(input)[0] = 0;
    const ref = await promise; assert.equal(decodeText((await s.read(ref, "n.md")).bytes), "cat");
    const read = await s.read(ref, "n.md"); new Uint8Array(read.bytes)[0] = 0;
    assert.equal(decodeText((await s.read(ref, "n.md")).bytes), "cat");
  });
  it("rejects foreign scope/path and corrupt stored bytes", async () => {
    const table = new Table(), s = new ContentStore(table, scope(), owner);
    const ref = await s.put("n.md", bytes("x"), "merge-input");
    await assert.rejects(new ContentStore(table, scope("other"), owner).read(ref, "n.md"), /scope/);
    await assert.rejects(s.read(ref, "other.md"), /invalid/);
    (table.map.get(ref) as BodyObject).bytes = bytes("y");
    await assert.rejects(s.read(ref, "n.md"), /Corrupt/);
  });
  it("serializes profile budget checks across instances sharing a live table", async () => {
    const table = new Table(), limits = { note: 4, profile: 5 };
    const a = new ContentStore(table, scope(), owner, limits), b = new ContentStore(table, scope(), owner, limits);
    const result = await Promise.allSettled([a.put("a.md", bytes("123"), "merge-input"), b.put("b.md", bytes("456"), "merge-input")]);
    assert.equal(result.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(table.map.size, 1);
  });
  it("propagates quota/read-back failures without publishing a record", async () => {
    const table = new Table(), s = new ContentStore(table, scope(), owner);
    table.setItem = async () => { throw new Error("QuotaExceededError"); };
    await assert.rejects(s.put("n.md", bytes("x"), "clean-base"), /Quota/);
    table.setItem = async (k, v) => { table.map.set(k, { ...v as object, hash: "0".repeat(64) }); };
    await assert.rejects(s.put("n.md", bytes("x"), "clean-base"), /Corrupt/);
  });
});

// Exercise the actual existing physical schema/pool, not only a Map substitute.
import { IdbConnectionPool, IdbStore } from "../../src/idbStore";
describe("content foundation with actual IndexedDB adapter", () => {
  it("persists bodies across owner disposal without upgrading the schema", async () => {
    const db = "p1-content-foundation-" + Date.now(), pool = new IdbConnectionPool();
    const table = new IdbStore(db, "filecontenthistory", ["filecontenthistory"], pool);
    const store = new ContentStore(table, scope(), () => pool.assertOpen());
    const ref = await store.prepareBase("note.md", bytes("saved"), bytes("saved"));
    pool.dispose(); await assert.rejects(store.read(ref, "note.md"), /disposed/);
    const next = new IdbConnectionPool();
    try {
      const body = await new ContentStore(new IdbStore(db, "filecontenthistory", ["filecontenthistory"], next), scope(), () => next.assertOpen()).read(ref, "note.md");
      assert.equal(decodeText(body.bytes), "saved");
    } finally { next.dispose(); }
  });
  it("counts only the active profile in IndexedDB and rejects corrupt accounting entries", async () => {
    const pool = new IdbConnectionPool();
    const table = new IdbStore("p1-content-budget-" + crypto.randomUUID(), "history", ["history"], pool);
    const limits = { note: 4, profile: 5 };
    const guard = () => pool.assertOpen();
    const a = new ContentStore(table, scope(), guard, limits);
    const b = new ContentStore(table, scope("other"), guard, limits);
    try {
      await b.put("other.md", bytes("1234"), "clean-base");
      const results = await Promise.allSettled([
        a.put("a.md", bytes("123"), "merge-input"),
        new ContentStore(table, scope(), guard, limits).put("b.md", bytes("456"), "merge-input"),
      ]);
      const saved = results.filter(r => r.status === "fulfilled").map(r => r.value);
      assert.equal(saved.length, 1);
      await assert.rejects(a.ensureCapacity(3), /content-limit-pending/);
      await table.setItem(saved[0], {});
      await assert.rejects(a.ensureCapacity(1), /Invalid content accounting/);
      await assert.rejects(a.put("late.md", bytes("x"), "merge-input"), /Invalid content accounting/);
      assert.equal((await table.keys()).length, 2);
    } finally { pool.dispose(); }
  });
  it("binds a reservation to its path and owner and accounts for writes with a lost result", async () => {
    const pool = new IdbConnectionPool();
    const table = new IdbStore("p1-content-reservation-" + crypto.randomUUID(), "history", ["history"], pool);
    const guard = () => pool.assertOpen(), limits = { note: 4, profile: 5 };
    const store = new ContentStore(table, scope(), guard, limits);
    const other = new ContentStore(table, scope(), guard, limits);
    const reservation = await store.reserveCapacity(new Map([["a.md", 3], ["b.md", 2]]));
    const setItem = table.setItem.bind(table);
    try {
      await assert.rejects(other.put("a.md", bytes("1"), "merge-input", reservation), /invalid-content-reservation/);
      await assert.rejects(store.put("outside.md", bytes("1"), "merge-input", reservation), /invalid-content-reservation/);
      await assert.rejects(other.put("a.md", bytes("1"), "merge-input"), /content-limit-pending/);
      table.setItem = async (key, value) => {
        await setItem(key, value);
        throw Error("result lost after persisted body");
      };
      await assert.rejects(store.put("a.md", bytes("123"), "merge-input", reservation), /result lost/);
      table.setItem = setItem;
      await assert.rejects(store.put("a.md", bytes("1"), "merge-input", reservation), /content-limit-pending/);
      reservation.release();
      await assert.rejects(store.put("b.md", bytes("1"), "merge-input", reservation), /invalid-content-reservation/);
      await assert.rejects(store.reserveCapacity(new Map([["b.md", 3]])), /content-limit-pending/);
      const remaining = await store.reserveCapacity(new Map([["b.md", 2]]));
      try {
        const ref = await store.put("b.md", bytes("45"), "clean-base", remaining);
        assert.equal(decodeText((await store.read(ref, "b.md")).bytes), "45");
        assert.equal((await table.keys()).length, 2);
      } finally { remaining.release(); }
    } finally { reservation.release(); pool.dispose(); }
  });
  it("does not publish a reference when its owner retires during the admitted write", async () => {
    const table = new Table(); let retired = false;
    const put = table.setItem.bind(table);
    table.setItem = async (k, v) => { await put(k, v); retired = true; };
    const store = new ContentStore(table, scope(), () => { if (retired) throw Error("retired"); });
    await assert.rejects(store.put("note.md", bytes("saved"), "merge-input"), /retired/);
    assert.equal(table.map.size, 1); // An opaque orphan is retained, never presented as a committed base.
  });
  it("counts foreign profiles independently and does not poison the next queued write after failure", async () => {
    const table = new Table(), limits = { note: 4, profile: 4 };
    const a = new ContentStore(table, scope(), owner, limits), b = new ContentStore(table, scope("other"), owner, limits);
    await a.put("a.md", bytes("1234"), "clean-base");
    await assert.rejects(a.put("b.md", bytes("1"), "merge-input"), /content-limit/);
    const ref = await b.put("b.md", bytes("5678"), "clean-base");
    assert.equal(decodeText((await b.read(ref, "b.md")).bytes), "5678");
  });
});

describe("2b862ba snapshot ownership review regressions", () => {
  it("copies shared adapter buffers before a later read can mutate them", async () => {
    const fs = new MemoryFs().put("n.md", "cat\n"), entity = await fs.stat("n.md");
    const shared = bytes("cat\n"); let reads = 0;
    fs.readFile = async () => {
      if (++reads === 2) new Uint8Array(shared).set(new Uint8Array(bytes("dog\n")));
      return shared;
    };
    await assert.rejects(localSnapshot(fs, "n.md", entity, owner), /快照读取/);
  });
  it("does not let the caller mutate a returned snapshot's version identity", async () => {
    const fs = new MemoryFs().put("n.md", "cat\n"), expected = await fs.stat("n.md");
    const a = await localSnapshot(fs, "n.md", expected, owner);
    expected.mtimeCli = 12345; assert.notEqual(a.entity.mtimeCli, expected.mtimeCli);
    const remote = new MemoryFs("remote").put("n.md", "cat\n");
    remote.files.get("n.md")!.entity.etag = "E1";
    const re = await remote.stat("n.md");
    const b = await remoteSnapshot(remote, "n.md", re, owner);
    re.etag = "different"; assert.notEqual(b.entity.etag, re.etag);
  });
});
