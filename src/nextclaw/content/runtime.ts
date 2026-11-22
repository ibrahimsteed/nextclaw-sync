import { probeSpan } from "./probeTrace";
import type { Entity } from "../../baseTypes";
import { getAllPrevSyncRecordsByVaultAndProfile, type InternalDBs, type NextclawSyncRecord } from "../../localdb";
import { RootReseed, checkRootStages, RootStagePaused } from "./rootReseed";
import { DeleteExecutor, DeletionLedger, type DeleteIO } from "./deletion";
import { inConfig } from "../engine/model";
import { NativeWritePaused } from "../nativeWriteJournal";
import { assertVersion, etagHeader, isStrongMoveEtag, sameVersion, SyncConflict } from "../engine/versionGuard";
import { decodeRecord, name, observation, type SyncInput } from "../engine/model";
import { scopeKey, localSnapshot, hashBytes, isAttachmentPath, matchesAttachmentSignature, type Snapshot } from "./identity";
import { loadContentHistory, strongEtag } from "./migration";
import type { ContentPlan } from "./decision";
import { ContentStore, MOBILE_CONTENT_LIMITS } from "./store";
import { IdbContentCheckpoint, TableOperationRepository } from "./repository";
import { ContentExecutor, type ContentView } from "./operation";
import { collectContent } from "./cleanup";
import { acknowledgedMove, committedMove, ContentMove, contentMoveKey, isFinishedMove } from "./move";
export class ContentStagePaused extends Error {
  constructor() { super("存在缺少明确完成回执的内容写入；同步已暂停，请保留现场"); }
}

type InitialDownload = ContentView & { version: Entity; etag: string };

function matchesDownloadVersion(expected: Entity, actual: Entity | undefined) {
  return !!actual && !!expected.remoteFileId && name(actual) === name(expected) &&
    actual.remoteFileId === expected.remoteFileId && actual.remoteChecksum === expected.remoteChecksum &&
    actual.etag === expected.etag && sameVersion(expected, actual);
}
export async function checkVaultStages(db: InternalDBs, vault: string, assertActive: () => void, moveScope?: () => string | undefined) {
  assertActive();
  try { await checkRootStages(db.fileContentHistoryTbl, vault, assertActive); }
  catch (e) { if (e instanceof RootStagePaused) throw new ContentStagePaused(); throw e; }
  const operationIds = new Map<string, Set<string>>();
  for (const key of await db.fileContentHistoryTbl.keys()) {
    assertActive(); let k: unknown;
    try { k = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(k)) continue;
    const parts: unknown[] = k;
    if (parts[0] === "nextclaw-content-move") {
      if (typeof parts[2] !== "string") throw new Error("invalid-move-stage-scope");
      const identity: unknown = JSON.parse(parts[2]);
      if (!Array.isArray(identity)) throw new Error("invalid-move-stage-scope");
      if (identity[0] !== vault) continue;
      if (key !== contentMoveKey(parts[2])) throw new Error("invalid-move-stage-key");
      const stage = await db.fileContentHistoryTbl.getItem<unknown>(key);
      assertActive();
      if (!isFinishedMove(stage, parts[2]) &&
          !(acknowledgedMove(stage, parts[2]) && moveScope?.() === parts[2])) throw new ContentStagePaused();
      continue;
    }
    if (!["nextclaw-content-operation", "nextclaw-content-deletion"].some(n => n === parts[0])) continue;
    if (typeof parts[2] !== "string") throw new Error("内容作用域无效");
    let scope: unknown;
    try { scope = JSON.parse(parts[2]); } catch { throw new Error("内容操作作用域损坏"); }
    if (!Array.isArray(scope) || scope[0] !== vault) continue;
    if (parts.length !== 4 || parts[1] !== 1 || typeof parts[3] !== "string") throw new Error("未知内容操作格式");
    if (k[0] === "nextclaw-content-deletion") {
      const entries = await new DeletionLedger(db.fileContentHistoryTbl, parts[2], assertActive).list(); assertActive();
      if (entries.some(o => o.phase === "dispatched")) throw new ContentStagePaused();
      continue;
    }
    const ids = operationIds.get(parts[2]) ?? new Set<string>();
    ids.add(parts[3]);
    operationIds.set(parts[2], ids);
  }
  for (const [scope, ids] of operationIds) {
    const rows = await new TableOperationRepository(db.fileContentHistoryTbl, scope, assertActive).list(scope);
    assertActive();
    for (const op of rows) {
      if (op.phase === "remote-dispatched") throw new ContentStagePaused();
      ids.delete(op.id);
    }
    if (ids.size) throw new ContentStagePaused();
  }
}
export async function assertContentResetSafe(db: InternalDBs, vault: string, assertActive: () => void) {
  await checkVaultStages(db, vault, assertActive);
  for (const key of await db.fileContentHistoryTbl.keys()) {
    assertActive(); let parts: unknown; try { parts = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(parts)) continue;
    const k: unknown[] = parts;
    if (!["nextclaw-content-deletion", "nextclaw-content-root"].some(n => n === k[0])) continue;
    if (typeof k[2] !== "string") throw new Error("invalid-reset-stage-scope");
    const identity: unknown = JSON.parse(k[2]); if (!Array.isArray(identity) || identity[0] !== vault) continue;
    const stage = await db.fileContentHistoryTbl.getItem<{ phase: string }>(key); assertActive();
    if (!stage || !["committed", "rediscover", "rejected", "complete"].includes(stage.phase)) throw new Error("存在未完成的删除或根恢复，暂不能切换或清除记录");
  }
  for (const [key, value] of Object.entries(await db.prevSyncRecordsTbl.getItems())) {
    assertActive(); if (!key.startsWith(vault + "\t")) continue;
    const r = value as NextclawSyncRecord;
    if (r.content && (r.pendingLocalUpload || r.content.status !== "clean" || r.content.conflictRef || r.content.operationRef))
      throw new Error("存在未完成的内容同步，暂不能切换或清除记录");
  }
}
export function contentScope(input: Pick<SyncInput, "fsRemote" | "vaultRandomID" | "profileID" | "configDir">) {
  return scopeKey({ vault: input.vaultRandomID, profile: input.profileID, ...input.fsRemote.contentBinding(),
    configDir: input.configDir, filterVersion: 1 });
}
export function contentRuntime(input: SyncInput) {
  const runtime = input.contentRuntime;
  if (!runtime) throw new Error("模式B缺少受保护内容运行环境；未退回旧同步策略");
  const guard = () => { runtime.assertActive(); if (runtime.journal.blocked()) throw new NativeWritePaused(); };
  guard(); if (input.fsRemote.kind !== "webdav") throw new Error("仅支持WebDAV内容同步");
  const binding = input.fsRemote.contentBinding();
  if (binding.journalToken !== runtime.journal.token) throw new Error("内容传输与原生登记owner不匹配");
  const scope = contentScope(input);
  const bodies = new ContentStore(input.db.fileContentHistoryTbl, scope, guard,
    input.mobileDailyContentBudget ? MOBILE_CONTENT_LIMITS : undefined);
  const attachments = bodies.attachmentStore();
  const operations = new TableOperationRepository(input.db.fileContentHistoryTbl, scope, guard);
  const rootReseed = new RootReseed(input.db.fileContentHistoryTbl, scope, input.fsRemote.contentEndpoint("/"), runtime.journal, guard);
  async function bindRoot(root: Entity) {
    guard(); if (name(root) !== "/") throw new Error("invalid-content-root-response");
    const id = root.remoteFileId, key = `content-root-identity:${scope}`;
    const previous = await input.db.simpleKVForMiscTbl.getItem<{ id: string }>(key); guard();
    if (previous && (typeof previous.id !== "string" || !previous.id)) throw new Error("invalid-root-identity");
    if (previous && previous.id !== id && !(await rootReseed.active())) throw new Error("content-root-identity-changed");
    guard(); if (id && previous?.id !== id && input.triggerSource !== "dry") {
      await input.db.simpleKVForMiscTbl.setItem(key, { id }); guard();
    }
  }
  async function ensureRoot(records: NextclawSyncRecord[]) {
    if ((await rootReseed.read())?.phase === "rejected") throw new Error("root-reseed-rejected-requires-review");
    try { const root = await input.fsRemote.stat("/"); guard(); await bindRoot(root); startRootEtag = root.etag; return root.remoteFileId; }
    catch (e) {
      guard(); const code = e as { status?: number; code?: string };
      if (code.status !== 404 || input.triggerSource === "dry") throw e;
    }
    if (acknowledgedMove(await input.db.fileContentHistoryTbl.getItem(contentMoveKey(scope)), scope))
      throw new SyncConflict("move-root-missing");
    guard();
    const candidates = records.filter(r => !r.isFolder && !inConfig(r.key, input.configDir));
    if (!candidates.length || candidates.some(r => r.content?.scopeKey !== scope || !["clean", "deleted"].includes(r.content.status) || r.pendingLocalUpload || r.content.conflictRef || r.content.operationRef))
      throw new Error("root-reseed-requires-bound-clean-scope");
    for (const r of candidates) {
      if (r.content?.status === "deleted") {
        const slot = await file(r.key).checkpoint.read(); guard();
        if (!(await deletions.list()).some(o => o.phase === "committed" && o.id === slot.commitId && o.path === r.key &&
          o.baseHash === r.content!.localHash && o.baseHash === r.content!.remoteHash)) throw new Error("root-reseed-missing-delete-proof");
        continue;
      }
      if (!r.content?.cleanBaseRef) throw new Error("root-reseed-missing-base-proof");
      const base = await bodies.read(r.content.cleanBaseRef, r.key); guard();
      if (base.kind !== "clean-base" || base.hash !== r.content.localHash || base.hash !== r.content.remoteHash)
        throw new Error("root-reseed-invalid-base-proof");
    }
    await input.fsRemote.checkContentRootParent(); guard();
    await rootReseed.restore(() => { guard(); return input.fsRemote.restoreContentRoot(); }, binding.nativeManaged);
    guard(); const root = await input.fsRemote.stat("/"); await bindRoot(root); startRootEtag = root.etag; guard(); return root.remoteFileId;
  }
  const deletions = new DeletionLedger(input.db.fileContentHistoryTbl, scope, guard);
  let startRootEtag: string | undefined;
  let manifestUnsafe = false;
  let manifestLocal: Entity[] = [], manifestRemote: Entity[] = [], manifestRecords: NextclawSyncRecord[] = [];
  const setManifest = (l: Entity[], r: Entity[], records: NextclawSyncRecord[], unsafe = false) => {
    manifestUnsafe = unsafe; manifestLocal = l; manifestRemote = r; manifestRecords = records;
  };
  const fresh = async (fs: SyncInput["fsLocal"], path: string) => {
    guard(); try { const e = await (fs.kind === "webdav" && !path.endsWith("/") ? probeSpan(path, "version", () => fs.stat(path)) : fs.stat(path)); guard(); return e; }
    catch (e) { guard(); const v = e as { code?: string; status?: number }; if ((fs.kind !== "webdav" && v.code === "ENOENT") || v.status === 404) return; throw e; }
  };
  async function deletionEvidence(path: string) {
    guard();
    if (scopeKey({ vault: input.vaultRandomID, profile: input.profileID, ...input.fsRemote.contentBinding(), configDir: input.configDir, filterVersion: 1 }) !== scope)
      throw new Error("deletion-scope-changed");
    await bindRoot(await input.fsRemote.stat("/")); guard();
    const current = await fresh(input.fsRemote, path); guard();
    const reseed = await rootReseed.active(); guard();
    if (!current) { manifestRemote = await input.fsRemote.walk(); guard(); }
    const previous = manifestRecords.find(r => r.key.normalize("NFC") === path)?.content;
    const known = new Set(manifestRecords.map(r => r.key.normalize("NFC")));
    const ordinary = (e: Entity) => !name(e).endsWith("/") && !inConfig(name(e), input.configDir);
    const local = await fresh(input.fsLocal, path); guard();
    if (!local) { manifestLocal = await input.fsLocal.walk(); guard(); }
    const holdKey = `content-delete-holds:${scope}`;
    const storedHolds = await input.db.simpleKVForMiscTbl.getItem<Record<string, string>>(holdKey) ?? {};
    guard(); if (typeof storedHolds !== "object" || Array.isArray(storedHolds) || Object.values(storedHolds).some(x => typeof x !== "string")) throw new Error("invalid-delete-holds");
    const holds: Record<string,string> = Object.assign(Object.create(null) as Record<string,string>, storedHolds);
    const movedId = !current && previous?.remoteFileId && manifestRemote.some(e => name(e) !== path && e.remoteFileId === previous.remoteFileId);
    const ambiguousNew = !local && manifestLocal.some(e => ordinary(e) && name(e) !== path && !known.has(name(e).normalize("NFC"))) ||
      (!current && !previous?.remoteFileId && manifestRemote.some(e => ordinary(e) && name(e) !== path && !known.has(name(e).normalize("NFC"))));
    if (movedId || ambiguousNew || (!current && previous?.status === "clean" && !previous.remoteFileId && !reseed) || (current && previous?.remoteFileId && current.remoteFileId && current.remoteFileId !== previous.remoteFileId)) {
      holds[path] = "suspected-file-move"; guard(); await input.db.simpleKVForMiscTbl.setItem(holdKey, holds); guard();
    }
    // Reappearance of both original paths removes the ambiguous deletion intent.
    if (local && current && holds[path]) { delete holds[path]; await input.db.simpleKVForMiscTbl.setItem(holdKey, holds); guard(); }
    return { confirmedMissing: current === undefined, suspectedMove: manifestUnsafe || !!holds[path], reseed };
  }
  function file(path: string, local?: Entity, remote?: Entity, initial?: InitialDownload, attachment = false) {
    const fileBodies = attachment ? attachments : bodies;
    let attachmentVersion = initial?.version;
    const lp = local ? name(local) : remote ? name(remote) : path;
    const rp = remote ? name(remote) : local ? name(local) : path;
    const endpoint = input.fsRemote.contentEndpoint(rp);
    const seed: NextclawSyncRecord = { ...(local ?? remote ?? { keyRaw: path, sizeRaw: 0 }), key: path,
      v: 1, isFolder: false, local: local ? observation(local, "local") : { mtime: 0, size: 0 },
      remote: remote ? observation(remote, "remote") : { mtime: 0, size: 0 } };
    const checkpoint = new IdbContentCheckpoint(runtime!.pool, input.db.prevSyncRecordsTbl, input.db.fileContentHistoryTbl,
      `${input.vaultRandomID}\t${input.profileID}\t${path}`, scope, seed, guard);
    async function readRemoteVersion(e: Entity, verify = () => assertVersion(input.fsRemote, rp, e)) {
      if ((e.size ?? e.sizeRaw) > fileBodies.fileLimit) throw new Error("content-limit-pending");
      const view = await probeSpan(path, "get", () => input.fsRemote.readContent(rp, e)); guard();
      if (view.bytes.byteLength > fileBodies.fileLimit)
        throw new Error(attachment ? "attachment-file-limit-pending" : "content-limit-pending");
      await verify(); guard();
      if (e.remoteChecksum && e.remoteChecksum !== await hashBytes(view.bytes)) throw new SyncConflict("远端正文校验和不匹配");
      if (attachment) attachmentVersion = e;
      guard(); return { ...view, remoteFileId: e.remoteFileId };
    }
    async function assertInitialVersion(version: Entity) {
      const current = await fresh(input.fsRemote, rp); guard();
      if (!matchesDownloadVersion(version, current))
        throw new SyncConflict("首次下载期间远端版本变化，待重新扫描");
    }
    async function prefetchInitialDownload(version: Entity): Promise<InitialDownload> {
      const download = await readRemoteVersion(version, () => assertInitialVersion(version));
      const { etag } = download;
      if (etag !== etagHeader(version) ||
          download.bytes.byteLength !== (version.size ?? version.sizeRaw))
        throw new SyncConflict("首次下载响应与清单版本不一致，待重新扫描");
      if (attachment && isAttachmentPath(path) && !matchesAttachmentSignature(path, download.bytes))
        throw new Error("attachment-signature-mismatch");
      return { ...download, etag, version };
    }
    async function cleanSavePlan(l: Snapshot, record: NextclawSyncRecord, before: Entity): Promise<ContentPlan | undefined> {
      const c = record.content;
      if (record.key !== path || name(l.entity) !== path || c?.scopeKey !== scope || c.status !== "clean" ||
        record.pendingLocalUpload || c.operationRef || c.conflictRef || c.acknowledgedUploadRef || !c.cleanBaseRef ||
        !c.remoteFileId || !isStrongMoveEtag(c.remoteEtag) || c.localHash !== l.hash || c.remoteHash !== l.hash) return;
      const matches = (e: Entity) => name(e) === path && e.remoteFileId === c.remoteFileId &&
        strongEtag(e.etag) && etagHeader(e) === c.remoteEtag && (e.size ?? e.sizeRaw) === l.bytes.byteLength &&
        (!e.remoteChecksum || e.remoteChecksum === l.hash);
      if (!remote || !matches(remote) || !matches(before)) return;
      // The same scoped base reader verifies the stored body and its marker rules.
      try {
        const history = await loadContentHistory({ rawRecord: record, scope, path, store: bodies, assertOwner: guard });
        if (history.base?.hash !== l.hash) return;
      } catch {
        guard(); return;
      }
      guard();
      return { action: "none", status: "none", reason: "verified-clean-base-without-get", fullyConverged: false,
        fatalBudgetDelta: 0, expected: { scope, path, localHash: l.hash, remoteHash: l.hash,
          remoteEtag: c.remoteEtag, baseRef: c.cleanBaseRef } };
    }
    async function readForPlan(l?: Snapshot, record?: NextclawSyncRecord, cleanOnly = false) {
      if (initial) {
        if (l) throw new SyncConflict("首次下载本地目标已出现，待重新扫描");
        // The executor checks the version again before admitting any write.
        return { remote: initial };
      }
      const before = await fresh(input.fsRemote, rp);
      if (!before) return {};
      const clean = l && record ? await cleanSavePlan(l, record, before) : undefined;
      if (!clean) return cleanOnly ? {} : { remote: await readRemoteVersion(before) };
      const after = await fresh(input.fsRemote, rp);
      if (!after) throw new SyncConflict();
      if (sameVersion(before, after) && name(before) === name(after) &&
        before.remoteFileId === after.remoteFileId && before.remoteChecksum === after.remoteChecksum) return { clean };
      return cleanOnly ? {} : { remote: await readRemoteVersion(after) };
    }
    // Clean proof against this round's walk manifest entry, without per-file remote probes.
    // Freshness is guaranteed by the caller's round-end baseDir etag recheck, not a per-file after stat.
    async function readForPlanTrusted(l?: Snapshot, record?: NextclawSyncRecord): Promise<{ clean?: ContentPlan; remote?: InitialDownload }> {
      if (initial) return { remote: initial };
      if (!remote) return {};
      const clean = l && record ? await cleanSavePlan(l, record, remote) : undefined;
      return clean ? { clean } : {};
    }
    async function readLocal() {
      const e = await fresh(input.fsLocal, lp); if (!e) return;
      return localSnapshot(input.fsLocal, lp, e, guard, fileBodies.fileLimit);
    }
    const io: DeleteIO = { scope, path, endpoint, nativeManaged: binding.nativeManaged,
      readLocal,
      async readRemote() {
        if (initial) {
          await assertInitialVersion(initial.version);
          return initial;
        }
        const e = await fresh(input.fsRemote, rp); if (!e) return;
        return readRemoteVersion(e);
      },
      putRemote(bytes, expected) { guard(); return input.fsRemote.putContent(rp, bytes, expected); },
      async writeLocal(bytes, expectedHash, current) {
        current(); const e = await fresh(input.fsLocal, lp);
        const before = e ? await localSnapshot(input.fsLocal, lp, e, guard, fileBodies.fileLimit) : undefined; current();
        if (before?.hash !== expectedHash) throw new SyncConflict("本地在替换前再次变化");
        if (initial) await assertInitialVersion(initial.version);
        const version = attachmentVersion;
        if (attachment && (!version?.remoteFileId || e))
          throw new SyncConflict("附件目标或远端版本不符合新建条件");
        try {
          await probeSpan(path, "guarded-write", () => input.fsLocal.writeFileGuarded(lp, bytes, Date.now(), Date.now(), e ?? null, before?.bytes,
            current, attachment && version ? () => assertInitialVersion(version) : undefined));
        } catch (error) {
          if ((attachment || input.mobileDailyContentBudget) && (error instanceof Error && error.name === "QuotaExceededError" ||
              (error as { code?: string } | null)?.code === "ENOSPC"))
            throw new Error("attachment-storage-quota-pending");
          throw error;
        }
        current();
      },
      checkpoint: () => checkpoint.read(),
      async assertDeletionEvidence(afterKnownDelete = false) {
        if (afterKnownDelete) {
          guard(); await bindRoot(await input.fsRemote.stat("/")); guard(); return;
        }
        const evidence = await deletionEvidence(path); guard();
        if (evidence.suspectedMove) throw new SyncConflict("suspected-file-move");
      },
      async removeRemote(etag, hash, dispatch) {
        guard(); const e = await fresh(input.fsRemote, rp); guard();
        if (!e || (e.etag?.startsWith('"') ? e.etag : `"${e.etag}"`) !== etag) throw new SyncConflict("delete-remote-version-changed");
        const view = await probeSpan(path, "get", () => input.fsRemote.readContent(rp, e)); guard();
        if (await hashBytes(view.bytes) !== hash) throw new SyncConflict("delete-remote-content-changed");
        guard(); return dispatch(() => { guard(); return input.fsRemote.deleteContent(rp, e); });
      },
      async removeLocal(hash, current) {
        current(); const e = await fresh(input.fsLocal, lp); if (!e) throw new SyncConflict("delete-local-disappeared");
        const snapshot = await localSnapshot(input.fsLocal, lp, e, guard, fileBodies.fileLimit); current();
        if (snapshot.hash !== hash) throw new SyncConflict("delete-local-content-changed");
        await input.fsLocal.rmGuarded(lp, e, snapshot.bytes, current); current();
      },
      async coveredOperations() {
        const rows = await operations.list(scope); guard();
        return rows.filter(o => o.path === path && ["committed", "rejected", "rediscover", "archived"].includes(o.phase)).map(o => o.id);
      },
      async commitDeleted(generation, content, id, current) {
        await io.assertDeletionEvidence(true); current();
        if (await fresh(input.fsLocal, lp) || await fresh(input.fsRemote, rp)) throw new SyncConflict("delete-path-recreated-before-commit");
        current(); await checkpoint.commit(generation, content, false, id, current, {
          keyRaw: path, sizeRaw: 0, local: { mtime: 0, size: 0 }, remote: { mtime: 0, size: 0 },
        });
      },
      async commit(generation, content, pending, id, current) {
        current(); const l = await fresh(input.fsLocal, lp), r = await fresh(input.fsRemote, rp); current();
        if (!r || !strongEtag(r.etag)) throw new SyncConflict("提交前远端版本缺失");
        if (initial && !matchesDownloadVersion(initial.version, r)) throw new SyncConflict("首次下载提交前远端版本变化");
        if (attachment && r.remoteFileId !== content.remoteFileId)
          throw new SyncConflict("附件提交前远端身份变化");
        const normalizedTag = r.etag.startsWith('"') ? r.etag : `"${r.etag}"`;
        if (normalizedTag !== content.remoteEtag) throw new SyncConflict("提交前远端版本改变");
        await checkpoint.commit(generation, content, pending, id, current, {
          keyRaw: l ? name(l) : path, sizeRaw: l?.sizeRaw ?? seed.sizeRaw,
          local: l ? observation(l, "local") : seed.local, remote: observation(r, "remote"),
        });
      }, requestRerun: () => { guard(); runtime!.requestRerun(); },
    };
    return { io, checkpoint, bodies: fileBodies, readLocal, readForPlan, readForPlanTrusted, prefetchInitialDownload, deletion: new DeleteExecutor(deletions, io, runtime!.journal, guard, input.configDir), executor: new ContentExecutor(scope, path, fileBodies, operations, io, runtime!.journal,
      endpoint, () => { try { runtime!.assertActive(); return true; } catch { return false; } }, input.configDir, initial) };
  }
  async function collect() {
    guard(); const rows = [];
    for (const raw of await getAllPrevSyncRecordsByVaultAndProfile(input.db, input.vaultRandomID, input.profileID)) {
      const value = decodeRecord(raw); if (!value) throw new Error("旧同步记录损坏");
      if (!value.content || value.content.scopeKey !== scope || value.isFolder) continue;
      const slot = await file(value.key).checkpoint.read(); guard(); rows.push({ value, commitId: slot.commitId });
    }
    const stage = await input.db.fileContentHistoryTbl.getItem(contentMoveKey(scope));
    return collectContent(bodies, input.db.fileContentHistoryTbl, operations, rows, guard,
      (await deletions.list()).map(o => ({ id: o.id, path: o.path, baseRef: o.baseRef, baseHash: o.baseHash, supersedes: o.supersedes, phase: o.phase })),
      acknowledgedMove(stage, scope)?.targetBase, committedMove(stage, scope));
  }
  const move = (rootId: string) => binding.nativeManaged ? new ContentMove({ pool: runtime.pool, records: input.db.prevSyncRecordsTbl,
    history: input.db.fileContentHistoryTbl, vault: input.vaultRandomID, profile: input.profileID, configDir: input.configDir,
    journal: runtime.journal, assertActive: guard, local: input.fsLocal, remote: input.fsRemote, rootId }) : undefined;
  return { scope, bodies, attachments, operations, rootReseed, ensureRoot, deletions, deletionEvidence, setManifest, file, guard, collect, move,
    get startRootEtag() { return startRootEtag; } };
}
