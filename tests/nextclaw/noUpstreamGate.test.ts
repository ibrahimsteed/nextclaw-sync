import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";

const mainTs = readFileSync(
  path.join(__dirname, "..", "..", "src", "main.ts"),
  "utf8"
);

describe("NextClaw：启动时不经过上游的「同步算法有重大更新」确认框", () => {
  it("弹窗与它的开关都已删除", () => {
    // 那个弹窗是给 remotely-save v2→v3 的老用户看的，而且点 X 关闭会停用插件。
    assert.doesNotMatch(mainTs, /SyncAlgoV3Modal|agreeToUseSyncV3(?!")/);
  });

  it("onload 无条件接上三个自动触发", () => {
    const i = mainTs.indexOf("async onload()");
    const j = mainTs.indexOf("async onunload()");
    const onload = mainTs.slice(i, j);
    assert.match(onload, /\n    this\.enableAutoSyncIfSet\(\);\n    this\.enableInitSyncIfSet\(\);\n    this\.toggleSyncOnSaveIfSet\(\);\n/);
  });
});
