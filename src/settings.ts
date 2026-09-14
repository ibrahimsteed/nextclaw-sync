import {
  type App,
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

    //////////////////////////////////////////////////
    // 账号
    //////////////////////////////////////////////////

    new Setting(containerEl).setName(t("nextclaw_group_account")).setHeading();

    new Setting(containerEl)
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

    let usernameText: TextComponent | undefined;
    new Setting(containerEl)
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
          await save();
        });
      })
      .addExtraButton((eye) => hideTextWithToggle(usernameText!, eye));

    let passwordText: TextComponent | undefined;
    new Setting(containerEl)
      .setName(t("settings_webdav_password"))
      .setDesc(t("settings_webdav_password_desc"))
      .addText((text) => {
        passwordText = text;
        text.setValue(settings.webdav.password).onChange(async (value) => {
          settings.webdav.password = value.trim();
          await save();
        });
      })
      .addExtraButton((eye) => hideTextWithToggle(passwordText!, eye));

    //////////////////////////////////////////////////
    // 同步
    //////////////////////////////////////////////////

    new Setting(containerEl).setName(t("nextclaw_group_sync")).setHeading();

    new Setting(containerEl)
      .setName(t("settings_runoncestartup"))
      .setDesc(t("settings_runoncestartup_desc"))
      .addDropdown((dropdown) => {
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

    let newRemoteBaseDir = settings.webdav.remoteBaseDir || "";
    new Setting(otherBody)
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
