import "fake-indexeddb/auto";
import { strict as assert } from "assert";
import { IdbStore } from "../../src/idbStore";
import {
  DEFAULT_DB_NAME,
  DEFAULT_TBL_PREV_SYNC_RECORDS,
  getAllPrevSyncRecordsByVaultAndProfile,
  prepareDBs,
} from "../../src/localdb";

const storesOf = (name: string) =>
  new Promise<string[]>((resolve, reject) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => {
      const names = Array.from(r.result.objectStoreNames);
      r.result.close();
      resolve(names);
    };
    r.onerror = () => reject(r.error);
  });

describe("NextClaw：本地数据库", () => {
  it("数据库名不是上游的 remotelysavedb", () => {
    // IndexedDB 跨插件共享；同名则与 remotely-save 同装一个库时 prevSync 完全重叠。
    assert.notEqual(DEFAULT_DB_NAME, "remotelysavedb");
    assert.equal(DEFAULT_DB_NAME, "nextclawsyncdb");
  });

  it("prepareDBs 的所有表都建在 nextclawsyncdb 里，且同一路径拿到同一个 vaultRandomID", async () => {
    const a = await prepareDBs("/vault/one", "", "webdav-default-1");
    const b = await prepareDBs("/vault/one", "", "webdav-default-1");
    assert.equal(a.vaultRandomID, b.vaultRandomID);
    const stores = await storesOf(DEFAULT_DB_NAME);
    for (const t of Object.values(a.db)) {
      assert.equal((t as IdbStore).dbName, DEFAULT_DB_NAME);
      assert.ok(stores.includes((t as IdbStore).storeName), (t as IdbStore).storeName);
    }
    assert.ok(stores.length >= 7);
  });
});

describe("NextClaw：IndexedDB 表的读写", () => {
  const t = new IdbStore("unit-db", "items", ["items", "other"]);

  it("setItem/getItem/removeItem/removeItems/keys/getItems/iterate/clear", async () => {
    await t.clear();
    assert.equal(await t.getItem("missing"), null);
    await t.setItem("a", { n: 1 });
    await t.setItem("b", [1, 2]);
    await t.setItem("c", "x");
    assert.deepEqual(await t.getItem("a"), { n: 1 });
    assert.deepEqual((await t.keys()).sort(), ["a", "b", "c"]);
    assert.deepEqual(await t.getItems(), { a: { n: 1 }, b: [1, 2], c: "x" });
    const seen: string[] = [];
    const stopped = await t.iterate((_v, k) => (seen.push(k), k === "b" ? "stop" : undefined));
    assert.equal(stopped, "stop");
    assert.deepEqual(seen, ["a", "b"]);
    await t.removeItem("a");
    await t.removeItems(["b", "nope"]);
    assert.deepEqual(await t.keys(), ["c"]);
    await t.clear();
    assert.deepEqual(await t.keys(), []);
  });
});

describe("NextClaw：与 localforage 写入的数据兼容（已有设备不丢同步记录）", () => {
  it("localforage 写的记录能读出；缺的表会补建，原有数据不受影响", async () => {
    // biome-ignore lint: 仅测试依赖，需在 fake-indexeddb 装好后加载
    const localforage = require("localforage");
    require("localforage-getitems").extendPrototype(localforage);
    const name = "compat-db";
    const legacy = localforage.createInstance({ name, storeName: DEFAULT_TBL_PREV_SYNC_RECORDS });
    const record = { key: "笔记.md", keyRaw: "笔记.md", v: 1, isFolder: false, local: { mtime: 1, size: 2 }, remote: { mtime: 1, size: 2 }, sizeRaw: 2 };
    await legacy.setItem("vault1\twebdav-default-1\t笔记.md", record);
    await legacy.setItem("vault2\twebdav-default-1\tother.md", { ...record, key: "other.md" });

    const stores = [DEFAULT_TBL_PREV_SYNC_RECORDS, "schemaversion", "simplekvformisc"];
    const db = { prevSyncRecordsTbl: new IdbStore(name, DEFAULT_TBL_PREV_SYNC_RECORDS, stores) } as any;
    const got = await getAllPrevSyncRecordsByVaultAndProfile(db, "vault1", "webdav-default-1");
    assert.deepEqual(got, [record]);
    const created = await storesOf(name);
    for (const s of stores) assert.ok(created.includes(s), s);

    // 反向：新代码写入的，localforage 也能读（回退到旧版本时不丢数据）。
    await db.prevSyncRecordsTbl.setItem("vault1\twebdav-default-1\tnew.md", { ...record, key: "new.md" });
    const again = localforage.createInstance({ name, storeName: DEFAULT_TBL_PREV_SYNC_RECORDS });
    assert.equal((await again.getItem("vault1\twebdav-default-1\tnew.md")).key, "new.md");
    assert.equal(Object.keys(await again.getItems()).length, 3);
  });
});
