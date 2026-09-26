import {
  type App,
  type DropdownComponent,
  type ExtraButtonComponent,
  Modal,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  type TextComponent,
} from "obsidian";
import type { WebdavAuthType } from "./baseTypes";
import { exportVaultSyncPlansToFiles } from "./debugMode";
import type { TransItemType } from "./i18n";
import type NextclawSyncPlugin from "./main"; // unavoidable
import { checkHasSpecialCharForDir } from "./misc";

import { BranchLocks } from "./nextclaw/branchUi";
import { applyUsernameChange } from "./nextclaw/usernameChange";
import { needsPasswordBeforeSync } from "./nextclaw/accountPolicy";
import { renewLink, shouldShowRenewButton } from "./nextclaw/renew";

export class ChangeRemoteBaseDirModal extends Modal {
  readonly plugin: NextclawSyncPlugin;
  readonly newRemoteBaseDir: string;
  constructor(app: App, plugin: NextclawSyncPlugin, newRemoteBaseDir: string) {
    super(app);
    this.plugin = plugin;
    this.newRemoteBaseDir = newRemoteBaseDir;
  }

  onOpen() {
    const { contentEl } = this;
    const t = (x: TransItemType) => this.plugin.i18n.t(x);

    this.titleEl.setText(t("modal_remotebasedir_title"));
    for (const line of t("modal_remotebasedir_shortdesc").split("\n")) {
      contentEl.createEl("p", { text: line });
    }

    const save = async (value: string) => {
      this.plugin.settings.webdav.remoteBaseDir = value;
      // NextClaw：远端目录变了，旧同步记录作废，下次同步前清空。
      this.plugin.settings.nextclawPendingRecordReset = true;
      await this.plugin.saveSettings();
      new Notice(t("modal_remotebasedir_notice"));
      this.close();
    };

    const setting = new Setting(contentEl);
    if (
      this.newRemoteBaseDir === "" ||
      this.newRemoteBaseDir === this.app.vault.getName()
    ) {
      // 空值表示使用库名作为远端目录。
      setting.addButton((button) =>
        button
          .setButtonText(t("modal_remotebasedir_secondconfirm_vaultname"))
          .setCta()
          .onClick(() => save(""))
      );
    } else if (checkHasSpecialCharForDir(this.newRemoteBaseDir)) {
      contentEl.createEl("p", {
        text: t("modal_remotebasedir_invaliddirhint"),
      });
    } else {
      setting.addButton((button) =>
        button
          .setButtonText(t("modal_remotebasedir_secondconfirm_change"))
          .setCta()
          .onClick(() => save(this.newRemoteBaseDir))
      );
    }
    setting.addButton((button) =>
      button.setButtonText(t("goback")).onClick(() => this.close())
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 移动端把整行改成上下堆叠，输入框独占一行。
 *
 * 官方样式里有 `.is-mobile input[type="text"] { width: 100% }`，**只匹配 text**：
 * 眼睛按钮是靠改 `input.type` 遮内容的，一切到显示状态就命中这条规则，
 * 而 `width: 100%` 在内容宽度的一行里退化成"剩多少算多少"，输入框突然缩水
 * （实测 238px → 120px，用户名看不全）。竖屏下长说明文字挤得更狠。
 * 堆叠后输入框占满一行，两种 type 宽度一致。
 */
const stackInputOnMobile = (setting: Setting) => {
  setting.settingEl.addClass("nextclaw-stacked-input");
  return setting;
};

/** 输入框默认遮住内容，右侧的眼睛按钮切换显示。 */
const hideTextWithToggle = (text: TextComponent, eye: ExtraButtonComponent) => {
  text.inputEl.type = "password";
  eye.setIcon("eye-off").onClick(() => {
    const hidden = text.inputEl.type === "password";
    text.inputEl.type = hidden ? "text" : "password";
    eye.setIcon(hidden ? "eye" : "eye-off");
  });
};

export class NextclawSyncSettingTab extends PluginSettingTab {
  readonly plugin: NextclawSyncPlugin;

  constructor(app: App, plugin: NextclawSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("nextclaw-settings");

    const t = (x: TransItemType) => this.plugin.i18n.t(x);
    const settings = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    // NextClaw：A 分支下若干控件不可编辑，收集起来统一切换，见 nextclaw/branchUi.ts
    const locks = new BranchLocks(settings.webdav);

    // 密码提示由用户名和密码两处输入共同决定，先声明，两个 onChange 都会调。
    let passwordHint: HTMLElement | undefined;
    const refreshPasswordHint = () =>
      passwordHint?.toggle(needsPasswordBeforeSync(settings.webdav));

    // 续费按钮的显示条件只看用户名与地址，用户名一改就要跟着变。
    let renewSetting: Setting | undefined;
    const refreshRenewButton = () =>
      renewSetting?.settingEl.toggle(
        shouldShowRenewButton(settings.webdav, Platform.isDesktopApp)
      );

    //////////////////////////////////////////////////
    // 账号
    //////////////////////////////////////////////////

    new Setting(containerEl).setName(t("nextclaw_group_account")).setHeading();

    let usernameText: TextComponent | undefined;
    // 分支切换会改掉自动同步两项的取值，下拉框要跟着刷新（不重绘整页，免得打断输入）。
    let startupDropdown: DropdownComponent | undefined;
    let autorunDropdown: DropdownComponent | undefined;
    const usernameSetting = stackInputOnMobile(new Setting(containerEl));
    usernameSetting
      .setName(t("settings_webdav_user"))
      .setDesc(t("settings_webdav_user_desc"))
      .addText((text) => {
        usernameText = text;
        text.setValue(settings.webdav.username).onChange(async (value) => {
          // 用户名是分支判据，且地址要跟着它重算。
          // 逻辑在 nextclaw/usernameChange.ts，这里只把结果落到界面上。
          const r = applyUsernameChange(settings, value, Platform.isMobile);
          if (r.branchChanged || r.addressChanged) {
            locks.refresh();
          }
          if (r.addressChanged) {
            locks.showAddress(r.address); // 别只改设置不改显示
          }
          if (r.branchChanged) {
            startupDropdown?.setValue(`${settings.initRunAfterMilliseconds}`);
            autorunDropdown?.setValue(`${settings.autoRunEveryMilliseconds}`);
          }
          refreshPasswordHint();
          refreshRenewButton();
          await save();
        });
      })
      .addExtraButton((eye) => hideTextWithToggle(usernameText!, eye));
    // 桌面端提前说清楚：学生账号在这里填了也不会同步，别等点了同步才发现。
    if (Platform.isDesktopApp) {
      usernameSetting.descEl.createDiv({
        text: t("nextclaw_desktop_student_hint"),
        cls: "mod-warning",
      });
    }

    let passwordText: TextComponent | undefined;
    const passwordSetting = stackInputOnMobile(new Setting(containerEl));
    passwordSetting
      .setName(t("settings_webdav_password"))
      .setDesc(t("settings_webdav_password_desc"))
      .addText((text) => {
        passwordText = text;
        text.setValue(settings.webdav.password).onChange(async (value) => {
          settings.webdav.password = value.trim();
          refreshPasswordHint(); // 填上密码，提示要跟着消失
          await save();
        });
      })
      .addExtraButton((eye) => hideTextWithToggle(passwordText!, eye));
    // 学生账号填了用户名却没填密码时，同步不会开始（见 nextclaw/accountPolicy.ts）。
    // 在这里说明，别让用户点了同步才发现。
    passwordHint = passwordSetting.descEl.createDiv({
      text: t("nextclaw_password_required_hint"),
      cls: "mod-warning",
    });
    refreshPasswordHint();

    // NextClaw：续费入口（设计文档第九节）。**只有一个按钮**，不显示到期日、
    // 不显示订阅状态——插件不发任何订阅相关的请求，不缓存、不轮询。
    //
    // 显不显示只看本地设置。按网络或订阅状态决定的话，会在最需要续费的时候
    // （服务已停、网络不通）恰好把按钮藏起来。
    renewSetting = new Setting(containerEl)
      .setName(t("nextclaw_renew_name"))
      .setDesc(t("nextclaw_renew_desc"))
      .addButton((button) =>
        button.setButtonText(t("nextclaw_renew_button")).onClick(() => {
          // 链接在本地拼，域名是插件里的常量；点的这一刻重新读一次用户名，
          // 因为设置页开着时它可能刚被删空。
          const link = renewLink(settings.webdav);
          if (!link.ok) {
            new Notice(t("nextclaw_renew_needs_username"));
            return;
          }
          window.open(link.url, "_blank");
        })
      );
    refreshRenewButton();

    //////////////////////////////////////////////////
    // 同步
    //////////////////////////////////////////////////

    new Setting(containerEl).setName(t("nextclaw_group_sync")).setHeading();

    new Setting(containerEl)
      .setName(t("settings_runoncestartup"))
      .setDesc(t("settings_runoncestartup_desc"))
      .addDropdown((dropdown) => {
        startupDropdown = dropdown;
        locks.lockInA(dropdown);
        dropdown
          .addOption("-1", t("settings_runoncestartup_notset"))
          .addOption(`${1000 * 1}`, t("settings_runoncestartup_1sec"))
          .addOption(`${1000 * 10}`, t("settings_runoncestartup_10sec"))
          .addOption(`${1000 * 30}`, t("settings_runoncestartup_30sec"))
          .setValue(`${settings.initRunAfterMilliseconds}`)
          .onChange(async (val) => {
            settings.initRunAfterMilliseconds = Number.parseInt(val);
            await save();
          });
      });

    new Setting(containerEl)
      .setName(t("settings_autorun"))
      .setDesc(t("settings_autorun_desc"))
      .addDropdown((dropdown) => {
        autorunDropdown = dropdown;
        locks.lockInA(dropdown);
        dropdown
          .addOption("-1", t("settings_autorun_notset"))
          .addOption(`${1000 * 60 * 1}`, t("settings_autorun_1min"))
          .addOption(`${1000 * 60 * 5}`, t("settings_autorun_5min"))
          .addOption(`${1000 * 60 * 10}`, t("settings_autorun_10min"))
          .addOption(`${1000 * 60 * 30}`, t("settings_autorun_30min"))
          .setValue(`${settings.autoRunEveryMilliseconds}`)
          .onChange(async (val) => {
            const ms = Number.parseInt(val);
            settings.autoRunEveryMilliseconds = ms;
            await save();
            if (this.plugin.autoRunIntervalID !== undefined) {
              window.clearInterval(this.plugin.autoRunIntervalID);
              this.plugin.autoRunIntervalID = undefined;
            }
            if (ms > 0) {
              const intervalID = window.setInterval(() => {
                void this.plugin.syncRun("auto");
              }, ms);
              this.plugin.autoRunIntervalID = intervalID;
              this.plugin.registerInterval(intervalID);
            }
          });
      });

    //////////////////////////////////////////////////
    // 诊断
    //////////////////////////////////////////////////

    new Setting(containerEl)
      .setName(t("nextclaw_group_diagnostics"))
      .setHeading();

    const exportPlans = (count: number, onlyChange: boolean) => async () => {
      await exportVaultSyncPlansToFiles(
        this.plugin.db,
        this.app.vault,
        this.plugin.vaultRandomID,
        count,
        onlyChange
      );
      new Notice(t("settings_syncplans_notice"));
    };
    const exportSetting = new Setting(containerEl)
      .setName(t("settings_syncplans"))
      .setDesc(t("settings_syncplans_desc"));
    exportSetting.settingEl.addClass("setting-need-wrapping");
    const exportButtons: [TransItemType, number, boolean][] = [
      ["settings_syncplans_button_1_only_change", 1, true],
      ["settings_syncplans_button_5_only_change", 5, true],
      ["settings_syncplans_button_1", 1, false],
      ["settings_syncplans_button_5", 5, false],
      ["settings_syncplans_button_all", -1, false],
    ];
    for (const [label, count, onlyChange] of exportButtons) {
      exportSetting.addButton((button) =>
        button.setButtonText(t(label)).onClick(exportPlans(count, onlyChange))
      );
    }

    new Setting(containerEl)
      .setName(t("settings_debuglevel"))
      .setDesc(t("settings_debuglevel_desc"))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("info", "Info")
          .addOption("debug", "Debug")
          .setValue(settings.currLogLevel ?? "info")
          .onChange(async (val) => {
            settings.currLogLevel = val;
            await save();
          });
      });

    //////////////////////////////////////////////////
    // 其他 WebDAV 服务（默认折叠）
    //////////////////////////////////////////////////

    const otherHeading = new Setting(containerEl)
      .setName(t("nextclaw_group_otherwebdav"))
      .setDesc(t("nextclaw_group_otherwebdav_desc"))
      .setHeading();
    otherHeading.settingEl.addClass("nextclaw-other-webdav-heading");
    otherHeading.addExtraButton((button) => {
      const toggle = () => {
        const open = !otherBody.isShown();
        otherBody.toggle(open);
        button.setIcon(open ? "chevron-down" : "chevron-right");
      };
      button.setIcon("chevron-right").onClick(toggle);
      otherHeading.nameEl.addEventListener("click", toggle);
    });
    const otherBody = containerEl.createDiv();
    otherBody.hide();

    // 服务器地址放在折叠区块里：使用 NextClaw 账号时按用户名自动填写，学生不需要看到它；
    // 连接其他 WebDAV 服务的用户展开后填写。
    stackInputOnMobile(new Setting(otherBody))
      .setName(t("settings_webdav_addr"))
      .setDesc(t("settings_webdav_addr_desc"))
      .addText((text) => {
        locks.bindAddress(text); // A 分支强制回落并置灰
        text.setValue(settings.webdav.address).onChange(async (value) => {
          settings.webdav.address = value.trim();
          locks.refresh(); // 地址决定远端目录是否可编辑
          await save();
        });
      });

    let newRemoteBaseDir = settings.webdav.remoteBaseDir || "";
    stackInputOnMobile(new Setting(otherBody))
      .setName(t("settings_remotebasedir"))
      .setDesc(t("settings_remotebasedir_desc"))
      .addText((text) => {
        locks.lockWhenNextclawAddress(text);
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(newRemoteBaseDir)
          .onChange((value) => {
            newRemoteBaseDir = value.trim();
          });
      })
      .addButton((button) => {
        locks.lockWhenNextclawAddress(button);
        button.setButtonText(t("confirm")).onClick(() => {
          new ChangeRemoteBaseDirModal(
            this.app,
            this.plugin,
            newRemoteBaseDir
          ).open();
        });
      });

    new Setting(otherBody)
      .setName(t("settings_webdav_auth"))
      .setDesc(t("settings_webdav_auth_desc"))
      .addDropdown((dropdown) => {
        locks.lockInA(dropdown);
        dropdown
          .addOption("basic", "Basic")
          .addOption("digest", "Digest")
          .setValue(settings.webdav.authType)
          .onChange(async (val) => {
            settings.webdav.authType = val as WebdavAuthType;
            await save();
          });
      });

    new Setting(otherBody)
      .setName(t("settings_webdav_depth"))
      .setDesc(t("settings_webdav_depth_desc"))
      .addDropdown((dropdown) => {
        locks.lockInA(dropdown);
        dropdown
          .addOption("manual_1", t("settings_webdav_depth_1"))
          .addOption("manual_infinity", t("settings_webdav_depth_inf"))
          .setValue(settings.webdav.depth || "manual_1")
          .onChange(async (val) => {
            const infinity = val === "manual_infinity";
            settings.webdav.depth = infinity ? "manual_infinity" : "manual_1";
            settings.webdav.manualRecursive = !infinity;
            await save();
          });
      });

    new Setting(otherBody)
      .setName(t("settings_webdav_customheaders"))
      .setDesc(t("settings_webdav_customheaders_desc"))
      .addTextArea((textArea) => {
        locks.lockInA(textArea);
        textArea
          .setValue(settings.webdav.customHeaders ?? "")
          .onChange(async (value) => {
            settings.webdav.customHeaders = value
              .split("\n")
              .map((x) => x.trim())
              .filter((x) => x !== "")
              .join("\n");
            await save();
          });
        textArea.inputEl.rows = 5;
        textArea.inputEl.addClass("webdav-customheaders-textarea");
      });

    // 所有控件都注册完了，按当前分支切一次锁定状态。
    // 必须放在 display() 的最后——早于任何一个 lockInA() 就会漏掉它。
    locks.refresh();
  }

  hide() {
    this.containerEl.empty();
    super.hide();
  }
}
