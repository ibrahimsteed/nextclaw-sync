import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";

const src = (f: string) =>
  readFileSync(path.join(__dirname, "..", "..", "src", f), "utf8");
const mainTs = src("main.ts");

describe("NextClaw：删除落到库内 .trash，不用系统回收站", () => {
  it("DEFAULT_SETTINGS 是 obsidian", () => {
    assert.match(mainTs, /deleteToWhere:\s*"obsidian",/);
  });

  it("所有兜底也是 obsidian——否则等于默认值被顶回去", () => {
    // 和 agreeToUseSyncV3 同一类地雷：DEFAULT_SETTINGS 改了但兜底没改，
    // 一旦设置里该项为 undefined 就又回到系统回收站。
    const leaks = [
      ...mainTs.matchAll(/deleteToWhere\s*(\?\?|=)\s*"system"/g),
    ].map((m) => m[0]);
    assert.deepEqual(leaks, [], `仍有兜底指向系统回收站: ${leaks.join(", ")}`);
  });

  it("构造 FakeFsLocal 用 obsidian 兜底", () => {
    const n = [...mainTs.matchAll(/deleteToWhere\s*\?\?\s*"obsidian"/g)].length;
    const ctors = [...mainTs.matchAll(/new FakeFsLocal\(/g)].length;
    assert.equal(ctors, 1, `期望 1 处 FakeFsLocal 构造，实到 ${ctors}`);
    assert.equal(n, ctors, `期望 ${ctors} 处兜底，实到 ${n}`);
  });

  it("两个分支的预设都带 deleteToWhere=obsidian", () => {
    // 放进 COMMON 而不是只靠 DEFAULT_SETTINGS：那只是"新装时的默认值"。
    // 进预设后 A 分支每次加载都重套用，B 分支在切换时设定一次。
    const { PRESET_A, PRESET_B } = require("../../src/nextclaw/presets");
    assert.equal(PRESET_A.deleteToWhere, "obsidian");
    assert.equal(PRESET_B.deleteToWhere, "obsidian");
  });

  it("上游 rm 的回退链仍在（我们只是不再依赖它）", () => {
    // "obsidian" 直接 trashLocal；"system" 才走 trashSystem→trashLocal 的回退。
    const fsLocal = src("fsLocal.ts");
    assert.match(fsLocal, /trashLocal\(key\)/);
    assert.match(fsLocal, /trashSystem\(key\)/);
  });

  it(".trash 不会被同步——本地遍历用 getAllLoadedFiles，不含隐藏目录", () => {
    // 这一条保证删除的内容不会以 .trash/ 的形式被推进学生库。
    assert.match(src("fsLocal.ts"), /this\.vault\.getAllLoadedFiles\(\)/);
  });
});
