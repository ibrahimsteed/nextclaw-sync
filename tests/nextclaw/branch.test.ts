import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import {
  detectBranch,
  accountAddressFor,
  effectiveWebdavConfig,
} from "../../src/nextclaw/branch";
import { PRESET_A, PRESET_B, applyBranchPreset } from "../../src/nextclaw/presets";
import {
  NEXTCLAW_PUBLIC_SHARE_TOKEN,
  NEXTCLAW_PUBLIC_SHARE_PASSWORD,
  NEXTCLAW_PUBLIC_WEBDAV_URL,
  NEXTCLAW_REMOTE_BASE_DIR,
} from "../../src/nextclaw/constants";

const src = (f: string) =>
  readFileSync(path.join(__dirname, "..", "..", "src", f), "utf8");

describe("NextClaw 阶段 2：分支判定", () => {
  it("用户名为空 → A", () => {
    assert.equal(detectBranch({ username: "" }), "A");
    assert.equal(detectBranch({ username: "   " }), "A");
    assert.equal(detectBranch({}), "A");
  });

  it("用户名非空 → B", () => {
    assert.equal(detectBranch({ username: "student01" }), "B");
  });

  it("判据只看用户名，不看密码", () => {
    // 若要求两者都非空：用户填完用户名、还没填密码时仍在 A、控件还锁着，
    // 他就没机会填密码——死锁。
    assert.equal(detectBranch({ username: "student01", password: "" } as any), "B");
  });
});

describe("NextClaw 阶段 2：连接时的凭据注入", () => {
  it("A 分支注入 token 与占位密码", () => {
    const eff = effectiveWebdavConfig({
      address: "",
      username: "",
      password: "",
      remoteBaseDir: NEXTCLAW_REMOTE_BASE_DIR,
    });
    assert.equal(eff.address, NEXTCLAW_PUBLIC_WEBDAV_URL);
    assert.equal(eff.username, NEXTCLAW_PUBLIC_SHARE_TOKEN);
    assert.equal(eff.password, NEXTCLAW_PUBLIC_SHARE_PASSWORD);
  });

  it("注入是返回新对象，不污染设置本身", () => {
    // 一旦写回 settings.webdav.username，detectBranch 就永远判成 B，
    // 用户再也回不到欢迎库。
    const stored = { address: "", username: "", password: "" };
    effectiveWebdavConfig(stored);
    assert.equal(stored.username, "");
    assert.equal(stored.password, "");
  });

  it("B 分支原样返回，不碰用户填的东西", () => {
    const mine = {
      address: "https://my.dav/x",
      username: "me",
      password: "pw",
    };
    assert.deepEqual(effectiveWebdavConfig(mine), mine);
  });
});

describe("NextClaw 阶段 2：预设", () => {
  it("A 分支：只拉不删、三个自动触发全关", () => {
    assert.equal(PRESET_A.syncDirection, "incremental_pull_only");
    assert.equal(PRESET_A.autoRunEveryMilliseconds, -1);
    assert.equal(PRESET_A.initRunAfterMilliseconds, -1);
    assert.equal(PRESET_A.syncOnSaveAfterMilliseconds, -1);
  });

  it("B 分支：双向、三个自动触发按设计取值", () => {
    assert.equal(PRESET_B.syncDirection, "bidirectional");
    assert.equal(PRESET_B.autoRunEveryMilliseconds, 600000);
    assert.equal(PRESET_B.initRunAfterMilliseconds, 10000);
    assert.equal(PRESET_B.syncOnSaveAfterMilliseconds, 30000);
  });

  it("两个分支都开 syncConfigDir 与 syncUnderscoreItems", () => {
    // 交付配置全在 .obsidian/；_meta/ 的仪表盘靠 underscore。
    for (const p of [PRESET_A, PRESET_B]) {
      assert.equal(p.syncConfigDir, true);
      assert.equal(p.syncUnderscoreItems, true);
      assert.equal(p.conflictAction, "keep_newer");
      // 保护阈值两分支不同，见 regressions.test.ts
    }
  });

  it("套用 A 预设会强制地址与远端基文件夹", () => {
    const st: any = {
      webdav: { username: "", address: "https://elsewhere/", remoteBaseDir: "" },
    };
    applyBranchPreset(st);
    assert.equal(st.webdav.address, NEXTCLAW_PUBLIC_WEBDAV_URL);
    assert.equal(st.webdav.remoteBaseDir, NEXTCLAW_REMOTE_BASE_DIR);
    assert.equal(st.syncDirection, "incremental_pull_only");
  });

  it("套用 B 预设会把地址模板填成用户名", () => {
    const st: any = {
      webdav: {
        username: "student01",
        address: NEXTCLAW_PUBLIC_WEBDAV_URL,
        remoteBaseDir: "",
      },
    };
    applyBranchPreset(st);
    assert.ok(st.webdav.address.includes("/files/student01/"));
    assert.equal(st.webdav.remoteBaseDir, NEXTCLAW_REMOTE_BASE_DIR);
    assert.equal(st.syncDirection, "bidirectional");
  });

  it("B 预设不覆盖用户自己填的地址", () => {
    const st: any = {
      webdav: {
        username: "me",
        address: "https://my.own.dav/dav",
        remoteBaseDir: "Vault",
      },
    };
    applyBranchPreset(st);
    assert.equal(st.webdav.address, "https://my.own.dav/dav");
    assert.equal(st.webdav.remoteBaseDir, "Vault");
  });

  it("地址模板对用户名做百分号转义", () => {
    assert.ok(accountAddressFor("a b").includes("a%20b"));
  });
});

describe("NextClaw 阶段 2：上游文件的接线", () => {
  it("fsGetter 用 effectiveWebdavConfig 构造 WebDAV 客户端", () => {
    assert.match(
      src("fsGetter.ts"),
      /new FakeFsWebdav\(\s*effectiveWebdavConfig\(settings\.webdav\)/
    );
  });
});
