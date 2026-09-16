import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import {
  SUCCESS_VISIBLE_MS,
  liftHeight,
  shouldShowMobileStatusBar,
} from "../../src/nextclaw/mobileStatusBar";
import { FakeDom, FakeEl } from "./fakeDom";

const root = path.join(__dirname, "..", "..");
const css = readFileSync(path.join(root, "styles.css"), "utf8");
const manifest = JSON.parse(
  readFileSync(path.join(root, "manifest.json"), "utf8")
) as { id: string };

/** 去掉换行与多余空格，方便匹配被格式化工具折行的选择器。 */
const flat = css.replace(/\s+/g, " ");

const state = (o: Partial<Parameters<typeof shouldShowMobileStatusBar>[0]>) => ({
  syncing: false,
  hasTimestamp: true,
  isSuccess: true,
  msSinceLastSync: 0,
  ...o,
});

describe("NextClaw：移动端状态条的抬高量", () => {
  it("取可见者中最高的一条", () => {
    assert.equal(liftHeight([52, 40]), 52);
    assert.equal(liftHeight([40, 52]), 52);
  });
  it("导航栏消失后归零，不保留上一次量到的值", () => {
    // 这是问题的根源：只在插入时量高度，导航栏移除后状态条继续悬空，
    // 正好压在屏幕右下角别人的按钮上。
    assert.equal(liftHeight([0, 0]), 0);
    assert.equal(liftHeight([]), 0);
  });
  it("量不到高度时算 0，不产生 NaN 的 CSS 值", () => {
    assert.equal(liftHeight([Number.NaN, 0]), 0);
    assert.equal(liftHeight([Number.NaN, 52]), 52);
  });
});

describe("NextClaw：移动端状态条什么时候显示", () => {
  it("同步中显示", () => {
    assert.equal(shouldShowMobileStatusBar(state({ syncing: true })), true);
    // 同步中即使上一次成功已久，也要显示。
    assert.equal(
      shouldShowMobileStatusBar(
        state({ syncing: true, msSinceLastSync: 10 * SUCCESS_VISIBLE_MS })
      ),
      true
    );
  });
  it("从未同步过时常驻", () => {
    assert.equal(
      shouldShowMobileStatusBar(
        state({ hasTimestamp: false, isSuccess: false })
      ),
      true
    );
  });
  it("同步失败时常驻，隔多久都不淡出", () => {
    assert.equal(
      shouldShowMobileStatusBar(
        state({ isSuccess: false, msSinceLastSync: 10 * SUCCESS_VISIBLE_MS })
      ),
      true
    );
  });
  it("同步成功后先显示，过了时限才淡出", () => {
    assert.equal(shouldShowMobileStatusBar(state({ msSinceLastSync: 0 })), true);
    assert.equal(
      shouldShowMobileStatusBar(
        state({ msSinceLastSync: SUCCESS_VISIBLE_MS - 1 })
      ),
      true
    );
    assert.equal(
      shouldShowMobileStatusBar(state({ msSinceLastSync: SUCCESS_VISIBLE_MS })),
      false
    );
    assert.equal(
      shouldShowMobileStatusBar(
        state({ msSinceLastSync: 10 * SUCCESS_VISIBLE_MS })
      ),
      false
    );
  });
});

describe("NextClaw：移动端状态条的接线", () => {
  const BAR = ".is-mobile .app-container .status-bar";
  const VAR = "--nextclaw-mobile-navbar-height";
  let dom: FakeDom;
  let restore: () => void;
  // 必须在替身装好之后再 require：misc.ts 在模块作用域外用这些全局。
  let misc: typeof import("../../src/misc");

  beforeEach(() => {
    dom = new FakeDom();
    dom.add(".app-container");
    dom.add(BAR);
    restore = dom.install();
    delete require.cache[require.resolve("../../src/misc")];
    misc = require("../../src/misc");
  });
  afterEach(() => restore());

  it("开启时按底部导航栏的高度抬起", () => {
    dom.add(".mobile-navbar", 52);
    misc.changeMobileStatusBar("enable");
    const bar = dom.els.get(BAR)!;
    assert.equal(bar.hasClass("nextclaw-mobile-status-bar"), true);
    assert.equal(bar.props.get(VAR), "52px");
  });

  it("导航栏被移除后重新归零，不继续悬空", () => {
    // 这是附件里那个症状的成因：状态条悬在半空，正好压住右下角的「发送」。
    dom.add(".mobile-navbar", 52);
    misc.changeMobileStatusBar("enable");
    const bar = dom.els.get(BAR)!;
    assert.equal(bar.props.get(VAR), "52px");

    const navbar = dom.els.get(".mobile-navbar")!;
    dom.els.delete(".mobile-navbar");
    dom.mutate({ removedNodes: [navbar] });
    dom.runTimers();
    assert.equal(bar.props.get(VAR), "0px");
  });

  it("键盘工具栏插入后抬到它之上", () => {
    misc.changeMobileStatusBar("enable");
    const toolbar = dom.add(".mobile-toolbar", 44);
    dom.mutate({ addedNodes: [toolbar] });
    dom.runTimers();
    assert.equal(dom.els.get(BAR)!.props.get(VAR), "44px");
  });

  it("与底部无关的 DOM 变化不触发重算", () => {
    dom.add(".mobile-navbar", 52);
    misc.changeMobileStatusBar("enable");
    dom.mutate({ addedNodes: [new FakeEl(".some-modal")] });
    assert.equal(dom.timers.length, 0);
  });

  it("关闭时清掉两个类和变量", () => {
    dom.add(".mobile-navbar", 52);
    misc.changeMobileStatusBar("enable");
    misc.setMobileStatusBarIdle(true);
    misc.changeMobileStatusBar("disable");
    const bar = dom.els.get(BAR)!;
    assert.equal(bar.hasClass("nextclaw-mobile-status-bar"), false);
    assert.equal(bar.hasClass("nextclaw-mobile-status-bar-idle"), false);
    assert.equal(bar.props.has(VAR), false);
  });

  it("淡出开关只加减 idle 类", () => {
    misc.changeMobileStatusBar("enable");
    const bar = dom.els.get(BAR)!;
    misc.setMobileStatusBarIdle(true);
    assert.equal(bar.hasClass("nextclaw-mobile-status-bar-idle"), true);
    misc.setMobileStatusBarIdle(false);
    assert.equal(bar.hasClass("nextclaw-mobile-status-bar-idle"), false);
    // 主类不受影响，否则淡出一次之后再也显示不出来。
    assert.equal(bar.hasClass("nextclaw-mobile-status-bar"), true);
  });

  it("桌面端（查不到移动端状态栏）时是空操作，不抛", () => {
    dom.els.delete(BAR);
    assert.doesNotThrow(() => misc.setMobileStatusBarIdle(true));
    assert.equal(misc.changeMobileStatusBar("enable"), undefined);
  });
});

describe("NextClaw：移动端状态条的样式", () => {
  it("只放出自己那一项，其余核心插件的条目仍然隐藏", () => {
    // 插件 id 改名时这条会红：选择器里的 plugin-<id> 由 Obsidian 生成，
    // 写死的旧 id 会让反向链接、字数统计等条目重新冒出来。
    assert.ok(
      flat.includes(
        `> .status-bar-item:not(.plugin-${manifest.id}) { display: none; }`
      ),
      "styles.css 里缺少只显示本插件条目的规则"
    );
  });
  it("状态条不接受点击", () => {
    // 它没有任何点击行为，却盖在别人的按钮上，pointer-events 必须让开。
    assert.match(
      flat,
      /\.status-bar\.nextclaw-mobile-status-bar \{[^}]*pointer-events: none;/
    );
  });
  it("idle 类真的把它藏起来", () => {
    assert.match(
      flat,
      /\.nextclaw-mobile-status-bar\.nextclaw-mobile-status-bar-idle \{[^}]*visibility: hidden;/
    );
  });
});
