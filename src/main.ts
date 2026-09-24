// biome-ignore lint/suspicious/noShadowRestrictedNames: <explanation>
import AggregateError from "aggregate-error";
import {
  Events,
  debounce,
  FileSystemAdapter,
  Notice,
  Platform,
  Plugin,
  setIcon,
} from "obsidian";
import { runSync } from "./nextclaw/syncEngine";
import type {
  NextclawSyncSettings,
  SyncTriggerSourceType,
} from "./baseTypes";
import { messyConfigToNormal, normalConfigToMessy } from "./configPersist";
import { exportVaultSyncPlansToFiles } from "./debugMode";
import { getClient } from "./fsGetter";
import { FakeFsLocal } from "./fsLocal";
import { DEFAULT_WEBDAV_CONFIG } from "./fsWebdav";
import { I18n } from "./i18n";
import type { LangTypeAndAuto, TransItemType, TransVars } from "./i18n";
import {
  type InternalDBs,
  clearAllPrevSyncRecordByVault,
  getAllPrevSyncRecordsByVaultAndProfile,
  insertSyncPlanRecordByVault,
  clearAllLoggerOutputRecords,
  clearExpiredSyncPlanRecords,
  getLastFailedSyncTimeByVault,
  getLastSuccessSyncTimeByVault,
  prepareDBs,
  upsertLastFailedSyncTimeByVault,
  upsertLastSuccessSyncTimeByVault,
  upsertPluginVersionByVault,
} from "./localdb";
import { changeMobileStatusBar, setMobileStatusBarIdle } from "./misc";
import {
  type MobileStatusBarState,
  SUCCESS_VISIBLE_MS,
  shouldShowMobileStatusBar,
} from "./nextclaw/mobileStatusBar";
import { relativeTimeText } from "./statusBarTime";
import { NextclawSyncSettingTab } from "./settings";

import { NEXTCLAW_WEBDAV_DEFAULTS } from "./nextclaw/constants";
import { switchAtoB, formatReceipt } from "./nextclaw/switchAtoB";
import {
  markReloadPending,
  reloadAfterFirstASync,
  reloadAfterFirstBSync,
  shouldReloadAfterFirstASync,
  shouldReloadAfterSync,
  type ReloadDeps,
} from "./nextclaw/reloadAfterSwitch";
import { detectBranch, effectiveIgnorePaths } from "./nextclaw/branch";
import { applyBranchPreset, enforceHiddenSettings } from "./nextclaw/presets";
import { canAskNow, evaluateGuard } from "./nextclaw/existingVaultGuard";
import {
  isStudentAccountOnDesktop,
  needsPasswordBeforeSync,
} from "./nextclaw/accountPolicy";
import { confirmExistingVault } from "./nextclaw/existingVaultModal";
const DEFAULT_SETTINGS: NextclawSyncSettings = {
  // NextClaw：叠加预填值。展开顺序保证上游新增字段自动继承默认。
  webdav: { ...DEFAULT_WEBDAV_CONFIG, ...NEXTCLAW_WEBDAV_DEFAULTS },
  serviceType: "webdav", // NextClaw：只支持 WebDAV
  nextclawPendingSwitchToB: false, // NextClaw
  nextclawReloadAfterFirstBSync: false, // NextClaw
  nextclawReloadAfterFirstASync: true, // NextClaw：全新安装的首次模式 A 同步后重新加载
  nextclawPendingRecordReset: false, // NextClaw
  nextclawExistingVaultAcknowledged: false, // NextClaw
  currLogLevel: "info",
  autoRunEveryMilliseconds: -1,
  initRunAfterMilliseconds: -1,
  syncOnSaveAfterMilliseconds: -1,
  concurrency: 5,
  syncConfigDir: false,
  syncBookmarks: false,
  syncUnderscoreItems: false,
  lang: "auto",
  skipSizeLargerThan: -1,
  ignorePaths: [],
  onlyAllowPaths: [],
  enableStatusBarInfo: true,
  /**
   * NextClaw：删除落到 **Obsidian 的库内 `.trash`**，不用系统回收站
   *（上游默认 "system"）。
   *
   * 上游 `"system"` 的逻辑是"先试系统回收站，**返回 false 才回退**到 `.trash`"
   *（`src/fsLocal.ts` 的 `rm`）。这条回退链依赖 `trashSystem` 在失败时
   * **诚实地返回 false**。
   *
   * 移动端的库常建在**应用存储**而非设备存储，那里的"系统回收站"行为不可控——
   * 若它返回 true 却什么也没做，或丢到用户够不到的地方，回退就不会触发，
   * 文件直接没了。**少一条行为不确定的依赖，比赌它行为正确划算**。
   *
   * 改成 `"obsidian"` 的四条好处：
   * ① 确定性：一个行为，两个平台一致，不依赖回退；
   * ② 可达性：`.trash` 在库内，学生用文件管理器就能翻到；
   * ③ 不污染同步：`.trash` 是隐藏目录，`vault.getAllLoadedFiles()` 不返回它，
   *    **不会被推上服务端**（已核 `src/fsLocal.ts` 的 `walk`）；
   * ④ A→B 切换更安全：`switchAtoB` 删掉的欢迎库内容落进 `.trash`，
   *    万一学生真在演示库里写过东西，捞得回来。
   *
   * 代价：`.trash` 占设备存储且 Obsidian 不自动清理。按本产品的量级
   *（欢迎库 2 个文件 + 偶发冲突）可忽略，交付手册里提一句即可。
   *
   * 引擎规格要求：同步引擎删除本地文件**与目录**都必须走 `fsLocal.rm`，
   * 本设置才对所有删除一致生效。
   */
  deleteToWhere: "obsidian",
  conflictAction: "keep_newer",
  protectModifyPercentage: 50,
  syncDirection: "bidirectional",
  obfuscateSettingFile: true,
  enableMobileStatusBar: false,
};

const LEGACY_SETTING_KEYS = [
  "s3",
  "dropbox",
  "onedrive",
  "webdis",
  "password",
  "encryptionMethod",
  "agreeToUseSyncV3",
  "profiler",
  "agreeToUploadExtraMetadata",
  "logToDB",
  "howToCleanEmptyFolder",
  "vaultRandomID",
];

// Obsidian 自带的 Lucide 图标。
const iconNameSyncWait = "rotate-ccw";
const iconNameSyncRunning = "refresh-ccw";
const iconNameLogs = "file-text";

const getStatusBarShortMsgFromSyncSource = (
  t: (x: TransItemType, vars?: TransVars) => string,
  s: SyncTriggerSourceType | undefined
) => {
  if (s === undefined) {
    return "";
  }
  switch (s) {
    case "manual":
      return t("statusbar_sync_source_manual");
    case "dry":
      return t("statusbar_sync_source_dry");
    case "auto":
      return t("statusbar_sync_source_auto");
    case "auto_once_init":
      return t("statusbar_sync_source_auto_once_init");
    case "auto_sync_on_save":
      return t("statusbar_sync_source_auto_sync_on_save");
    default:
      throw Error(`no translate for ${String(s)}`);
  }
};

export default class NextclawSyncPlugin extends Plugin {
  settings!: NextclawSyncSettings;
  db!: InternalDBs;
  isSyncing!: boolean;
  hasPendingSyncOnSave!: boolean;
  statusBarElement!: HTMLSpanElement;
  currLogLevel!: string;
  currSyncMsg?: string;
  syncRibbon?: HTMLElement;
  autoRunIntervalID?: number;
  syncOnSaveIntervalID?: number;
  i18n!: I18n;
  vaultRandomID!: string;
  syncEvent?: Events;
  appContainerObserver?: MutationObserver;
  /** 移动端状态条"同步成功后淡出"的一次性定时器。 */
  mobileStatusBarTimer?: number;
  /** 本次运行已提示过"需要手动同步确认"，自动同步不再重复提示。 */
  existingVaultNoticeShown = false;
  /** 本次运行已提示过"桌面端不能同步学生账号"，自动同步不再重复提示。 */
  desktopBlockNoticeShown = false;
  /** 本次运行已提示过"还需要填写密码"，自动同步不再重复提示。 */
  passwordNoticeShown = false;

  async syncRun(triggerSource: SyncTriggerSourceType = "manual") {
    if (this.isSyncing) {
      if (triggerSource === "manual" || triggerSource === "dry") new Notice(this.i18n.t("syncrun_alreadyrunning", { pluginName: this.manifest.name, syncStatus: "running", newTriggerSource: triggerSource }));
      return;
    }
    // NextClaw：桌面端不同步学生账号（付费内容只交付到平板），见 nextclaw/accountPolicy.ts。
    // 必须在一切之前：A→B 切换会把本地内容移进 .trash，被拦下时一个文件都不能动，
    // 也不能发出任何请求。
    if (isStudentAccountOnDesktop(this.settings.webdav, Platform.isDesktopApp)) {
      // 手动触发每次都提示；自动触发（启动、定时、保存后）只提示一次，免得刷屏。
      if (triggerSource === "manual" || triggerSource === "dry" || !this.desktopBlockNoticeShown) {
        this.desktopBlockNoticeShown = true;
        new Notice(this.i18n.t("nextclaw_desktop_student_blocked"), 10 * 1000);
      }
      return;
    }
    // NextClaw：学生账号没填密码就不同步。分支判据是用户名，所以"填了用户名、
    // 还没填密码"这段时间里插件已经是 B 分支，放行的话 A→B 切换会把演示库内容
    // 移进 .trash，然后因为没有密码而同步失败。见 nextclaw/accountPolicy.ts。
    if (needsPasswordBeforeSync(this.settings.webdav)) {
      if (triggerSource === "manual" || triggerSource === "dry" || !this.passwordNoticeShown) {
        this.passwordNoticeShown = true;
        new Notice(this.i18n.t("nextclaw_password_required"), 10 * 1000);
      }
      return;
    }
    this.isSyncing = true;
    const startedAt = Date.now();
    try {
      const fsLocal = new FakeFsLocal(
        this.app.vault,
        this.settings.syncConfigDir ?? false,
        false,
        this.app.vault.configDir,
        this.manifest.id,
        this.settings.deleteToWhere ?? "obsidian" // NextClaw
      );
      const fsRemote = getClient(
        this.settings,
        this.app.vault.getName(),
        async () => await this.saveSettings()
      );


      const t = (x: TransItemType, vars?: TransVars) => {
        return this.i18n.t(x, vars);
      };

      const profileID = this.getCurrProfileID();

      const getProtectError = (
        protectModifyPercentage: number,
        realModifyDeleteCount: number,
        allFilesCount: number
      ) => {
        const percent = ((100 * realModifyDeleteCount) / allFilesCount).toFixed(
          1
        );
        const res = t("syncrun_abort_protectmodifypercentage", {
          protectModifyPercentage,
          realModifyDeleteCount,
          allFilesCount,
          percent,
        });
        return res;
      };

      const getNotice = (
        s: SyncTriggerSourceType,
        msg: string,
        timeout?: number
      ) => {
        if (s === "manual" || s === "dry") {
          new Notice(msg, timeout);
        }
      };

      const notifyFunc = async (s: SyncTriggerSourceType, step: number) => {
        switch (step) {
          case 0:
            if (s === "dry") {
              if (this.settings.currLogLevel === "info") {
                getNotice(s, t("syncrun_shortstep0"));
              } else {
                getNotice(s, t("syncrun_step0"));
              }
            }

            break;

          case 1:
            if (this.settings.currLogLevel === "info") {
              getNotice(
                s,
                t("syncrun_shortstep1", {
                  serviceType: this.settings.serviceType,
                })
              );
            } else {
              getNotice(
                s,
                t("syncrun_step1", {
                  serviceType: this.settings.serviceType,
                })
              );
            }
            break;

          case 2:
            if (this.settings.currLogLevel === "info") {
              // pass
            } else {
              getNotice(s, t("syncrun_step2"));
            }
            break;

          case 3:
            if (this.settings.currLogLevel === "info") {
              // pass
            } else {
              getNotice(s, t("syncrun_step3"));
            }
            break;

          case 4:
            if (this.settings.currLogLevel === "info") {
              // pass
            } else {
              getNotice(s, t("syncrun_step4"));
            }
            break;

          case 5:
            if (this.settings.currLogLevel === "info") {
              // pass
            } else {
              getNotice(s, t("syncrun_step5"));
            }
            break;

          case 6:
            if (this.settings.currLogLevel === "info") {
              // pass
            } else {
              getNotice(s, t("syncrun_step6"));
            }
            break;

          case 7:
            if (s === "dry") {
              if (this.settings.currLogLevel === "info") {
                getNotice(s, t("syncrun_shortstep2skip"));
              } else {
                getNotice(s, t("syncrun_step7skip"));
              }
            } else {
              if (this.settings.currLogLevel === "info") {
                // pass
              } else {
                getNotice(s, t("syncrun_step7"));
              }
            }
            break;

          case 8:
            if (this.settings.currLogLevel === "info") {
              getNotice(s, t("syncrun_shortstep2"));
            } else {
              getNotice(s, t("syncrun_step8"));
            }
            break;

          default:
            throw Error(`unknown step=${step} for showing notice`);
        }
      };

      const errNotifyFunc = async (s: SyncTriggerSourceType, error: Error) => {
        console.error(error);
        if (error instanceof AggregateError) {
          for (const e of error.errors) {
            getNotice(s, (e as Error).message, 10 * 1000);
          }
        } else {
          getNotice(s, error?.message ?? "error while sync", 10 * 1000);
        }
      };

      const ribboonFunc = async (s: SyncTriggerSourceType, step: number) => {
        if (step === 1) {
          if (this.syncRibbon !== undefined) {
            setIcon(this.syncRibbon, iconNameSyncRunning);
            this.syncRibbon.setAttribute(
              "aria-label",
              t("syncrun_syncingribbon", {
                pluginName: this.manifest.name,
                triggerSource: s,
              })
            );
          }
        } else if (step === 8) {
          // last step
          if (this.syncRibbon !== undefined) {
            setIcon(this.syncRibbon, iconNameSyncWait);
            const originLabel = `${this.manifest.name}`;
            this.syncRibbon.setAttribute("aria-label", originLabel);
          }
        }
      };

      const statusBarFunc = async (
        s: SyncTriggerSourceType,
        step: number,
        everythingOk: boolean
      ) => {
        if (step === 1) {
          // change status to "syncing..." on statusbar
          this.updateLastSyncMsg(s, "syncing", -1, -1);
        } else if (step === 8 && everythingOk) {
          const ts = Date.now();
          await upsertLastSuccessSyncTimeByVault(this.db, this.vaultRandomID, ts);
          this.updateLastSyncMsg(s, "not_syncing", ts, null); // hack: 'not_syncing'
        } else if (!everythingOk) {
          const ts = Date.now();
          await upsertLastFailedSyncTimeByVault(this.db, this.vaultRandomID, ts);
          this.updateLastSyncMsg(s, "not_syncing", null, ts);
        }
      };

      const markIsSyncingFunc = async (isSyncing: boolean) => {
        this.isSyncing = isSyncing;
      };

      const callbackSyncProcess = async (
        s: SyncTriggerSourceType,
        realCounter: number,
        realTotalCount: number,
        pathName: string,
        decision: string
      ) => {
        this.setCurrSyncMsg(
          t,
          s,
          realCounter,
          realTotalCount,
          pathName,
          decision,
          triggerSource
        );
      };

      const mode = this.settings.syncDirection === "incremental_pull_only" ? "A"
        : this.settings.syncDirection === "bidirectional" ? "B" : undefined;
      if (!mode) throw new Error("不支持的同步方向");

      // NextClaw：装进已有笔记的库时，首次同步演示库与 A→B 切换之前先确认。
      // 见 nextclaw/existingVaultGuard.ts。
      const guard = await evaluateGuard({
        mode,
        triggerSource,
        pendingSwitchToB: this.settings.nextclawPendingSwitchToB === true,
        acknowledgedFirstDemoSync: this.settings.nextclawExistingVaultAcknowledged === true,
        configDir: this.app.vault.configDir,
        readRecordKeys: async () =>
          (await getAllPrevSyncRecordsByVaultAndProfile(this.db, this.vaultRandomID, profileID)).map(
            (r) => r.key ?? r.keyRaw
          ),
        walk: () => fsLocal.walk(),
      });
      if (guard !== null) {
        if (!canAskNow(triggerSource)) {
          if (!this.existingVaultNoticeShown) {
            this.existingVaultNoticeShown = true;
            new Notice(t("nextclaw_guard_manual_required", { count: guard.fileCount }), 10 * 1000);
          }
          return;
        }
        if (!(await confirmExistingVault(this.app, t, guard))) {
          new Notice(t("nextclaw_guard_cancelled"));
          return;
        }
        if (guard.kind === "first-demo-sync") {
          this.settings.nextclawExistingVaultAcknowledged = true;
          await this.saveSettings();
        }
      }

      // NextClaw：A→B 切换，必须在本次同步**开始之前**做完。
      // 枚举本地 → 删配置目录与 .trash 以外的全部顶层条目 → 清 prevSync。
      // 见 nextclaw/switchAtoB.ts。
      if (this.settings.nextclawPendingSwitchToB === true && triggerSource !== "dry") {
        const receipt = await switchAtoB({
          db: this.db,
          vaultRandomID: this.vaultRandomID,
          fsLocal: fsLocal,
          configDir: this.app.vault.configDir,
        });
        console.debug(formatReceipt(receipt));
        if (receipt.failed.length) throw new Error("A→B 清理未完成，请重试；本次未同步");
        // 标记只在切换**成功执行**后清掉。上面任何一步抛异常都会让本次
        // syncRun 中止而标记仍在，下次同步会重来——宁可重做，不可漏做：
        // 漏做的后果是欢迎库的内容被推进学生库。
        this.settings.nextclawPendingSwitchToB = false;
        // 首次模式 B 同步成功后重新加载 Obsidian，见 nextclaw/reloadAfterSwitch.ts。
        markReloadPending(this.settings);
        await this.saveSettings();
      }

      // NextClaw：远端目录变更后，同步记录对应的是旧目录，必须先清空。
      if (this.settings.nextclawPendingRecordReset === true && triggerSource !== "dry") {
        await clearAllPrevSyncRecordByVault(this.db, this.vaultRandomID);
        this.settings.nextclawPendingRecordReset = false;
        await this.saveSettings();
      }

      const result = await runSync({
        mode, fsLocal, fsRemote, db: this.db, triggerSource, profileID,
        vaultRandomID: this.vaultRandomID,
        configDir: this.app.vault.configDir,
        syncConfigDir: this.settings.syncConfigDir ?? false,
        pluginId: this.manifest.id,
        ignorePaths: effectiveIgnorePaths(this.settings.ignorePaths, this.manifest.id, this.app.vault.configDir),
        protectModifyPercentage: this.settings.protectModifyPercentage ?? (mode === "A" ? 100 : 50),
        concurrency: this.settings.concurrency ?? 5,
        callbacks: {
          protectError: getProtectError, markIsSyncing: markIsSyncingFunc,
          notify: notifyFunc, errNotify: errNotifyFunc, ribbon: ribboonFunc,
          statusBar: statusBarFunc, progress: callbackSyncProcess,
        },
      });

      this.syncEvent?.trigger("SYNC_DONE");

      const reloadDeps = {
        settings: this.settings,
        saveSettings: async () => await this.saveSettings(),
        notice: (message: string, timeoutMs: number) => new Notice(message, timeoutMs),
        commands: (this.app as unknown as { commands: ReloadDeps["commands"] }).commands,
        delay: (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
      };
      if (
        shouldReloadAfterSync({
          pending: this.settings.nextclawReloadAfterFirstBSync,
          mode,
          triggerSource,
          ok: result.ok,
        })
      ) {
        // 引擎结束时已把 isSyncing 复位；这里重新置位，挡住提示等待期间的新同步
        // （例如保存时同步），免得它被重新加载中途打断。finally 会复位。
        this.isSyncing = true;
        await reloadAfterFirstBSync(reloadDeps);
      } else if (
        shouldReloadAfterFirstASync({
          pending: this.settings.nextclawReloadAfterFirstASync,
          mode,
          triggerSource,
          ok: result.ok,
        })
      ) {
        this.isSyncing = true;
        await reloadAfterFirstASync(reloadDeps);
      }
    } catch (error) {
      await insertSyncPlanRecordByVault(this.db, {
        "/$@meta": {
          mode: this.settings.syncDirection === "incremental_pull_only" ? "A" : this.settings.syncDirection === "bidirectional" ? "B" : "invalid",
          triggerSource, startedAt, finishedAt: Date.now(), aborted: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      }, this.vaultRandomID, "webdav");
      await upsertLastFailedSyncTimeByVault(this.db, this.vaultRandomID, Date.now());
      this.updateLastSyncMsg(triggerSource, "not_syncing", null, Date.now());
      if (triggerSource === "manual" || triggerSource === "dry") new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      this.isSyncing = false;
    }
  }

  async onload() {
    this.currSyncMsg = "";
    this.isSyncing = false;
    this.hasPendingSyncOnSave = false;

    this.syncEvent = new Events();

    await this.loadSettings();

    // MUST after loadSettings and before prepareDB
    const profileID: string = this.getCurrProfileID();

    // lang should be load early, but after settings
    this.i18n = new I18n(this.settings.lang!, async (lang: LangTypeAndAuto) => {
      this.settings.lang = lang;
      await this.saveSettings();
    });
    const t = (x: TransItemType, vars?: TransVars) => {
      return this.i18n.t(x, vars);
    };

    void this.tryToAddIgnoreFile();

    const vaultBasePath = this.getVaultBasePath();

    try {
      await this.prepareDBAndVaultRandomID(vaultBasePath, profileID);
    } catch (err) {
      new Notice(
        err instanceof Error ? err.message : "error of prepareDBAndVaultRandomID",
        10 * 1000
      );
      throw err;
    }

    // must AFTER preparing DB
    this.enableAutoClearOutputToDBHistIfSet();

    // must AFTER preparing DB
    this.enableAutoClearSyncPlanHist();

    this.syncRibbon = this.addRibbonIcon(
      iconNameSyncWait,
      `${this.manifest.name}`,
      async () => this.syncRun("manual")
    );

    this.enableMobileStatusBarIfSet();

    // Create Status Bar Item
    if (
      (!Platform.isMobile ||
        (Platform.isMobile && this.settings.enableMobileStatusBar)) &&
      this.settings.enableStatusBarInfo === true
    ) {
      const statusBarItem = this.addStatusBarItem();
      this.statusBarElement = statusBarItem.createSpan();
      this.statusBarElement.setAttribute("data-tooltip-position", "top");

      if (!this.isSyncing) {
        this.updateLastSyncMsg(
          undefined,
          "not_syncing",
          await getLastSuccessSyncTimeByVault(this.db, this.vaultRandomID),
          await getLastFailedSyncTimeByVault(this.db, this.vaultRandomID)
        );
      }
      // update statusbar text every 30 seconds
      const refreshLastSyncMsg = async () => {
        if (!this.isSyncing) {
          this.updateLastSyncMsg(
            undefined,
            "not_syncing",
            await getLastSuccessSyncTimeByVault(this.db, this.vaultRandomID),
            await getLastFailedSyncTimeByVault(this.db, this.vaultRandomID)
          );
        }
      };
      this.registerInterval(
        window.setInterval(() => void refreshLastSyncMsg(), 1000 * 30)
      );
    }

    this.addCommand({
      id: "start-sync",
      name: t("command_startsync"),
      icon: iconNameSyncWait,
      callback: async () => {
        void this.syncRun("manual");
      },
    });

    this.addCommand({
      id: "start-sync-dry-run",
      name: t("command_drynrun"),
      icon: iconNameSyncWait,
      callback: async () => {
        void this.syncRun("dry");
      },
    });

    this.addCommand({
      id: "export-sync-plans-1-only-change",
      name: t("command_exportsyncplans_1_only_change"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          1,
          true
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addCommand({
      id: "export-sync-plans-1",
      name: t("command_exportsyncplans_1"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          1,
          false
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addCommand({
      id: "export-sync-plans-5",
      name: t("command_exportsyncplans_5"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          5,
          false
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addCommand({
      id: "export-sync-plans-all",
      name: t("command_exportsyncplans_all"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          -1,
          false
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addSettingTab(new NextclawSyncSettingTab(this.app, this));

    this.enableAutoSyncIfSet();
    this.enableInitSyncIfSet();
    this.toggleSyncOnSaveIfSet();

    await upsertPluginVersionByVault(
      this.db,
      this.vaultRandomID,
      this.manifest.version
    );
  }

  onunload() {
    this.syncRibbon = undefined;
    if (this.appContainerObserver !== undefined) {
      this.appContainerObserver.disconnect();
      this.appContainerObserver = undefined;
    }
    if (this.mobileStatusBarTimer !== undefined) {
      window.clearTimeout(this.mobileStatusBarTimer);
      this.mobileStatusBarTimer = undefined;
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      structuredClone(DEFAULT_SETTINGS),
      messyConfigToNormal(
        (await this.loadData()) as Parameters<typeof messyConfigToNormal>[0]
      )
    );

    // 旧版本留下的其它网盘与加密设置不再使用，不留在设置文件里。
    for (const key of LEGACY_SETTING_KEYS) {
      delete (this.settings as unknown as Record<string, unknown>)[key];
    }

    if (this.settings.syncBookmarks === undefined) {
      this.settings.syncBookmarks = false;
    }

    // NextClaw：A 分支每次加载都套一遍预设。
    //
    // 只在设置界面"分支切换"时套预设是不够的：**全新安装根本没有切换发生**，
    // A 分支就会跑上游默认值（双向同步、syncConfigDir 关、syncUnderscoreItems 关），
    // 界面锁住的是错的值。后果：.obsidian/ 拉不下来；双向同步试图往只读的
    // 公开分享推送用户新建的笔记（403）；同步方向显示"双向同步"。
    //
    // A 分支全程锁定、没有用户选择需要保留，所以每次加载无条件覆盖是安全的。
    // **B 分支绝不能这样做**——那些项允许用户改，覆盖会抹掉他的选择。
    if (detectBranch(this.settings.webdav ?? {}) === "A") {
      applyBranchPreset(this.settings, Platform.isMobile);
    }
    // NextClaw：设置页不显示的项每次加载都强制为预设值，见 nextclaw/presets.ts。
    if (enforceHiddenSettings(this.settings).remoteBaseDirReset) {
      this.settings.nextclawPendingRecordReset = true;
    }

    if (this.settings.webdav.manualRecursive === undefined) {
      this.settings.webdav.manualRecursive = true;
    }
    if (
      this.settings.webdav.depth === undefined ||
      this.settings.webdav.depth === "auto" ||
      this.settings.webdav.depth === "auto_1" ||
      this.settings.webdav.depth === "auto_infinity" ||
      this.settings.webdav.depth === "auto_unknown"
    ) {
      // auto is deprecated as of 20240116
      this.settings.webdav.depth = "manual_1";
      this.settings.webdav.manualRecursive = true;
    }
    if (this.settings.webdav.remoteBaseDir === undefined) {
      this.settings.webdav.remoteBaseDir = "";
    }
    if (this.settings.webdav.customHeaders === undefined) {
      this.settings.webdav.customHeaders = "";
    }
    if (this.settings.ignorePaths === undefined) {
      this.settings.ignorePaths = [];
    }
    if (this.settings.onlyAllowPaths === undefined) {
      this.settings.onlyAllowPaths = [];
    }
    if (this.settings.enableStatusBarInfo === undefined) {
      this.settings.enableStatusBarInfo = true;
    }
    if (this.settings.syncOnSaveAfterMilliseconds === undefined) {
      this.settings.syncOnSaveAfterMilliseconds = -1;
    }
    if (this.settings.deleteToWhere === undefined) {
      this.settings.deleteToWhere = "obsidian"; // NextClaw：见 DEFAULT_SETTINGS 的说明
    }

    if (this.settings.conflictAction === undefined) {
      this.settings.conflictAction = "keep_newer";
    }
    if (this.settings.protectModifyPercentage === undefined) {
      this.settings.protectModifyPercentage = 50;
    }
    if (this.settings.syncDirection === undefined) {
      this.settings.syncDirection = "bidirectional";
    }

    if (this.settings.obfuscateSettingFile === undefined) {
      this.settings.obfuscateSettingFile = true;
    }

    if (this.settings.enableMobileStatusBar === undefined) {
      this.settings.enableMobileStatusBar = false;
    }


    await this.saveSettings();
  }

  async saveSettings() {
    if (this.settings.obfuscateSettingFile) {
      await this.saveData(normalConfigToMessy(this.settings));
    } else {
      await this.saveData(this.settings);
    }
  }

  /**
   * After 202403 the data should be of profile based.
   */
  getCurrProfileID() {
    if (this.settings.serviceType !== undefined) {
      return `${this.settings.serviceType}-default-1`;
    } else {
      throw Error("unknown serviceType in the setting!");
    }
  }

  getVaultBasePath() {
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      // in desktop
      return this.app.vault.adapter.getBasePath().split("?")[0];
    } else {
      // in mobile
      return this.app.vault.adapter.getResourcePath("").split("?")[0];
    }
  }

  async prepareDBAndVaultRandomID(vaultBasePath: string, profileID: string) {
    const { db, vaultRandomID } = await prepareDBs(vaultBasePath, "", profileID);
    this.db = db;
    this.vaultRandomID = vaultRandomID;
  }

  enableAutoSyncIfSet() {
    if (
      this.settings.autoRunEveryMilliseconds !== undefined &&
      this.settings.autoRunEveryMilliseconds !== null &&
      this.settings.autoRunEveryMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        const intervalID = window.setInterval(() => {
          void this.syncRun("auto");
        }, this.settings.autoRunEveryMilliseconds);
        this.autoRunIntervalID = intervalID;
        this.registerInterval(intervalID);
      });
    }
  }

  enableInitSyncIfSet() {
    if (
      this.settings.initRunAfterMilliseconds !== undefined &&
      this.settings.initRunAfterMilliseconds !== null &&
      this.settings.initRunAfterMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => {
          void this.syncRun("auto_once_init");
        }, this.settings.initRunAfterMilliseconds);
      });
    }
  }

  async _checkCurrFileModified(caller: "SYNC" | "FILE_CHANGES") {
    console.debug(`inside checkCurrFileModified`);
    const currentFile = this.app.workspace.getActiveFile();

    if (currentFile) {
      console.debug(`we have currentFile=${currentFile.path}`);
      // get the last modified time of the current file
      // if it has modified after lastSuccessSync
      // then schedule a run for syncOnSaveAfterMilliseconds after it was modified
      const lastModified = currentFile.stat.mtime;
      const lastSuccessSyncMillis = await getLastSuccessSyncTimeByVault(
        this.db,
        this.vaultRandomID
      );

      console.debug(
        `lastModified=${lastModified}, lastSuccessSyncMillis=${lastSuccessSyncMillis}`
      );

      if (
        caller === "SYNC" ||
        (caller === "FILE_CHANGES" &&
          lastModified > (lastSuccessSyncMillis ?? 1))
      ) {
        console.debug(
          `so lastModified > lastSuccessSyncMillis or it's called while syncing before`
        );
        console.debug(
          `caller=${caller}, isSyncing=${this.isSyncing}, hasPendingSyncOnSave=${this.hasPendingSyncOnSave}`
        );
        if (this.isSyncing) {
          this.hasPendingSyncOnSave = true;
          // wait for next event
          return;
        } else {
          if (this.hasPendingSyncOnSave || caller === "FILE_CHANGES") {
            this.hasPendingSyncOnSave = false;
            await this.syncRun("auto_sync_on_save");
          }
          return;
        }
      }
    } else {
      console.debug(`no currentFile here`);
    }
  }

  _syncOnSaveEvent1 = () => {
    void this._checkCurrFileModified("SYNC");
  };

  // 首次变化后等 3 秒再检查，期间的变化合并为一次（不重置计时）。
  _syncOnSaveEvent2 = debounce(
    () => {
      void this._checkCurrFileModified("FILE_CHANGES");
    },
    1000 * 3,
    false
  );

  toggleSyncOnSaveIfSet() {
    if (
      this.settings.syncOnSaveAfterMilliseconds !== undefined &&
      this.settings.syncOnSaveAfterMilliseconds !== null &&
      this.settings.syncOnSaveAfterMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        // listen to sync done
        if (this.syncEvent !== undefined) {
          this.registerEvent(
            this.syncEvent.on("SYNC_DONE", this._syncOnSaveEvent1)
          );
        }

        // listen to current file save changes
        this.registerEvent(this.app.vault.on("modify", this._syncOnSaveEvent2));
        this.registerEvent(this.app.vault.on("create", this._syncOnSaveEvent2));
        this.registerEvent(this.app.vault.on("delete", this._syncOnSaveEvent2));
        this.registerEvent(this.app.vault.on("rename", this._syncOnSaveEvent2));
      });
    } else {
      this.syncEvent?.off("SYNC_DONE", this._syncOnSaveEvent1);
      this.app.vault.off("modify", this._syncOnSaveEvent2);
      this.app.vault.off("create", this._syncOnSaveEvent2);
      this.app.vault.off("delete", this._syncOnSaveEvent2);
      this.app.vault.off("rename", this._syncOnSaveEvent2);
    }
  }

  enableMobileStatusBarIfSet() {
    this.app.workspace.onLayoutReady(() => {
      if (Platform.isMobile && this.settings.enableMobileStatusBar) {
        this.appContainerObserver = changeMobileStatusBar("enable");
      }
    });
  }

  /**
   * 同步成功 SUCCESS_VISIBLE_MS 后把状态条淡出，其余状态常驻。
   * 状态条固定在视口右下角，那里通常是别人的按钮，不该长期占着。
   */
  refreshMobileStatusBarVisibility(state: MobileStatusBarState) {
    if (!Platform.isMobile || !this.settings.enableMobileStatusBar) {
      return;
    }
    if (this.mobileStatusBarTimer !== undefined) {
      window.clearTimeout(this.mobileStatusBarTimer);
      this.mobileStatusBarTimer = undefined;
    }
    const visible = shouldShowMobileStatusBar(state);
    setMobileStatusBarIdle(!visible);
    if (visible && !state.syncing && state.hasTimestamp && state.isSuccess) {
      // 文字每 30 秒才刷新一次，等不到那时候，单独安排一次淡出。
      const remaining = Math.max(SUCCESS_VISIBLE_MS - state.msSinceLastSync, 0);
      this.mobileStatusBarTimer = window.setTimeout(() => {
        this.mobileStatusBarTimer = undefined;
        setMobileStatusBarIdle(true);
      }, remaining);
    }
  }

  setCurrSyncMsg(
    t: (x: TransItemType, vars?: TransVars) => string,
    s: SyncTriggerSourceType,
    i: number,
    totalCount: number,
    pathName: string,
    decision: string,
    triggerSource: SyncTriggerSourceType
  ) {
    const L = `${totalCount}`.length;
    const iStr = `${i}`.padStart(L, "0");
    const prefix = getStatusBarShortMsgFromSyncSource(t, s);
    const shortMsg = prefix + `Syncing ${iStr}/${totalCount}`;
    const longMsg =
      prefix +
      `Syncing progress=${iStr}/${totalCount},decision=${decision},path=${pathName},source=${triggerSource}`;
    this.currSyncMsg = longMsg;

    if (this.statusBarElement !== undefined) {
      this.statusBarElement.setText(shortMsg);
      this.statusBarElement.setAttribute("aria-label", longMsg);
    }
    this.refreshMobileStatusBarVisibility({
      syncing: true,
      hasTimestamp: false,
      isSuccess: false,
      msSinceLastSync: 0,
    });
  }

  updateLastSyncMsg(
    s: SyncTriggerSourceType | undefined,
    syncStatus: "not_syncing" | "syncing",
    lastSuccessSyncMillis: number | null | undefined,
    lastFailedSyncMillis: number | null | undefined
  ) {
    if (this.statusBarElement === undefined) return;

    // console.debug(lastSuccessSyncMillis);
    // console.debug(lastFailedSyncMillis);

    const t = (x: TransItemType, vars?: TransVars) => {
      return this.i18n.t(x, vars);
    };

    let lastSyncMsg = t("statusbar_lastsync_never");
    let lastSyncLabelMsg = t("statusbar_lastsync_never_label");

    const inputTs = Math.max(
      lastSuccessSyncMillis ?? -999,
      lastFailedSyncMillis ?? -999
    );
    const isSuccess =
      (lastSuccessSyncMillis ?? -999) >= (lastFailedSyncMillis ?? -999);

    if (syncStatus === "syncing") {
      lastSyncMsg =
        getStatusBarShortMsgFromSyncSource(t, s) + t("statusbar_syncing");
    } else if (inputTs > 0) {
      let prefix = "";
      if (isSuccess) {
        prefix = t("statusbar_sync_status_prefix_success");
      } else {
        prefix = t("statusbar_sync_status_prefix_failed");
      }

      const deltaTime = Date.now() - inputTs;
      const timeText = relativeTimeText(deltaTime, t);
      const dateText = new Date(inputTs).toLocaleTimeString(
        navigator.language,
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }
      );

      lastSyncMsg = prefix + timeText;
      lastSyncLabelMsg =
        prefix + t("statusbar_lastsync_label", { date: dateText });
    } else {
      // TODO: no idea what happened.
    }

    this.statusBarElement.setText(lastSyncMsg);
    this.statusBarElement.setAttribute("aria-label", lastSyncLabelMsg);

    this.refreshMobileStatusBarVisibility({
      syncing: syncStatus === "syncing",
      hasTimestamp: inputTs > 0,
      isSuccess,
      msSinceLastSync: Date.now() - inputTs,
    });
  }

  /**
   * Because data.json contains sensitive information,
   * We usually want to ignore it in the version control.
   * However, if there's already a an ignore file (even empty),
   * we respect the existing configure and not add any modifications.
   * @returns
   */
  async tryToAddIgnoreFile() {
    const pluginConfigDir =
      this.manifest.dir ||
      `${this.app.vault.configDir}/plugins/${this.manifest.dir}`;
    const pluginConfigDirExists =
      await this.app.vault.adapter.exists(pluginConfigDir);
    if (!pluginConfigDirExists) {
      // what happened?
      return;
    }
    const ignoreFile = `${pluginConfigDir}/.gitignore`;
    const ignoreFileExists = await this.app.vault.adapter.exists(ignoreFile);

    const contentText = "data.json\n";

    try {
      if (!ignoreFileExists) {
        await this.app.vault.adapter.write(ignoreFile, contentText);
      }
    } catch {
      // .gitignore 写不进去不影响同步。
    }
  }

  enableAutoClearOutputToDBHistIfSet() {
    const initClearOutputToDBHistAfterMilliseconds = 1000 * 30;

    this.app.workspace.onLayoutReady(() => {
      // init run
      window.setTimeout(() => {
        void clearAllLoggerOutputRecords(this.db);
      }, initClearOutputToDBHistAfterMilliseconds);
    });
  }

  enableAutoClearSyncPlanHist() {
    const initClearSyncPlanHistAfterMilliseconds = 1000 * 45;
    const autoClearSyncPlanHistAfterMilliseconds = 1000 * 60 * 5;

    this.app.workspace.onLayoutReady(() => {
      // init run
      window.setTimeout(() => {
        void clearExpiredSyncPlanRecords(this.db);
      }, initClearSyncPlanHistAfterMilliseconds);

      // scheduled run
      const intervalID = window.setInterval(() => {
        void clearExpiredSyncPlanRecords(this.db);
      }, autoClearSyncPlanHistAfterMilliseconds);
      this.registerInterval(intervalID);
    });
  }
}
