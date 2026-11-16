import { operationIntentHash } from "./operation";
import { strongEtag } from "./migration";
import type { IdbConnectionPool, IdbStore } from "../../idbStore";
import type { NextclawSyncRecord } from "../../localdb";
import { SyncConflict } from "../engine/versionGuard";
import { decodeRecord } from "../engine/model";
import { validContentRecord, type ContentRecord } from "./identity";
import type { ContentOperation, OperationRepository, Checkpoint } from "./operation";
import type { ContentTable } from "./store";

const transitions: Record<ContentOperation["phase"], string[]> = {
  "inputs-durable": ["remote-dispatched", "local-verified", "rediscover"],
  "remote-dispatched": ["remote-acknowledged", "rejected"],
  "remote-acknowledged": ["local-verified", "committed", "rediscover"],
  "local-verified": ["local-verified", "committed", "rediscover"], committed: ["archived"], rejected: ["archived"], rediscover: ["archived"], archived: [],
};
/** Stored beside immutable bodies with a separate namespace; no DB version upgrade or deletion. */
export class TableOperationRepository implements OperationRepository {
  constructor(private readonly table: ContentTable, private readonly scope: string, private readonly guard: () => void) {}
  private key(id: string) { return JSON.stringify(["nextclaw-content-operation", 1, this.scope, id]); }
  async get(id: string): Promise<ContentOperation | undefined> {
    this.guard(); const o = await this.table.getItem<ContentOperation>(this.key(id)); this.guard();
    if (o === null) return;
    if (o.version !== 1 || o.id !== id || o.scope !== this.scope || !Object.prototype.hasOwnProperty.call(transitions, o.phase) || !o.intentHash)
      throw new Error("invalid-persistent-operation");
    if (typeof o.dispatchStarted !== "boolean" || o.intentHash !== await operationIntentHash(o)) throw new Error("invalid-operation-intent");
    this.guard();
    if (o.phase === "remote-dispatched" && !o.dispatchStarted) throw new Error("invalid-dispatch-proof");
    if (o.dispatchStarted && !["remote-dispatched"].includes(o.phase)) {
      const a = o.receipt, reject = o.rejection;
      if (o.phase === "rejected" || (o.phase === "archived" && reject)) {
        if (!reject || reject.operation !== o.id || reject.intentHash !== o.intentHash || ![400,401,403,404,405,412,413,415,423].includes(reject.status))
          throw new Error("invalid-rejection-proof");
      } else if (!a || a.intentHash !== o.intentHash || a.operation !== o.id || a.owner !== o.owner ||
        a.outputHash !== o.outputHash || a.expectedEtag !== o.expectedEtag || ![200,201,204].includes(a.status) || !strongEtag(a.etag))
        throw new Error("invalid-completion-proof");
    }
    if (o.phase === "archived" && !o.retiredBy) throw new Error("invalid-retirement-proof");
    return structuredClone(o);
  }
  async list(scope: string) {
    if (scope !== this.scope) throw new Error("operation-scope-mismatch");
    this.guard(); const out: ContentOperation[] = [];
    for (const key of await this.table.keys()) {
      this.guard(); let parts: unknown;
      try { parts = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(parts) || parts[0] !== "nextclaw-content-operation" || parts[2] !== scope) continue;
      if (parts.length !== 4 || parts[1] !== 1 || typeof parts[3] !== "string" || key !== this.key(parts[3]))
        throw new Error("invalid-operation-key");
      const o = await this.get(parts[3]); if (!o) throw new Error("missing-persistent-operation"); out.push(o);
    }
    return out;
  }
  async put(value: ContentOperation) {
    if (value.scope !== this.scope) throw new Error("operation-scope-mismatch");
    const next = structuredClone(value), previous = await this.get(next.id);
    if (previous ? previous.intentHash !== next.intentHash || (previous.dispatchStarted && !next.dispatchStarted) || !transitions[previous.phase].includes(next.phase) : next.phase !== "inputs-durable")
      throw new Error("invalid-operation-transition");
    if (next.phase === "archived" && !next.retiredBy) throw new Error("missing-retirement-proof");
    this.guard(); await this.table.setItem(this.key(next.id), next); this.guard();
    if (JSON.stringify(await this.get(next.id)) !== JSON.stringify(next)) throw new Error("operation-readback-failed");
  }
}
export const contentCommitKey = (scope: string, recordKey: string) =>
  JSON.stringify(["nextclaw-content-commit", 1, scope, recordKey]);

/** Atomic record+commit-id CAS across the two existing stores. Used by the default B content runtime. */
export class IdbContentCheckpoint {
  constructor(private readonly pool: IdbConnectionPool, private readonly records: IdbStore,
    private readonly history: IdbStore, private readonly recordKey: string, private readonly scope: string,
    private readonly seed: NextclawSyncRecord, private readonly guard: () => void) {
    if (records.dbName !== history.dbName || records.storeName === history.storeName || !scope ||
      !decodeRecord(seed) || seed.isFolder || !recordKey.endsWith(`\t${seed.key}`))
      throw new Error("invalid-checkpoint-binding");
    this.seed = structuredClone(seed);
  }
  private auxKey() { return contentCommitKey(this.scope, this.recordKey); }
  private async transact(content?: ContentRecord, pending = false, commitId?: string, expected?: string, assertCurrent?: () => void, observed?: Pick<NextclawSyncRecord, "local" | "remote" | "sizeRaw" | "keyRaw">): Promise<Checkpoint> {
    const guard = () => { this.guard(); assertCurrent?.(); };
    guard(); const db = await this.pool.database(this.records.dbName, [this.records.storeName, this.history.storeName]); guard();
    return new Promise<Checkpoint>((resolve, reject) => {
      const tx = db.transaction([this.records.storeName, this.history.storeName], content ? "readwrite" : "readonly");
      let error: Error | undefined, result: Checkpoint;
      tx.onabort = tx.onerror = () => reject(error ?? tx.error ?? Error("checkpoint transaction failed"));
      tx.oncomplete = () => { try { guard(); resolve(result); } catch (e) { reject(e instanceof Error ? e : Error("checkpoint owner rejected")); } };
      const records = tx.objectStore(this.records.storeName), history = tx.objectStore(this.history.storeName);
      const recordRequest = records.get(this.recordKey), auxRequest = history.get(this.auxKey()); let ready = 0;
      const consume = () => {
        if (++ready !== 2) return;
        try {
          guard(); const raw = recordRequest.result as unknown, aux = auxRequest.result as { version: number; id: string } | undefined;
          const record = raw === undefined ? undefined : decodeRecord(raw);
          if ((raw !== undefined && (!record || record.key !== this.seed.key || record.isFolder)) ||
            (aux && (aux.version !== 1 || typeof aux.id !== "string"))) throw new Error("invalid-checkpoint-record");
          if (record?.content !== undefined && (!validContentRecord(record.content) || record.content.scopeKey !== this.scope))
            throw new Error("invalid-checkpoint-capability");
          const generation = JSON.stringify([raw ?? null, aux ?? null]);
          result = { generation, content: record?.content, pendingLocalUpload: record?.pendingLocalUpload === true, commitId: aux?.id };
          if (content) {
            if (generation !== expected) throw new SyncConflict("checkpoint-generation-changed");
            if (!validContentRecord(content) || content.scopeKey !== this.scope || !commitId) throw new Error("invalid-checkpoint-content");
            records.put({ ...(record ?? this.seed), ...observed, content, pendingLocalUpload: pending || undefined }, this.recordKey);
            history.put({ version: 1, id: commitId }, this.auxKey());
          }
        } catch (e) { error = e instanceof Error ? e : Error("checkpoint failed"); tx.abort(); }
      };
      recordRequest.onsuccess = consume; auxRequest.onsuccess = consume;
    });
  }
  read() { return this.transact(); }
  async commit(generation: string, content: ContentRecord, pending: boolean, id: string, assertCurrent?: () => void, observed?: Pick<NextclawSyncRecord, "local" | "remote" | "sizeRaw" | "keyRaw">) {
    // Clone before the asynchronous database open; callers cannot retarget a commit.
    await this.transact(structuredClone(content), pending, id, generation, assertCurrent, observed && structuredClone(observed));
  }
}
