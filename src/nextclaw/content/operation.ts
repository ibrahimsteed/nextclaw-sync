import { probeEvent, probeSpan } from "./probeTrace";
import { nanoid } from "nanoid";
import { inConfig } from "../engine/model";
import { SyncConflict } from "../engine/versionGuard";
import { NativeWriteJournal } from "../nativeWriteJournal";
import { hashBytes, type ContentRecord } from "./identity";
import { strongEtag, type ConflictRegistration } from "./migration";
import { mergeContent } from "./merge";
import { ContentStore, isAttachmentRef, type ContentReservation } from "./store";
import type { ContentPlan } from "./decision";
import { markerState } from "./markers";

export interface ContentView { bytes: ArrayBuffer; etag?: string; remoteFileId?: string; }
type VerifiedView = ContentView & { hash: string };
/** Adapter must atomically compare the generation and patch the existing record, retaining metadata. */
export interface Checkpoint {
  generation: string; content?: ContentRecord; pendingLocalUpload: boolean; commitId?: string;
}
export interface ContentIO {
  readonly nativeManaged?: boolean;
  readonly scope: string; readonly path: string; readonly endpoint: string;
  readLocal(): Promise<ContentView | undefined>;
  readRemote(): Promise<ContentView | undefined>;
  putRemote(bytes: ArrayBuffer, expectedEtag: string | null): Promise<{ status: number; etag?: string }>;
  /** Adapter checks hash/existence AND assertCurrent at replacement after its own awaits. */
  writeLocal(bytes: ArrayBuffer, expectedHash: string | undefined, assertCurrent: () => void): Promise<void>;
  checkpoint(): Promise<Checkpoint>;
  commit(expectedGeneration: string, content: ContentRecord, pendingLocalUpload: boolean, commitId: string, assertCurrent: () => void): Promise<void>;
  requestRerun(): void;
}
type Phase = "inputs-durable" | "remote-dispatched" | "remote-acknowledged" | "local-verified" | "committed" | "rejected" | "rediscover" | "archived";
export interface ContentOperation {
  version: 1; id: string; scope: string; path: string; owner: string; phase: Phase;
  intentHash: string;
  retiredBy?: string;
  dispatchStarted: boolean;
  supersedes?: string[];
  rejection?: { operation: string; intentHash: string; status: number };
  action: ContentPlan["action"]; previous: Checkpoint;
  localRef?: string; remoteRef?: string; baseRef?: string; outputRef: string;
  localHash?: string; remoteHash?: string; outputHash: string; expectedEtag?: string;
  attachmentFileId?: string;
  outputKind: "clean" | "conflict"; originalUpload: boolean;
  receipt?: { intentHash: string; operation: string; owner: string; outputHash: string; expectedEtag?: string; status: number; etag: string };
  conflict?: ConflictRegistration;
}
/** Persistent repository must enumerate all operations for this scope, including across loads. */
export interface OperationRepository {
  list(scope: string): Promise<ContentOperation[]>;
  get(id: string): Promise<ContentOperation | undefined>;
  put(value: ContentOperation): Promise<void>;
}
export interface ContentOutcome { status: "converged" | "content-conflict" | "pending" | "failed" | "blocked-unknown-write"; reason: string; operation?: string; }
export interface InitialDownloadGroup {
  readonly priorOperations: readonly ContentOperation[];
  readonly reservation: ContentReservation;
  writeLocal(work: () => Promise<void>): Promise<void>;
}
type ScopeLock = { group?: InitialDownloadGroup; paths: Set<string> };
const active = new WeakMap<NativeWriteJournal, Map<string, ScopeLock>>();
const serialized = (x: unknown) => JSON.stringify(x);
const success = (status: number) => [200, 201, 204].includes(status);
export const operationIntentHash = (o: ContentOperation) => hashBytes(new TextEncoder().encode(JSON.stringify([
  o.version, o.id, o.scope, o.path, o.owner, o.action, o.previous, o.localRef, o.remoteRef,
  o.baseRef, o.outputRef, o.localHash, o.remoteHash, o.outputHash, o.expectedEtag, o.outputKind, o.originalUpload, o.supersedes ?? [],
  ...(o.attachmentFileId === undefined ? [] : [o.attachmentFileId]),
])).buffer);
const settled = (o: ContentOperation) => ["committed", "rejected", "rediscover", "archived"].includes(o.phase);
/** Default B content executor; never exposes a journal unlock. */
export class ContentExecutor {
  constructor(private readonly scope: string, private readonly path: string, private readonly bodies: ContentStore,
    private readonly operations: OperationRepository, private readonly io: ContentIO,
    private readonly journal: NativeWriteJournal, private readonly endpoint: string,
    private readonly ownerActive: () => boolean, configDir: string,
    private readonly prefetchedDownload?: ContentView) {
    if (!scope || !configDir || !path || path.endsWith("/") || path.split("/").some(x => !x || x === "." || x === "..") ||
      inConfig(path, configDir) || io.scope !== scope || io.path !== path || io.endpoint !== endpoint ||
      !["https:", "http:"].includes(new URL(endpoint).protocol) || bodies.scope !== scope || new URL(endpoint).search || new URL(endpoint).hash ||
      new URL(endpoint).username || new URL(endpoint).password) throw new Error("Invalid content executor binding");
  }
  private guard() {
    if (!this.ownerActive()) throw new Error("retired-owner-no-write");
    if (this.journal.blocked()) throw new Error("retain-native-journal");
  }
  private async view(side: "local" | "remote", prefetched?: ContentView): Promise<VerifiedView | undefined> {
    this.guard(); const v = await (side === "local" ? this.io.readLocal() : prefetched ?? this.io.readRemote()); this.guard();
    if (!v) return;
    if (v.bytes.byteLength > this.bodies.fileLimit) throw new Error("content-limit-pending");
    const bytes = v.bytes.slice(0), etag = v.etag, hash = await hashBytes(bytes); this.guard();
    if (side === "remote" && !strongEtag(etag)) throw new Error("strong-remote-version-required");
    return { bytes, hash, etag, remoteFileId: v.remoteFileId };
  }
  private async save(o: ContentOperation) {
    this.guard(); await this.operations.put(structuredClone(o)); this.guard();
    if (serialized(await this.operations.get(o.id)) !== serialized(o)) throw new Error("operation-readback-failed");
    this.guard();
  }
  private async publish(generation: string, content: ContentRecord, pending: boolean, id: string) {
    this.guard(); await this.io.commit(generation, content, pending, id, () => this.guard()); this.guard();
    const saved = await probeSpan(this.path, "checkpoint-readback", () => this.io.checkpoint()); this.guard();
    if (saved.commitId !== id || saved.generation === generation || saved.pendingLocalUpload !== pending ||
      serialized(saved.content) !== serialized(content)) throw new Error("record-commit-readback-failed");
    probeEvent(this.path, "checkpoint-readback-verified");
  }
  private async exclusive(work: () => Promise<ContentOutcome>, group?: InitialDownloadGroup): Promise<ContentOutcome> {
    const locks = active.get(this.journal) ?? new Map<string, ScopeLock>();
    const current = locks.get(this.scope);
    if (current && (!group || current.group !== group || current.paths.has(this.path)))
      return { status: "pending", reason: "content-owner-busy" };
    const lock = current ?? { group, paths: new Set<string>() };
    lock.paths.add(this.path);
    locks.set(this.scope, lock);
    active.set(this.journal, locks);
    try { this.guard(); return await work(); }
    catch (e) {
      return { status: !this.ownerActive() ? "pending" : this.journal.blocked() ? "blocked-unknown-write" :
        e instanceof SyncConflict || (e instanceof Error &&
          ["content-limit-pending", "attachment-storage-quota-pending"].includes(e.message)) ? "pending" : "failed",
        reason: e instanceof Error ? e.message : "content-operation-failed" };
    } finally {
      lock.paths.delete(this.path);
      if (!lock.paths.size) locks.delete(this.scope);
      if (!locks.size) active.delete(this.journal);
    }
  }
  async execute(plan: ContentPlan, group?: InitialDownloadGroup): Promise<ContentOutcome> {
    if (this.bodies.attachment && (!group || plan.action !== "download-create"))
      return { status: "pending", reason: "attachment-import-create-only" };
    if (group && (!this.prefetchedDownload || plan.action !== "download-create" ||
      plan.expected?.localHash !== undefined || plan.expected?.baseRef !== undefined))
      return { status: "pending", reason: "initial-download-admission-changed" };
    return this.exclusive(async () => {
      if (!plan.expected || plan.expected.scope !== this.scope || plan.expected.path !== this.path ||
        !["prepare-base", "upload", "upload-create", "download", "download-create", "merge-three-way", "conflict-two-way", "resolve-local"].includes(plan.action))
        return { status: "pending", reason: "non-executable-content-plan" };
      const previousOperations = group?.priorOperations ?? await this.operations.list(this.scope); this.guard();
      if (previousOperations.some(o => o.version !== 1 || o.scope !== this.scope || !o.id || !o.owner))
        throw new Error("invalid-operation-collection");
      if (previousOperations.some(o => !settled(o))) return { status: "pending", reason: "keep-unconfirmed-stage" };
      const local = await this.view("local");
      const prefetched = plan.action === "download-create" && !local && !plan.expected.baseRef
        ? this.prefetchedDownload : undefined;
      const remote = await this.view("remote", prefetched);
      if (this.bodies.attachment && !remote?.remoteFileId)
        return { status: "pending", reason: "attachment-identity-missing" };
      if (local?.hash !== plan.expected.localHash || remote?.hash !== plan.expected.remoteHash || remote?.etag !== plan.expected.remoteEtag)
        return { status: "pending", reason: "rediscover-actual-bytes" };
      const previous = structuredClone(await this.io.checkpoint()); this.guard();
      if (previous.content && previous.content.scopeKey !== this.scope) throw new Error("checkpoint-scope-mismatch");
      if (group && (local || previous.content || previous.commitId || previous.pendingLocalUpload))
        return { status: "pending", reason: "initial-download-admission-changed" };
      if (previous.content?.cleanBaseRef !== plan.expected.baseRef || previous.content?.conflictRef !== plan.expected.conflictRef)
        return { status: "pending", reason: "record-generation-changed" };
      const base = plan.expected.baseRef ? await this.bodies.read(plan.expected.baseRef, this.path) : undefined; this.guard();
      if (base && base.kind !== "clean-base") throw new Error("invalid-operation-base");
      const merge = ["merge-three-way", "conflict-two-way"].includes(plan.action)
        ? mergeContent(plan.action === "conflict-two-way" ? undefined : base?.bytes, local!.bytes, remote!.bytes)
        : { kind: "clean" as const, bytes: (plan.action.startsWith("download") ? remote!.bytes : local!.bytes).slice(0) };
      if (merge.kind === "pending") return { status: "pending", reason: merge.reason };
      const outputMarkers = markerState(merge.bytes);
      if (merge.kind === "clean" && outputMarkers !== "clear" &&
        !(outputMarkers === "binary" && !this.path.toLowerCase().endsWith(".md"))) return { status: "pending", reason: "unresolved-marker" };
      // Includes input copies, output and the verified clean base; no partial input
      // staging or local replacement when the complete operation cannot fit.
      const required = (local?.bytes.byteLength ?? 0) + (remote?.bytes.byteLength ?? 0) +
        merge.bytes.byteLength * (merge.kind === "clean" ? 2 : 1);
      if (group) this.bodies.checkReservedCapacity(this.path, required, group.reservation);
      else await this.bodies.ensureCapacity(required);
      this.guard();
      const put = (v: typeof local) => v ? this.bodies.put(this.path, v.bytes, "merge-input", group?.reservation) : undefined;
      const localRef = await put(local); this.guard(); const remoteRef = await put(remote); this.guard();
      const outputRef = await this.bodies.put(this.path, merge.bytes, "merge-input", group?.reservation); this.guard();
      const operation: ContentOperation = { version: 1, id: nanoid(), scope: this.scope, path: this.path,
        supersedes: previousOperations.filter(o => o.path === this.path && settled(o)).map(o => o.id),
        owner: this.journal.token, intentHash: "", dispatchStarted: false, phase: "inputs-durable", action: plan.action, previous, localRef, remoteRef,
        baseRef: previous.content?.status === "deleted" ? undefined : plan.expected.baseRef, outputRef, localHash: local?.hash, remoteHash: remote?.hash,
        outputHash: await hashBytes(merge.bytes), expectedEtag: remote?.etag, outputKind: merge.kind,
        ...(this.bodies.attachment ? { attachmentFileId: remote!.remoteFileId } : {}),
        originalUpload: ["upload", "upload-create", "resolve-local"].includes(plan.action) };
      operation.intentHash = await operationIntentHash(operation); this.guard();
      await this.save(operation);
      // Recheck after durable input storage. The conditional PUT closes the remote race.
      if ((await this.view("local"))?.hash !== local?.hash) {
        operation.phase = "rediscover"; await this.save(operation);
        return { status: "pending", reason: "local-cas-reject", operation: operation.id };
      }
      if (!["download", "download-create", "prepare-base"].includes(plan.action)) {
        operation.dispatchStarted = true; operation.phase = "remote-dispatched"; await this.save(operation);
        const dispatch = () => { this.guard(); return this.io.putRemote(merge.bytes.slice(0), remote?.etag ?? null); };
        const receipt = this.io.nativeManaged ? await dispatch() :
          await this.journal.send("PUT", this.endpoint, remote?.etag ?? null, dispatch);
        this.guard();
        if (!success(receipt.status)) {
          operation.rejection = { operation: operation.id, intentHash: operation.intentHash, status: receipt.status };
          operation.phase = "rejected"; await this.save(operation);
          return { status: receipt.status === 412 ? "pending" : "failed", reason: `remote-rejected-${receipt.status}`, operation: operation.id };
        }
        if (!strongEtag(receipt.etag)) throw new Error("acknowledged-write-without-version");
        operation.receipt = { intentHash: operation.intentHash, operation: operation.id, owner: operation.owner, outputHash: operation.outputHash,
          expectedEtag: operation.expectedEtag, status: receipt.status, etag: receipt.etag };
        operation.phase = "remote-acknowledged"; await this.save(operation);
      } else { operation.phase = "local-verified"; await this.save(operation); }
      return this.complete(operation, prefetched ? remote : undefined, group);
    }, group);
  }
  /** No dispatch/replay here. Incomplete dispatched stages remain pending even when reads match. */
  async finish(id: string): Promise<ContentOutcome> {
    return this.exclusive(async () => {
      const operation = structuredClone(await this.operations.get(id)); this.guard();
      if (!operation || operation.version !== 1 || operation.scope !== this.scope || operation.path !== this.path)
        throw new Error("invalid-operation-binding");
      if (!["remote-acknowledged", "local-verified"].includes(operation.phase))
        return { status: "pending", reason: "keep-unconfirmed-stage", operation: id };
      return this.complete(operation);
    });
  }
  private async complete(o: ContentOperation, prefetched?: VerifiedView, group?: InitialDownloadGroup): Promise<ContentOutcome> {
    if (o.intentHash !== await operationIntentHash(o)) throw new Error("invalid-operation-intent");
    this.guard();
    if (o.scope !== this.scope || o.path !== this.path || !o.id || !o.owner ||
      o.originalUpload !== ["upload", "upload-create", "resolve-local"].includes(o.action) ||
      !["clean", "conflict"].includes(o.outputKind)) throw new Error("invalid-operation-binding");
    if (isAttachmentRef(o.outputRef) ?
        !this.bodies.attachment || typeof o.attachmentFileId !== "string" || !o.attachmentFileId || o.action !== "download-create" :
        o.attachmentFileId !== undefined || this.bodies.attachment) throw new Error("invalid-attachment-operation");
    for (const [ref, hash] of [[o.localRef, o.localHash], [o.remoteRef, o.remoteHash]] as const) {
      if ((ref === undefined) !== (hash === undefined)) throw new Error("invalid-operation-input");
      if (ref) {
        const body = await this.bodies.read(ref, this.path); this.guard();
        if (body.hash !== hash || body.kind !== "merge-input") throw new Error("invalid-operation-input");
      }
    }
    const sendsRemote = !["download", "download-create", "prepare-base"].includes(o.action);
    if (sendsRemote && (!o.receipt || o.receipt.intentHash !== o.intentHash || o.receipt.operation !== o.id || o.receipt.owner !== o.owner ||
      o.receipt.outputHash !== o.outputHash || o.receipt.expectedEtag !== o.expectedEtag || !success(o.receipt.status) || !strongEtag(o.receipt.etag)))
      throw new Error("invalid-bound-completion");
    const output = await this.bodies.read(o.outputRef, this.path); this.guard();
    if (output.hash !== o.outputHash || output.kind !== "merge-input") throw new Error("invalid-operation-output");
    const remote = prefetched ?? await this.view("remote"), local = await this.view("local");
    const expectedEtag = sendsRemote ? o.receipt!.etag : o.expectedEtag;
    if (remote?.hash !== output.hash || remote?.etag !== expectedEtag ||
        (o.attachmentFileId && o.attachmentFileId !== remote.remoteFileId)) {
      o.phase = "rediscover"; await this.save(o);
      return { status: "pending", reason: "remote-changed-after-ack", operation: o.id };
    }
    const checkpoint = await this.io.checkpoint(); this.guard();
    if (checkpoint.commitId === o.id) {
      if (checkpoint.content?.scopeKey !== this.scope || checkpoint.content.remoteHash !== output.hash ||
        checkpoint.content.remoteEtag !== expectedEtag ||
        (!checkpoint.pendingLocalUpload && (checkpoint.content.localHash !== output.hash ||
          checkpoint.content.status !== (o.outputKind === "clean" ? "clean" : "content-conflict"))))
        throw new Error("invalid-idempotent-commit");
      if (checkpoint.pendingLocalUpload) {
        if (checkpoint.content.acknowledgedUploadRef !== o.outputRef) throw new Error("invalid-idempotent-upload-ref");
      } else if (o.outputKind === "clean") {
        if (!checkpoint.content.cleanBaseRef) throw new Error("missing-idempotent-base");
        const base = await this.bodies.read(checkpoint.content.cleanBaseRef, this.path); this.guard();
        if (base.kind !== "clean-base" || base.hash !== output.hash) throw new Error("invalid-idempotent-base");
      } else if (checkpoint.content.conflictRef !== o.id || o.conflict?.confirmedMarkerHash !== output.hash)
        throw new Error("invalid-idempotent-conflict");
      o.phase = "committed"; await this.save(o);
      if (local?.hash !== output.hash) {
        this.io.requestRerun(); return { status: "pending", reason: "local-changed-after-commit", operation: o.id };
      }
      return { status: checkpoint.pendingLocalUpload ? "pending" : o.outputKind === "conflict" ? "content-conflict" : "converged", reason: "idempotent-record-commit", operation: o.id };
    }
    if (checkpoint.generation !== o.previous.generation) return { status: "pending", reason: "record-generation-changed", operation: o.id };
    if (local?.hash !== o.localHash && local?.hash !== output.hash) {
      if (!o.originalUpload) {
        o.phase = "rediscover"; await this.save(o);
        return { status: "pending", reason: "keep-inputs-and-stage-rediscover", operation: o.id };
      }
      const content: ContentRecord = { version: 1, scopeKey: this.scope,
        status: o.baseRef ? "clean" : "unbased", cleanBaseRef: o.baseRef,
        localHash: o.localHash, remoteHash: output.hash, remoteEtag: remote.etag, remoteFileId: remote.remoteFileId, acknowledgedUploadRef: o.outputRef };
      await this.publish(checkpoint.generation, content, true, o.id);
      o.phase = "committed"; await this.save(o); this.io.requestRerun();
      return { status: "pending", reason: "pendingLocalUpload-existing-rerun", operation: o.id };
    }
    if (local?.hash !== output.hash) {
      const publishLocal = () => {
        this.guard();
        return this.io.writeLocal(output.bytes.slice(0), o.localHash, () => this.guard());
      };
      if (group) await group.writeLocal(publishLocal);
      else await publishLocal();
      this.guard();
    }
    const current = await this.view("local"), verifiedRemote = prefetched ?? await this.view("remote");
    if (current?.hash !== output.hash || verifiedRemote?.hash !== output.hash || verifiedRemote.etag !== expectedEtag)
      return { status: "pending", reason: "rediscover-actual-bytes", operation: o.id };
    o.phase = "local-verified";
    let baseRef = o.baseRef;
    if (o.outputKind === "clean") baseRef = await this.bodies.prepareBase(this.path, current.bytes, verifiedRemote.bytes, group?.reservation);
    else {
      if (!o.localRef || !o.remoteRef) throw new Error("missing-conflict-inputs");
      o.conflict = { version: 1, id: o.id, scope: this.scope, path: this.path, format: "whole-document-v1",
        localInputRef: o.localRef, remoteInputRef: o.remoteRef, markerRef: o.outputRef,
        confirmedMarkerHash: output.hash, remoteEtag: verifiedRemote.etag! };
    }
    await this.save(o);
    const content: ContentRecord = { version: 1, scopeKey: this.scope, status: o.outputKind === "clean" ? "clean" : "content-conflict",
      cleanBaseRef: baseRef, conflictRef: o.conflict?.id, localHash: output.hash, remoteHash: output.hash, remoteEtag: verifiedRemote.etag, remoteFileId: verifiedRemote.remoteFileId };
    // The initial-download adapter verifies the bound version at the guarded
    // local write and again inside commit. Keep a fresh remote read after commit.
    if ((await this.view("local"))?.hash !== output.hash || (!prefetched && (await this.view("remote"))?.etag !== expectedEtag))
      return { status: "pending", reason: "changed-before-record-commit", operation: o.id };
    await this.publish(checkpoint.generation, content, false, o.id);
    o.phase = "committed"; await this.save(o);
    if ((await this.view("local"))?.hash !== output.hash || (await this.view("remote"))?.hash !== output.hash) {
      this.io.requestRerun(); return { status: "pending", reason: "changed-after-record-commit", operation: o.id };
    }
    return { status: o.outputKind === "clean" ? "converged" : "content-conflict", reason: "verified-record-commit", operation: o.id };
  }
}
