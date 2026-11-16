import { checkVaultStages, assertContentResetSafe, ContentStagePaused } from "../../../src/nextclaw/content/runtime";
import { NativeWriteJournal, NativeWritePaused } from "../../../src/nextclaw/nativeWriteJournal";
import { TRANSPORT_PAUSED } from "../../../src/nextclaw/writeQuarantine";
import { fence } from "../../../src/nextclaw/loadFence";
import { DeferredTasks } from "../../../src/nextclaw/deferredTasks";
import AggregateError from "aggregate-error";
import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import ts from "typescript";
import { harness } from "./helpers";
import { effectiveIgnorePaths } from "../../../src/nextclaw/branch";
import { runLegacySync as runSync } from "../../../src/nextclaw/engine/legacy";
import {
  clearAllPrevSyncRecordByVault,
  getAllPrevSyncRecordsByVaultAndProfile,
  insertSyncPlanRecordByVault,
} from "../../../src/localdb";
import {
  canAskNow,
  evaluateGuard,
} from "../../../src/nextclaw/existingVaultGuard";
import {
  isStudentAccountOnDesktop,
  needsPasswordBeforeSync,
} from "../../../src/nextclaw/accountPolicy";
import { switchAtoB } from "../../../src/nextclaw/switchAtoB";
import {
  markReloadPending,
  reloadAfterFirstASync,
  reloadAfterFirstBSync,
  shouldReloadAfterFirstASync,
  shouldReloadAfterSync,
} from "../../../src/nextclaw/reloadAfterSwitch";

// Compile the production orchestration method against the explicit legacy test engine; integrated B entry has its own real-IDB suite.
export function mainHarness(h = harness(), engine: typeof runSync = runSync) {
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
  // 运行平台：默认移动端；测桌面端拦截时改成 true。
  const platform = { isDesktopApp: false, isAndroidApp: false };
  const globals: Record<string, any> = {
    checkVaultStages, assertContentResetSafe, ContentStagePaused,
    fence,
    NativeWriteJournal,
    NativeWritePaused,
    TRANSPORT_PAUSED,
    isStudentAccountOnDesktop,
    needsPasswordBeforeSync,
    Platform: platform,
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
    runSync: engine,
    switchAtoB,
    markReloadPending,
    reloadAfterFirstBSync,
    shouldReloadAfterSync,
    reloadAfterFirstASync,
    shouldReloadAfterFirstASync,
    clearAllPrevSyncRecordByVault,
    // 提示等待不真的等 2.5 秒。
    window: { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, setTimeout: (fn: () => void) => (fn(), 0) },
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
    upsertPendingDirectoryCountByVault: async () => {},
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
    deferredTasks: new DeferredTasks({setTimeout(fn) { queueMicrotask(fn); return 1; }, clearTimeout() {}}),
    isSyncing: false,
    transportStorageKey: () => "test-vault",
    transportBlocked: () => plugin.nativeWrites?.blocked() ?? false,
    settings: {
      webdav: { username: "", address: "", password: "" },
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
        executeCommandById: (id: string) => (
          executed.push(`${id}|isSyncing=${plugin.isSyncing}`), true
        ),
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
    platform,
    run: (trigger = "manual", saveOnly = false) => fn.call(plugin, trigger, saveOnly),
  };
}
