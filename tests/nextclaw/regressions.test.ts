/**
 * 端到端路径的回归测试。
 *
 * 只验"分支切换时"的行为不够，还要验"全新安装"和"用户名逐字符输入"这两条真实路径。
 */
import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import {
  detectBranch,
  accountAddressFor,
  isManagedAddress,
} from "../../src/nextclaw/branch";
import { applyBranchPreset, PRESET_A, PRESET_B } from "../../src/nextclaw/presets";
import { applyUsernameChange } from "../../src/nextclaw/usernameChange";
import {
  NEXTCLAW_PUBLIC_WEBDAV_URL,
  NEXTCLAW_REMOTE_BASE_DIR,
} from "../../src/nextclaw/constants";

const mainTs = readFileSync(
  path.join(__dirname, "..", "..", "src", "main.ts"),
  "utf8"
);

describe("回归：全新安装时 A 分支预设没被套上", () => {
  it("loadSettings 里对 A 分支套预设", () => {
    // 原先只在设置界面"分支切换"时套，而全新安装根本没有切换发生。
    const i = mainTs.indexOf("async loadSettings()");
    const j = mainTs.indexOf("applyBranchPreset(this.settings", i);
    assert.ok(j > i, "loadSettings 里必须有 applyBranchPreset");
  });

  it("而且只对 A 分支套——B 分支这些项允许用户改", () => {
    const i = mainTs.indexOf("async loadSettings()");
    const seg = mainTs.slice(i, i + 3000);
    assert.match(seg, /detectBranch\([\s\S]{0,60}\) === "A"/);
  });

  it("套完之后三项必须是 A 分支的值，不是上游默认", () => {
    // 上游默认：bidirectional / false / false。锁住错的值等于没锁。
    const st: any = {
      webdav: { username: "", address: "", remoteBaseDir: "" },
      syncDirection: "bidirectional",
      syncConfigDir: false,
      syncUnderscoreItems: false,
    };
    applyBranchPreset(st);
    assert.equal(st.syncDirection, "incremental_pull_only");
    assert.equal(st.syncConfigDir, true);
    assert.equal(st.syncUnderscoreItems, true);
  });

  it("A 分支是只拉不推——否则会往只读的公开分享推送用户笔记，403", () => {
    assert.ok(PRESET_A.syncDirection.startsWith("incremental_pull"));
    assert.ok(!PRESET_A.syncDirection.includes("push"));
    assert.ok((PRESET_A.syncDirection as string) !== "bidirectional");
  });
});

describe("回归：地址被定死成用户名第一个字符生成的那个", () => {
  it("isManagedAddress 认模板形状，不是某个具体值", () => {
    assert.ok(isManagedAddress(""));
    assert.ok(isManagedAddress(NEXTCLAW_PUBLIC_WEBDAV_URL));
    assert.ok(isManagedAddress(accountAddressFor("s")));
    assert.ok(isManagedAddress(accountAddressFor("student01")));
  });

  it("用户自己改的地址不算 managed，不会被覆盖", () => {
    assert.ok(!isManagedAddress("https://my.own.dav/dav"));
    // 多一层路径就不是我们的模板了
    assert.ok(
      !isManagedAddress(accountAddressFor("student01") + "/Extra")
    );
    // 注意 accountAddressFor 会把用户名百分号转义，所以 "a/b" 生成的
    // 仍是合法的我们自己的地址（a%2Fb），**算 managed**。
    assert.ok(isManagedAddress(accountAddressFor("a/b")));
  });

  it("逐字符输入用户名，地址每一步都跟着重算", () => {
    const st: any = {
      webdav: { username: "", address: NEXTCLAW_PUBLIC_WEBDAV_URL, remoteBaseDir: "" },
    };
    for (const u of ["s", "s1", "s10", "student01"]) {
      st.webdav.username = u;
      applyBranchPreset(st);
    }
    assert.equal(st.webdav.address, accountAddressFor("student01"));
    assert.ok(!st.webdav.address.includes("/files/s/"));
  });

  it("中途用户改成自己的服务器后，后续输入不再覆盖它", () => {
    const st: any = {
      webdav: { username: "s1", address: "https://my.own.dav/dav", remoteBaseDir: "" },
    };
    st.webdav.username = "student01";
    applyBranchPreset(st);
    assert.equal(st.webdav.address, "https://my.own.dav/dav");
  });
});

describe("回归：A 分支的 remoteBaseDir 必须被强制", () => {
  it("即便设置里被改成别的，A 分支加载时也会被拉回", () => {
    const st: any = {
      webdav: { username: "", address: "", remoteBaseDir: "别的" },
    };
    applyBranchPreset(st);
    assert.equal(st.webdav.remoteBaseDir, NEXTCLAW_REMOTE_BASE_DIR);
  });
});

describe("回归：用户名变化的完整行为（提成纯函数后可直接验）", () => {
  const fresh = () => ({
    webdav: {
      username: "",
      password: "",
      address: NEXTCLAW_PUBLIC_WEBDAV_URL,
      remoteBaseDir: NEXTCLAW_REMOTE_BASE_DIR,
    },
  } as any);

  it("逐字符输入：地址每一步都重算，且报告 addressChanged", () => {
    const st = fresh();
    const seen: string[] = [];
    for (const u of ["s", "s1", "s10", "student01"]) {
      const r = applyUsernameChange(st, u);
      assert.equal(r.addressChanged, true, `输入 ${u} 时地址应变化`);
      seen.push(r.address);
    }
    assert.equal(st.webdav.address, accountAddressFor("student01"));
    assert.ok(!st.webdav.address.includes("/files/s/"));
    assert.equal(new Set(seen).size, 4, "四步应生成四个不同地址");
  });

  it("只有第一次报告 branchChanged / switchedAtoB", () => {
    const st = fresh();
    const r1 = applyUsernameChange(st, "s");
    assert.equal(r1.branchChanged, true);
    assert.equal(r1.switchedAtoB, true);
    assert.equal(st.nextclawPendingSwitchToB, true);

    const r2 = applyUsernameChange(st, "student01");
    assert.equal(r2.branchChanged, false);
    assert.equal(r2.switchedAtoB, false);
  });

  it("清空用户名退回 A：地址被强制回落，且不打切换标记", () => {
    const st = fresh();
    applyUsernameChange(st, "student01");
    st.nextclawPendingSwitchToB = false;

    const r = applyUsernameChange(st, "");
    assert.equal(r.branchChanged, true);
    assert.equal(r.switchedAtoB, false, "B→A 不是切换，不该打标记");
    assert.equal(st.webdav.address, NEXTCLAW_PUBLIC_WEBDAV_URL);
    assert.equal(st.syncDirection, "incremental_pull_only");
    assert.notEqual(st.nextclawPendingSwitchToB, true);
  });

  it("填了用户名、还没同步就清空：待执行的切换被取消", () => {
    const st = fresh();
    applyUsernameChange(st, "student01");
    assert.equal(st.nextclawPendingSwitchToB, true);
    applyUsernameChange(st, "");
    assert.equal(st.nextclawPendingSwitchToB, false, "否则下次同步演示库会把库里的内容移进 .trash");
    applyUsernameChange(st, "student01");
    assert.equal(st.nextclawPendingSwitchToB, true, "再次填入用户名重新打标记");
  });

  it("用户自己改过地址后，继续输入用户名不会覆盖它", () => {
    const st = fresh();
    applyUsernameChange(st, "s1");
    st.webdav.address = "https://my.own.dav/dav";
    const r = applyUsernameChange(st, "student01");
    assert.equal(st.webdav.address, "https://my.own.dav/dav");
    assert.equal(r.addressChanged, false);
  });

  it("用户名前后空白会被去掉", () => {
    const st = fresh();
    applyUsernameChange(st, "  student01  ");
    assert.equal(st.webdav.username, "student01");
  });
});

describe("回归：A 分支绝不能带删", () => {
  it("PRESET_A 的方向里不含 delete", () => {
    // 带删的拉取把"本地有、远端无、曾同步过"的目录当作远端已删除：
    // 设备曾同步过学生库 → .obsidian/plugins/ 满足该条件；
    // 而欢迎库没有该目录 → 整个 plugins/ 被删，三个交付插件与同步插件自己一起没。
    assert.ok(!(PRESET_A.syncDirection as string).includes("delete"));
  });

  it("A 分支仍然是只拉，不会往只读的公开分享推送", () => {
    assert.ok((PRESET_A.syncDirection as string).startsWith("incremental_pull"));
    assert.ok(!(PRESET_A.syncDirection as string).includes("push"));
  });

  it("B 分支不受影响，仍是双向", () => {
    assert.equal(PRESET_B.syncDirection, "bidirectional");
  });
});

describe("回归：欢迎库太小，A 分支同步被修改保护误中断", () => {
  it("A 分支关闭修改保护（100 = 关闭）", () => {
    // 欢迎库 7 个文件，5 个 .obsidian 配置每 15 分钟被刷新 mtime。
    // 跨刻度再同步时它们全判"远端已修改、要拉取"并计入阈值，
    // 约 5/10 = 50% → 触发 >= → 整轮同步中断，欢迎库的更新拉不下来。
    assert.equal(PRESET_A.protectModifyPercentage, 100);
  });

  it("B 分支保持 50——学生库约 1440 个文件，切换时只有约 1.6% 计入", () => {
    assert.equal(PRESET_B.protectModifyPercentage, 50);
  });

  it("按引擎规格复算：A 分支取 100 时，欢迎库场景不会中断", () => {
    // 引擎规格：计入数 / 总数 >= 阈值% 则中断；阈值 100 表示关闭保护。
    const aborts = (pct: number, count: number, total: number) =>
      pct < 100 && count * 100 >= total * pct;
    assert.equal(aborts(50, 5, 10), true, "旧取值 50 在欢迎库场景下必然中断");
    assert.equal(aborts(PRESET_A.protectModifyPercentage, 5, 10), false);
    assert.equal(aborts(PRESET_A.protectModifyPercentage, 10, 10), false, "全部计入也放行");
    assert.equal(aborts(PRESET_B.protectModifyPercentage, 23, 1440), false);
  });
});

describe("回归：移动端启动延迟必须是下拉里现成的选项", () => {
  it("取值在 settings_runoncestartup 的选项之中，否则下拉显示为空", () => {
    const st = readFileSync(
      path.join(__dirname, "..", "..", "src", "settings.ts"), "utf8");
    const i = st.indexOf('t("settings_runoncestartup")');
    assert.ok(i > 0);
    const seg = st.slice(i, i + 900);
    // 选项形如 `${1000 * 10 * 1}`，这里把表达式算出来
    const opts = [...seg.matchAll(/addOption\(\s*(?:"(-?\d+)"|`\$\{([\d\s*]+)\}`)/g)]
      .map((m) => (m[1] !== undefined ? Number(m[1])
        : m[2].split("*").map((x) => Number(x.trim())).reduce((a, b) => a * b, 1)));
    assert.ok(opts.length >= 3, `解析到的选项: ${opts}`);
    const { PRESET_B_MOBILE_OVERRIDES } = require("../../src/nextclaw/presets");
    assert.ok(opts.includes(PRESET_B_MOBILE_OVERRIDES.initRunAfterMilliseconds),
      `${PRESET_B_MOBILE_OVERRIDES.initRunAfterMilliseconds} 不在下拉选项 ${opts} 中`);
    assert.ok(opts.includes(PRESET_B.initRunAfterMilliseconds),
      `桌面取值 ${PRESET_B.initRunAfterMilliseconds} 不在下拉选项中`);
  });
});
