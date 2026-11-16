import { nanoid } from "nanoid";
import type { Entity } from "../../baseTypes";
import type { FakeFs } from "../../fsAll";
import type { IdbConnectionPool, IdbStore } from "../../idbStore";
import type { NextclawSyncRecord } from "../../localdb";
import { decodeRecord, inConfig, name, observation } from "../engine/model";
import { equalBytes, etagHeader, isOrdinaryMovePath, isStrongMoveEtag, sameVersion, SyncConflict } from "../engine/versionGuard";
import { NativeWritePaused, type NativeWriteJournal, terminalReceipt } from "../nativeWriteJournal";
import { isHash, localSnapshot, remoteSnapshot, scopeKey, validContentRecord } from "./identity";
import { contentCommitKey } from "./repository";
import { ContentStore, type BodyObject } from "./store";

type MoveStage = {
  version: 1; scope: string; id: string; owner: string; rootId: string;
  source: string; target: string; sourceGeneration: string;
  sourceEtag: string; fileId: string; hash: string; targetBase: string;
  sourceCommitId?: string;
} & ({ phase: "dispatched" | "not-dispatched" } | { phase: "acknowledged" | "committed"; status: 201 } |
  { phase: "rejected"; status: number });

type MoveOptions = {
  pool: IdbConnectionPool; records: IdbStore; history: IdbStore;
  vault: string; profile: string; configDir: string; rootId: string;
  journal: NativeWriteJournal; assertActive: () => void;
  local: Pick<FakeFs, "stat" | "readFile">;
  remote: Pick<FakeFs, "contentBinding" | "stat" | "readFile" | "moveContent">;
};

export const contentMoveKey = (scope: string) => JSON.stringify(["nextclaw-content-move", 1, scope]);
export class MoveTargetOccupied extends SyncConflict {
  constructor() { super("move-target-occupied"); }
}
function rejectedMove(status: number) {
  return status !== 201 && status !== 204 && terminalReceipt("MOVE", status);
}
export function isFinishedMove(stage: unknown, scope: string) {
  return validStage(stage, scope) &&
    (stage.phase === "committed" || stage.phase === "rejected" || stage.phase === "not-dispatched");
}
export function acknowledgedMove(stage: unknown, scope: string) {
  if (validStage(stage, scope) && stage.phase === "acknowledged")
    return { id: stage.id, source: stage.source, target: stage.target, targetBase: stage.targetBase };
}
export function committedMove(stage: unknown, scope: string) {
  if (validStage(stage, scope) && stage.phase === "committed") return stage;
}
function validStage(value: unknown, scope: string): value is MoveStage {
  if (!value || typeof value !== "object") return false;
  const stage = value as MoveStage;
  return stage.version === 1 && stage.scope === scope &&
    [stage.id, stage.owner, stage.rootId, stage.fileId, stage.targetBase, stage.sourceGeneration]
      .every(value => typeof value === "string" && value.length > 0) &&
    (stage.sourceCommitId === undefined || typeof stage.sourceCommitId === "string" && !!stage.sourceCommitId) &&
    [stage.source, stage.target].every(path => typeof path === "string" && isOrdinaryMovePath(path)) &&
    stage.source.toLowerCase() !== stage.target.toLowerCase() && isHash(stage.hash) && isStrongMoveEtag(stage.sourceEtag) &&
    (stage.phase === "dispatched" || stage.phase === "not-dispatched" ||
      (stage.phase === "committed" || stage.phase === "acknowledged") && stage.status === 201 ||
      stage.phase === "rejected" && rejectedMove(stage.status));
}

/** Executes a verified local rename toward WebDAV. Discovery supplies the two paths. */
export class ContentMove {
  readonly scope: string;
  private readonly store: ContentStore;
  private readonly key: string;

  constructor(private readonly o: MoveOptions) {
    if (o.records.dbName !== o.history.dbName || o.records.storeName === o.history.storeName ||
        !o.rootId || o.vault.includes("\t") || o.profile.includes("\t")) throw new Error("invalid-move-scope");
    this.scope = this.currentScope();
    this.key = contentMoveKey(this.scope);
    this.store = new ContentStore(o.history, this.scope, this.guard);
  }

  private currentScope() {
    const binding = this.o.remote.contentBinding();
    if (!binding.nativeManaged || binding.journalToken !== this.o.journal.token) throw new NativeWritePaused();
    return scopeKey({ ...binding, vault: this.o.vault, profile: this.o.profile,
      configDir: this.o.configDir, filterVersion: 1 });
  }

  private guard = () => {
    this.o.assertActive();
    if (this.o.journal.blocked()) throw new NativeWritePaused();
    if (this.currentScope() !== this.scope) throw new SyncConflict("move-scope-changed");
  };

  private recordKey(path: string) { return [this.o.vault, this.o.profile, path].join("\t"); }

  private checkPaths(source: string, target: string) {
    if (![source, target].every(path => isOrdinaryMovePath(path) &&
        !inConfig(path.toLowerCase(), this.o.configDir.toLowerCase())) ||
        source.toLowerCase() === target.toLowerCase()) throw new SyncConflict("invalid-move-paths");
  }

  private async checkRoot() {
    this.guard();
    const root = await this.o.remote.stat("/");
    this.guard();
    if (name(root) !== "/" || root.remoteFileId !== this.o.rootId) throw new SyncConflict("move-root-changed");
  }

  private async stat(side: "local" | "remote", path: string) {
    this.guard();
    try {
      const entity = await this.o[side].stat(path);
      this.guard();
      if (name(entity) !== path) throw new SyncConflict("move-path-changed");
      return entity;
    } catch (error) {
      this.guard();
      const err = error as { code?: string; status?: number };
      if (side === "local" ? err.code === "ENOENT" : err.status === 404) return undefined;
      throw error;
    }
  }

  private async checkRemoteIdentity(path: string, expected: Entity) {
    const current = await this.stat("remote", path);
    if (!current || current.remoteFileId !== expected.remoteFileId || !sameVersion(expected, current))
      throw new SyncConflict("move-remote-identity-changed");
  }

  /** Checks the durable stage and both generations in the same transaction as the update. */
  private async update(stage: MoveStage, previous: MoveStage | null, commit?: {
    local: Entity; remote: Entity; body: BodyObject;
  }, current?: () => boolean) {
    const { pool, records, history } = this.o;
    this.guard();
    const db = await pool.database(records.dbName, [records.storeName, history.storeName]);
    this.guard();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([records.storeName, history.storeName], "readwrite", { durability: "strict" });
      let error: unknown;
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the original transaction failure.
      tx.onabort = tx.onerror = () => reject(error ?? tx.error ?? new Error("move-transaction-failed"));
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the original ownership error.
      tx.oncomplete = () => { try { this.guard(); resolve(); } catch (e) { reject(e); } };
      const index = tx.objectStore(records.storeName), ledger = tx.objectStore(history.storeName);
      const from = this.recordKey(stage.source), to = this.recordKey(stage.target);
      const fromCommit = contentCommitKey(this.scope, from), toCommit = contentCommitKey(this.scope, to);
      const stored = ledger.get(this.key), source = index.get(from), target = index.get(to);
      const oldCommit = ledger.get(fromCommit), targetCommit = ledger.get(toCommit);
      const body = ledger.get(stage.targetBase);
      const reads = [stored, source, target, oldCommit, targetCommit, body];
      let remaining = reads.length;
      for (const request of reads) request.onsuccess = () => {
        if (--remaining) return;
        try {
          this.guard();
          if (current && !current()) throw new SyncConflict("move-intent-changed");
          if (JSON.stringify(stored.result ?? null) !== JSON.stringify(previous)) throw new SyncConflict("move-stage-changed");
          // An in-flight receipt belongs to the persisted dispatch even if newer observations
          // prevent committing the two paths. Record the receipt before checking those observations.
          if (stage.phase === "committed" || stage.phase === "dispatched") {
            if (JSON.stringify([source.result ?? null, oldCommit.result ?? null]) !== stage.sourceGeneration ||
                target.result !== undefined || targetCommit.result !== undefined)
              throw new SyncConflict("move-index-generation-changed");
          }
          if (commit) {
            const fromRecord = decodeRecord(source.result)!;
            const dst = body.result as BodyObject | undefined;
            if (!dst || dst.version !== 1 || dst.path !== stage.target || dst.scope !== this.scope ||
                dst.generation !== commit.body.generation || dst.kind !== "clean-base" || dst.hash !== stage.hash ||
                !(dst.bytes instanceof ArrayBuffer) || !equalBytes(dst.bytes, commit.body.bytes))
              throw new SyncConflict("move-base-changed");
            const next: NextclawSyncRecord = {
              v: 1, key: stage.target, keyRaw: stage.target, isFolder: false, sizeRaw: commit.local.sizeRaw,
              local: observation(commit.local, "local"), remote: observation(commit.remote, "remote"),
              content: { ...fromRecord.content!, cleanBaseRef: stage.targetBase,
                remoteEtag: commit.remote.etag, remoteFileId: stage.fileId },
            };
            index.delete(from);
            ledger.delete(fromCommit);
            index.add(next, to);
            ledger.add({ version: 1, id: stage.id }, toCommit);
          }
          ledger.put(stage, this.key);
        } catch (e) { error = e; tx.abort(); }
      };
    });
  }

  async send(source: string, target: string, current: () => boolean = () => true): Promise<{ id: string; status: number }> {
    this.guard();
    this.checkPaths(source, target);
    const previous = await this.o.history.getItem<MoveStage>(this.key);
    if (previous !== null && !isFinishedMove(previous, this.scope)) throw new NativeWritePaused();
    const key = this.recordKey(source);
    const raw = await this.o.records.getItem<NextclawSyncRecord>(key);
    const aux = await this.o.history.getItem<{ version: number; id: string }>(contentCommitKey(this.scope, key));
    const record = decodeRecord(raw);
    const content = record?.content;
    if (record?.key !== source || record.isFolder || record.pendingLocalUpload ||
        !validContentRecord(content) || content.scopeKey !== this.scope || content.status !== "clean" ||
        !content.localHash || content.localHash !== content.remoteHash || !content.cleanBaseRef ||
        !content.remoteFileId || !content.remoteEtag ||
        content.conflictRef || content.operationRef || content.acknowledgedUploadRef ||
        aux && (aux.version !== 1 || typeof aux.id !== "string")) throw new SyncConflict("move-source-not-clean");
    const base = await this.store.read(content.cleanBaseRef, source);
    if (base.kind !== "clean-base" || base.hash !== content.localHash) throw new SyncConflict("move-source-base-mismatch");
    await this.checkRoot();
    const local = await this.stat("local", target), remote = await this.stat("remote", source);
    if (!local || !remote || await this.stat("local", source) ||
        remote.remoteFileId !== content.remoteFileId) throw new SyncConflict("move-precondition-changed");
    if (await this.stat("remote", target)) throw new MoveTargetOccupied();
    const etag = etagHeader(remote);
    if (!isStrongMoveEtag(etag) || etag !== etagHeader({ ...remote, etag: content.remoteEtag }))
      throw new SyncConflict("move-source-version-changed");
    const localProof = await localSnapshot(this.o.local, target, local, this.guard);
    const remoteProof = await remoteSnapshot(this.o.remote, source, remote, this.guard);
    if (localProof.hash !== base.hash || remoteProof.hash !== base.hash) throw new SyncConflict("move-source-content-changed");
    const targetBase = await this.store.prepareBase(target, localProof.bytes, remoteProof.bytes);
    await this.checkRoot();
    await this.checkRemoteIdentity(source, remote);
    const stage: MoveStage = { version: 1, scope: this.scope, id: nanoid(), owner: this.o.journal.token,
      rootId: this.o.rootId, source, target, sourceGeneration: JSON.stringify([raw, aux]),
      sourceEtag: etag, fileId: content.remoteFileId, hash: base.hash, targetBase, phase: "dispatched" };
    if (aux?.id) stage.sourceCommitId = aux.id;
    await this.update(stage, previous, undefined, current);
    if (!current()) {
      await this.update({ ...stage, phase: "not-dispatched" }, stage);
      throw new SyncConflict("move-intent-changed");
    }
    try {
      this.guard();
      const { status } = await this.o.remote.moveContent(source, target, etag);
      if (status === 201) await this.update({ ...stage, phase: "acknowledged", status }, stage);
      else if (rejectedMove(status)) await this.update({ ...stage, phase: "rejected", status }, stage);
      else throw new NativeWritePaused();
      if (status !== 412) return { id: stage.id, status };
    } catch (error) {
      if (error instanceof NativeWritePaused) throw error;
      throw Object.assign(new NativeWritePaused(), { cause: error });
    }
    // A 412 can also mean the source changed. Only an observed target is a collision.
    if (await this.stat("remote", target)) throw new MoveTargetOccupied();
    return { id: stage.id, status: 412 };
  }

  async rejectedPrecondition() {
    this.guard();
    const stage = await this.o.history.getItem<MoveStage>(this.key);
    this.guard();
    if (validStage(stage, this.scope) && stage.rootId === this.o.rootId &&
        stage.phase === "rejected" && stage.status === 412) return stage;
  }

  async pendingCommit() {
    this.guard();
    const stage = await this.o.history.getItem<MoveStage>(this.key);
    this.guard();
    if (stage === null || isFinishedMove(stage, this.scope)) return undefined;
    if (!validStage(stage, this.scope) || stage.rootId !== this.o.rootId ||
        stage.phase !== "acknowledged") throw new NativeWritePaused();
    return acknowledgedMove(stage, this.scope);
  }

  async finish(id: string) {
    this.guard();
    const stage = await this.o.history.getItem<MoveStage>(this.key);
    if (!validStage(stage, this.scope) || stage.id !== id || stage.rootId !== this.o.rootId)
      throw new SyncConflict("move-receipt-not-bound");
    if (stage.phase === "committed" && stage.status === 201) return;
    if (stage.phase !== "acknowledged" || stage.status !== 201) throw new NativeWritePaused();
    this.checkPaths(stage.source, stage.target);
    const body = await this.store.read(stage.targetBase, stage.target);
    if (body.kind !== "clean-base" || body.hash !== stage.hash) throw new SyncConflict("move-base-changed");
    await this.checkRoot();
    const local = await this.stat("local", stage.target), remote = await this.stat("remote", stage.target);
    if (!local || !remote || remote.remoteFileId !== stage.fileId ||
        await this.stat("local", stage.source) || await this.stat("remote", stage.source))
      throw new SyncConflict("move-postcondition-changed");
    if (!isStrongMoveEtag(etagHeader(remote))) throw new SyncConflict("move-target-version-invalid");
    const localProof = await localSnapshot(this.o.local, stage.target, local, this.guard);
    const remoteProof = await remoteSnapshot(this.o.remote, stage.target, remote, this.guard);
    if (localProof.hash !== stage.hash || remoteProof.hash !== stage.hash) throw new SyncConflict("move-target-content-changed");
    await this.checkRemoteIdentity(stage.target, remote);
    await this.update({ ...stage, phase: "committed" }, stage, { local, remote, body });
  }
}
