import { strict as assert } from "assert";
import { Modal, type Setting, installFakeObsidian } from "./fakeObsidian";
import {
  canAskNow,
  decideGuard,
  evaluateGuard,
  findUserContent,
} from "../../src/nextclaw/existingVaultGuard";

installFakeObsidian();
// biome-ignore lint: 必须在替身装好之后再加载
const { confirmExistingVault } = require("../../src/nextclaw/existingVaultModal");

const e = (key: string) => ({ key, keyRaw: key });

describe("NextClaw 保护弹窗：识别用户自己的内容", () => {
  it("没有同步记录的文件算用户内容；配置目录、.trash、调试文件夹、文件夹条目不算", () => {
    const r = findUserContent(
      [
        e("请阅读.md"),
        e("attachments/"),
        e("attachments/contact_me_qr.png"),
        e("我的笔记.md"),
        e("课程/"),
        e("课程/第一章.md"),
        e("课程/图/x.png"),
        e("空文件夹/"),
        e(".obsidian/app.json"),
        e(".trash/旧.md"),
        e("_nextclaw_debug/plan.md"),
        e("_debug_remotely_save/plan.md"),
      ],
      ["请阅读.md", "attachments/", "attachments/contact_me_qr.png"],
      ".obsidian"
    );
    assert.deepEqual(r, { fileCount: 3, topLevel: ["我的笔记.md", "课程/"] });
  });

  it("路径按 NFC 比较：记录与本地的 Unicode 组合方式不同也算同一个文件", () => {
    const nfd = "café.md".normalize("NFD");
    assert.equal(findUserContent([e(nfd)], ["café.md".normalize("NFC")], ".obsidian").fileCount, 0);
  });

  it("配置目录名跟随 vault 实际取值", () => {
    assert.equal(findUserContent([e(".config/app.json")], [], ".config").fileCount, 0);
    assert.equal(findUserContent([e(".config/app.json")], [], ".obsidian").fileCount, 1);
  });
});

describe("NextClaw 保护弹窗：何时询问", () => {
  const content = { fileCount: 2, topLevel: ["a.md", "b/"] };
  const base = {
    mode: "A" as "A" | "B",
    triggerSource: "manual",
    pendingSwitchToB: false,
    acknowledgedFirstDemoSync: false,
    hasAnyRecord: false,
    userContent: content,
  };

  it("A→B 切换待执行且有用户内容 → 询问切换", () => {
    assert.equal(decideGuard({ ...base, mode: "B", pendingSwitchToB: true, hasAnyRecord: true })?.kind, "switch-to-account");
  });
  it("模式 A、从未同步、未确认、有用户内容 → 询问首次同步演示库", () => {
    assert.equal(decideGuard(base)?.kind, "first-demo-sync");
  });
  it("已同步过或已确认过 → 模式 A 不再询问", () => {
    assert.equal(decideGuard({ ...base, hasAnyRecord: true }), null);
    assert.equal(decideGuard({ ...base, acknowledgedFirstDemoSync: true }), null);
  });
  it("没有用户内容、空跑、模式 B 日常同步 → 不询问", () => {
    assert.equal(decideGuard({ ...base, userContent: { fileCount: 0, topLevel: [] } }), null);
    assert.equal(decideGuard({ ...base, triggerSource: "dry" }), null);
    assert.equal(decideGuard({ ...base, mode: "B" }), null);
  });
  it("只有手动同步能弹窗", () => {
    assert.equal(canAskNow("manual"), true);
    for (const s of ["auto", "auto_once_init", "auto_sync_on_save", "dry"]) assert.equal(canAskNow(s), false, s);
  });

  it("模式 A 日常同步只读记录，不枚举本地文件", async () => {
    let walks = 0;
    const r = await evaluateGuard({
      mode: "A", triggerSource: "manual", pendingSwitchToB: false, acknowledgedFirstDemoSync: false,
      configDir: ".obsidian", readRecordKeys: async () => ["请阅读.md"], walk: async () => (walks++, [e("x.md")]),
    });
    assert.equal(r, null);
    assert.equal(walks, 0);
  });
  it("已确认过的库（即使上次同步失败、还没有记录）不再读记录、不枚举、不询问", async () => {
    let reads = 0, walks = 0;
    const r = await evaluateGuard({
      mode: "A", triggerSource: "manual", pendingSwitchToB: false, acknowledgedFirstDemoSync: true,
      configDir: ".obsidian", readRecordKeys: async () => (reads++, []), walk: async () => (walks++, [e("x.md")]),
    });
    assert.equal(r, null);
    assert.equal(reads + walks, 0);
  });
  it("模式 B 日常同步既不读记录也不枚举", async () => {
    let reads = 0;
    const r = await evaluateGuard({
      mode: "B", triggerSource: "auto", pendingSwitchToB: false, acknowledgedFirstDemoSync: false,
      configDir: ".obsidian", readRecordKeys: async () => (reads++, []), walk: async () => [e("x.md")],
    });
    assert.equal(r, null);
    assert.equal(reads, 0);
  });
});

describe("NextClaw 保护弹窗：界面", () => {
  const t = (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k);
  const open = (decision: any) => {
    Modal.opened = [];
    const p: Promise<boolean> = confirmExistingVault({}, t, decision);
    const modal = Modal.opened[0];
    const buttons = modal.contentEl.settings().flatMap((s: Setting) => s.buttons);
    return { p, modal, buttons };
  };

  it("切换弹窗：标题、数量、列出顶层条目，超过 8 项折叠；取消是默认按钮、继续是危险按钮", async () => {
    const tops = Array.from({ length: 10 }, (_, i) => `n${i}.md`);
    const { p, modal, buttons } = open({ kind: "switch-to-account", fileCount: 12, topLevel: tops });
    assert.equal(modal.titleEl.text, "nextclaw_guard_switch_title");
    const texts = modal.contentEl.texts();
    assert.ok(texts.includes('nextclaw_guard_switch_body:{"count":12}'));
    assert.deepEqual(texts.filter((x: string) => /^n\d\.md$/.test(x)), tops.slice(0, 8));
    assert.ok(texts.includes('nextclaw_guard_more:{"count":2}'));
    assert.deepEqual(buttons.map((b: any) => b.text), ["nextclaw_guard_cancel", "nextclaw_guard_switch_continue"]);
    assert.equal(buttons[0].cta, true);
    assert.equal(buttons[1].destructive, true);
    await buttons[1].click();
    assert.equal(await p, true);
    assert.equal(modal.closed, true);
  });

  it("首次同步演示库弹窗：点取消返回 false", async () => {
    const { p, modal, buttons } = open({ kind: "first-demo-sync", fileCount: 1, topLevel: ["a.md"] });
    assert.equal(modal.titleEl.text, "nextclaw_guard_demo_title");
    assert.ok(modal.contentEl.texts().includes("nextclaw_guard_demo_advice"));
    assert.equal(buttons[1].text, "nextclaw_guard_demo_continue");
    await buttons[0].click();
    assert.equal(await p, false);
  });

  it("直接关闭弹窗（右上角、返回键）等同于取消", async () => {
    const { p, modal } = open({ kind: "switch-to-account", fileCount: 1, topLevel: ["a.md"] });
    modal.close();
    assert.equal(await p, false);
  });
});
