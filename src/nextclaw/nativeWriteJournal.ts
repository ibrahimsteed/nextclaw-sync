import { nanoid } from "nanoid";
import { mutationPending, TRANSPORT_PAUSED } from "./writeQuarantine";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Operation = { id: string; method: string; path: string; expected: string | null; at: number; destination?: string; overwrite?: "F" };
type Journal = { version: 1; owner: string; operations: Operation[] };
export const NATIVE_OWNER_HEADER = "x-nextclaw-native-owner";
const owners = new Map<string, NativeWriteJournal>();
/** A completion must match the immutable registration, not only an id. */
function sameOperation(expected: Operation | undefined, stored: Operation): boolean {
  if (!expected || !stored || typeof stored !== "object") return false;
  const keys = Object.keys(expected) as (keyof Operation)[];
  return Object.keys(stored).length === keys.length &&
    keys.every(key => expected[key] === stored[key]);
}
export class NativeWritePaused extends Error {
  constructor() { super(TRANSPORT_PAUSED); this.name = "NativeWritePaused"; }
}
const reads = new Set(["GET", "HEAD", "PROPFIND", "OPTIONS", "REPORT"]);
export const isMutation = (method: string) => !reads.has(method.toUpperCase());
/** Only explicit final receipts. A gateway timeout or 202 is not completion. */
export function terminalReceipt(method: string, status: number): boolean {
  const success: Record<string, number[]> = {
    PUT: [200, 201, 204], DELETE: [200, 204], MKCOL: [201],
    MOVE: [201, 204], COPY: [201, 204], PATCH: [200, 204],
  };
  // Explicit rejection: retain existing authentication, permissions and race handling.
  return (success[method.toUpperCase()] ?? []).includes(status) ||
    [400, 401, 403, 404, 405, 412, 413, 415, 423].includes(status);
}
/** One load owns only its own outstanding registrations. No recovery/unlock API. */
export class NativeWriteJournal {
  readonly token = nanoid();
  private active = new Map<string, Operation>();
  private uncertain = false;
  private retired = false;
  constructor(private readonly storage: Store, readonly key: string) {
    owners.set(this.token, this);
  }
  blocked(): boolean {
    if (this.retired || this.uncertain) return true;
    try {
      if (this.storage.getItem(this.key + ":recovery") !== null) return true;
      const raw = this.storage.getItem(this.key);
      if (raw === null) return this.active.size !== 0;
      const journal = JSON.parse(raw) as Journal;
      return journal.version !== 1 || journal.owner !== this.token ||
        !Array.isArray(journal.operations) || journal.operations.length === 0 ||
        journal.operations.length !== this.active.size ||
        new Set(journal.operations.map(op => op.id)).size !== journal.operations.length ||
        journal.operations.some(op => !sameOperation(this.active.get(op.id), op));
    } catch { return true; }
  }
  private load(): Journal {
    const raw = this.storage.getItem(this.key);
    return raw === null ? { version: 1, owner: this.token, operations: [] } : JSON.parse(raw) as Journal;
  }
  async send<T extends { status: number }>(
    method: string, url: string, expected: string | null, send: () => Promise<T>, guardedDestination?: string
  ): Promise<T> {
    if (this.blocked()) throw new NativeWritePaused();
    const id = nanoid();
    // Never persist credentials, query strings, headers or file bodies.
    const source = new URL(url), verb = method.toUpperCase();
    let destination: string | undefined;
    if (guardedDestination !== undefined) {
      const target = new URL(guardedDestination);
      if (verb !== "MOVE" || !expected || target.origin !== source.origin || target.username || target.password ||
        target.search || target.hash || target.pathname === source.pathname) throw new Error("invalid-guarded-move-destination");
      destination = target.pathname;
    }
    const op: Operation = Object.freeze({ id, method: verb, path: source.pathname, expected, at: Date.now(),
      ...(destination === undefined ? {} : { destination, overwrite: "F" as const }) });
    try {
      const journal = this.load();
      journal.operations.push(op);
      const raw = JSON.stringify(journal);
      this.storage.setItem(this.key, raw);
      if (this.storage.getItem(this.key) !== raw) throw new Error("journal readback mismatch");
      this.active.set(id, op);
    } catch { this.uncertain = true; throw new NativeWritePaused(); }
    try {
      const response = await send();
      if (!terminalReceipt(method, response.status) || destination !== undefined && response.status === 204) throw new NativeWritePaused();
      // A receipt can settle only the exact registration, including after unload.
      const journal = this.load();
      if (journal.version !== 1 || journal.owner !== this.token ||
          !Array.isArray(journal.operations) ||
          journal.operations.filter(x => x.id === id).length !== 1 ||
          !sameOperation(op, journal.operations.find(x => x.id === id)!)) throw new NativeWritePaused();
      journal.operations = journal.operations.filter(x => x.id !== id);
      if (journal.operations.length) {
        const raw = JSON.stringify(journal);
        this.storage.setItem(this.key, raw);
        if (this.storage.getItem(this.key) !== raw) throw new NativeWritePaused();
      } else {
        this.storage.removeItem(this.key);
        if (mutationPending(this.storage, this.key)) throw new NativeWritePaused();
      }
      return response;
    } catch {
      this.uncertain = true;
      throw new NativeWritePaused();
    } finally {
      this.active.delete(id);
      if (this.retired && !this.active.size) owners.delete(this.token);
    }
  }
  retire() {
    this.retired = true;
    if (!this.active.size) owners.delete(this.token);
  }
}
/** Native request dispatch, shared by every WebDAV mutation including MKCOL. */
export async function dispatchNative<T extends { status: number }>(
  token: string | undefined, method: string, url: string,
  expected: string | null, send: () => Promise<T>, guardedDestination?: string
): Promise<T> {
  const owner = token ? owners.get(token) : undefined;
  if (token && (!owner || owner.blocked())) throw new NativeWritePaused();
  if (!isMutation(method)) return send();
  if (!owner) throw new NativeWritePaused();
  return owner.send(method, url, expected, send, guardedDestination);
}
