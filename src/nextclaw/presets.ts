/**
 * 两个分支的设置取值。
 *
 * 括号内为上游默认值，便于看出我们改了什么。
 */
import { detectBranch, accountAddressFor, isManagedAddress } from "./branch";
import { NEXTCLAW_PUBLIC_WEBDAV_URL, NEXTCLAW_REMOTE_BASE_DIR } from "./constants";
import type { NextclawSyncSettings, WebdavConfig } from "../baseTypes";

/** 预设作用的设置对象。测试里常只给出一部分字段，所以全部可选。 */
export type PresetSettings = Omit<Partial<NextclawSyncSettings>, "webdav"> & {
  webdav?: Partial<WebdavConfig>;
};

/** 两个分支都一样的部分。 */
const COMMON = {
  syncConfigDir: true, //          上游 false —— 交付配置全在 .obsidian/ 里
  syncUnderscoreItems: true, //    上游 false —— _meta/ 的仪表盘靠它
  conflictAction: "keep_newer", // 上游同值，写出来是因为整套 mtime 分层依赖它
  /**
   * 删除落到**库内 `.trash`**，不用系统回收站（上游默认 "system"）。
   *
   * 放进 COMMON 而不是只靠 `DEFAULT_SETTINGS`：那样只是"新装时的默认值"。
   * 设置页不显示此项，每次加载由 `enforceHiddenSettings` 强制。
   *
   * 理由见 `src/main.ts` 里 `deleteToWhere` 的说明：核心是不去依赖
   * `trashSystem` 在 Android 应用存储上"失败时诚实返回 false"这一未验证行为。
   */
  deleteToWhere: "obsidian",
  /**
   * 强制 WebDAV。设置界面里的「选择远程服务」已隐藏，若 `serviceType` 因任何
   * 原因不是 `webdav`（导入了别的设置、`data.json` 损坏），用户将**没有任何
   * 途径改回来**——WebDAV 那一段也不会显示，插件看起来彻底坏了。
   * 放进预设即消除这个死角。
   */
  serviceType: "webdav",
} as const;

export const PRESET_A = {
  ...COMMON,
  /**
   * **关闭修改保护**（100 = 关闭，引擎规格约定）。
   *
   * 欢迎库很小（个位数文件，多数是 `.obsidian/` 下的配置）。欢迎库配置一更新，
   * 这几个文件同时判为"远端已修改、要拉取"并计入保护阈值，比例轻易超过 50%，
   * 同步在执行前就被中断——欢迎库的更新拉不下来，用户只看到一条报错。
   *
   * A 分支是从只读公开分享只拉不删：本地不删除，服务端拒绝一切写入。
   * 保护阈值在这里没有可保护的对象，只会误伤。
   */
  protectModifyPercentage: 100,
  /**
   * **只拉，不带删**。
   *
   * 带删的拉取（`incremental_pull_and_delete_only`）会毁掉设备上的插件目录：
   * 它把"本地有、远端没有、但曾经同步过"的目录当作远端已删除。
   * 设备只要**曾经同步过学生库（B）**，`.obsidian/plugins/` 就满足这一条件；
   * 之后一旦再以 A 分支同步，因为**欢迎库根本没有 `plugins/` 目录**，
   * 整个 `.obsidian/plugins/` 被删掉——copilot、dataview、borrax-html
   * 连同同步插件自己一起没，而且**失败完全静默**（插件没了自然不同步）。
   *
   * 触发场景：学生清空用户名、`data.json` 丢失导致回落 A，
   * 或任何让插件重新判成 A 分支的情况。
   *
   * 改用 `incremental_pull_only` 后**不存在任何本地删除**（远端没有的一律跳过），
   * 这一整类破坏消失。代价只有一个：若将来从欢迎库删掉某页，
   * 已同步过的设备会留一份陈旧副本——而 A→B 切换时 `switchAtoB` 会删掉
   * 配置目录以外的全部本地内容，它**不会漏进学生库**。
   */
  syncDirection: "incremental_pull_only",
  // A 分支不自动同步：由用户手动点一次。
  autoRunEveryMilliseconds: -1,
  initRunAfterMilliseconds: -1,
  syncOnSaveAfterMilliseconds: -1,
} as const;

export const PRESET_B = {
  ...COMMON,
  // 学生库约 1440 个文件；A→B 切换时计入保护阈值的只有两边都存在的
  // .obsidian/ 配置，约 23 条（1.6%），远低于 50%。全量拉取走"新建"，不计入。
  protectModifyPercentage: 50,
  syncDirection: "bidirectional",
  autoRunEveryMilliseconds: 600000, //  10 分钟
  initRunAfterMilliseconds: 10000, //   启动后 10 秒
  syncOnSaveAfterMilliseconds: 30000, // **只是开关**，见下
} as const;

/**
 * 移动端（Android 平板 / iPad）对 B 分支的覆盖值。
 *
 * 只覆盖 `initRunAfterMilliseconds`：10 秒 → **30 秒**。平板启动并索引上千个
 * 文件比桌面慢，10 秒容易撞上索引高峰；而这一次同步最有价值
 * （拉服务端的更新、推上次离线写的）。iOS 挂起后台更狠，这条价值更高。
 *
 * `autoRunEveryMilliseconds` 维持 10 分钟：两个平台都会挂起后台定时器，
 * 它实际只在前台生效；"服务端 → 设备"方向的即时性由服务端写入方
 * 主动触发同步解决，不靠缩短轮询。
 *
 * ### `syncOnSaveAfterMilliseconds` 为什么保持开启
 *
 * 学生不是唯一的写入方：服务端另有写入方（例如 AI 助手）会读取并改写同一批笔记。
 * 学生的编辑若最长 10 分钟才上传，服务端写入方就会基于陈旧内容改写，
 * 学生那次编辑在冲突里被判"较旧"而静默丢失。开启后学生一停笔约 3 秒，
 * 编辑即到服务端。配置目录只拉不推，开启它不会造成配置回流。
 */
export const PRESET_B_MOBILE_OVERRIDES = {
  // 必须是设置页下拉里现成的选项之一：-1 / 1000 / 10000 / 30000
  // （src/settings.ts 的 settings_runoncestartup）。取值不在其中时，
  // 计时器仍按原值生效，但下拉显示为空，用户一碰就再也选不回来。
  initRunAfterMilliseconds: 30000,
} as const;

/**
 * 按当前分支覆盖设置。**在分支发生切换时调用**，不要每次渲染都调——
 * B 分支这些项是允许用户改的，无条件覆盖会把他的选择抹掉。
 */
export const applyBranchPreset = (
  settings: PresetSettings,
  isMobile = false
): void => {
  const webdav = (settings.webdav ??= {});
  const branch = detectBranch(webdav);
  Object.assign(settings, branch === "A" ? PRESET_A : PRESET_B);
  // 移动端只覆盖 B 分支：A 分支三个自动触发本来就全关，没有可调的。
  if (branch === "B" && isMobile) {
    Object.assign(settings, PRESET_B_MOBILE_OVERRIDES);
  }

  if (branch === "A") {
    webdav.address = NEXTCLAW_PUBLIC_WEBDAV_URL;
    webdav.remoteBaseDir = NEXTCLAW_REMOTE_BASE_DIR;
  } else {
    // 只在地址仍是"我们生成的"时才跟着用户名重算——
    // 用户可能已经把地址改成了自己的 WebDAV 服务，不能覆盖掉他填的。
    if (isManagedAddress(webdav.address)) {
      webdav.address = accountAddressFor(webdav.username ?? "");
    }
    if ((webdav.remoteBaseDir ?? "").trim() === "") {
      webdav.remoteBaseDir = NEXTCLAW_REMOTE_BASE_DIR;
    }
  }
};

/**
 * 设置页不显示的项，每次加载都强制为预设值（两个分支都适用）。
 *
 * 设置页只保留账号、同步、诊断三组和默认折叠的"其他 WebDAV 服务"。
 * 其余项对用户不可见——若某台设备上的值曾被改过，用户将**没有任何途径改回来**，
 * 所以必须每次加载都覆盖，而不是只在分支切换时套用一次。
 *
 * 可见项（地址、用户名、密码、启动后/定时自动同步、提示级别，以及非 NextClaw 地址下的
 * 远端目录、认证方式、Depth、自定义请求头）保留用户的值，不在此覆盖；
 * 其中模式 A 的项由 `applyBranchPreset` 与本函数的 A 分支部分负责。
 *
 * 返回 `remoteBaseDirReset`：远端目录被改回默认值时为 true。调用方须在下次同步前
 * 清空同步记录——记录按路径保存，不含远端目录，目录一换，旧记录会让另一侧的文件
 * 全部被判为"已删除"。
 */
export const enforceHiddenSettings = (
  settings: PresetSettings
): { remoteBaseDirReset: boolean } => {
  const webdav = (settings.webdav ??= {});
  const branch = detectBranch(webdav);
  const preset = branch === "A" ? PRESET_A : PRESET_B;

  Object.assign(settings, COMMON);
  settings.syncDirection = preset.syncDirection;
  settings.protectModifyPercentage = preset.protectModifyPercentage;
  settings.syncOnSaveAfterMilliseconds = preset.syncOnSaveAfterMilliseconds;

  settings.syncBookmarks = false;
  settings.skipSizeLargerThan = -1;
  settings.onlyAllowPaths = [];
  settings.ignorePaths = [];
  settings.concurrency = 5;
  settings.enableStatusBarInfo = true;
  settings.enableMobileStatusBar = true;
  settings.obfuscateSettingFile = true;

  if (branch === "A") {
    // 演示库：折叠区块里的三项同样锁定，值必须是能连通公开分享的那组。
    webdav.authType = "basic";
    webdav.depth = "manual_1";
    webdav.manualRecursive = true;
    webdav.customHeaders = "";
  }

  let remoteBaseDirReset = false;
  if (isManagedAddress(webdav.address) && webdav.remoteBaseDir !== NEXTCLAW_REMOTE_BASE_DIR) {
    // 空值也算改动：上游在空值时回落为本地库名，那也是另一个远端目录。
    remoteBaseDirReset = true;
    webdav.remoteBaseDir = NEXTCLAW_REMOTE_BASE_DIR;
  }
  return { remoteBaseDirReset };
};
