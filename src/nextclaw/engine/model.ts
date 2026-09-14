import type { Entity, SyncTriggerSourceType } from "../../baseTypes";
import type { FakeFs } from "../../fsAll";
import type { InternalDBs, NextclawSyncRecord } from "../../localdb";

export type State = "unchanged" | "modified" | "deleted" | "new" | "absent";
export type Decision =
  | "none"
  | "record"
  | "clear"
  | "pull"
  | "push"
  | "mkdirLocal"
  | "mkdirRemote"
  | "deleteLocal"
  | "deleteRemote"
  | "error";
export interface PlanItem {
  local?: Entity;
  remote?: Entity;
  record?: NextclawSyncRecord;
  decision: Decision;
  reason: string;
  change: boolean;
  trash?: boolean;
  error?: string;
}
type Callback = void | Promise<void>;
export interface SyncCallbacks {
  markIsSyncing(value: boolean): Callback;
  notify(source: SyncTriggerSourceType, step: number): Callback;
  ribbon(source: SyncTriggerSourceType, step: number): Callback;
  statusBar(source: SyncTriggerSourceType, step: number, ok: boolean): Callback;
  progress(
    source: SyncTriggerSourceType,
    done: number,
    total: number,
    path: string,
    decision: string
  ): Callback;
  errNotify(source: SyncTriggerSourceType, error: Error): Callback;
  protectError(pct: number, count: number, total: number): string;
}
export interface SyncInput {
  mode: "A" | "B";
  fsLocal: FakeFs;
  fsRemote: FakeFs;
  db: InternalDBs;
  vaultRandomID: string;
  profileID: string;
  configDir: string;
  syncConfigDir: boolean;
  ignorePaths: string[];
  pluginId: string;
  protectModifyPercentage: number;
  concurrency?: number;
  triggerSource: SyncTriggerSourceType;
  callbacks: SyncCallbacks;
}
export interface SyncResult {
  ok: boolean;
  counts: Partial<Record<Decision, number>>;
  errors: Error[];
}
export const folder = (key: string) => key.endsWith("/");
export const name = (e: Entity) => e.key ?? e.keyRaw;
export const rawPath = (e: Entity) => name(e).replace(/\/+$/, "");
export const mtime = (e: Entity, side: "local" | "remote") =>
  (side === "local" ? e.mtimeCli : e.mtimeSvr) ?? e.mtimeCli ?? 0;
export const observation = (e: Entity, side: "local" | "remote") => ({
  mtime: mtime(e, side),
  size: e.size ?? e.sizeRaw,
});
export const inConfig = (key: string, configDir: string) => {
  const dir = configDir.normalize("NFC").replace(/\/+$/, "");
  return key.replace(/\/+$/, "") === dir || key.startsWith(`${dir}/`);
};
export function state(
  e: Entity | undefined,
  record: NextclawSyncRecord | undefined,
  side: "local" | "remote"
): State {
  if (!record) return e ? "new" : "absent";
  if (!e) return "deleted";
  const prev = record[side];
  return record.isFolder ||
    (mtime(e, side) === prev.mtime && (e.size ?? e.sizeRaw) === prev.size)
    ? "unchanged"
    : "modified";
}
export function decodeRecord(value: unknown): NextclawSyncRecord | undefined {
  const r = value as NextclawSyncRecord | null;
  if (
    !r ||
    r.v !== 1 ||
    typeof r.key !== "string" ||
    typeof r.isFolder !== "boolean" ||
    r.isFolder !== folder(r.key)
  )
    return;
  for (const o of [r.local, r.remote]) {
    if (!o || !Number.isFinite(o.mtime) || !Number.isFinite(o.size)) return;
  }
  if (
    r.remoteList !== undefined &&
    (!Array.isArray(r.remoteList) ||
      !r.remoteList.every((x) => typeof x === "string"))
  )
    return;
  return r;
}
export function decideFile(
  local: Entity | undefined,
  remote: Entity | undefined,
  record: NextclawSyncRecord | undefined,
  pullOnly: boolean,
  config: boolean
): Pick<PlanItem, "decision" | "reason" | "trash"> {
  const l = state(local, record, "local"),
    r = state(remote, record, "remote");
  const result = (decision: Decision, reason: string, trash = false) => ({
    decision,
    reason,
    trash,
  });
  if (!record) {
    if (!local) return result(remote ? "pull" : "none", "仅远端存在时拉取");
    if (!remote)
      return result(
        pullOnly ? "none" : "push",
        "本地独有；只拉模式保留且不记记录"
      );
    if (config) return result("pull", "配置无记录，交付配置优先（D9）");
  } else if (pullOnly) {
    if (r === "deleted") return result("clear", "远端已删，保留本地并清记录");
    if (r === "modified") return result("pull", "远端更新，以服务端为准");
    return result("none", "远端未变，保留本地状态和记录");
  } else {
    if (l === "deleted" && r === "deleted")
      return result("clear", "两侧已删，清记录");
    if (l === "deleted")
      return result(
        r === "modified" ? "pull" : "deleteRemote",
        "远端修改则恢复本地，否则传播删除"
      );
    if (r === "deleted")
      return result(
        l === "modified" ? "push" : "deleteLocal",
        "本地修改则恢复远端，否则传播删除"
      );
    if (l === "unchanged")
      return result(r === "modified" ? "pull" : "none", "仅远端变化时拉取");
    if (r === "unchanged") return result("push", "仅本地变化，推送");
  }
  const delta = mtime(local!, "local") - mtime(remote!, "remote");
  if (
    Math.abs(delta) < 1000 &&
    (local!.size ?? local!.sizeRaw) === (remote!.size ?? remote!.sizeRaw)
  )
    return result("record", "时间差小于一秒且大小相同，记录两侧观测值");
  if (Math.abs(delta) < 1000 || delta < 0)
    return result("pull", "两侧冲突，远端胜", !pullOnly);
  return result(pullOnly ? "none" : "push", "两侧冲突，本地更新");
}
export const errorOf = (e: unknown): Error =>
  e instanceof Error ? e : new Error(String(e));
