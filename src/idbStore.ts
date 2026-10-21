/**
 * 基于 IndexedDB 的键值表，替代 localforage。
 *
 * localforage 为兼容旧浏览器打包了会动态创建 `<script>` 的代码与 localStorage 回退，
 * Obsidian 插件审查会把它们判为风险。本插件只在 Obsidian（桌面端 Electron、移动端 WebView）
 * 里运行，IndexedDB 总是可用，因此直接使用 IndexedDB。
 *
 * 与 localforage 的 IndexedDB 存储格式兼容：同名数据库、每张表一个对象仓库、
 * 键在仓库外（无 keyPath）、值按结构化克隆原样存放。已有设备上的数据无需迁移。
 */

const asError = (e: DOMException | null, fallback: string) =>
  e ?? new Error(fallback);

const promisify = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(asError(request.error, "IndexedDB request failed"));
  });

/** One loaded plugin owns one pool. Disposed owners cannot reopen connections. */
export class IdbConnectionPool {
  private readonly connections = new Map<string, Promise<IDBDatabase>>();
  private disposed = false;

  assertOpen() {
    if (this.disposed) throw new Error("IndexedDB owner has been disposed");
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const pending = [...this.connections.values()];
    this.connections.clear();
    for (const promise of pending) {
      // close() lets already admitted transactions finish; it never deletes data.
      void promise.then((db) => {
        db.onversionchange = null;
        db.close();
      }, () => {});
    }
  }

  private openRaw(name: string, version: number | undefined, stores: readonly string[]) {
    this.assertOpen();
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
      let settled = false;
      const fail = (error: Error | DOMException) => {
        if (!settled) { settled = true; reject(error); }
      };
      request.onupgradeneeded = () => {
        if (settled || this.disposed) {
          request.transaction?.abort();
          request.result.close();
          return;
        }
        for (const store of stores) {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        }
      };
      request.onsuccess = () => {
        // A blocked/rejected request may succeed later. Never leak its handle.
        if (settled || this.disposed) {
          request.result.close();
          fail(new Error("IndexedDB owner has been disposed or open cancelled"));
          return;
        }
        settled = true;
        resolve(request.result);
      };
      request.onerror = () => fail(asError(request.error, "IndexedDB request failed"));
      request.onblocked = () => fail(new Error(`IndexedDB ${name} upgrade is blocked by another connection`));
    });
  }

  private async connect(name: string, stores: readonly string[], invalidate: () => void) {
    let db = await this.openRaw(name, undefined, stores);
    if (this.disposed) { db.close(); this.assertOpen(); }
    if (stores.some((store) => !db.objectStoreNames.contains(store))) {
      const next = db.version + 1;
      db.close();
      db = await this.openRaw(name, next, stores);
      if (this.disposed) { db.close(); this.assertOpen(); }
    }
    db.onversionchange = () => {
      db.onversionchange = null;
      db.close();
      invalidate();
    };
    return db;
  }

  async database(name: string, stores: readonly string[]) {
    this.assertOpen();
    let promise = this.connections.get(name);
    if (promise === undefined) {
      const opened = this.connect(name, stores, () => {
        if (this.connections.get(name) === opened) this.connections.delete(name);
      });
      this.connections.set(name, opened);
      void opened.catch(() => {
        if (this.connections.get(name) === opened) this.connections.delete(name);
      });
      promise = opened;
    }
    const db = await promise;
    this.assertOpen();
    return db;
  }
}

// Compatibility for standalone consumers. Production supplies its own owner.
const defaultConnections = new IdbConnectionPool();

export class IdbStore {
  constructor(
    readonly dbName: string,
    readonly storeName: string,
    private readonly allStores: readonly string[],
    private readonly connections: IdbConnectionPool = defaultConnections
  ) {}

  private async store(mode: IDBTransactionMode) {
    const db = await this.connections.database(this.dbName, this.allStores);
    this.connections.assertOpen();
    const tx = db.transaction(this.storeName, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(asError(tx.error, "IndexedDB transaction failed"));
      tx.onabort = () => reject(asError(tx.error, "IndexedDB transaction aborted"));
    });
    return { store: tx.objectStore(this.storeName), done };
  }

  async getItem<T>(key: string): Promise<T | null> {
    const { store, done } = await this.store("readonly");
    const value = (await promisify(store.get(key))) as T | undefined;
    await done;
    return value === undefined ? null : value;
  }

  async setItem<T>(key: string, value: T): Promise<T> {
    const { store, done } = await this.store("readwrite");
    store.put(value === undefined ? null : value, key);
    await done;
    return value;
  }

  async removeItem(key: string): Promise<void> {
    const { store, done } = await this.store("readwrite");
    store.delete(key);
    await done;
  }

  async removeItems(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const { store, done } = await this.store("readwrite");
    for (const key of keys) {
      store.delete(key);
    }
    await done;
  }

  async keys(): Promise<string[]> {
    const { store, done } = await this.store("readonly");
    const keys = await promisify(store.getAllKeys());
    await done;
    return keys as string[];
  }

  /** 全部条目，键 → 值。 */
  async getItems(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    await this.iterate((value, key) => {
      out[key] = value;
    });
    return out;
  }

  /** 依次访问每个条目；回调返回非 undefined 的值时提前结束并返回它。 */
  async iterate<R>(
    callback: (value: unknown, key: string, iterationNumber: number) => R | undefined
  ): Promise<R | undefined> {
    const { store, done } = await this.store("readonly");
    const result = await new Promise<R | undefined>((resolve, reject) => {
      const request = store.openCursor();
      let n = 1;
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) {
          resolve(undefined);
          return;
        }
        const r = callback(cursor.value, cursor.key as string, n++);
        if (r !== undefined) {
          resolve(r);
          return;
        }
        cursor.continue();
      };
      request.onerror = () => reject(asError(request.error, "IndexedDB request failed"));
    });
    await done;
    return result;
  }

  async clear(): Promise<void> {
    const { store, done } = await this.store("readwrite");
    store.clear();
    await done;
  }
}
