import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import {
  PRESET_A,
  PRESET_B,
  PRESET_B_MOBILE_OVERRIDES,
  applyBranchPreset,
} from "../../src/nextclaw/presets";
import { applyUsernameChange } from "../../src/nextclaw/usernameChange";

const stB = () => ({
  webdav: { username: "student01", address: "", remoteBaseDir: "" },
}) as any;
const stA = () => ({
  webdav: { username: "", address: "", remoteBaseDir: "" },
}) as any;

describe("NextClaw：移动端的 B 分支自动触发取值", () => {
  it("移动端：启动后 30 秒", () => {
    const s = stB();
    applyBranchPreset(s, true);
    assert.equal(s.initRunAfterMilliseconds, 30000);
  });

  it("移动端：保存时同步**保持开启**", () => {
    // 服务端另有写入方。学生的编辑若最长 10 分钟才上传，服务端写入方会基于
    // 陈旧内容改写，学生那次编辑在冲突里被判"较旧"而静默丢失。
    const s = stB();
    applyBranchPreset(s, true);
    assert.equal(s.syncOnSaveAfterMilliseconds, 30000);
    assert.ok(s.syncOnSaveAfterMilliseconds > 0, "必须 > 0 才算开启");
  });

  it("移动端：自动运行维持 10 分钟", () => {
    const s = stB();
    applyBranchPreset(s, true);
    assert.equal(s.autoRunEveryMilliseconds, 600000);
  });

  it("桌面端保持原规格", () => {
    const s = stB();
    applyBranchPreset(s, false);
    assert.equal(s.initRunAfterMilliseconds, 10000);
    assert.equal(s.syncOnSaveAfterMilliseconds, 30000);
    assert.equal(s.autoRunEveryMilliseconds, 600000);
  });

  it("两个平台唯一的差别就是启动延迟", () => {
    const m = stB(); applyBranchPreset(m, true);
    const d = stB(); applyBranchPreset(d, false);
    const diffs = Object.keys(m).filter(
      (k) => k !== "webdav" && JSON.stringify(m[k]) !== JSON.stringify(d[k])
    );
    assert.deepEqual(diffs, ["initRunAfterMilliseconds"]);
  });

  it("不传第二个参数时默认按桌面处理", () => {
    const s = stB();
    applyBranchPreset(s);
    assert.equal(s.initRunAfterMilliseconds, 10000);
  });

  it("A 分支不受移动端覆盖影响——它三个触发本来就全关", () => {
    const s = stA();
    applyBranchPreset(s, true);
    assert.equal(s.autoRunEveryMilliseconds, -1);
    assert.equal(s.initRunAfterMilliseconds, -1);
    assert.equal(s.syncOnSaveAfterMilliseconds, -1);
  });

  it("覆盖表只动启动延迟一项", () => {
    assert.deepEqual(Object.keys(PRESET_B_MOBILE_OVERRIDES), [
      "initRunAfterMilliseconds",
    ]);
  });

  it("A→B 切换时移动端取值随之生效", () => {
    const s = stA();
    applyUsernameChange(s, "student01", true);
    assert.equal(s.initRunAfterMilliseconds, 30000);
    assert.equal(s.syncOnSaveAfterMilliseconds, 30000);
  });

  it("桌面端走同一条路径但取原值", () => {
    const s = stA();
    applyUsernameChange(s, "student01", false);
    assert.equal(s.initRunAfterMilliseconds, 10000);
    assert.equal(s.syncOnSaveAfterMilliseconds, 30000);
  });
});

describe("NextClaw：移动端取值的接线", () => {
  const src = (f: string) =>
    readFileSync(path.join(__dirname, "..", "..", "src", f), "utf8");

  it("main.ts 在 loadSettings 里传 Platform.isMobile", () => {
    assert.match(src("main.ts"), /applyBranchPreset\(this\.settings,\s*Platform\.isMobile\)/);
  });

  it("settings.ts 在用户名变化时传 Platform.isMobile", () => {
    assert.match(src("settings.ts"), /applyUsernameChange\([\s\S]{0,120}Platform\.isMobile/);
  });
});
