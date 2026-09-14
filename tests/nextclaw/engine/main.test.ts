import AggregateError from "aggregate-error";
import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import ts from "typescript";
import { harness } from "./helpers";
import { effectiveIgnorePaths } from "../../../src/nextclaw/branch";
import { runSync } from "../../../src/nextclaw/syncEngine";
import {
  clearAllPrevSyncRecordByVault,
  getAllPrevSyncRecordsByVaultAndProfile,
  insertSyncPlanRecordByVault,
} from "../../../src/localdb";
import { canAskNow, evaluateGuard } from "../../../src/nextclaw/existingVaultGuard";
import { switchAtoB } from "../../../src/nextclaw/switchAtoB";
import {
  markReloadPending,
  reloadAfterFirstASync,
  reloadAfterFirstBSync,
  shouldReloadAfterFirstASync,
  shouldReloadAfterSync,
} from "../../../src/nextclaw/reloadAfterSwitch";

// Compile the unmodified production method, with injected host objects only.
function mainHarness() {
  const h = harness();
  const source = ts.createSourceFile(
    "main.ts",
    readFileSync(path.resolve(__dirname, "../../../src/main.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  let method = "";
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === "syncRun")
      method = node.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(method);
  const notices: string[] = [];
  // 保护弹窗：默认用户点"继续"，并记下弹过哪些。
  const guardUi = { answer: true, asked: [] as any[] };
  const globals: Record<string, any> = {
    insertSyncPlanRecordByVault,
    getAllPrevSyncRecordsByVaultAndProfile,
    evaluateGuard,
    canAskNow,
    confirmExistingVault: async (_app: unknown, _t: unknown, d: unknown) => {
      guardUi.asked.push(d);
      return guardUi.answer;
    },
    FakeFsLocal: class {
      constructor() {
        return h.local;
      }
    },
    getClient: () => h.remote,
    runSync,
    switchAtoB,
    markReloadPending,
    reloadAfterFirstBSync,
    shouldReloadAfterSync,
    reloadAfterFirstASync,
    shouldReloadAfterFirstASync,
    clearAllPrevSyncRecordByVault,
    // 提示等待不真的等 2.5 秒。
    window: { setTimeout: (fn: () => void) => (fn(), 0) },
    effectiveIgnorePaths,
    formatReceipt: () => "test switch receipt",
    Notice: class {
      constructor(s: string) {
        notices.push(s);
      }
    },
    setIcon: () => {},
    iconNameSyncRunning: "running",
    iconNameSyncWait: "idle",
    upsertLastSuccessSyncTimeByVault: async () => {},
    upsertLastFailedSyncTimeByVault: async () => {},
    AggregateError,
  };
  const compiled = ts.transpileModule(
    method.replace(/^async syncRun/, "async function syncRun"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
      },
    }
  ).outputText;
  const fn = new Function(
    ...Object.keys(globals),
    `${compiled}; return syncRun;`
  )(...Object.values(globals));
  const executed: string[] = [];
  const plugin: any = {
    isSyncing: false,
    settings: {
      syncDirection: "bidirectional",
      serviceType: "webdav",
      concurrency: 2,
      protectModifyPercentage: 100,
      syncConfigDir: true,
    },
    manifest: { id: "nextclaw-sync", name: "NextClaw", version: "test" },
    app: {
      vault: { configDir: ".obsidian", getName: () => "test" },
      commands: {
        commands: { "app:reload": {} },
        executeCommandById: (id: string) => (executed.push(`${id}|isSyncing=${plugin.isSyncing}`), true),
      },
    },
    db: h.input.db,
    vaultRandomID: "v",
    getCurrProfileID: () => "p",
    i18n: { t: (s: string) => s },
    saveSettings: async () => {},
    updateLastSyncMsg: () => {},
    setCurrSyncMsg: () => {},
  };
  return {
    h,
    plugin,
    notices,
    executed,
    guardUi,
    run: (trigger = "manual") => fn.call(plugin, trigger),
  };
}
describe("§3 §8 main syncRun real method wiring", () => {
  it("unknown direction rejects and unlocks", async () => {
    const t = mainHarness();
    t.plugin.settings.syncDirection = "pull_only";
    await t.run();
    assert.deepEqual(t.h.remote.calls, []);
    assert.equal(t.plugin.isSyncing, false);
    assert.match(t.notices[0], /方向/);
  });
  it("reentry is blocked while an asynchronous run is in progress", async () => {
    const t = mainHarness();
    t.h.remote.put("note.md");
    t.h.local.latency = 10;
    await Promise.all([t.run(), t.run()]);
    assert.equal(t.h.remote.calls.filter((c) => c.op === "walk").length, 1);
    assert.equal(t.plugin.isSyncing, false);
  });
  it("dry with pending switch never clears welcome files or pending flag", async () => {
    const t = mainHarness();
    t.plugin.settings.nextclawPendingSwitchToB = true;
    t.h.local.put("welcome.md");
    await t.run("dry");
    assert.deepEqual(t.h.local.writes(), []);
    assert.equal(t.plugin.settings.nextclawPendingSwitchToB, true);
  });
  it("switch failure does not clear pending flag or start engine", async () => {
    const t = mainHarness();
    t.plugin.settings.nextclawPendingSwitchToB = true;
    t.h.local.put("welcome.md");
    t.h.local.fail = (op) => op === "rm";
    await t.run();
    assert.equal(t.plugin.settings.nextclawPendingSwitchToB, true);
    assert.deepEqual(t.h.remote.calls, []);
    assert.equal(t.plugin.isSyncing, false);
  });
  it("successful switch preserves config and passes new input including pluginId", async () => {
    const t = mainHarness();
    t.plugin.settings.nextclawPendingSwitchToB = true;
    t.h.local
      .put("welcome.md")
      .put(".obsidian/plugins/custom/manifest.json", "{}")
      .put(".obsidian/community-plugins.json", '["custom"]');
    t.h.remote
      .put("student.md")
      .put(".obsidian/community-plugins.json", "[]", 1000);
    await t.run();
    assert.equal(t.plugin.settings.nextclawPendingSwitchToB, false);
    assert.deepEqual(t.h.remote.writes(), []);
    assert.ok(t.h.local.files.has("student.md"));
    assert.ok(t.h.local.files.has(".obsidian/plugins/custom/manifest.json"));
    assert.equal(t.plugin.isSyncing, false);
  });
  it("§14.1 successful first B sync after switch reloads once, flag cleared before reload", async () => {
    const t = mainHarness();
    const saved: boolean[] = [];
    t.plugin.saveSettings = async () => {
      saved.push(t.plugin.settings.nextclawReloadAfterFirstBSync);
    };
    t.plugin.settings.nextclawPendingSwitchToB = true;
    t.h.local.put("welcome.md");
    t.h.remote.put("student.md");
    await t.run();
    assert.deepEqual(t.executed, ["app:reload|isSyncing=true"], "执行重新加载时必须挡住新同步");
    assert.equal(t.plugin.settings.nextclawReloadAfterFirstBSync, false);
    assert.equal(saved[saved.length - 1], false, "reload 前最后一次保存时标记必须已清除");
    assert.ok(saved.includes(true), "切换后应先保存待重新加载标记");
    assert.ok(t.notices.some((n) => n.includes("重新加载")));
    await t.run();
    assert.deepEqual(t.executed, ["app:reload|isSyncing=true"], "之后的同步不再重新加载");
  });
  it("§14.1 failed first B sync keeps the reload flag and does not reload", async () => {
    const t = mainHarness();
    t.plugin.settings.nextclawPendingSwitchToB = true;
    t.h.local.put("welcome.md");
    t.h.remote.put("student.md");
    t.h.remote.fail = (op: string) => op === "readFile";
    await t.run();
    assert.equal(t.plugin.settings.nextclawPendingSwitchToB, false);
    assert.equal(t.plugin.settings.nextclawReloadAfterFirstBSync, true);
    assert.deepEqual(t.executed, []);
    t.h.remote.fail = () => false;
    await t.run();
    assert.deepEqual(t.executed, ["app:reload|isSyncing=true"], "下一次成功的 B 同步再重新加载");
  });
  it("§14.1 ordinary B sync without switch never reloads", async () => {
    const t = mainHarness();
    t.h.remote.put("student.md");
    await t.run();
    assert.deepEqual(t.executed, []);
  });
  it("§14.1 first mode-A sync reloads once, then never again", async () => {
    const t = mainHarness();
    t.plugin.settings.syncDirection = "incremental_pull_only";
    t.plugin.settings.nextclawReloadAfterFirstASync = true;
    t.h.remote.put("welcome.md");
    await t.run();
    assert.deepEqual(t.executed, ["app:reload|isSyncing=true"]);
    assert.equal(t.plugin.settings.nextclawReloadAfterFirstASync, false);
    assert.ok(t.notices.some((n) => n.includes("演示库")));
    await t.run();
    assert.deepEqual(t.executed, ["app:reload|isSyncing=true"]);
  });
  it("§14.1 failed or dry first mode-A sync keeps the flag", async () => {
    const t = mainHarness();
    t.plugin.settings.syncDirection = "incremental_pull_only";
    t.plugin.settings.nextclawReloadAfterFirstASync = true;
    t.h.remote.put("welcome.md");
    await t.run("dry");
    assert.deepEqual(t.executed, []);
    t.h.remote.fail = (op: string) => op === "readFile";
    await t.run();
    assert.deepEqual(t.executed, []);
    assert.equal(t.plugin.settings.nextclawReloadAfterFirstASync, true);
    t.h.remote.fail = () => false;
    await t.run();
    assert.deepEqual(t.executed, ["app:reload|isSyncing=true"]);
  });
  it("§14.1 mode-B sync never triggers the mode-A reload", async () => {
    const t = mainHarness();
    t.plugin.settings.nextclawReloadAfterFirstASync = true;
    t.h.remote.put("student.md");
    await t.run();
    assert.deepEqual(t.executed, []);
    assert.equal(t.plugin.settings.nextclawReloadAfterFirstASync, true);
  });
  it("remote folder change: records are cleared before the next sync, flag cleared", async () => {
    const t = mainHarness();
    t.plugin.settings.nextclawPendingRecordReset = true;
    // 记录与本地文件完全一致（本地"未变"）；远端新目录里没有它。
    t.h.seed({ key: "old-dir-note.md", v: 1, isFolder: false, local: { mtime: 10000, size: 1 }, remote: { mtime: 10000, size: 1 } });
    t.h.local.put("old-dir-note.md");
    await t.run();
    assert.equal(t.plugin.settings.nextclawPendingRecordReset, false);
    // 记录已清空：本地独有的笔记按"新建"推送，而不是按"远端已删除"被删掉。
    assert.ok(t.h.local.files.has("old-dir-note.md"), "本地笔记不应被删除");
    assert.ok(t.h.remote.files.has("old-dir-note.md"), "应作为新建推送到新目录");
  });
  it("remote folder change: without the reset, the stale record would delete the local note (control)", async () => {
    const t = mainHarness();
    t.h.seed({ key: "old-dir-note.md", v: 1, isFolder: false, local: { mtime: 10000, size: 1 }, remote: { mtime: 10000, size: 1 } });
    t.h.local.put("old-dir-note.md");
    await t.run();
    assert.ok(!t.h.local.files.has("old-dir-note.md"), "对照：旧记录让本地笔记被判为远端已删除");
  });
  it("remote folder change: dry run keeps records and the flag", async () => {
    const t = mainHarness();
    t.plugin.settings.nextclawPendingRecordReset = true;
    t.h.seed({ key: "keep.md", v: 1, isFolder: false, local: { mtime: 1, size: 1 }, remote: { mtime: 1, size: 1 } });
    await t.run("dry");
    assert.equal(t.plugin.settings.nextclawPendingRecordReset, true);
    assert.ok(t.h.rec("keep.md"), "空跑不清空记录");
  });
  it("§14.1 switch clears the mode-A flag; first B sync reloads exactly once", async () => {
    const t = mainHarness();
    t.plugin.settings.nextclawReloadAfterFirstASync = true;
    t.plugin.settings.nextclawPendingSwitchToB = true;
    t.h.local.put("welcome.md");
    t.h.remote.put("student.md");
    await t.run();
    assert.deepEqual(t.executed, ["app:reload|isSyncing=true"]);
    assert.equal(t.plugin.settings.nextclawReloadAfterFirstASync, false);
    assert.ok(t.notices.some((n) => n.includes("学生库")));
  });
  it("guard: switch with the user's own notes asks first; cancel keeps everything and does not sync", async () => {
    const t = mainHarness();
    t.plugin.settings.nextclawPendingSwitchToB = true;
    t.h.local.put("my note.md").put("folder/a.md");
    t.h.remote.put("student.md");
    t.guardUi.answer = false;
    await t.run();
    assert.equal(t.guardUi.asked.length, 1);
    assert.equal(t.guardUi.asked[0].kind, "switch-to-account");
    assert.equal(t.guardUi.asked[0].fileCount, 2);
    assert.deepEqual(t.guardUi.asked[0].topLevel, ["folder/", "my note.md"]);
    assert.ok(t.h.local.files.has("my note.md"), "取消后本地内容不动");
    assert.deepEqual(t.h.local.trash.size, 0);
    assert.deepEqual(t.h.remote.calls, [], "取消后不连远端");
    assert.equal(t.plugin.settings.nextclawPendingSwitchToB, true, "取消后切换标记保留");
    assert.ok(t.notices.includes("nextclaw_guard_cancelled"));
    assert.equal(t.plugin.isSyncing, false);
  });
  it("guard: switch confirmed moves the notes to .trash and syncs", async () => {
    const t = mainHarness();
    t.plugin.settings.nextclawPendingSwitchToB = true;
    t.h.local.put("my note.md");
    t.h.remote.put("student.md");
    await t.run();
    assert.equal(t.guardUi.asked.length, 1);
    assert.ok(!t.h.local.files.has("my note.md"));
    assert.ok(t.h.local.files.has("student.md"));
    assert.equal(t.plugin.settings.nextclawPendingSwitchToB, false);
  });
  it("guard: switch after syncing only the demo vault does not ask", async () => {
    const t = mainHarness();
    t.plugin.settings.nextclawPendingSwitchToB = true;
    t.h.seed({ key: "welcome.md", v: 1, isFolder: false, local: { mtime: 10000, size: 1 }, remote: { mtime: 10000, size: 1 } });
    t.h.local.put("welcome.md").put(".obsidian/app.json", "{}");
    t.h.remote.put("student.md");
    await t.run();
    assert.equal(t.guardUi.asked.length, 0);
    assert.ok(t.h.local.files.has("student.md"));
  });
  it("guard: automatic sync never opens the dialog; it skips once with a single notice", async () => {
    const t = mainHarness();
    t.plugin.settings.nextclawPendingSwitchToB = true;
    t.h.local.put("my note.md");
    for (const trigger of ["auto_once_init", "auto", "auto_sync_on_save"]) await t.run(trigger);
    assert.equal(t.guardUi.asked.length, 0);
    assert.equal(t.notices.filter((n) => n === "nextclaw_guard_manual_required").length, 1);
    assert.ok(t.h.local.files.has("my note.md"));
    assert.deepEqual(t.h.remote.calls, []);
    assert.equal(t.plugin.settings.nextclawPendingSwitchToB, true);
  });
  it("guard: first demo sync in a vault with notes asks once; confirmed, it never asks again", async () => {
    const t = mainHarness();
    t.plugin.settings.syncDirection = "incremental_pull_only";
    t.h.local.put("my note.md");
    t.h.remote.put("welcome.md");
    t.guardUi.answer = false;
    await t.run();
    assert.equal(t.guardUi.asked[0].kind, "first-demo-sync");
    assert.ok(!t.h.local.files.has("welcome.md"), "取消后不拉取演示库");
    assert.notEqual(t.plugin.settings.nextclawExistingVaultAcknowledged, true);
    t.guardUi.answer = true;
    await t.run();
    assert.equal(t.guardUi.asked.length, 2);
    assert.equal(t.plugin.settings.nextclawExistingVaultAcknowledged, true);
    assert.ok(t.h.local.files.has("welcome.md"));
    assert.ok(t.h.local.files.has("my note.md"), "模式 A 不动用户笔记");
    await t.run();
    assert.equal(t.guardUi.asked.length, 2, "确认过之后不再询问");
  });
  it("guard: empty vault and dry runs never ask", async () => {
    const t = mainHarness();
    t.plugin.settings.syncDirection = "incremental_pull_only";
    t.h.local.put(".obsidian/app.json", "{}");
    t.h.remote.put("welcome.md");
    await t.run();
    assert.equal(t.guardUi.asked.length, 0);
    const d = mainHarness();
    d.plugin.settings.nextclawPendingSwitchToB = true;
    d.h.local.put("my note.md");
    await d.run("dry");
    assert.equal(d.guardUi.asked.length, 0);
  });
});
