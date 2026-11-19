import { jsonArrayKeyRange, type IdbStore } from "../../idbStore";
import { nanoid } from "nanoid";
import { hashBytes, isHash, NOTE_LIMIT, PROFILE_LIMIT } from "./identity";
export interface ContentTable {
  keys(): Promise<string[]>;
  iterate?: IdbStore["iterate"];
  getEntries?: IdbStore["getEntries"];
  getItem<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T): Promise<unknown>;
}
export interface BodyObject {
  version: 1; scope: string; path: string; generation: string;
  kind: "clean-base" | "merge-input"; bytes: ArrayBuffer; hash: string;
}
const queues = new WeakMap<ContentTable, Promise<unknown>>();
export interface ContentReservation { release(): void; }
type ReservationState = { owner: ContentStore; handle: ContentReservation; remaining: Map<string, number> };
const reservations = new WeakMap<ContentTable, Map<string, ReservationState>>();
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
  private async usedBytes() {
    let used = 0;
    const count = (value: unknown, key: string) => {
      this.assertOwner();
      if (!this.owns(key)) return;
      const obj = value as BodyObject | null;
      if (!obj || !(obj.bytes instanceof ArrayBuffer)) throw new Error("Invalid content accounting");
      used += obj.bytes.byteLength;
    };
    if (this.table.iterate) {
      await this.table.iterate(count, jsonArrayKeyRange(["nextclaw-content", 1, this.scope]));
    } else {
      for (const key of await this.table.keys()) {
        this.assertOwner();
        if (this.owns(key)) count(await this.table.getItem(key), key);
      }
    }
    this.assertOwner();
    return used;
  }
  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.table) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    queues.set(this.table, run);
    try { return await run; }
    finally { if (queues.get(this.table) === run) queues.delete(this.table); }
  }
  /** Full operation working set, checked before any body or mutation is admitted. */
  async ensureCapacity(additionalBytes: number) {
    this.assertOwner();
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Error("invalid-content-reservation");
    if (reservations.get(this.table)?.has(this.scope) || await this.usedBytes() + additionalBytes > this.limits.profile)
      throw new Error("content-limit-pending");
  }
  async reserveCapacity(budgets: ReadonlyMap<string, number>): Promise<ContentReservation> {
    const remaining = new Map(budgets);
    let total = 0;
    for (const size of remaining.values()) {
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid-content-reservation");
      total += size;
    }
    return this.enqueue(async () => {
      await this.ensureCapacity(total);
      this.assertOwner();
      const scopes = reservations.get(this.table) ?? new Map<string, ReservationState>();
      const handle: ContentReservation = {
        release: () => {
          if (scopes.get(this.scope)?.handle !== handle) return;
          scopes.delete(this.scope);
          if (!scopes.size) reservations.delete(this.table);
        },
      };
      scopes.set(this.scope, { owner: this, handle, remaining });
      reservations.set(this.table, scopes);
      return handle;
    });
  }
  checkReservedCapacity(path: string, size: number, handle: ContentReservation): number {
    this.assertOwner();
    const current = reservations.get(this.table)?.get(this.scope);
    const available = current?.remaining.get(path);
    if (!current || current.owner !== this || current.handle !== handle || available === undefined)
      throw new Error("invalid-content-reservation");
    if (!Number.isSafeInteger(size) || size < 0 || size > available) throw new Error("content-limit-pending");
    return available;
  }
  async put(path: string, bytes: ArrayBuffer, kind: BodyObject["kind"], reservation?: ContentReservation): Promise<string> {
    if (bytes.byteLength > this.limits.note) throw new Error("content-limit-pending");
    const copy = bytes.slice(0);
    return this.enqueue(async () => {
      if (reservation) {
        const available = this.checkReservedCapacity(path, copy.byteLength, reservation);
        // Charge before writing. A failure can leave a persisted body.
        reservations.get(this.table)!.get(this.scope)!.remaining.set(path, available - copy.byteLength);
      } else await this.ensureCapacity(copy.byteLength);
      const generation = nanoid(), ref = this.key(path, generation);
      const body: BodyObject = { version: 1, scope: this.scope, path, generation, kind,
        bytes: copy, hash: await hashBytes(copy) };
      this.assertOwner(); await this.table.setItem(ref, body); this.assertOwner();
      if ((await this.read(ref, path)).hash !== body.hash) throw new Error("Content write verification failed");
      return ref;
    });
  }
  async prepareBase(path: string, local: ArrayBuffer, remote: ArrayBuffer, reservation?: ContentReservation): Promise<string> {
    const l = local.slice(0), r = new Uint8Array(remote.slice(0));
    if (l.byteLength !== r.byteLength || new Uint8Array(l).some((v, i) => v !== r[i]))
      throw new Error("Cannot seed a common base from different bytes");
    return this.put(path, l, "clean-base", reservation);
  }
}
