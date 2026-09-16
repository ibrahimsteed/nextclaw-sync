import { strict as assert } from "assert";
import {
  type FakeEl,
  Modal,
  type Setting,
  installFakeObsidian,
} from "./fakeObsidian";
import {
  NEXTCLAW_PUBLIC_WEBDAV_URL,
  NEXTCLAW_REMOTE_BASE_DIR,
} from "../../src/nextclaw/constants";
import { accountAddressFor } from "../../src/nextclaw/branch";

installFakeObsidian();
// biome-ignore lint: 必须在替身装好之后再加载
const { NextclawSyncSettingTab } = require("../../src/settings");

const studentAddr = accountAddressFor("s1");

const render = (webdav: Record<string, any>, extra: Record<string, any> = {}) => {
  const intervals: { id: number; ms: number }[] = [];
  const cleared: number[] = [];
  (global as any).window = {
    setInterval: (_fn: () => void, ms: number) => {
      intervals.push({ id: intervals.length + 1, ms });
      return intervals.length;
    },
    clearInterval: (id: number) => cleared.push(id),
  };
  let saves = 0;
  const plugin: any = {
    settings: {
      webdav: {
        address: NEXTCLAW_PUBLIC_WEBDAV_URL,
        username: "",
        password: "",
        authType: "basic",
        depth: "manual_1",
        manualRecursive: true,
        customHeaders: "",
        remoteBaseDir: NEXTCLAW_REMOTE_BASE_DIR,
        ...webdav,
      },
      initRunAfterMilliseconds: -1,
      autoRunEveryMilliseconds: -1,
      currLogLevel: "info",
      ...extra,
    },
    i18n: { t: (k: string) => k },
    saveSettings: async () => {
      saves++;
    },
    registerInterval: (id: number) => id,
    syncRun: async () => {},
  };
  const app = { vault: { getName: () => "MyVault" } };
  const tab = new NextclawSyncSettingTab(app, plugin);
  tab.display();
  const root: FakeEl = tab.containerEl;
  const all = root.settings();
  const byName = (name: string) => {
    const s = all.find((x: Setting) => x.name === name);
    assert.ok(s, `找不到设置项 ${name}`);
    return s;
  };
  return { tab, root, all, byName, plugin, intervals, cleared, saves: () => saves };
};

const LAYOUT = [
  "# nextclaw_group_account",
  "settings_webdav_user",
  "settings_webdav_password",
  "# nextclaw_group_sync",
  "settings_runoncestartup",
  "settings_autorun",
  "# nextclaw_group_diagnostics",
  "settings_syncplans",
  "settings_debuglevel",
  "# nextclaw_group_otherwebdav",
  "settings_webdav_addr",
  "settings_remotebasedir",
  "settings_webdav_auth",
  "settings_webdav_depth",
  "settings_webdav_customheaders",
];
const FOLDED = LAYOUT.slice(LAYOUT.indexOf("# nextclaw_group_otherwebdav") + 1);

describe("NextClaw 设置页（渲染）：布局", () => {
  beforeEach(() => {
    Modal.opened = [];
  });

  it("只渲染四组、共 11 项，顺序固定，服务器地址在折叠区块最前，没有其它设置项", () => {
    const { all } = render({});
    assert.deepEqual(
      all.map((s: Setting) => (s.heading ? `# ${s.name}` : s.name)),
      LAYOUT
    );
  });

  it("没有 h1/h2 等手写标题元素，分组标题都用 setHeading()", () => {
    const { root } = render({});
    const tags: string[] = [];
    const walk = (e: FakeEl) => {
      tags.push(e.tag);
      e.children.forEach(walk);
    };
    walk(root);
    assert.deepEqual(tags.filter((t) => /^h[1-6]$/.test(t)), []);
  });

  it("\"其他 WebDAV 服务\"默认折叠：服务器地址等五项不可见，其余可见", () => {
    const { all } = render({});
    for (const s of all as Setting[]) {
      const folded = FOLDED.includes(s.name);
      assert.equal(s.settingEl.visible(), !folded, s.name);
    }
  });

  it("点箭头展开、再点收起；点标题文字同样可以切换", () => {
    const { byName } = render({});
    const heading = byName("nextclaw_group_otherwebdav");
    const remote = byName("settings_remotebasedir");
    assert.equal(heading.extraButton.icon, "chevron-right");
    heading.extraButton.click();
    assert.equal(remote.settingEl.visible(), true);
    assert.equal(heading.extraButton.icon, "chevron-down");
    heading.extraButton.click();
    assert.equal(remote.settingEl.visible(), false);
    heading.nameEl.dispatch("click");
    assert.equal(remote.settingEl.visible(), true);
  });

  it("用户名与密码默认遮住，点眼睛切换显示", () => {
    const { byName } = render({});
    for (const name of ["settings_webdav_user", "settings_webdav_password"]) {
      const s = byName(name);
      assert.equal(s.text.inputEl.type, "password", name);
      s.extraButton.click();
      assert.equal(s.text.inputEl.type, "text", name);
      assert.equal(s.extraButton.icon, "eye", name);
      s.extraButton.click();
      assert.equal(s.text.inputEl.type, "password", name);
    }
  });
});

describe("NextClaw 设置页（渲染）：锁定", () => {
  const LOCKED_IN_A = [
    "settings_runoncestartup",
    "settings_autorun",
    "settings_webdav_auth",
    "settings_webdav_depth",
    "settings_webdav_customheaders",
  ];
  const control = (s: Setting) => s.dropdown ?? s.textArea ?? s.text;

  it("模式 A：地址强制为演示库并锁定；同步两项、折叠区块全部锁定；账号与诊断可用", () => {
    const { byName, plugin } = render({ address: "https://changed/" });
    const addr = byName("settings_webdav_addr");
    assert.equal(addr.text.disabled, true);
    assert.equal(addr.text.value, NEXTCLAW_PUBLIC_WEBDAV_URL);
    assert.equal(plugin.settings.webdav.address, NEXTCLAW_PUBLIC_WEBDAV_URL);
    for (const n of LOCKED_IN_A) assert.equal(control(byName(n)).disabled, true, n);
    const remote = byName("settings_remotebasedir");
    assert.equal(remote.text.disabled, true);
    assert.equal(remote.buttons[0].disabled, true);
    assert.equal(byName("settings_webdav_user").text.disabled, false);
    assert.equal(byName("settings_webdav_password").text.disabled, false);
    assert.equal(byName("settings_debuglevel").dropdown.disabled, false);
  });

  it("模式 B + NextClaw 地址：全部可编辑，只有远端目录锁定", () => {
    const { byName } = render({ username: "s1", address: studentAddr });
    assert.equal(byName("settings_webdav_addr").text.disabled, false);
    for (const n of LOCKED_IN_A) assert.equal(control(byName(n)).disabled, false, n);
    assert.equal(byName("settings_remotebasedir").text.disabled, true);
    assert.equal(byName("settings_remotebasedir").buttons[0].disabled, true);
  });

  it("模式 B + 其他地址：远端目录可编辑；把地址改回 NextClaw 地址后重新锁定并保存", async () => {
    const r = render({ username: "s1", address: "https://my.own/dav" });
    const remote = r.byName("settings_remotebasedir");
    assert.equal(remote.text.disabled, false);
    await r.byName("settings_webdav_addr").text.change(` ${studentAddr} `);
    assert.equal(r.plugin.settings.webdav.address, studentAddr);
    assert.equal(remote.text.disabled, true);
    assert.equal(remote.buttons[0].disabled, true);
    assert.ok(r.saves() > 0);
  });

  it("填入用户名：地址跟着变、控件解锁、打上 A→B 切换标记并保存", async () => {
    const r = render({});
    await r.byName("settings_webdav_user").text.change("s1");
    assert.equal(r.byName("settings_webdav_addr").text.value, studentAddr);
    assert.equal(r.byName("settings_webdav_addr").text.disabled, false);
    assert.equal(r.byName("settings_autorun").dropdown.disabled, false);
    assert.equal(r.plugin.settings.nextclawPendingSwitchToB, true);
    assert.ok(r.saves() > 0);
  });

  it("分支切换后，自动同步两项的下拉框显示切换后的取值", async () => {
    const r = render({});
    await r.byName("settings_webdav_user").text.change("s1");
    assert.equal(r.byName("settings_runoncestartup").dropdown.value, `${r.plugin.settings.initRunAfterMilliseconds}`);
    assert.equal(r.byName("settings_autorun").dropdown.value, `${r.plugin.settings.autoRunEveryMilliseconds}`);
    assert.notEqual(r.plugin.settings.autoRunEveryMilliseconds, -1, "模式 B 预设应开启定时同步");
    await r.byName("settings_webdav_user").text.change("");
    assert.equal(r.byName("settings_runoncestartup").dropdown.value, "-1");
    assert.equal(r.byName("settings_autorun").dropdown.value, "-1");
  });

  it("清空用户名：回到模式 A，地址回落演示库并重新锁定", async () => {
    const r = render({ username: "s1", address: studentAddr });
    await r.byName("settings_webdav_user").text.change("");
    assert.equal(r.byName("settings_webdav_addr").text.value, NEXTCLAW_PUBLIC_WEBDAV_URL);
    assert.equal(r.byName("settings_webdav_addr").text.disabled, true);
    assert.equal(r.byName("settings_autorun").dropdown.disabled, true);
  });
});

describe("NextClaw 设置页（渲染）：修改值", () => {
  beforeEach(() => {
    Modal.opened = [];
  });

  const remoteModal = async (value: string) => {
    const r = render({ username: "s1", address: "https://my.own/dav", remoteBaseDir: "Old" });
    const remote = r.byName("settings_remotebasedir");
    await remote.text.change(value);
    await remote.buttons[0].click();
    assert.equal(Modal.opened.length, 1);
    const modal = Modal.opened[0];
    assert.equal(modal.titleEl.text, "modal_remotebasedir_title");
    const buttons = modal.contentEl.settings().flatMap((s: Setting) => s.buttons);
    return { r, modal, buttons };
  };

  it("远端目录：确认修改后保存新值，并要求下次同步前清空同步记录", async () => {
    const { r, modal, buttons } = await remoteModal(" Mine ");
    assert.deepEqual(buttons.map((b) => b.text), ["modal_remotebasedir_secondconfirm_change", "goback"]);
    await buttons[0].click();
    assert.equal(r.plugin.settings.webdav.remoteBaseDir, "Mine");
    assert.equal(r.plugin.settings.nextclawPendingRecordReset, true);
    assert.equal(modal.closed, true);
    assert.ok(r.saves() > 0);
  });

  it("远端目录：留空时改用库名，同样要求清空同步记录", async () => {
    const { r, buttons } = await remoteModal("");
    assert.equal(buttons[0].text, "modal_remotebasedir_secondconfirm_vaultname");
    await buttons[0].click();
    assert.equal(r.plugin.settings.webdav.remoteBaseDir, "");
    assert.equal(r.plugin.settings.nextclawPendingRecordReset, true);
  });

  it("远端目录：含非法字符时只能返回，不改值、不清记录", async () => {
    const { r, modal, buttons } = await remoteModal("a/b");
    assert.deepEqual(buttons.map((b) => b.text), ["goback"]);
    assert.ok(modal.contentEl.texts().includes("modal_remotebasedir_invaliddirhint"));
    await buttons[0].click();
    assert.equal(r.plugin.settings.webdav.remoteBaseDir, "Old");
    assert.equal(r.plugin.settings.nextclawPendingRecordReset, undefined);
  });

  it("远端目录：只改输入框不点确认，不会写进设置", async () => {
    const r = render({ username: "s1", address: "https://my.own/dav", remoteBaseDir: "Old" });
    await r.byName("settings_remotebasedir").text.change("Mine");
    assert.equal(r.plugin.settings.webdav.remoteBaseDir, "Old");
  });

  it("Depth：切换时同步更新 manualRecursive", async () => {
    const r = render({ username: "s1", address: "https://my.own/dav" });
    const depth = r.byName("settings_webdav_depth").dropdown;
    await depth.change("manual_infinity");
    assert.equal(r.plugin.settings.webdav.depth, "manual_infinity");
    assert.equal(r.plugin.settings.webdav.manualRecursive, false);
    await depth.change("manual_1");
    assert.equal(r.plugin.settings.webdav.depth, "manual_1");
    assert.equal(r.plugin.settings.webdav.manualRecursive, true);
  });

  it("自定义请求头：去掉每行首尾空格与空行", async () => {
    const r = render({ username: "s1", address: "https://my.own/dav" });
    await r.byName("settings_webdav_customheaders").textArea.change("  X-A: 1 \n\n X-B: 2\n");
    assert.equal(r.plugin.settings.webdav.customHeaders, "X-A: 1\nX-B: 2");
  });

  it("定时自动同步：改值时先清掉旧定时器再按新间隔注册，改为不设置则只清不建", async () => {
    const r = render({ username: "s1", address: studentAddr });
    const dd = r.byName("settings_autorun").dropdown;
    await dd.change(`${1000 * 60 * 5}`);
    assert.deepEqual(r.intervals.map((x) => x.ms), [300000]);
    await dd.change(`${1000 * 60 * 10}`);
    assert.deepEqual(r.cleared, [1]);
    assert.deepEqual(r.intervals.map((x) => x.ms), [300000, 600000]);
    await dd.change("-1");
    assert.deepEqual(r.cleared, [1, 2]);
    assert.equal(r.intervals.length, 2);
    assert.equal(r.plugin.settings.autoRunEveryMilliseconds, -1);
  });

  it("启动后自动同步与提示级别写回设置", async () => {
    const r = render({ username: "s1", address: studentAddr });
    await r.byName("settings_runoncestartup").dropdown.change("30000");
    assert.equal(r.plugin.settings.initRunAfterMilliseconds, 30000);
    await r.byName("settings_debuglevel").dropdown.change("debug");
    assert.equal(r.plugin.settings.currLogLevel, "debug");
  });

  it("启动后自动同步的选项包含移动端预设值 30 秒", () => {
    const { PRESET_B_MOBILE_OVERRIDES } = require("../../src/nextclaw/presets");
    const r = render({ username: "s1", address: studentAddr });
    const values = r.byName("settings_runoncestartup").dropdown.options.map(([v]) => v);
    assert.ok(values.includes(`${PRESET_B_MOBILE_OVERRIDES.initRunAfterMilliseconds}`));
  });
});

describe("NextClaw 设置页（渲染）：移动端输入框宽度", () => {
  const css = require("fs").readFileSync(
    require("path").join(__dirname, "..", "..", "styles.css"),
    "utf8"
  ) as string;
  const flat = css.replace(/\s+/g, " ");
  // 带输入框的四行都要堆叠：眼睛按钮把 type 从 password 切成 text 时，
  // 官方的 `.is-mobile input[type="text"] { width: 100% }` 会让输入框突然缩水
  // （竖屏实测 238px → 65px，用户名看不全）。
  const STACKED = [
    "settings_webdav_user",
    "settings_webdav_password",
    "settings_webdav_addr",
    "settings_remotebasedir",
  ];

  it("四个带输入框的设置项都带上了堆叠类", () => {
    const { byName } = render({});
    for (const name of STACKED) {
      assert.ok(
        byName(name).settingEl.classes.has("nextclaw-stacked-input"),
        `${name} 缺少 nextclaw-stacked-input`
      );
    }
  });

  it("没有输入框的设置项不加这个类", () => {
    const { all } = render({});
    const extra = all
      .filter(
        (s: Setting) =>
          !s.heading &&
          !STACKED.includes(s.name) &&
          s.settingEl.classes.has("nextclaw-stacked-input")
      )
      .map((s: Setting) => s.name);
    assert.deepEqual(extra, []);
  });

  it("样式里这个类让输入框占满一行，且只在移动端生效", () => {
    assert.match(
      flat,
      /\.is-mobile \.nextclaw-settings \.nextclaw-stacked-input \.setting-item-control \{[^}]*width: 100%;/
    );
    assert.match(
      flat,
      /\.is-mobile \.nextclaw-settings \.nextclaw-stacked-input \.setting-item-control input \{[^}]*width: 100%;/
    );
    // 桌面端不受影响：所有相关规则都挂在 .is-mobile 下。
    for (const rule of flat.split("}")) {
      if (rule.includes("nextclaw-stacked-input")) {
        assert.ok(
          rule.includes(".is-mobile"),
          `规则未限定在移动端: ${rule.trim().slice(0, 80)}`
        );
      }
    }
  });
});
