/**
 * Only type defs here.
 * To avoid circular dependency.
 */

import type { LangTypeAndAuto } from "./i18n";

export type SUPPORTED_SERVICES_TYPE = "webdav";

export type WebdavAuthType = "digest" | "basic";
export type WebdavDepthType =
  | "auto" // deprecated on 20240116
  | "auto_unknown" // deprecated on 20240116
  | "auto_1" // deprecated on 20240116
  | "auto_infinity" // deprecated on 20240116
  | "manual_1"
  | "manual_infinity";

export interface WebdavConfig {
  address: string;
  username: string;
  password: string;
  authType: WebdavAuthType;

  depth?: WebdavDepthType;
  remoteBaseDir?: string;

  customHeaders?: string;

  /** 与 depth 保持一致（manual_1 时为 true），供旧版本读取。 */
  manualRecursive: boolean;
}

export type SyncDirectionType =
  | "bidirectional"
  | "incremental_pull_only"
  | "incremental_push_only"
  | "incremental_pull_and_delete_only"
  | "incremental_push_and_delete_only";

/**
 * 一次同步的计划：路径 → 该路径的决策记录（外加 `/$@meta` 元信息）。
 * 只用于持久化与「导出同步计划」调试，因此不约束记录的具体形状。
 */
export type SyncPlanType = Record<string, unknown>;

export interface NextclawSyncSettings {
  /**
   * NextClaw：A→B 切换待执行。
   *
   * 切换不能在用户键入用户名第一个字符时就做——他还没输完。
   * 这里只打标记，真正的删除与清记录推迟到**下一次同步开始前**执行。
   */
  nextclawPendingSwitchToB?: boolean;
  /**
   * NextClaw：A→B 切换已执行，等待首次模式 B 同步成功后重新加载 Obsidian。
   * 见 nextclaw/reloadAfterSwitch.ts。
   */
  nextclawReloadAfterFirstBSync?: boolean;
  /**
   * NextClaw：首次模式 A 同步成功后重新加载 Obsidian。默认 true。
   * 见 nextclaw/reloadAfterSwitch.ts。
   */
  nextclawReloadAfterFirstASync?: boolean;
  /**
   * NextClaw：远端目录已变更，下次同步开始前须清空同步记录。
   * 记录按路径保存、不含远端目录；目录一换，旧记录会让另一侧的文件全部被判为"已删除"。
   */
  nextclawPendingRecordReset?: boolean;
  /**
   * NextClaw：用户已确认在有文件的库里同步演示库。见 nextclaw/existingVaultGuard.ts。
   */
  nextclawExistingVaultAcknowledged?: boolean;
  webdav: WebdavConfig;

  /** 固定为 "webdav"。本地数据库按 `${serviceType}-default-1` 区分同步记录，不能改。 */
  serviceType: "webdav";
  currLogLevel?: string;
  autoRunEveryMilliseconds?: number;
  initRunAfterMilliseconds?: number;
  syncOnSaveAfterMilliseconds?: number;

  concurrency?: number;
  syncConfigDir?: boolean;
  syncBookmarks?: boolean;
  syncUnderscoreItems?: boolean;
  lang?: LangTypeAndAuto;
  skipSizeLargerThan?: number;
  ignorePaths?: string[];
  onlyAllowPaths?: string[];
  enableStatusBarInfo?: boolean;
  deleteToWhere?: "system" | "obsidian";
  conflictAction?: ConflictActionType;

  protectModifyPercentage?: number;
  syncDirection?: SyncDirectionType;

  obfuscateSettingFile?: boolean;

  enableMobileStatusBar?: boolean;

}

export type ConflictActionType =
  | "keep_newer"
  | "keep_larger";

/**
 * uniform representation
 * everything should be flat and primitive, so that we can copy.
 */
export interface Entity {
  key?: string;
  keyEnc?: string;
  keyRaw: string;
  mtimeCli?: number;
  mtimeCliFmt?: string;
  ctimeCli?: number;
  ctimeCliFmt?: string;
  mtimeSvr?: number;
  mtimeSvrFmt?: string;
  prevSyncTime?: number;
  prevSyncTimeFmt?: string;
  size?: number; // might be unknown or to be filled
  sizeEnc?: number;
  sizeRaw: number;
  hash?: string;
  etag?: string;
  synthesizedFolder?: boolean;
  synthesizedFile?: boolean;
}

/** 导出同步计划等调试文件的目录。旧版名称 `_debug_remotely_save/` 仍被同步过滤排除。 */
export const DEFAULT_DEBUG_FOLDER = "_nextclaw_debug/";
export const DEFAULT_SYNC_PLANS_HISTORY_FILE_PREFIX =
  "sync_plans_hist_exported_on_";

export type SyncTriggerSourceType =
  | "manual"
  | "dry"
  | "auto"
  | "auto_once_init"
  | "auto_sync_on_save";
