/**
 * 首次同步成功后自动重新加载 Obsidian（不保存）：
 * - A→B 切换后的首次模式 B 同步；
 * - 首次模式 A 同步（演示库）。
 *
 * 为什么模式 A 也需要：Obsidian 仅在配置文件 mtime 变化时自动重读配置，而 iOS 上只在
 * mtime **变新**时重读。学生新建的库总比欢迎库配置新，
 * 首次模式 A 同步写入的欢迎库配置 mtime 更旧，iOS 不会重读，内存停留在默认配置；
 * 重启前一旦触发保存，就会覆盖刚拉下的欢迎库配置，且模式 A 不会纠正。
 *
 * 切换后首次同步把学生库的交付配置与插件拉到本地。此时正在运行的 Obsidian
 * 内存里仍可能是欢迎库的配置，也还没有加载新拉下来的插件：
 * - 若在重启前触发了配置保存（例如翻设置、开图谱），内存里的旧配置会写回磁盘，
 *   而配置目录只拉不推，本地这份错误配置会一直保留；
 * - 新拉下的交付插件要到下次启动才加载。
 *
 * "重新加载 Obsidian（不保存）"（命令 `app:reload`）从磁盘重新读取全部配置并加载插件，
 * 且不会把内存中的配置写回磁盘（Android 与 iOS 上的 Obsidian 1.13.8 均已验证）。
 */

export const RELOAD_COMMAND_ID = "app:reload";
/** 重新加载前提示停留的时间。 */
export const RELOAD_NOTICE_MS = 2500;

export const RELOAD_NOTICE = "NextClaw Sync：已同步学生库，正在重新加载 Obsidian……";
export const RELOAD_NOTICE_A = "NextClaw Sync：已同步演示库，正在重新加载 Obsidian……";
export const RESTART_MANUALLY_NOTICE =
  "NextClaw Sync：已同步学生库。请彻底关闭并重新打开 Obsidian，让学生库的配置与插件生效。";

type Settings = {
  nextclawReloadAfterFirstBSync?: boolean;
  nextclawReloadAfterFirstASync?: boolean;
};
export type ReloadFlag = keyof Settings;

/**
 * A→B 清理成功后调用：打上"待重新加载"标记。调用方负责保存设置。
 * 同时清除模式 A 的标记——已经切到学生库，之后若退回演示库不应再为"首次模式 A 同步"重新加载。
 */
export const markReloadPending = (settings: Settings): void => {
  settings.nextclawReloadAfterFirstBSync = true;
  settings.nextclawReloadAfterFirstASync = false;
};

/**
 * 同步结束后是否应当重新加载。
 *
 * 只在模式 B、非空跑、且本次同步**完全成功**时重新加载。
 * 失败时保留现场与标记，等下一次成功的模式 B 同步再重新加载。
 */
export const shouldReloadAfterSync = (p: {
  pending: boolean | undefined;
  mode: "A" | "B";
  triggerSource: string;
  ok: boolean;
}): boolean =>
  p.pending === true && p.mode === "B" && p.triggerSource !== "dry" && p.ok;

/**
 * 首次模式 A 同步后是否应当重新加载。
 *
 * 标记默认为 true（全新安装与升级后的首次模式 A 同步各重新加载一次），
 * 只在模式 A、非空跑、且本次同步完全成功时重新加载。
 */
export const shouldReloadAfterFirstASync = (p: {
  pending: boolean | undefined;
  mode: "A" | "B";
  triggerSource: string;
  ok: boolean;
}): boolean =>
  p.pending === true && p.mode === "A" && p.triggerSource !== "dry" && p.ok;

export interface ReloadDeps {
  settings: Settings;
  saveSettings(): Promise<void>;
  notice(message: string, timeoutMs: number): void;
  commands: {
    commands: Record<string, unknown>;
    executeCommandById(id: string): boolean;
  };
  delay(ms: number): Promise<void>;
}

/**
 * 执行重新加载。
 *
 * 标记必须**先清除并保存**，再执行命令：重新加载会立即结束当前运行环境，
 * 若标记没落盘，重新加载后的首次同步会再次触发，形成循环。
 *
 * 命令不存在时不执行，改为提示手动重启；标记同样清除，避免每次同步都提示。
 */
const reloadObsidian = async (
  deps: ReloadDeps,
  flag: ReloadFlag,
  notice: string,
  restartNotice: string
): Promise<"reloaded" | "restart-manually"> => {
  deps.settings[flag] = false;
  await deps.saveSettings();

  if (!Object.prototype.hasOwnProperty.call(deps.commands.commands, RELOAD_COMMAND_ID)) {
    deps.notice(restartNotice, 10000);
    return "restart-manually";
  }

  deps.notice(notice, RELOAD_NOTICE_MS);
  await deps.delay(RELOAD_NOTICE_MS);
  deps.commands.executeCommandById(RELOAD_COMMAND_ID);
  return "reloaded";
};

export const reloadAfterFirstBSync = (deps: ReloadDeps) =>
  reloadObsidian(deps, "nextclawReloadAfterFirstBSync", RELOAD_NOTICE, RESTART_MANUALLY_NOTICE);

export const RESTART_MANUALLY_NOTICE_A =
  "NextClaw Sync：已同步演示库。请彻底关闭并重新打开 Obsidian，让演示库的配置生效。";

export const reloadAfterFirstASync = (deps: ReloadDeps) =>
  reloadObsidian(deps, "nextclawReloadAfterFirstASync", RELOAD_NOTICE_A, RESTART_MANUALLY_NOTICE_A);
