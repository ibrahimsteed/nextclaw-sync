import { isOrdinaryMovePath, SyncConflict } from "./engine/versionGuard";
import { getAllPrevSyncRecordsByVaultAndProfile, insertSyncPlanRecordByVault } from "../localdb";
import { executePlan } from "./engine/execute";
import { decodeRecord, inConfig, name, errorOf, type PlanItem, type SyncInput, type SyncResult } from "./engine/model";
import { buildPlan, makeFilter, protection } from "./engine/plan";
import { runLegacySync } from "./engine/legacy";
import { contentRuntime, contentScope, checkVaultStages, ContentStagePaused } from "./content/runtime";
import { selectBatch, type BatchState } from "./content/batches";
import { planContent } from "./content/decision";
import { hashBytes, isHash } from "./content/identity";
import { MoveTargetOccupied } from "./content/move";
import { NativeWritePaused, type NativeWriteJournal } from "./nativeWriteJournal";
export type { SyncCallbacks, SyncInput, SyncResult } from "./engine/model";
const running = new WeakSet<NativeWriteJournal>();
type MoveCollision = { source: string; target: string; fileId: string; hash: string };
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
    for (const op of await rt.operations.list(rt.scope)) {
      rt.guard();
      if (op.phase !== "committed" && op.phase !== "archived") recheck.add(op.path);
      if (collisions.some(pair => pair.source === op.path || pair.target === op.path)) continue;
      if (op.phase === "inputs-durable" && source !== "dry") { op.phase = "rediscover"; await rt.operations.put(op); }
      if (["remote-acknowledged", "local-verified"].includes(op.phase)) {
        if (source === "dry") throw new Error("有待提交的内容操作，请先进行正常同步");
        const item = plan[op.path]; const outcome = await rt.file(op.path, item?.local, item?.remote).executor.finish(op.id);
        if (!["converged", "content-conflict"].includes(outcome.status)) {
          result.pendingContent!.push({ path: op.path, reason: outcome.reason });
          if (outcome.status === "failed") result.errors.push(new Error(outcome.reason));
          if (outcome.status === "blocked-unknown-write") result.contentSummary!.blocked = true;
          return result;
        }
        // Observations and record generations changed; re-discover through a queued run, not an old plan.
        input.contentRuntime!.requestRerun(); result.pendingContent!.push({ path: op.path, reason: "操作已确认，待重新扫描" }); return result;
      }
    }
    if (source !== "dry") await rt.collect();
    const contentEntries = Object.entries(plan).filter(([key, item]) => !reserved.has(key) && !item.error && !key.endsWith("/") && !inConfig(key, input.configDir));
    const bounded = source !== "dry" && input.protectModifyPercentage >= 100;
    const scheduleKey = `content-batch:${rt.scope}`;
    const previousBatch = bounded ? await input.db.simpleKVForMiscTbl.getItem<BatchState>(scheduleKey) : undefined;
    const saveOnly = input.androidSaveOnly === true && source === "auto_sync_on_save" && !!rootId &&
      !result.errors.length && !(await rt.rootReseed.active());
    rt.guard();
    const batch = bounded ? selectBatch(contentEntries.map(([path, item]) => ({ path,
      urgent: item.record?.pendingLocalUpload === true,
      size: Math.max(item.local?.size ?? item.local?.sizeRaw ?? 0, item.remote?.size ?? item.remote?.sizeRaw ?? 0) })),
      previousBatch, saveOnly) : undefined;
    for (const issue of previousBatch?.issues ?? []) recheck.add(issue.path);
    const inspect = async (key: string, item: PlanItem) => {
      rt!.guard();
      const f = rt!.file(key, item.local, item.remote);
      try {
        const l = await f.readLocal();
        const record = (batch?.saveSweep ?? saveOnly) && !recheck.has(key) && !result.errors.length ? item.record : undefined;
        const { clean, remote: r } = await f.readForPlan(l, record);
        item.content = clean ?? await planContent({ scope: rt!.scope, path: key, store: rt!.bodies, rawRecord: recordByPath.get(key),
          mode: "B", configDir: input.configDir, ownerActive: () => { try { rt!.guard(); return true; } catch { return false; } },
          unknownWrite: journal!.blocked(), deletion: item.record && (!l || !r) ? await rt!.deletionEvidence(key) : undefined, local: l, remote: r && { bytes: r.bytes, etag: r.etag, remoteFileId: r.remoteFileId },
          readConflict: async id => (await rt!.operations.get(id))?.conflict });
        item.decision = "content"; item.change = !["prepare-base", "hold", "none", "preserve-both"].includes(item.content.action);
        item.reason = item.content.reason;
        if (item.content.status === "failed") { item.error = item.content.reason; result.errors.push(new Error(`${key}：${item.error}`)); }
      } catch (e) {
        rt!.guard(); item.decision = "content"; item.change = false;
        if (e instanceof SyncConflict || (e as {status?:number}).status === 412) item.contentPending = "读取时版本发生变化，待重新扫描";
        else if (e instanceof Error && e.message === "content-limit-pending") item.contentPending = "内容超过安全预算，待处理";
        else { item.error = errorOf(e).message; result.errors.push(errorOf(e)); }
      }
    };
    if (!bounded) for (const [key, item] of contentEntries) await inspect(key, item);
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
      let done = 0;
      const executionEntries = bounded ? batch!.selected.map(key => [key, plan[key]] as const) : Object.entries(plan);
      for (const [key, item] of executionEntries) {
        if (reserved.has(key)) continue;
        if (bounded) await inspect(key, item);
        if (item.decision !== "content" || item.error || !item.content) continue;
        rt.guard(); if (result.errors.length >= 10) { item.contentPending = "前序错误，未执行"; continue; }
        const p = item.content;
        if (["hold", "preserve-both", "none"].includes(p.action)) {
          if (p.action !== "none") item.contentPending = p.reason; continue;
        }
        const f = rt.file(key, item.local, item.remote);
        const out = await (p.action.startsWith("delete-") ? f.deletion.execute(p) : f.executor.execute(p)); item.reason = out.reason;
        await cb.progress(source, ++done, Object.values(plan).filter(i=>i.content).length, key, "content");
        if (out.status === "failed") { item.error = out.reason; result.errors.push(new Error(`${key}：${out.reason}`)); }
        else if (out.status !== "converged") item.contentPending = out.status === "content-conflict" ? "content-conflict" : out.reason;
        if (out.status === "blocked-unknown-write") { result.contentSummary!.blocked = true; break; }
        await checkVaultStages(input.db, input.vaultRandomID, rt.guard, moveScope);
        // Only verified retirement proof can release bodies, between admitted operations.
        await rt.collect();
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
          if (batch.next.remaining.length && !result.errors.length) input.contentRuntime!.requestRerun(batch.next.saveOnly);
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
