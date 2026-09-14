import { type App, Modal, Setting } from "obsidian";
import type { TransItemType, TransVars } from "../i18n";
import type { GuardDecision } from "./existingVaultGuard";

/** 弹窗最多列出的顶层条目数。 */
const MAX_LISTED = 8;

type Translate = (key: TransItemType, vars?: TransVars) => string;

class ExistingVaultModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly t: Translate,
    private readonly decision: GuardDecision,
    private readonly resolve: (ok: boolean) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, t, decision } = this;
    const demo = decision.kind === "first-demo-sync";
    this.titleEl.setText(
      t(demo ? "nextclaw_guard_demo_title" : "nextclaw_guard_switch_title")
    );
    contentEl.createEl("p", {
      text: t(demo ? "nextclaw_guard_demo_body" : "nextclaw_guard_switch_body", {
        count: decision.fileCount,
      }),
    });

    const list = contentEl.createEl("ul");
    for (const item of decision.topLevel.slice(0, MAX_LISTED)) {
      list.createEl("li", { text: item });
    }
    if (decision.topLevel.length > MAX_LISTED) {
      list.createEl("li", {
        text: t("nextclaw_guard_more", {
          count: decision.topLevel.length - MAX_LISTED,
        }),
      });
    }
    if (demo) {
      contentEl.createEl("p", { text: t("nextclaw_guard_demo_advice") });
    }

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText(t("nextclaw_guard_cancel"))
          .setCta()
          .onClick(() => this.finish(false))
      )
      .addButton((button) =>
        button
          .setButtonText(
            t(demo ? "nextclaw_guard_demo_continue" : "nextclaw_guard_switch_continue")
          )
          .setDestructive()
          .onClick(() => this.finish(true))
      );
  }

  private finish(ok: boolean) {
    this.decided = true;
    this.resolve(ok);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    // 点右上角关闭或按返回键，等同于取消。
    if (!this.decided) {
      this.decided = true;
      this.resolve(false);
    }
  }
}

/** 弹窗询问是否继续。返回 true 表示用户确认继续。 */
export const confirmExistingVault = (
  app: App,
  t: Translate,
  decision: GuardDecision
): Promise<boolean> =>
  new Promise((resolve) => {
    new ExistingVaultModal(app, t, decision, resolve).open();
  });
