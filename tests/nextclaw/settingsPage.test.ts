import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import { DEFAULT_DEBUG_FOLDER } from "../../src/baseTypes";
import { BranchLocks } from "../../src/nextclaw/branchUi";
import {
  NEXTCLAW_PUBLIC_WEBDAV_URL,
  NEXTCLAW_REMOTE_BASE_DIR,
} from "../../src/nextclaw/constants";
import {
  PRESET_A,
  PRESET_B,
  enforceHiddenSettings,
} from "../../src/nextclaw/presets";

const src = (f: string) =>
  readFileSync(path.join(__dirname, "..", "..", "src", f), "utf8");

/** 一台被改乱过的设备上的设置。 */
const messy = (webdav: Record<string, any>) => ({
  webdav: {
    authType: "digest",
    depth: "manual_infinity",
    manualRecursive: false,
    customHeaders: "X-A: 1",
    ...webdav,
  },
  syncConfigDir: false,
  syncUnderscoreItems: false,
  conflictAction: "keep_larger",
  deleteToWhere: "system",
  serviceType: "s3",
  syncDirection: "incremental_push_only",
  protectModifyPercentage: 10,
  syncOnSaveAfterMilliseconds: -1,
  syncBookmarks: true,
  skipSizeLargerThan: 1000,
  onlyAllowPaths: ["x"],
  ignorePaths: ["y"],
  concurrency: 1,
  enableStatusBarInfo: false,
  enableMobileStatusBar: false,
  obfuscateSettingFile: false,
  autoRunEveryMilliseconds: 300000,
  initRunAfterMilliseconds: 1000,
  currLogLevel: "debug",
}) as any;

const studentAddr = "https://cloud.nextclaw.chat/remote.php/dav/files/s1/Documents";

describe("NextClaw 设置页：隐藏项每次加载强制为预设值", () => {
  it("模式 B：隐藏项全部回到预设", () => {
    const s = messy({ username: "s1", address: studentAddr, remoteBaseDir: NEXTCLAW_REMOTE_BASE_DIR });
    enforceHiddenSettings(s);
    assert.equal(s.syncConfigDir, true);
    assert.equal(s.syncUnderscoreItems, true);
    assert.equal(s.conflictAction, "keep_newer");
    assert.equal(s.deleteToWhere, "obsidian");
    assert.equal(s.serviceType, "webdav");
    assert.equal(s.syncDirection, PRESET_B.syncDirection);
    assert.equal(s.protectModifyPercentage, PRESET_B.protectModifyPercentage);
    assert.equal(s.syncOnSaveAfterMilliseconds, PRESET_B.syncOnSaveAfterMilliseconds);
    assert.ok(s.syncOnSaveAfterMilliseconds > 0, "保存时同步必须开启");
    assert.equal(s.syncBookmarks, false);
    assert.equal(s.skipSizeLargerThan, -1);
    assert.deepEqual(s.onlyAllowPaths, []);
    assert.deepEqual(s.ignorePaths, []);
    assert.equal(s.concurrency, 5);
    assert.equal(s.enableStatusBarInfo, true);
    assert.equal(s.enableMobileStatusBar, true);
    assert.equal(s.obfuscateSettingFile, true);
  });

  it("模式 A：分支相关的隐藏项取模式 A 预设，折叠区块三项也强制", () => {
    const s = messy({ username: "", address: NEXTCLAW_PUBLIC_WEBDAV_URL, remoteBaseDir: NEXTCLAW_REMOTE_BASE_DIR });
    enforceHiddenSettings(s);
    assert.equal(s.syncDirection, PRESET_A.syncDirection);
    assert.equal(s.protectModifyPercentage, PRESET_A.protectModifyPercentage);
    assert.equal(s.syncOnSaveAfterMilliseconds, PRESET_A.syncOnSaveAfterMilliseconds);
    assert.equal(s.webdav.authType, "basic");
    assert.equal(s.webdav.depth, "manual_1");
    assert.equal(s.webdav.manualRecursive, true);
    assert.equal(s.webdav.customHeaders, "");
  });

  it("可见项保留用户的值（模式 B）", () => {
    const s = messy({ username: "s1", address: "https://my.own/dav", password: "pw", remoteBaseDir: "Mine" });
    enforceHiddenSettings(s);
    assert.equal(s.webdav.address, "https://my.own/dav");
    assert.equal(s.webdav.username, "s1");
    assert.equal(s.webdav.password, "pw");
    assert.equal(s.webdav.authType, "digest");
    assert.equal(s.webdav.depth, "manual_infinity");
    assert.equal(s.webdav.customHeaders, "X-A: 1");
    assert.equal(s.webdav.remoteBaseDir, "Mine");
    assert.equal(s.autoRunEveryMilliseconds, 300000);
    assert.equal(s.initRunAfterMilliseconds, 1000);
    assert.equal(s.currLogLevel, "debug");
  });

  it("数组是新的，不与其它设置共用引用", () => {
    const a = messy({ username: "s1", address: studentAddr });
    const b = messy({ username: "s1", address: studentAddr });
    enforceHiddenSettings(a);
    enforceHiddenSettings(b);
    a.ignorePaths.push("z");
    assert.deepEqual(b.ignorePaths, []);
  });

  it("NextClaw 地址：远端目录被改过 → 改回默认并要求清空同步记录", () => {
    for (const address of [studentAddr, NEXTCLAW_PUBLIC_WEBDAV_URL]) {
      const username = address === studentAddr ? "s1" : "";
      for (const old of ["Other", ""]) {
        const s = messy({ username, address, remoteBaseDir: old });
        const r = enforceHiddenSettings(s);
        assert.equal(s.webdav.remoteBaseDir, NEXTCLAW_REMOTE_BASE_DIR, `${address} ${old}`);
        assert.equal(r.remoteBaseDirReset, true, `${address} 旧值 "${old}"`);
      }
    }
  });

  it("NextClaw 地址且远端目录已是默认 → 不要求清空", () => {
    const s = messy({ username: "s1", address: studentAddr, remoteBaseDir: NEXTCLAW_REMOTE_BASE_DIR });
    assert.equal(enforceHiddenSettings(s).remoteBaseDirReset, false);
  });

  it("其他 WebDAV 地址 → 远端目录不动、不要求清空", () => {
    const s = messy({ username: "u", address: "https://my.own/dav", remoteBaseDir: "Mine" });
    assert.equal(enforceHiddenSettings(s).remoteBaseDirReset, false);
    assert.equal(s.webdav.remoteBaseDir, "Mine");
  });
});

const fake = () => {
  const st = { disabled: undefined as boolean | undefined, value: "" };
  return { st, setDisabled(v: boolean) { st.disabled = v; return this; }, setValue(v: string) { st.value = v; return this; } };
};

describe("NextClaw 设置页：远端目录在 NextClaw 地址下只读", () => {
  it("模式 A 锁定", () => {
    const locks = new BranchLocks({ username: "", address: "" });
    const c = fake(); locks.lockWhenNextclawAddress(c); locks.refresh();
    assert.equal(c.st.disabled, true);
  });
  it("模式 B + 学生账号模板地址 锁定", () => {
    const locks = new BranchLocks({ username: "s1", address: studentAddr });
    const c = fake(); locks.lockWhenNextclawAddress(c); locks.refresh();
    assert.equal(c.st.disabled, true);
  });
  it("模式 B + 其他地址 解锁；改回 NextClaw 地址后再次锁定", () => {
    const webdav: any = { username: "s1", address: "https://my.own/dav" };
    const locks = new BranchLocks(webdav);
    const c = fake(); locks.lockWhenNextclawAddress(c); locks.refresh();
    assert.equal(c.st.disabled, false);
    webdav.address = studentAddr; locks.refresh();
    assert.equal(c.st.disabled, true);
  });
  it("lockInA 的控件在模式 B 其他地址下同样解锁（折叠区块三项）", () => {
    const locks = new BranchLocks({ username: "s1", address: "https://my.own/dav" });
    const c = fake(); locks.lockInA(c); locks.refresh();
    assert.equal(c.st.disabled, false);
  });
});

describe("NextClaw 设置页：文案", () => {
  it("新文案三种语言齐全，且不再带上游的\"实验性质\"字样", () => {
    const keys = ["nextclaw_group_account", "nextclaw_group_sync", "nextclaw_group_diagnostics",
      "nextclaw_group_otherwebdav", "nextclaw_group_otherwebdav_desc", "settings_remotebasedir", "settings_runoncestartup",
      "settings_autorun", "settings_syncplans", "settings_debuglevel", "settings_webdav_auth", "settings_webdav_depth",
      "settings_webdav_customheaders"];
    for (const lang of ["en", "zh_cn", "zh_tw"]) {
      const d = JSON.parse(src(`langs/${lang}.json`));
      for (const k of keys) assert.ok(typeof d[k] === "string" && d[k].trim() !== "", `${lang}.${k}`);
      assert.doesNotMatch(d.settings_remotebasedir, /experimental|实验|實驗/, lang);
    }
  });
});

describe("NextClaw 设置页：加载与同步接线", () => {
  const m = src("main.ts");
  it("加载设置时在模式 A 预设之后强制隐藏项，并在远端目录被改回时打清空标记", () => {
    const iPreset = m.indexOf("applyBranchPreset(this.settings, Platform.isMobile);");
    const stmt = /\n    if \(enforceHiddenSettings\(this\.settings\)\.remoteBaseDirReset\) \{\n      this\.settings\.nextclawPendingRecordReset = true;\n    \}\n/;
    const mm = stmt.exec(m);
    assert.ok(mm, "loadSettings 中必须无条件调用 enforceHiddenSettings 并据结果打清空标记");
    assert.ok(iPreset > 0 && mm.index > iPreset, "必须在模式 A 预设之后");
    assert.equal((m.match(/enforceHiddenSettings\(/g) ?? []).length, 1, "只能有一处调用");
  });
  it("默认设置里清空标记为 false", () => {
    assert.match(m, /nextclawPendingRecordReset: false,/);
  });
  it("调试文件夹改名为 _nextclaw_debug/", () => {
    assert.equal(DEFAULT_DEBUG_FOLDER, "_nextclaw_debug/");
  });
});
