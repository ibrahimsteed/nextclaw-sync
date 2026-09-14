import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import {
  RELOAD_COMMAND_ID,
  RELOAD_NOTICE,
  RELOAD_NOTICE_A,
  RELOAD_NOTICE_MS,
  markReloadPending,
  reloadAfterFirstASync,
  reloadAfterFirstBSync,
  shouldReloadAfterFirstASync,
  shouldReloadAfterSync,
} from "../../src/nextclaw/reloadAfterSwitch";

const base = {
  pending: true as boolean | undefined,
  mode: "B" as "A" | "B",
  triggerSource: "manual",
  ok: true,
};

describe("NextClaw：切换后首次模式 B 同步成功时重新加载——判定", () => {
  it("待重新加载、模式 B、非空跑、同步成功 → 重新加载", () => {
    assert.equal(shouldReloadAfterSync(base), true);
  });

  it("各种自动触发同样适用", () => {
    for (const s of ["auto", "auto_once_init", "auto_sync_on_save"]) {
      assert.equal(shouldReloadAfterSync({ ...base, triggerSource: s }), true, s);
    }
  });

  it("没有待重新加载标记 → 不重新加载（日常同步）", () => {
    assert.equal(shouldReloadAfterSync({ ...base, pending: false }), false);
    assert.equal(shouldReloadAfterSync({ ...base, pending: undefined }), false);
  });

  it("同步失败 → 不重新加载，保留现场", () => {
    assert.equal(shouldReloadAfterSync({ ...base, ok: false }), false);
  });

  it("空跑 → 不重新加载", () => {
    assert.equal(shouldReloadAfterSync({ ...base, triggerSource: "dry" }), false);
  });

  it("模式 A → 不重新加载（用户切回了演示库）", () => {
    assert.equal(shouldReloadAfterSync({ ...base, mode: "A" }), false);
  });

  it("markReloadPending 打上 B 标记，并清除 A 标记", () => {
    const s: { nextclawReloadAfterFirstBSync?: boolean; nextclawReloadAfterFirstASync?: boolean } =
      { nextclawReloadAfterFirstASync: true };
    markReloadPending(s);
    assert.equal(s.nextclawReloadAfterFirstBSync, true);
    assert.equal(s.nextclawReloadAfterFirstASync, false);
  });
});

describe("NextClaw：首次模式 A 同步成功时重新加载——判定", () => {
  const a = { ...base, mode: "A" as "A" | "B" };
  it("待重新加载、模式 A、非空跑、同步成功 → 重新加载", () => {
    assert.equal(shouldReloadAfterFirstASync(a), true);
  });
  it("没有标记 → 不重新加载", () => {
    assert.equal(shouldReloadAfterFirstASync({ ...a, pending: false }), false);
    assert.equal(shouldReloadAfterFirstASync({ ...a, pending: undefined }), false);
  });
  it("同步失败 → 不重新加载", () => {
    assert.equal(shouldReloadAfterFirstASync({ ...a, ok: false }), false);
  });
  it("空跑 → 不重新加载", () => {
    assert.equal(shouldReloadAfterFirstASync({ ...a, triggerSource: "dry" }), false);
  });
  it("模式 B → 不走模式 A 的重新加载", () => {
    assert.equal(shouldReloadAfterFirstASync({ ...a, mode: "B" }), false);
  });
});

const harness = (hasCommand = true) => {
  const log: string[] = [];
  const settings = { nextclawReloadAfterFirstBSync: true };
  const commands: Record<string, unknown> = hasCommand
    ? { [RELOAD_COMMAND_ID]: {} }
    : { "app:other": {} };
  return {
    log,
    settings,
    deps: {
      settings,
      saveSettings: async () => {
        log.push(`save:${settings.nextclawReloadAfterFirstBSync}`);
      },
      notice: (message: string, ms: number) => log.push(`notice:${ms}:${message}`),
      commands: {
        commands,
        executeCommandById: (id: string) => {
          log.push(`exec:${id}`);
          return true;
        },
      },
      delay: async (ms: number) => {
        log.push(`delay:${ms}`);
      },
    },
  };
};

describe("NextClaw：切换后首次模式 B 同步成功时重新加载——执行", () => {
  it("顺序：清标记并保存 → 提示 → 等待 → 执行 app:reload", async () => {
    const h = harness();
    const r = await reloadAfterFirstBSync(h.deps);
    assert.equal(r, "reloaded");
    assert.deepEqual(
      h.log.map((x) => x.split(":").slice(0, 2).join(":")),
      ["save:false", `notice:${RELOAD_NOTICE_MS}`, `delay:${RELOAD_NOTICE_MS}`, `exec:app`]
    );
    assert.equal(h.log[3], `exec:${RELOAD_COMMAND_ID}`);
  });

  it("保存时标记已经是 false——否则重新加载后会再次触发，形成循环", async () => {
    const h = harness();
    await reloadAfterFirstBSync(h.deps);
    assert.equal(h.log[0], "save:false");
    assert.equal(h.settings.nextclawReloadAfterFirstBSync, false);
  });

  it("命令不存在 → 不执行，提示手动重启，标记同样清除", async () => {
    const h = harness(false);
    const r = await reloadAfterFirstBSync(h.deps);
    assert.equal(r, "restart-manually");
    assert.ok(!h.log.some((x) => x.startsWith("exec:")));
    assert.ok(h.log.some((x) => x.startsWith("notice:") && x.includes("重新打开")));
    assert.equal(h.log[0], "save:false");
  });

  it("模式 A：清除的是 A 标记、提示演示库文案，B 标记不动", async () => {
    const h = harness();
    const settings = h.settings as { nextclawReloadAfterFirstBSync?: boolean; nextclawReloadAfterFirstASync?: boolean };
    settings.nextclawReloadAfterFirstASync = true;
    settings.nextclawReloadAfterFirstBSync = true;
    assert.equal(await reloadAfterFirstASync(h.deps), "reloaded");
    assert.equal(settings.nextclawReloadAfterFirstASync, false);
    assert.equal(settings.nextclawReloadAfterFirstBSync, true);
    assert.ok(h.log.some((x) => x === `notice:${RELOAD_NOTICE_MS}:${RELOAD_NOTICE_A}`));
    assert.equal(h.log[h.log.length - 1], `exec:${RELOAD_COMMAND_ID}`);
  });

  it("模式 B 提示学生库文案", async () => {
    const h = harness();
    await reloadAfterFirstBSync(h.deps);
    assert.ok(h.log.some((x) => x === `notice:${RELOAD_NOTICE_MS}:${RELOAD_NOTICE}`));
  });

  it("命令表继承来的同名属性不算存在", async () => {
    const h = harness(false);
    h.deps.commands.commands = Object.create({ [RELOAD_COMMAND_ID]: {} });
    assert.equal(await reloadAfterFirstBSync(h.deps), "restart-manually");
  });
});

describe("NextClaw：切换后重新加载——main.ts 接线", () => {
  const m = readFileSync(
    path.join(__dirname, "..", "..", "src", "main.ts"),
    "utf8"
  );

  it("标记在 A→B 清理成功之后、同步之前打上", () => {
    const iSwitch = m.indexOf("await switchAtoB({");
    const iMark = m.indexOf("markReloadPending(this.settings)");
    const iSync = m.indexOf("await runSync({");
    assert.ok(iSwitch > 0 && iMark > 0 && iSync > 0, "三个锚点都得存在");
    assert.ok(iSwitch < iMark && iMark < iSync);
    assert.equal((m.match(/markReloadPending\(/g) ?? []).length, 1, "只能有一处打标记");
  });

  it("打标记与清切换标记在同一分支内，且在清理失败抛错之后", () => {
    const iThrow = m.indexOf('if (receipt.failed.length) throw');
    const iClear = m.indexOf("this.settings.nextclawPendingSwitchToB = false");
    const iMark = m.indexOf("markReloadPending(this.settings)");
    assert.ok(iThrow > 0 && iThrow < iClear && iClear < iMark);
  });

  it("用同步结果判定，重新加载在同步完成之后", () => {
    assert.match(m, /const result = await runSync\(\{/);
    const iSync = m.indexOf("await runSync({");
    const iShould = m.indexOf("shouldReloadAfterSync({");
    const iReload = m.indexOf("await reloadAfterFirstBSync(");
    assert.ok(iSync < iShould && iShould < iReload);
    const call = m.slice(iShould, iReload);
    assert.match(call, /ok: result\.ok/);
    assert.match(call, /pending: this\.settings\.nextclawReloadAfterFirstBSync/);
    assert.match(call, /triggerSource/);
    assert.match(call, /mode/);
  });

  it("模式 A 的重新加载同样用同步结果判定，且在同步之后、catch 之前", () => {
    const iSync = m.indexOf("await runSync({");
    const iShouldA = m.indexOf("shouldReloadAfterFirstASync({");
    const iReloadA = m.indexOf("await reloadAfterFirstASync(");
    const iCatch = m.indexOf("} catch (error) {", iReloadA);
    assert.ok(iSync < iShouldA && iShouldA < iReloadA && iReloadA < iCatch);
    const call = m.slice(iShouldA, iReloadA);
    assert.match(call, /ok: result\.ok/);
    assert.match(call, /pending: this\.settings\.nextclawReloadAfterFirstASync/);
  });

  it("默认设置里模式 A 标记为 true，模式 B 标记为 false", () => {
    assert.match(m, /nextclawReloadAfterFirstASync: true,/);
    assert.match(m, /nextclawReloadAfterFirstBSync: false,/);
  });

  it("重新加载在 catch 之前（同步抛错时不会走到）", () => {
    const iReload = m.indexOf("await reloadAfterFirstBSync(");
    const iCatch = m.indexOf("} catch (error) {", iReload);
    const iSync = m.indexOf("await runSync({");
    assert.ok(iReload > iSync && iCatch > iReload);
  });
});
