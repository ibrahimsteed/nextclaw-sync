import { nanoid } from "nanoid";
import { hashBytes, isHash, type ContentRecord } from "./identity";
import type { ContentPlan } from "./decision";
import type { ContentTable } from "./store";
import type { ContentOutcome, ContentIO, Checkpoint } from "./operation";
import { NativeWriteJournal, terminalReceipt } from "../nativeWriteJournal";
import { strongEtag } from "./migration";
import { inConfig } from "../engine/model";
import { SyncConflict } from "../engine/versionGuard";

export interface DeleteOperation {
  version: 1; id: string; scope: string; path: string; endpoint: string; owner: string;
  action: "delete-local" | "delete-remote" | "delete-record";
  previous: Checkpoint; supersedes: string[]; baseRef: string; baseHash: string; expectedEtag?: string;
  intent: string; phase: "prepared" | "dispatched" | "acknowledged" | "committed" | "rediscover" | "rejected";
  receipt?: { id: string; owner: string; intent: string; status: number };
}
const namespace = "nextclaw-content-deletion";
export const deletionKey = (scope: string, id: string) => JSON.stringify([namespace, 1, scope, id]);
const intentOf = (o: DeleteOperation) => hashBytes(new TextEncoder().encode(JSON.stringify([
  o.version, o.id, o.scope, o.path, o.endpoint, o.owner, o.action, o.previous, o.supersedes, o.baseRef, o.baseHash, o.expectedEtag,
])).buffer);
const transitions: Record<DeleteOperation["phase"], string[]> = { prepared: ["dispatched", "acknowledged", "rediscover"],
  dispatched: ["acknowledged", "rejected", "rediscover"], acknowledged: ["committed", "rediscover"], committed: [], rediscover: [], rejected: [] };
/** Independent deletion namespace: the old PUT completion proof cannot settle a DELETE. */
export class DeletionLedger {
  constructor(private readonly table: ContentTable, readonly scope: string, private readonly guard: () => void) {}
  async list() {
    const out: DeleteOperation[] = [];
    for (const key of await this.table.keys()) {
      this.guard(); let k: unknown; try { k = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(k) || k[0] !== namespace || k[2] !== this.scope) continue;
      const o = await this.table.getItem<DeleteOperation>(key); this.guard();
      if (!o || k.length !== 4 || k[1] !== 1 || key !== deletionKey(this.scope, o.id) ||
        o.version !== 1 || o.scope !== this.scope || !o.owner || !o.id || !o.path || o.path.endsWith("/") ||
        o.path.split("/").some(x => !x || x === "." || x === "..") || !o.baseRef || !isHash(o.baseHash) ||
        !Array.isArray(o.supersedes) || o.supersedes.some(x => typeof x !== "string" || !x) || new Set(o.supersedes).size !== o.supersedes.length ||
        !["delete-local", "delete-remote", "delete-record"].includes(o.action) || !Object.prototype.hasOwnProperty.call(transitions, o.phase) ||
        o.intent !== await intentOf(o)) throw new Error("invalid-deletion-binding");
      this.guard();
      const c = o.previous?.content;
      if (!c || c.status !== "clean" || c.scopeKey !== o.scope || o.previous.pendingLocalUpload || c.conflictRef || c.operationRef ||
        c.cleanBaseRef !== o.baseRef || c.localHash !== o.baseHash || c.remoteHash !== o.baseHash ||
        (o.action === "delete-remote" && !strongEtag(o.expectedEtag))) throw new Error("invalid-deletion-base-binding");
      const a = o.receipt;
      if (["acknowledged", "committed"].includes(o.phase) || (o.phase === "rediscover" && a)) {
        if (!a || a.id !== o.id || a.owner !== o.owner || a.intent !== o.intent ||
          !(o.action === "delete-remote" ? [200,204].includes(a.status) : a.status === 204))
          throw new Error("invalid-deletion-completion");
      }
      if (o.phase === "rejected" && (!a || a.id !== o.id || a.owner !== o.owner || a.intent !== o.intent ||
        !terminalReceipt("DELETE", a.status) || [200,204].includes(a.status))) throw new Error("invalid-deletion-rejection");
      out.push(structuredClone(o));
    }
    return out;
  }
  async save(o: DeleteOperation) {
    this.guard(); const old = (await this.list()).find(x => x.id === o.id); this.guard();
    if (o.scope !== this.scope || o.intent !== await intentOf(o) ||
      (old ? old.intent !== o.intent || !transitions[old.phase].includes(o.phase) : o.phase !== "prepared"))
      throw new Error("invalid-deletion-transition");
    this.guard(); await this.table.setItem(deletionKey(this.scope, o.id), structuredClone(o)); this.guard();
    if (JSON.stringify((await this.list()).find(x => x.id === o.id)) !== JSON.stringify(o)) throw new Error("deletion-readback-failed");
  }
}
export interface DeleteIO extends ContentIO {
  assertDeletionEvidence(afterKnownDelete?: boolean): Promise<void>;
  removeLocal(hash: string, current: () => void): Promise<void>;
  removeRemote(etag: string, hash: string, dispatch: (send: () => Promise<{ status: number }>) => Promise<{ status: number }>): Promise<{ status: number }>;
  coveredOperations(): Promise<string[]>;
  commitDeleted(generation: string, content: ContentRecord, id: string, current: () => void): Promise<void>;
}
const deleting = new WeakSet<NativeWriteJournal>();
export class DeleteExecutor {
  constructor(private readonly ledger: DeletionLedger, private readonly io: DeleteIO,
    private readonly journal: NativeWriteJournal, private readonly guard: () => void, configDir: string) {
    if (io.scope !== ledger.scope || inConfig(io.path, configDir) || !io.path || io.path.endsWith("/"))
      throw new Error("invalid-delete-executor");
  }
  async execute(plan: ContentPlan): Promise<ContentOutcome> {
    if (deleting.has(this.journal)) return { status: "pending", reason: "delete-owner-busy" };
    deleting.add(this.journal);
    try { return await this.perform(plan); } finally { deleting.delete(this.journal); }
  }
  private async perform(plan: ContentPlan): Promise<ContentOutcome> {
    let operation: DeleteOperation | undefined, mutationMayHaveStarted = false;
    try {
      this.guard(); if (!plan.expected || !["delete-local", "delete-remote", "delete-record"].includes(plan.action) ||
        plan.expected.path !== this.io.path || plan.expected.scope !== this.io.scope || !plan.expected.baseRef)
        throw new Error("invalid-delete-plan");
      const previous = await this.io.checkpoint(); this.guard();
      if (previous.pendingLocalUpload || previous.content?.status !== "clean" ||
        previous.content.cleanBaseRef !== plan.expected.baseRef || previous.content.conflictRef || previous.content.operationRef ||
        previous.content.localHash !== previous.content.remoteHash || !isHash(previous.content.localHash))
        return { status: "pending", reason: "delete-requires-clean-base" };
      await this.io.assertDeletionEvidence(); this.guard();
      const l = await this.io.readLocal(), r = await this.io.readRemote(); this.guard();
      const lh = l && await hashBytes(l.bytes), rh = r && await hashBytes(r.bytes); this.guard();
      if (lh !== plan.expected.localHash || rh !== plan.expected.remoteHash || r?.etag !== plan.expected.remoteEtag ||
        (plan.action === "delete-remote" ? !!l || rh !== previous.content.remoteHash :
          plan.action === "delete-local" ? !!r || lh !== previous.content.localHash : !!l || !!r))
        return { status: "pending", reason: "delete-rediscover-current-bytes" };
      const o: DeleteOperation = { version: 1, id: nanoid(), scope: this.io.scope, path: this.io.path,
        endpoint: this.io.endpoint, owner: this.journal.token, action: plan.action as DeleteOperation["action"],
        previous, supersedes: await this.io.coveredOperations(), baseRef: plan.expected.baseRef, baseHash: previous.content.localHash, expectedEtag: r?.etag,
        intent: "", phase: "prepared" };
      o.intent = await intentOf(o); this.guard(); await this.ledger.save(o); operation = o;
      await this.io.assertDeletionEvidence(); this.guard();
      if (o.action !== "delete-record") {
        o.phase = "dispatched"; await this.ledger.save(o);
        let status = 204;
        if (o.action === "delete-remote") {
          status = (await this.io.removeRemote(o.expectedEtag!, o.baseHash, send => {
            this.guard(); mutationMayHaveStarted = true;
            return this.io.nativeManaged ? send() : this.journal.send("DELETE", o.endpoint, o.expectedEtag!, send);
          })).status;
        } else { mutationMayHaveStarted = true; await this.io.removeLocal(o.baseHash, this.guard); }
        this.guard(); o.receipt = { id: o.id, owner: o.owner, intent: o.intent, status };
        if (![200,204].includes(status)) {
          o.phase = "rejected"; await this.ledger.save(o);
          return { status: status === 412 || status === 404 ? "pending" : "failed", reason: `delete-rejected-${status}` };
        }
      } else o.receipt = { id: o.id, owner: o.owner, intent: o.intent, status: 204 };
      o.phase = "acknowledged"; await this.ledger.save(o);
      return await this.finish(o);
    } catch (e) {
      if (operation?.phase === "dispatched" && !mutationMayHaveStarted) {
        // This owner observed that the transport dispatch callback was never invoked.
        // A read/version failure here is not an uncertain DELETE result.
        this.guard(); operation.phase = "rediscover"; await this.ledger.save(operation);
      }
      return { status: this.journal.blocked() ? "blocked-unknown-write" : e instanceof SyncConflict ? "pending" : "failed",
        reason: e instanceof Error ? e.message : "deletion-failed" };
    }
  }
  async finish(o: DeleteOperation): Promise<ContentOutcome> {
    this.guard(); if (o.phase !== "acknowledged" || o.path !== this.io.path || o.scope !== this.io.scope || o.endpoint !== this.io.endpoint)
      throw new Error("invalid-delete-finish");
    const stored = (await this.ledger.list()).find(x => x.id === o.id); this.guard();
    if (JSON.stringify(stored) !== JSON.stringify(o)) throw new Error("unbound-delete-completion");
    // No replay here. Exact completion authorizes record finalization, not a new deletion.
    await this.io.assertDeletionEvidence(true); this.guard();
    const l = await this.io.readLocal(), r = await this.io.readRemote(); this.guard();
    if (l || r) { o.phase = "rediscover"; await this.ledger.save(o); this.io.requestRerun(); return { status: "pending", reason: "path-recreated-after-delete" }; }
    const c = await this.io.checkpoint(); this.guard();
    if (c.commitId !== o.id) {
      if (c.generation !== o.previous.generation) { o.phase = "rediscover"; await this.ledger.save(o); return { status: "pending", reason: "delete-record-generation-changed" }; }
      await this.io.commitDeleted(c.generation, { ...o.previous.content!, status: "deleted", cleanBaseRef: undefined }, o.id, this.guard); this.guard();
    } else if (c.content?.status !== "deleted" || c.content.scopeKey !== o.scope || c.content.cleanBaseRef !== undefined || c.content.localHash !== o.baseHash || c.content.remoteHash !== o.baseHash)
      throw new Error("invalid-delete-commit-proof");
    const saved = await this.io.checkpoint(); this.guard();
    if (saved.commitId !== o.id || saved.content?.status !== "deleted") throw new Error("delete-commit-readback-failed");
    o.phase = "committed"; await this.ledger.save(o);
    return { status: "converged", reason: "verified-delete-commit", operation: o.id };
  }
}
