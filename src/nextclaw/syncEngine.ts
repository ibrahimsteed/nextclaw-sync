/** Independent implementation of the material-package specification v1.3. */
import AggregateError from "aggregate-error";
import {
  getAllPrevSyncRecordsByVaultAndProfile,
  insertSyncPlanRecordByVault,
} from "../localdb";
import { executePlan } from "./engine/execute";
import {
  errorOf,
  type PlanItem,
  type SyncInput,
  type SyncResult,
} from "./engine/model";
import { buildPlan, protection } from "./engine/plan";
export type { SyncCallbacks, SyncInput, SyncResult } from "./engine/model";

export async function runSync(input: SyncInput): Promise<SyncResult> {
  const { callbacks: cb, triggerSource: source } = input;
  const result: SyncResult = { ok: false, fullyConverged: false, pendingDirectories: [], counts: {}, errors: [] };
  const meta: {
    mode: string;
    triggerSource: string;
    startedAt: number;
    finishedAt?: number;
    aborted?: "protect" | "error";
    outcome?: "failed" | "pending" | "converged";
    pendingDirectories?: string[];
  } = { mode: input.mode, triggerSource: source, startedAt: Date.now() };
  let plan: Record<string, PlanItem> = Object.create(null) as Record<string, PlanItem>;
  try {
    await cb.markIsSyncing(true);
    if (source === "dry") await cb.notify(source, 0);
    await cb.notify(source, 1);
    await cb.ribbon(source, 1);
    await cb.statusBar(source, 1, true);
    await cb.notify(source, 2);
    if (input.mode !== "A" && input.mode !== "B")
      throw new Error("不支持的同步模式");
    if (input.fsRemote.kind !== "webdav") throw new Error("仅支持 WebDAV");
    await input.fsRemote.stat("/");
    await cb.notify(source, 3);
    const remote = await input.fsRemote.walk();
    await cb.notify(source, 4);
    const local = await input.fsLocal.walk();
    await cb.notify(source, 5);
    const records = await getAllPrevSyncRecordsByVaultAndProfile(
      input.db,
      input.vaultRandomID,
      input.profileID
    );
    await cb.notify(source, 6);
    plan = buildPlan(input, local, remote, records);
    for (const [key, item] of Object.entries(plan)) {
      if (key.endsWith("/") && ["deleteLocal", "deleteRemote"].includes(item.decision)) {
        item.pending = "directory-delete-deferred";
      }
      result.counts[item.decision] = (result.counts[item.decision] ?? 0) + 1;
      if (item.error) result.errors.push(new Error(`${key}：${item.error}`));
    }
    result.pendingDirectories = Object.entries(plan).filter(([, item]) => item.pending).map(([key]) => key);
    const protect = protection(plan, input.protectModifyPercentage);
    if (protect.abort) {
      meta.aborted = "protect";
      throw new Error(
        cb.protectError(
          input.protectModifyPercentage,
          protect.count,
          protect.total
        )
      );
    }
    await cb.notify(source, 7); // Existing UI maps dry + 7 to step7skip.
    if (source !== "dry") await executePlan(input, plan, result.errors);
    result.pendingDirectories = Object.entries(plan)
      .filter(([, item]) => item.pending === "directory-delete-deferred")
      .map(([key]) => key);
    if (!result.errors.length && !result.pendingDirectories.length) await cb.notify(source, 8);
  } catch (e) {
    result.errors.push(errorOf(e));
  } finally {
    if (result.errors.length && !meta.aborted) meta.aborted = "error";
    meta.pendingDirectories = result.pendingDirectories;
    meta.outcome = result.errors.length ? "failed" : result.pendingDirectories.length ? "pending" : "converged";
    meta.finishedAt = Date.now();
    try {
      await insertSyncPlanRecordByVault(
        input.db,
        { "/$@meta": meta, ...plan },
        input.vaultRandomID,
        "webdav"
      );
    } catch (e) {
      result.errors.push(errorOf(e));
    }
    // UI failures must never strand the reentry flag.
    try {
      await cb.ribbon(source, 8);
    } catch (e) {
      result.errors.push(errorOf(e));
    }
    try {
      await cb.statusBar(source, 8, result.errors.length === 0, result.pendingDirectories.length);
    } catch (e) {
      result.errors.push(errorOf(e));
    }
    try {
      if (result.errors.length)
        await cb.errNotify(
          source,
          result.errors.length > 1
            ? new AggregateError(result.errors)
            : result.errors[0]
        );
    } finally {
      await cb.markIsSyncing(false);
    }
  }
  result.ok = result.errors.length === 0;
  result.fullyConverged = result.ok && result.pendingDirectories.length === 0;
  return result;
}
