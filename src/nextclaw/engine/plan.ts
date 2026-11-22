import XRegExp from "xregexp";
import type { Entity } from "../../baseTypes";
import type { NextclawSyncRecord } from "../../localdb";
import {
  decodeRecord,
  decideFile,
  folder,
  name,
  inConfig,
  type PlanItem,
  type SyncInput,
} from "./model";

export function makeFilter(
  input: Pick<SyncInput, "configDir" | "syncConfigDir" | "ignorePaths">
) {
  const patterns = input.ignorePaths
    .filter((x) => x.trim())
    .map((x) => XRegExp(x, "A"));
  // Exact names from specification §4.2 (the legacy helper also skips unrelated Office names).
  const special = new Set([
    ".git",
    ".github",
    ".gitlab",
    ".svn",
    "node_modules",
    ".DS_Store",
    "__MACOSX",
    "desktop.ini",
    "Desktop.ini",
    "thumbs.db",
    "Thumbs.db",
    "Icon\r",
  ]);
  return (key: string) => {
    const config = inConfig(key, input.configDir);
    const parts = key.replace(/\/+$/, "").split("/");
    if (parts.some((p) => special.has(p))) return false;
    if (
      parts.some((p) => p.startsWith(".")) &&
      !(config && input.syncConfigDir)
    )
      return false;
    if (
      key === ".trash/" ||
      key.startsWith(".trash/") ||
      key === "_nextclaw_debug/" ||
      key.startsWith("_nextclaw_debug/") ||
      key === "_debug_remotely_save/" ||
      key.startsWith("_debug_remotely_save/")
    )
      return false;
    if (
      config &&
      ["workspace.json", "workspace-mobile.json", "workspace"].includes(
        parts[parts.length - 1]
      )
    )
      return false;
    return !patterns.some((p) => XRegExp.test(key, p));
  };
}
export function buildPlan(
  input: SyncInput,
  locals: Entity[],
  remotes: Entity[],
  records: unknown[]
) {
  const keep = makeFilter(input);
  const blocked = new Set<string>();
  function index(entries: Entity[]) {
    const map = new Map<string, Entity>();
    const cases = new Map<string, string>();
    for (const entry of entries) {
      const key = name(entry).normalize("NFC");
      if (key === "" || key === "/" || !keep(key)) continue;
      if (
        key.startsWith("/") ||
        key.split("/").some((p) => p === ".." || p === ".") ||
        key.includes("\0")
      )
        throw new Error("文件清单包含非相对路径");
      const lower = key.toLowerCase().replace(/\/$/, "");
      const previous = cases.get(lower);
      if (previous !== undefined && previous !== key) {
        blocked.add(previous);
        blocked.add(key);
      }
      if (map.has(key) && name(map.get(key)!) !== name(entry)) blocked.add(key);
      cases.set(lower, key);
      map.set(key, entry);
    }
    // Some adapters omit directory entries. Parents are still observed to exist.
    for (const [, entry] of [...map]) {
      const parts = name(entry).replace(/\/$/, "").split("/");
      for (let i = 1; i < parts.length; i++) {
        const raw = `${parts.slice(0, i).join("/")}/`,
          parent = raw.normalize("NFC");
        if (keep(parent) && !map.has(parent))
          map.set(parent, { key: raw, keyRaw: raw, size: 0, sizeRaw: 0 });
      }
    }
    // Include implicit parents in collision detection as well.
    const allCases = new Map<string, string>();
    for (const key of map.keys()) {
      const lower = key.toLowerCase().replace(/\/$/, "");
      const prev = allCases.get(lower);
      if (prev && prev !== key) {
        blocked.add(prev);
        blocked.add(key);
      }
      allCases.set(lower, key);
    }
    return map;
  }
  const local = index(locals),
    remote = index(remotes);
  const prev = new Map<string, NextclawSyncRecord>();
  for (const value of records) {
    const r = decodeRecord(value);
    if (r && keep(r.key.normalize("NFC"))) prev.set(r.key.normalize("NFC"), r);
  }
  const keys = new Set([...local.keys(), ...remote.keys(), ...prev.keys()]);
  // A file and a directory cannot occupy the same filesystem location.
  for (const key of keys)
    if (!folder(key) && keys.has(`${key}/`)) {
      blocked.add(key);
      blocked.add(`${key}/`);
    }
  const plan: Record<string, PlanItem> = Object.create(null) as Record<string, PlanItem>;
  for (const key of [...keys].sort()) {
    const l = local.get(key),
      r = remote.get(key),
      record = prev.get(key);
    if (
      [...blocked].some((b) => key === b || (folder(b) && key.startsWith(b)))
    ) {
      plan[key] = {
        local: l,
        remote: r,
        record,
        decision: "error",
        reason: "路径大小写、规范化或文件类型冲突，不处理",
        change: false,
        error: "路径冲突",
      };
      continue;
    }
    const config = inConfig(key, input.configDir),
      pullOnly = input.mode === "A" || config;
    const chosen = folder(key)
      ? { decision: "none" as const, reason: "待判定文件夹" }
      : decideFile(l, r, record, pullOnly, config);
    plan[key] = {
      local: l,
      remote: r,
      record,
      ...chosen,
      change: ["pull", "push", "deleteLocal", "deleteRemote"].includes(
        chosen.decision
      ),
    };
  }
  for (const key of Object.keys(plan)
    .filter(folder)
    .sort((a, b) => b.length - a.length)) {
    const item = plan[key];
    if (item.error) continue;
    const { local: l, remote: r, record } = item;
    const pullOnly = input.mode === "A" || inConfig(key, input.configDir);
    let decision: PlanItem["decision"];
    if (l && r) decision = record ? "none" : "record";
    else if (!l && !r) decision = record ? "clear" : "none";
    else if (pullOnly) decision = r ? "mkdirLocal" : record ? "clear" : "none";
    else if (!record) decision = l ? "mkdirRemote" : "mkdirLocal";
    else {
      const survives = Object.entries(plan).some(
        ([child, p]) =>
          child !== key &&
          child.startsWith(key) &&
          (!!p.error ||
            (!["deleteLocal", "deleteRemote", "clear"].includes(p.decision) &&
              (!!p.local || !!p.remote)))
      );
      decision = survives
        ? l
          ? "mkdirRemote"
          : "mkdirLocal"
        : l
          ? "deleteLocal"
          : "deleteRemote";
    }
    item.decision = decision;
    item.reason = "按文件夹存在状态和同步后子项判定";
    item.change = [
      "mkdirLocal",
      "mkdirRemote",
      "deleteLocal",
      "deleteRemote",
    ].includes(decision);
  }
  return plan;
}
export function protection(plan: Record<string, PlanItem>, pct: number) {
  const files = Object.entries(plan).filter(([key]) => !folder(key));
  const count = files.filter(
    ([, p]) =>
      (p.decision === "pull" && p.local) ||
      (p.decision === "push" && p.remote) ||
      p.decision === "deleteLocal" ||
      p.decision === "deleteRemote"
  ).length;
  return {
    count,
    total: files.length,
    abort: files.length > 0 && pct < 100 && count * 100 >= files.length * pct,
  };
}
