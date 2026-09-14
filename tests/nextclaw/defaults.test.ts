import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import {
  NEXTCLAW_PUBLIC_WEBDAV_URL,
  NEXTCLAW_PUBLIC_SHARE_TOKEN,
  NEXTCLAW_PUBLIC_SHARE_PASSWORD,
  NEXTCLAW_ACCOUNT_WEBDAV_URL_TEMPLATE,
  NEXTCLAW_USERNAME_PLACEHOLDER,
  NEXTCLAW_REMOTE_BASE_DIR,
  NEXTCLAW_WEBDAV_DEFAULTS,
} from "../../src/nextclaw/constants";

// `src/main.ts` 依赖 `obsidian`，那是宿主在运行时注入的，node 里导不进来。
// 所以对 DEFAULT_SETTINGS 的接线改为读源码断言——它照样会在接线被删掉时报红。
const mainTs = readFileSync(
  path.join(__dirname, "..", "..", "src", "main.ts"),
  "utf8"
);

describe("NextClaw 阶段 1：预填常量", () => {
  it("远端基文件夹非空", () => {
    // 留空会回落成用户本地 vault 名（src/fsWebdav.ts 的 `|| vaultName`），
    // 而"本地库名随便起"正是这个字段存在的理由。
    assert.notEqual(NEXTCLAW_REMOTE_BASE_DIR, "");
    assert.equal(NEXTCLAW_WEBDAV_DEFAULTS.remoteBaseDir, NEXTCLAW_REMOTE_BASE_DIR);
  });

  it("用户名与密码的默认值为空", () => {
    // 分支判定靠"用户名为空"。token 一旦预填进 username，就永远进不了 A 分支。
    assert.equal(NEXTCLAW_WEBDAV_DEFAULTS.username, "");
    assert.equal(NEXTCLAW_WEBDAV_DEFAULTS.password, "");
  });

  it("公开分享的 token 没有泄漏进任何默认值", () => {
    const dumped = JSON.stringify(NEXTCLAW_WEBDAV_DEFAULTS);
    assert.ok(!dumped.includes(NEXTCLAW_PUBLIC_SHARE_TOKEN));
    assert.ok(!dumped.includes(NEXTCLAW_PUBLIC_SHARE_PASSWORD));
  });

  it("占位密码非空", () => {
    // src/fsWebdav.ts 只在 username 和 password 都非空时才发 Basic 认证头；
    // 为空则完全不发头，对 /public.php/webdav 就是 401。
    assert.notEqual(NEXTCLAW_PUBLIC_SHARE_PASSWORD, "");
  });

  it("地址预填指向公开分享端点", () => {
    assert.equal(NEXTCLAW_WEBDAV_DEFAULTS.address, NEXTCLAW_PUBLIC_WEBDAV_URL);
    assert.ok(NEXTCLAW_PUBLIC_WEBDAV_URL.startsWith("https://"));
    assert.ok(NEXTCLAW_PUBLIC_WEBDAV_URL.includes("/public.php/webdav"));
  });

  it("B 分支模板含可替换的 {username} 占位", () => {
    assert.ok(
      NEXTCLAW_ACCOUNT_WEBDAV_URL_TEMPLATE.includes(NEXTCLAW_USERNAME_PLACEHOLDER)
    );
    const filled = NEXTCLAW_ACCOUNT_WEBDAV_URL_TEMPLATE.replace(
      NEXTCLAW_USERNAME_PLACEHOLDER,
      "student01"
    );
    assert.ok(!filled.includes(NEXTCLAW_USERNAME_PLACEHOLDER));
    assert.ok(filled.includes("/files/student01/"));
  });
});

describe("NextClaw 阶段 1：DEFAULT_SETTINGS 的接线", () => {
  it("serviceType 已改为 webdav", () => {
    assert.match(mainTs, /serviceType:\s*"webdav"/);
  });

  it("webdav 默认值是展开覆盖，不是整体替换", () => {
    // 整体替换会丢掉上游将来新增的字段（authType、depth 等）。
    assert.match(
      mainTs,
      /webdav:\s*\{\s*\.\.\.DEFAULT_WEBDAV_CONFIG,\s*\.\.\.NEXTCLAW_WEBDAV_DEFAULTS\s*\}/
    );
  });

  it("常量确实从 nextclaw/constants 引入", () => {
    assert.match(mainTs, /from\s+"\.\/nextclaw\/constants"/);
  });
});
