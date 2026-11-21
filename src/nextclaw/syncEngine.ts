import { FIRST_B_DOWNLOAD_LIMIT, INITIAL_DOWNLOAD_BYTES } from "./content/initialDownloadLimit";
import { probeEvent } from "./content/probeTrace";
import { isOrdinaryMovePath, SyncConflict } from "./engine/versionGuard";
import { getAllPrevSyncRecordsByVaultAndProfile, insertSyncPlanRecordByVault } from "../localdb";
import { executePlan } from "./engine/execute";
import { decodeRecord, inConfig, name, errorOf, type PlanItem, type SyncInput, type SyncResult } from "./engine/model";
import { buildPlan, makeFilter, protection } from "./engine/plan";
import { runLegacySync } from "./engine/legacy";
import { contentRuntime, contentScope, checkVaultStages, ContentStagePaused } from "./content/runtime";
import { selectBatch, type BatchState } from "./content/batches";
import { ATTACHMENT_LIMIT, NOTE_LIMIT } from "./content/identity";
import { isAttachmentRef } from "./content/store";
import { planContent } from "./content/decision";
import type { InitialDownloadGroup } from "./content/operation";
import type { ContentReservation } from "./content/store";
import { hashBytes, isHash } from "./content/identity";
import { strongEtag } from "./content/migration";
import { MoveTargetOccupied } from "./content/move";
import { NativeWritePaused, type NativeWriteJournal } from "./nativeWriteJournal";
export type { SyncCallbacks, SyncInput, SyncResult } from "./engine/model";
const running = new WeakSet<NativeWriteJournal>();
type MoveCollision = { source: string; target: string; fileId: string; hash: string };
const INITIAL_PUBLICATION_CONCURRENCY = 4;
const FIRST_B_RECOVERY_CONCURRENCY = 4;
const INITIAL_COLLECTION_BATCH = 128;
const INITIAL_SMALL_COLLECTION_BATCH = 32;
export async function runSync(input: SyncInput): Promise<SyncResult> {
  const result: SyncResult = { ok: false, fullyConverged: false, pendingDirectories: [], counts: {}, errors: [],
    pendingContent: [], contentSummary: { pending: 0, conflicts: 0, blocked: false } };
  const cb = input.callbacks, source = input.triggerSource, journal = input.contentRuntime?.journal;
  const guard = () => { input.contentRuntime?.assertActive(); if (journal?.blocked()) throw new ContentStagePaused(); };
  if (journal && running.has(journal)) { result.pendingContent!.push({ path: "", reason: "同步正在运行，待补跑" }); result.contentSummary!.pending = 1; return result; }
  if (journal) running.add(journal);
  const plan = Object.create(null) as Record<string, PlanItem>;
  let rt: ReturnType<typeof contentRuntime> | undefined;
  const meta = { mode: input.mode, triggerSource: source, startedAt: Date.now(), outcome: "failed", finishedAt: 0 };
  try {
    guard();
    // Applies to A/config too: switching policy cannot erase an unconfirmed B operation.
    const moveScope = () => input.mode === "B" ? contentScope(input) : undefined;
    if (input.contentRuntime) await checkVaultStages(input.db, input.vaultRandomID, guard, moveScope);
    if (input.mode === "A") return await runLegacySync(input);
    if (input.mode !== "B") throw new Error("不支持的同步模式");
    rt = contentRuntime(input);
    await cb.markIsSyncing(true); await cb.notify(source, 1); await cb.ribbon(source, 1); await cb.statusBar(source, 1, true);
    const records = await getAllPrevSyncRecordsByVaultAndProfile(input.db, input.vaultRandomID, input.profileID); rt.guard();
    for (const raw of records) if (!decodeRecord(raw)) throw new Error("同步记录无效，未按新文件覆盖");
    const rootId = await rt.ensureRoot(records.map(r => decodeRecord(r)!)); rt.guard();
    const mover = rootId ? rt.move(rootId) : undefined;
    if (!mover) await checkVaultStages(input.db, input.vaultRandomID, rt.guard);
    const remote = await input.fsRemote.walk(); rt.guard(); const local = await input.fsLocal.walk(); rt.guard();
    Object.assign(plan, buildPlan(input, local, remote, records));
    for (const [key, item] of Object.entries(plan)) if (item.error) result.errors.push(new Error(`${key}：${item.error}`));
    rt.setManifest(local, remote, records.map(r => decodeRecord(r)!), Object.values(plan).some(i => !!i.error));
    for (const [key, item] of Object.entries(plan)) if (key.endsWith("/") && ["deleteLocal", "deleteRemote"].includes(item.decision)) item.pending = "directory-delete-deferred";
    const recordByPath = new Map(records.map(r => { const v = decodeRecord(r)!; return [v.key.normalize("NFC"), r]; }));
    const reserved = new Set<string>();
    const reserve = (pair: NonNullable<PlanItem["move"]>, reason: string, change = false) => {
      for (const raw of [pair.source, pair.target]) {
        const path = raw.normalize("NFC"), item = plan[path];
        if (!item || item.error || path.endsWith("/") || inConfig(path, input.configDir)) continue;
        reserved.add(path);
        item.decision = "content"; item.change = change && raw === pair.source;
        item.move = { source: pair.source, target: pair.target };
        item.reason = reason; item.contentPending = reason;
      }
    };
    const intents = (input.contentRuntime?.renames ?? []).filter(i => i.scope === rt!.scope);
    const pendingMove = await mover?.pendingCommit();
    if (pendingMove) {
      reserve(pendingMove, "move-commit-pending");
      try {
        if (source === "dry") throw new SyncConflict("move-commit-pending");
        await mover!.finish(pendingMove.id);
        for (const intent of intents) if (intent.source === pendingMove.source && intent.target === pendingMove.target) intent.settle();
        input.contentRuntime!.requestRerun();
        result.pendingContent!.push({ path: pendingMove.target, reason: "move-commit-rescan" });
        return result;
      } catch (e) {
        if (!(e instanceof SyncConflict)) throw e;
        result.pendingContent!.push({ path: pendingMove.target, reason: e.message });
      }
    }
    const keep = makeFilter(input);
    const eligibleMoves = [];
    const ordinary = (path: string) => isOrdinaryMovePath(path) && keep(path) && !inConfig(path, input.configDir);
    const history = input.db.simpleKVForMiscTbl;
    const collisionKey = `content-move-collisions:${rt.scope}`;
    const saved = await history.getItem<{ rootId: string; pairs: MoveCollision[] }>(collisionKey); rt.guard();
    if (saved !== null && (!rootId || saved.rootId !== rootId || !Array.isArray(saved.pairs) ||
        saved.pairs.some(pair => !pair || ![pair.source, pair.target].every(path =>
          typeof path === "string" && isOrdinaryMovePath(path) && !inConfig(path, input.configDir)) ||
          pair.source.toLowerCase() === pair.target.toLowerCase() ||
          typeof pair.fileId !== "string" || !pair.fileId || !isHash(pair.hash)))) throw new Error("invalid-move-collision");
    const collisions = (saved?.pairs ?? []).slice();
    const saveCollisions = async () => {
      if (source !== "dry") {
        rt!.guard();
        if (collisions.length) await history.setItem(collisionKey, { rootId, pairs: collisions });
        else await history.removeItem(collisionKey);
        rt!.guard();
      }
    };
    const holdCollision = async (pair: MoveCollision) => {
      if (!collisions.some(x => x.source === pair.source && x.target === pair.target)) {
        collisions.push(pair);
        await saveCollisions();
      }
      reserve(pair, "move-target-occupied");
    };
    const rejected = await mover?.rejectedPrecondition();
    if (rejected && plan[rejected.target.normalize("NFC")]?.remote &&
        plan[rejected.source.normalize("NFC")]?.remote?.remoteFileId === rejected.fileId &&
        !plan[rejected.source.normalize("NFC")]?.local && plan[rejected.target.normalize("NFC")]?.local) {
      const {source, target, fileId, hash} = rejected;
      await holdCollision({source, target, fileId, hash});
    }
    for (const pair of collisions.slice()) {
      const from = plan[pair.source.normalize("NFC")], to = plan[pair.target.normalize("NFC")];
      if (source !== "dry" && !result.errors.length && from?.local && from.remote?.remoteFileId === pair.fileId && !to?.local) {
        const restored = await rt.file(pair.source, from.local, from.remote).io.readLocal();
        if (restored && await hashBytes(restored.bytes) === pair.hash) {
          collisions.splice(collisions.indexOf(pair), 1);
          await saveCollisions();
          const reversal = intents.findIndex(i => i.source === pair.target && i.target === pair.source);
          if (reversal !== -1) intents.splice(reversal, 1)[0].settle();
          continue;
        }
      }
      reserve(pair, "move-target-occupied");
    }
    const parentPresent = (path: string) => {
      const slash = path.lastIndexOf("/");
      if (slash < 0) return true;
      const parent = plan[path.slice(0, slash + 1)];
      return !!parent?.local && !!parent.remote && !parent.error;
    };
    for (const intent of intents) {
      const from = plan[intent.source.normalize("NFC")], to = plan[intent.target.normalize("NFC")];
      if (reserved.has(intent.source.normalize("NFC")) || reserved.has(intent.target.normalize("NFC"))) continue;
      if (!from?.record && !to?.record) { intent.settle(); continue; }
      if (from?.local && from.remote && !to?.local && !to?.remote && !to?.record) { intent.settle(); continue; }
      const touchesOther = intents.some(other => other !== intent && [other.source, other.target].some(path =>
        [intent.source, intent.target].some(p => p.normalize("NFC").toLowerCase() === path.normalize("NFC").toLowerCase())));
      const content = from?.record?.content, identity = content?.remoteFileId, hash = content?.localHash;
      const bound = mover && !pendingMove && ordinary(intent.source) && ordinary(intent.target) &&
        !touchesOther && intent.current() && !result.errors.length &&
        from?.record?.key === intent.source && content?.scopeKey === rt.scope && content.status === "clean" &&
        isHash(hash) && hash === content.remoteHash && !!content.cleanBaseRef &&
        !!identity && from.remote?.remoteFileId === identity && !from.local &&
        to?.local && name(to.local) === intent.target &&
        !from.error && !to.error && parentPresent(intent.target) &&
        remote.filter(entry => entry.remoteFileId === identity).length === 1;
      if (bound && identity && hash && to.remote) {
        await holdCollision({ source: intent.source, target: intent.target, fileId: identity, hash });
        continue;
      }
      const eligible = bound && !to.remote && !to.record && input.fsRemote.supportsSingleAttemptMove();
      reserve(intent, eligible ? "move-planned" : "suspected-file-move", !!eligible);
      if (eligible) eligibleMoves.push(intent);
    }
    const recheck = new Set<string>();
    for (const deletion of await rt.deletions.list()) {
      rt.guard();
      if (deletion.phase !== "committed") recheck.add(deletion.path);
      if (collisions.some(pair => pair.source === deletion.path || pair.target === deletion.path)) continue;
      if (deletion.phase === "prepared" && source !== "dry") { deletion.phase = "rediscover"; await rt.deletions.save(deletion); }
      if (deletion.phase === "acknowledged") {
        if (source === "dry") throw new Error("删除回执待提交，请先进行正常同步");
        const outcome = await rt.file(deletion.path).deletion.finish(deletion);
        if (outcome.status === "failed") result.errors.push(new Error(outcome.reason));
        else if (outcome.status === "converged" || ["path-recreated-after-delete", "delete-record-generation-changed"].includes(outcome.reason)) input.contentRuntime!.requestRerun();
        result.pendingContent!.push({ path: deletion.path, reason: outcome.reason }); return result;
      }
    }
    // Recover only stages with durable completion. No dispatch/replay in this path.
    const recoveredPaths = new Set<string>();
    for (const op of await rt.operations.list(rt.scope)) {
      rt.guard();
      if (op.phase !== "committed" && op.phase !== "archived") recheck.add(op.path);
      if (collisions.some(pair => pair.source === op.path || pair.target === op.path)) continue;
      if (op.phase === "inputs-durable" && source !== "dry") { op.phase = "rediscover"; await rt.operations.put(op); }
      if (["remote-acknowledged", "local-verified"].includes(op.phase)) {
        if (source === "dry") throw new Error("有待提交的内容操作，请先进行正常同步");
        // A second operation at this path needs a fresh plan after the first commit.
        if (recoveredPaths.has(op.path)) break;
        const item = plan[op.path];
        const outcome = await rt.file(op.path, item?.local, item?.remote, undefined,
          isAttachmentRef(op.outputRef)).executor.finish(op.id);
        if (!["converged", "content-conflict"].includes(outcome.status)) {
          result.pendingContent!.push({ path: op.path, reason: outcome.reason });
          if (outcome.status === "failed") result.errors.push(new Error(outcome.reason));
          if (outcome.status === "blocked-unknown-write") result.contentSummary!.blocked = true;
          return result;
        }
        recoveredPaths.add(op.path);
        result.pendingContent!.push({ path: op.path, reason: "操作已确认，待重新扫描" });
      }
    }
    // Re-discover the confirmed paths before dispatching work from the old plan.
    if (recoveredPaths.size) {
      input.contentRuntime!.requestRerun();
      return result;
    }
    if (source !== "dry") await rt.collect();
    let contentEntries = Object.entries(plan).filter(([key, item]) => !reserved.has(key) && !item.error && !key.endsWith("/") && !inConfig(key, input.configDir));
    let bounded = source !== "dry" && input.protectModifyPercentage >= 100;
    const scheduleKey = `content-batch:${rt.scope}`;
    const previousBatch = bounded ? await input.db.simpleKVForMiscTbl.getItem<BatchState>(scheduleKey) : undefined;
    const saveOnly = input.androidSaveOnly === true && source === "auto_sync_on_save" && !!rootId &&
      !result.errors.length && !(await rt.rootReseed.active());
    rt.guard();
    const largeImported = (item: PlanItem) =>
      isAttachmentRef(item.record?.content?.cleanBaseRef) &&
      Math.max(item.local?.size ?? item.local?.sizeRaw ?? 0,
        item.remote?.size ?? item.remote?.sizeRaw ?? 0) > NOTE_LIMIT;
    const fileForPlan = (key: string, item: PlanItem) =>
      rt!.file(key, item.local, item.remote, undefined, !input.mobileDailyContentBudget && largeImported(item));
    const mobileFirstB = input.androidInitialDownload || input.ipadInitialDownload;
    const canVerifyClean = bounded && rootId && !result.errors.length && !result.pendingContent!.length &&
      !reserved.size && (mobileFirstB || input.androidFirstBRecovery || input.mobileDailyContentBudget) && !(await rt.rootReseed.active());
    const resumeFirstB = canVerifyClean && mobileFirstB &&
      (source === "manual" || source === "auto_sync_on_save") && records.length > 0;
    const verifyAfterReload = canVerifyClean && input.androidFirstBRecovery && source === "auto_sync_on_save" &&
      !recheck.size && !previousBatch?.remaining.length && !previousBatch?.completed.length && !previousBatch?.issues?.length &&
      contentEntries.length > 0 && contentEntries.every(([key, item]) => ordinary(key) && item.local &&
        item.remote && item.record?.content?.status === "clean" && !item.record.pendingLocalUpload) &&
      Object.entries(plan).every(([key, item]) =>
        !(key.endsWith("/") || inConfig(key, input.configDir)) || (!item.change && !item.pending));
    // Recheck the same evidence on queued follow-ups so clean paths stay out of the batch.
    const verifyDaily = canVerifyClean && input.mobileDailyContentBudget &&
      (source === "manual" || source === "auto" || source === "auto_once_init" || source === "auto_sync_on_save");
    const verifyIndependently = resumeFirstB || verifyDaily;
    if (verifyIndependently || verifyAfterReload) {
      const runtime = rt;
      const issues = new Set(previousBatch?.issues?.map(item => item.path));
      const candidates = verifyIndependently ? contentEntries.filter(([key, item]) => ordinary(key) && item.local &&
        item.remote && item.record?.content?.status === "clean" && !recheck.has(key) && !issues.has(key) &&
        (!verifyDaily || Math.max(item.local.size ?? item.local.sizeRaw ?? 0,
          item.remote.size ?? item.remote.sizeRaw ?? 0) <= ATTACHMENT_LIMIT)) : contentEntries;
      const verified = new Map<string, NonNullable<PlanItem["content"]>>();
      for (let i = 0; i < candidates.length;) {
        const next = candidates.slice(i, i + FIRST_B_RECOVERY_CONCURRENCY);
        const large = next.findIndex(([, item]) => largeImported(item));
        const chunk = large < 0 ? next : next.slice(0, Math.max(1, large));
        const checked = await Promise.allSettled(chunk.map(async ([key, item]) => {
          const file = fileForPlan(key, item);
          return (await file.readForPlan(await file.readLocal(), item.record, true)).clean;
        }));
        runtime.guard();
        for (const [index, check] of checked.entries()) {
          if (!verifyDaily && check.status === "rejected" && !(check.reason instanceof SyncConflict) &&
              (check.reason as { status?: number } | null)?.status !== 412) throw check.reason;
          if (check.status === "fulfilled" && check.value) verified.set(chunk[index][0], check.value);
        }
        i += chunk.length;
        if (!verifyIndependently && verified.size !== i) break;
      }
      if (verifyIndependently || verified.size === contentEntries.length) {
        for (const [key, clean] of verified) {
          const item = plan[key];
          item.decision = "content";
          item.change = false;
          item.content = clean;
          item.reason = clean.reason;
        }
        if (verifyIndependently) {
          // Schedule unresolved paths only. The clean proofs apply to this run, never a later sweep.
          contentEntries = contentEntries.filter(([key]) => !verified.has(key));
        } else {
          bounded = false;
        }
      }
    }
    const batch = bounded ? selectBatch(contentEntries.map(([path, item]) => ({ path,
      urgent: item.record?.pendingLocalUpload === true,
      size: Math.max(item.local?.size ?? item.local?.sizeRaw ?? 0, item.remote?.size ?? item.remote?.sizeRaw ?? 0) })),
      previousBatch, saveOnly) : undefined;
    const canImport = batch && mobileFirstB && rootId &&
      !result.errors.length && !(await rt.rootReseed.active());
    const newRemoteFiles = canImport ? contentEntries.filter(([key, item]) =>
      ordinary(key) && !recheck.has(key) && !item.local && !item.record && !!item.remote?.remoteFileId &&
      name(item.remote) === key && strongEtag(item.remote.etag)) : [];
    for (const issue of previousBatch?.issues ?? []) recheck.add(issue.path);
    const initial = new Set(newRemoteFiles.map(([key]) => key));
    const inspect = async (key: string, item: PlanItem, f = fileForPlan(key, item)) => {
      rt!.guard();
      try {
        const l = await f.readLocal();
        const record = (batch?.saveSweep ?? saveOnly) && !recheck.has(key) && !result.errors.length ? item.record : undefined;
        const { clean, remote: r } = await f.readForPlan(l, record);
        item.content = clean ?? await planContent({ scope: rt!.scope, path: key, store: f.bodies, rawRecord: recordByPath.get(key),
          mode: "B", configDir: input.configDir, ownerActive: () => { try { rt!.guard(); return true; } catch { return false; } },
          unknownWrite: journal!.blocked(), deletion: item.record && (!l || !r) ? await rt!.deletionEvidence(key) : undefined, local: l, remote: r && { bytes: r.bytes, etag: r.etag, remoteFileId: r.remoteFileId },
          readConflict: async id => (await rt!.operations.get(id))?.conflict });
        if (!input.mobileDailyContentBudget && largeImported(item) && !["hold", "none", "preserve-both"].includes(item.content.action)) {
          item.content = { action: "hold", status: "pending", reason: "large-attachment-change-pending",
            fullyConverged: false, fatalBudgetDelta: 0 };
        }
        item.decision = "content"; item.change = !["prepare-base", "hold", "none", "preserve-both"].includes(item.content.action);
        item.reason = item.content.reason;
        if (item.content.status === "failed") { item.error = item.content.reason; result.errors.push(new Error(`${key}：${item.error}`)); }
      } catch (e) {
        rt!.guard(); item.decision = "content"; item.change = false;
        if (e instanceof SyncConflict || (e as {status?:number}).status === 412) {
          item.contentPending = "读取时版本发生变化，待重新扫描";
          return true;
        }
        else if (e instanceof Error && e.message === "content-limit-pending") item.contentPending = "内容超过安全预算，待处理";
        else { item.error = errorOf(e).message; result.errors.push(errorOf(e)); }
      }
    };
    if (!bounded) {
      for (const [key, item] of contentEntries) if (!item.content) await inspect(key, item);
    }
    else for (const [, item] of contentEntries) {
      // The metadata planner uses legacy decisions. Never delegate uninspected B
      // content to executePlan (which is now limited to config/directories).
      item.decision = "content"; item.change = false;
    }
    const protect = protection(plan, input.protectModifyPercentage);
    if (protect.abort) throw new Error(cb.protectError(input.protectModifyPercentage, protect.count, protect.total));
    if (source === "dry") for (const item of Object.values(plan)) {
      if (item.content && item.content.action !== "none") item.contentPending = "仅预览，待执行";
    }
    if (source !== "dry") {
      for (const intent of eligibleMoves) {
        try {
          const reply = await mover!.send(intent.source, intent.target, intent.current);
          if (reply.status === 201) {
            await mover!.finish(reply.id);
            intent.settle();
            input.contentRuntime!.requestRerun();
            result.pendingContent!.push({ path: intent.target, reason: "move-commit-rescan" });
            return result;
          }
          reserve(intent, reply.status === 412 ? "move-conflict" : `move-rejected-${reply.status}`);
          if (reply.status !== 412) result.errors.push(new Error(`远端改名被拒绝（HTTP ${reply.status}）`));
        } catch (e) {
          if (e instanceof MoveTargetOccupied) {
            const content = plan[intent.source.normalize("NFC")].record!.content!;
            await holdCollision({ source: intent.source, target: intent.target, fileId: content.remoteFileId!, hash: content.localHash! });
          } else if (e instanceof SyncConflict || e instanceof Error && e.message === "content-limit-pending") {
            reserve(intent, e.message);
            // An acknowledged move can reserve the pair until its postcondition is met.
            if (await mover!.pendingCommit()) break;
          } else throw e;
        }
      }
      rt.guard(); await executePlan(input, plan, result.errors); rt.guard();
      if (batch && !result.errors.length && initial.size) {
        const importing = initial;
        batch.selected = [...new Set([...batch.selected, ...importing])];
        batch.next.remaining = batch.next.remaining.filter(key => !importing.has(key));
        batch.next.completed = batch.next.remaining.length ? [...new Set([...batch.next.completed, ...importing])] : [];
      } else {
        initial.clear();
      }
      let done = 0;
      let initialNeedsRescan = false;
      const executionEntries = bounded ? batch!.selected.map(key => [key, plan[key]] as const) : Object.entries(plan);
      const executeContent = async (key: string, item: PlanItem, prepared?: ReturnType<NonNullable<typeof rt>["file"]>,
        deferCollection = false, group?: InitialDownloadGroup) => {
        if (bounded) {
          const needsFreshPlan = await inspect(key, item, prepared);
          if (prepared && needsFreshPlan) initialNeedsRescan = true;
        }
        if (item.decision !== "content" || item.error || !item.content) return;
        rt!.guard(); if (result.errors.length >= 10) { item.contentPending = "前序错误，未执行"; return; }
        const p = item.content;
        if (["hold", "preserve-both", "none"].includes(p.action)) {
          if (p.action !== "none") item.contentPending = p.reason; return;
        }
        const f = prepared ?? rt!.file(key, item.local, item.remote);
        if (group && p.action !== "download-create") throw new Error("initial-download-admission-changed");
        const out = await (p.action.startsWith("delete-") ? f.deletion.execute(p) : f.executor.execute(p, group)); item.reason = out.reason;
        if (prepared && out.status === "pending" &&
            !["content-limit-pending", "attachment-storage-quota-pending"].includes(out.reason)) initialNeedsRescan = true;
        await cb.progress(source, ++done, Object.values(plan).filter(i=>i.content).length, key, "content");
        if (out.status === "failed") { item.error = out.reason; result.errors.push(new Error(`${key}：${out.reason}`)); }
        else if (out.status !== "converged") item.contentPending = out.status === "content-conflict" ? "content-conflict" : out.reason;
        if (out.status === "blocked-unknown-write") { result.contentSummary!.blocked = true; return; }
        if (!group) await checkVaultStages(input.db, input.vaultRandomID, rt!.guard, moveScope);
        // Only verified retirement proof can release bodies, between admitted operations.
        if (!deferCollection) await rt!.collect();
      };
      for (const [key, item] of executionEntries) {
        if (reserved.has(key) || initial.has(key)) continue;
        await executeContent(key, item);
        if (result.contentSummary!.blocked) break;
      }
      const runtime = rt;
      const downloads = executionEntries.filter(([key, item]) => {
        if (!initial.has(key)) return false;
        const size = item.remote!.size ?? item.remote!.sizeRaw;
        if (Number.isSafeInteger(size) && size >= 0 && size <= ATTACHMENT_LIMIT) return true;
        item.contentPending = "attachment-file-limit-pending";
        return false;
      });
      const unavailable = () => result.contentSummary!.blocked || result.errors.length >= 10;
      const sizeOf = (item: PlanItem) => item.remote!.size ?? item.remote!.sizeRaw;
      const limits = [INITIAL_COLLECTION_BATCH, INITIAL_SMALL_COLLECTION_BATCH, 1];
      let inFlightBytes = 0;
      function readChunk(start: number, end: number) {
        let bytes = 0;
        let next = start;
        while (next < end && next - start < FIRST_B_DOWNLOAD_LIMIT) {
          const size = sizeOf(downloads[next][1]);
          if (inFlightBytes + bytes + size > INITIAL_DOWNLOAD_BYTES) break;
          bytes += size;
          next++;
        }
        if (next === start) return;
        const entries = downloads.slice(start, next);
        inFlightBytes += bytes;
        probeEvent(entries[0][0], "download-byte-reserve", { group: start, bytes: inFlightBytes });
        return {
          start, next, entries,
          ready: Promise.allSettled(entries.map(async ([key, item]) => {
            probeEvent(key, "group-dispatch", { group: start });
            try {
              const download = await runtime.file(key, undefined, item.remote, undefined, true).prefetchInitialDownload(item.remote!);
              probeEvent(key, "download-ready", { group: start, bytes: download.bytes.byteLength });
              return download;
            } catch (error) {
              probeEvent(key, "download-rejected", { group: start, timeout: Number(/timeout|timed out|deadline/i.test(errorOf(error).message)) });
              throw error;
            }
          })),
          release() {
            inFlightBytes -= bytes;
            probeEvent(entries[0][0], "download-byte-release", { group: start, bytes: inFlightBytes });
          },
        };
      }
      function recordDownloadFailure(item: PlanItem, failure: unknown) {
        const reason = errorOf(failure).message;
        const status = (failure as { status?: number } | undefined)?.status;
        if (failure instanceof SyncConflict || status === 404 || status === 412) {
          item.contentPending = "首次下载版本变化，待重新扫描";
          initialNeedsRescan = true;
        } else if (["content-limit-pending", "attachment-file-limit-pending", "attachment-storage-quota-pending", "attachment-signature-mismatch"].includes(reason)) {
          item.contentPending = reason === "content-limit-pending" ? "attachment-budget-pending" : reason;
        } else {
          item.error = reason;
          result.errors.push(errorOf(failure));
        }
      }
      async function publishGroup(start: number, end: number, reservation: ContentReservation) {
        let active: ReturnType<typeof readChunk>;
        let prefetched: ReturnType<typeof readChunk>;
        let next = start;
        try {
          while (next < end && !unavailable()) {
            active = prefetched ?? readChunk(next, end);
            prefetched = undefined;
            if (!active) throw Error("initial-download-byte-budget");
            const { entries, ready, start: groupStart } = active;
            next = active.next;
            const completed = await ready;
            for (const [key] of entries) probeEvent(key, "group-released", { group: groupStart });
            runtime.guard();
            if (next < end) prefetched = readChunk(next, end);
            await checkVaultStages(input.db, input.vaultRandomID, runtime.guard, moveScope);
            const priorOperations = await runtime.operations.list(runtime.scope);
            runtime.guard();
            const writers = Array.from({ length: INITIAL_PUBLICATION_CONCURRENCY }, () => Promise.resolve());
            let nextWriter = 0;
            const group: InitialDownloadGroup = {
              priorOperations, reservation,
              writeLocal(work) {
                const writer = nextWriter++ % writers.length;
                const write = writers[writer].then(work);
                writers[writer] = write.catch(() => {});
                return write;
              },
            };
            const apply = async ([key, item]: typeof entries[number], index: number) => {
              if (unavailable()) { item.contentPending = "前序错误，未执行"; return; }
              const download = completed[index];
              if (download.status === "fulfilled") {
                await executeContent(key, item, runtime.file(key, undefined, item.remote, download.value, true), true, group);
              } else recordDownloadFailure(item, download.reason);
            };
            if (result.errors.length + entries.length <= 10) {
              const outcomes = await Promise.allSettled(entries.map(apply));
              for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
            } else {
              for (const [index, entry] of entries.entries()) await apply(entry, index);
            }
            if (!result.contentSummary!.blocked) await checkVaultStages(input.db, input.vaultRandomID, runtime.guard, moveScope);
            active.release();
            active = undefined;
          }
          for (const [, item] of downloads.slice(next, end)) item.contentPending = "前序错误，未执行";
        } finally {
          await prefetched?.ready;
          prefetched?.release();
          active?.release();
          reservation.release();
        }
      }
      for (let cursor = 0; cursor < downloads.length;) {
        if (unavailable()) {
          for (const [, item] of downloads.slice(cursor)) item.contentPending = "前序错误，未执行";
          break;
        }
        let end = cursor + 1;
        let reservation: ContentReservation | undefined;
        let previousEnd = -1;
        for (const limit of limits) {
          end = Math.min(cursor + limit, downloads.length);
          if (previousEnd === end) continue;
          previousEnd = end;
          const budgets = new Map(downloads.slice(cursor, end).map(([key, item]) => [key, 3 * sizeOf(item)]));
          try {
            reservation = await runtime.attachments.reserveCapacity(budgets);
            break;
          } catch (error) {
            if (!["content-limit-pending", "attachment-storage-quota-pending"].includes(errorOf(error).message)) throw error;
            if (end === cursor + 1) recordDownloadFailure(downloads[cursor][1], error);
          }
        }
        if (reservation) await publishGroup(cursor, end, reservation);
        cursor = end;
        if (!unavailable() && cursor < downloads.length) await runtime.collect();
      }
      if (!result.contentSummary!.blocked) {
        await rt.collect();
        if (batch) {
          const issues = new Map(batch.next.issues.map(i => [i.path, i.reason]));
          for (const key of batch.selected) {
            const item = plan[key];
            const reason = item.error ? "前轮读取或执行失败，待重新核对" : item.contentPending ??
              (item.content && ["pending", "content-conflict", "blocked-unknown-write"].includes(item.content.status) &&
              !["verified-record-commit", "idempotent-record-commit", "verified-delete-commit"].includes(item.reason) ? item.content.reason : undefined);
            if (reason) issues.set(key, reason); else issues.delete(key);
          }
          batch.next.issues = [...issues].map(([path, reason]) => ({path, reason}));
          for (const [key, reason] of issues) if (!reserved.has(key) && !batch.selected.includes(key)) plan[key].contentPending = reason;
          rt.guard(); await input.db.simpleKVForMiscTbl.setItem(scheduleKey, batch.next); rt.guard();
          for (const key of batch.next.remaining) {
            const item = plan[key]; item.decision = "content"; item.change = false;
            item.contentPending = "正文批次待续跑";
          }
          if ((batch.next.remaining.length || initialNeedsRescan) && !result.errors.length) input.contentRuntime!.requestRerun(batch.next.saveOnly);
        }
      }
    }
    for (const [key, item] of Object.entries(plan)) {
      if (item.decision === "content" && !item.error &&
        (item.contentPending || (item.content && ["pending", "content-conflict", "blocked-unknown-write"].includes(item.content.status)))) {
        // A conflict plan can resolve into a clean merge during execution.
        if (item.contentPending || (item.reason !== "verified-record-commit" && item.reason !== "idempotent-record-commit"))
          result.pendingContent!.push({ path: key, reason: item.contentPending ?? item.content!.reason });
      }
    }
    if (source !== "dry" && !result.errors.length && !result.pendingContent!.length &&
      !Object.values(plan).some(i => i.pending === "directory-delete-deferred")) await rt.rootReseed.finish();
  } catch (e) {
    if (journal?.blocked() || e instanceof ContentStagePaused || e instanceof NativeWritePaused) result.contentSummary!.blocked = true;
    result.errors.push(errorOf(e));
  } finally {
    if (input.mode !== "A") {
      result.pendingDirectories = Object.entries(plan).filter(([key, p]) => key.endsWith("/") && p.pending === "directory-delete-deferred").map(([key]) => key);
      for (const p of Object.values(plan)) result.counts[p.decision] = (result.counts[p.decision] ?? 0) + 1;
      result.contentSummary!.pending = result.pendingContent!.length;
      result.contentSummary!.conflicts = result.pendingContent!.filter(p => /conflict|marker|preserve-both|both-changed/.test(p.reason)).length;
      result.ok = !result.errors.length && !result.contentSummary!.blocked;
      result.fullyConverged = result.ok && !result.pendingDirectories.length && !result.pendingContent!.length;
      meta.finishedAt = Date.now(); meta.outcome = result.contentSummary!.blocked ? "blocked" : result.errors.length ? "failed" : result.fullyConverged ? "converged" : "pending";
      try {
        await insertSyncPlanRecordByVault(input.db, { "/$@meta": { ...meta, pendingContent: result.pendingContent, content: result.contentSummary }, ...plan }, input.vaultRandomID, "webdav");
        if (result.fullyConverged && source !== "dry") await cb.notify(source, 8);
        await cb.ribbon(source, 8); await cb.statusBar(source, 8, result.ok, result.pendingDirectories.length, result.contentSummary);
        if (result.errors.length) await cb.errNotify(source, result.errors[0]);
      } catch (e) { result.errors.push(errorOf(e)); result.ok = false; result.fullyConverged = false; }
      finally { await cb.markIsSyncing(false); }
    }
    if (journal) running.delete(journal);
  }
  return result;
}
