import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import XRegExp from "xregexp";
import { effectiveIgnorePaths } from "../../src/nextclaw/branch";

/**
 * 引擎规格：`ignorePaths` 每条是一个正则（XRegExp，astral 模式），
 * 对路径做 test；空白条目忽略。自有引擎必须按此实现。
 */
const ignored = (patterns: string[], key: string): boolean =>
  patterns.some((r) => r.trim() !== "" && XRegExp(r, "A").test(key));

describe("NextClaw：关掉插件对自己目录的同步", () => {
  const P = effectiveIgnorePaths([], "nextclaw-sync", ".obsidian");

  it("自己目录下的五个文件全部被排除", () => {
    for (const f of [
      "main.js",
      "manifest.json",
      "styles.css",
      "data.json",
      ".gitignore",
    ]) {
      assert.ok(
        ignored(P, `.obsidian/plugins/nextclaw-sync/${f}`),
        `${f} 应被排除`
      );
    }
  });

  it("目录本身也被排除，否则服务端会留个空文件夹", () => {
    assert.ok(ignored(P, ".obsidian/plugins/nextclaw-sync/"));
    assert.ok(ignored(P, ".obsidian/plugins/nextclaw-sync"));
  });

  it("别的插件不受影响——它们是交付内容，必须同步", () => {
    for (const p of ["copilot", "dataview", "borrax-html"]) {
      assert.ok(!ignored(P, `.obsidian/plugins/${p}/main.js`));
    }
  });

  it("名字前缀相同的插件不会被误伤", () => {
    assert.ok(!ignored(P, ".obsidian/plugins/nextclaw-sync-extra/main.js"));
  });

  it("库里的普通笔记不受影响", () => {
    assert.ok(!ignored(P, "_meta/dashboard.md"));
    assert.ok(!ignored(P, "concepts/nextclaw-sync.md"));
  });

  it("configDir 不写死，跟随 vault 实际取值", () => {
    const Q = effectiveIgnorePaths([], "nextclaw-sync", ".myconf");
    assert.ok(ignored(Q, ".myconf/plugins/nextclaw-sync/main.js"));
    assert.ok(!ignored(Q, ".obsidian/plugins/nextclaw-sync/main.js"));
  });

  it("保留用户自己填的忽略规则", () => {
    const R = effectiveIgnorePaths(["^tmp/"], "nextclaw-sync", ".obsidian");
    assert.equal(R.length, 2);
    assert.ok(R.includes("^tmp/"));
    assert.ok(ignored(R, "tmp/x.md"));
  });

  it("重复调用不会重复追加", () => {
    const once = effectiveIgnorePaths([], "nextclaw-sync", ".obsidian");
    const twice = effectiveIgnorePaths(once, "nextclaw-sync", ".obsidian");
    assert.deepEqual(once, twice);
  });

  it("undefined 也能处理", () => {
    assert.equal(
      effectiveIgnorePaths(undefined, "nextclaw-sync", ".obsidian").length,
      1
    );
  });

  it("main.ts 在 syncer 调用处注入，而不是写进用户设置", () => {
    // 写进 settings.ignorePaths 会显示在设置界面里，用户能删掉它，
    // 那这条不变量就守不住了。
    const m = readFileSync(
      path.join(__dirname, "..", "..", "src", "main.ts"),
      "utf8"
    );
    assert.match(m, /ignorePaths: effectiveIgnorePaths\(/);
  });
});
