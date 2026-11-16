import { nanoid } from "nanoid";
import { hashBytes, isHash, NOTE_LIMIT, PROFILE_LIMIT } from "./identity";
export interface ContentTable {
  keys(): Promise<string[]>;
  getItem<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T): Promise<unknown>;
}
export interface BodyObject {
  version: 1; scope: string; path: string; generation: string;
  kind: "clean-base" | "merge-input"; bytes: ArrayBuffer; hash: string;
}
const queues = new WeakMap<ContentTable, Promise<unknown>>();
/** Immutable verified bodies; no sync record is published by this store. */
export class ContentStore {
  constructor(private readonly table: ContentTable, readonly scope: string,
    private readonly assertOwner: () => void,
    private readonly limits = { note: NOTE_LIMIT, profile: PROFILE_LIMIT }) {
    if (!scope || !Number.isSafeInteger(limits.note) || limits.note < 1 ||
      !Number.isSafeInteger(limits.profile) || limits.profile < limits.note)
      throw new Error("Invalid content storage limits");
  }
  private key(path: string, generation: string) {
    return JSON.stringify(["nextclaw-content", 1, this.scope, path, generation]);
  }
  private owns(key: string): boolean {
    try {
      const a: unknown = JSON.parse(key);
      return Array.isArray(a) && a.length === 5 && a[0] === "nextclaw-content" && a[1] === 1 &&
        a[2] === this.scope && typeof a[3] === "string" && typeof a[4] === "string";
    } catch { return false; }
  }
  async read(ref: string, path: string): Promise<BodyObject> {
    this.assertOwner();
    if (!this.owns(ref)) throw new Error("Content reference scope mismatch");
    const body = await this.table.getItem<BodyObject>(ref); this.assertOwner();
    if (!body || body.version !== 1 || body.scope !== this.scope || body.path !== path ||
      !["clean-base", "merge-input"].includes(body.kind) ||
      typeof body.generation !== "string" || ref !== this.key(path, body.generation) ||
      !(body.bytes instanceof ArrayBuffer) || body.bytes.byteLength > this.limits.note || !isHash(body.hash))
      throw new Error("Missing or invalid content object");
    const copy = { ...body, bytes: body.bytes.slice(0) };
    if (await hashBytes(copy.bytes) !== copy.hash) throw new Error("Corrupt content object");
    this.assertOwner(); return copy;
  }
  /** Full operation working set, checked before any body or mutation is admitted. */
  async ensureCapacity(additionalBytes: number) {
    this.assertOwner();
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Error("invalid-content-reservation");
    let used = 0;
    for (const key of await this.table.keys()) {
      this.assertOwner(); if (!this.owns(key)) continue;
      const obj = await this.table.getItem<BodyObject>(key); this.assertOwner();
      if (!obj || !(obj.bytes instanceof ArrayBuffer)) throw new Error("Invalid content accounting");
      used += obj.bytes.byteLength;
    }
    if (used + additionalBytes > this.limits.profile) throw new Error("content-limit-pending");
  }
  async put(path: string, bytes: ArrayBuffer, kind: BodyObject["kind"]): Promise<string> {
    if (bytes.byteLength > this.limits.note) throw new Error("content-limit-pending");
    const copy = bytes.slice(0), previous = queues.get(this.table) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      this.assertOwner(); let used = 0;
      for (const key of await this.table.keys()) {
        this.assertOwner(); if (!this.owns(key)) continue;
        const obj = await this.table.getItem<BodyObject>(key); this.assertOwner();
        if (!obj || !(obj.bytes instanceof ArrayBuffer)) throw new Error("Invalid content accounting");
        used += obj.bytes.byteLength;
      }
      if (used + copy.byteLength > this.limits.profile) throw new Error("content-limit-pending");
      const generation = nanoid(), ref = this.key(path, generation);
      const body: BodyObject = { version: 1, scope: this.scope, path, generation, kind,
        bytes: copy, hash: await hashBytes(copy) };
      this.assertOwner(); await this.table.setItem(ref, body); this.assertOwner();
      if ((await this.read(ref, path)).hash !== body.hash) throw new Error("Content write verification failed");
      return ref;
    });
    queues.set(this.table, run);
    try { return await run; }
    finally { if (queues.get(this.table) === run) queues.delete(this.table); }
  }
  async prepareBase(path: string, local: ArrayBuffer, remote: ArrayBuffer): Promise<string> {
    const l = local.slice(0), r = new Uint8Array(remote.slice(0));
    if (l.byteLength !== r.byteLength || new Uint8Array(l).some((v, i) => v !== r[i]))
      throw new Error("Cannot seed a common base from different bytes");
    return this.put(path, l, "clean-base");
  }
}
