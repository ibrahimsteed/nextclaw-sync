import { strict as assert } from "assert";
import { runSync } from "../../src/nextclaw/syncEngine";
import { harness, text } from "./engine/helpers";

const list = ".obsidian/community-plugins.json";

/**
 * 交付插件改 id 的真实场景：Copilot 从 `copilot` 改名为 `nextclaw-copilot`。
 * NextClaw Sync 不认识任何具体插件名，这里验证通用的清单合并规则在改名时的结果。
 */
describe("NextClaw：交付插件改 id（copilot → nextclaw-copilot）", () => {
  const setupSynced = async () => {
    const h = harness("B");
    // 服务端改名前的交付状态
    h.remote
      .put(list, JSON.stringify(["copilot", "dataview", "nextclaw-sync"]), 20000)
      .put(".obsidian/plugins/copilot/manifest.json", '{"id":"copilot"}', 20000)
      .put(".obsidian/plugins/copilot/data.json", '{"device":"x"}', 20000);
    // 学生自己装的插件
    h.local
      .put(".obsidian/plugins/custom/manifest.json", '{"id":"custom"}')
      .put(list, JSON.stringify(["custom"]));
    assert.equal((await runSync(h.input)).ok, true);
    assert.deepEqual(JSON.parse(text(await h.local.readFile(list))), [
      "copilot",
      "dataview",
      "nextclaw-sync",
      "custom",
    ]);
    return h;
  };

  it("服务端改名后：启用清单换成新 id，旧 id 移出，学生自装插件保留，不写服务端", async () => {
    const h = await setupSynced();
    // 服务端迁移：新目录、data.json 移过去、清单改名、旧目录移走
    h.remote.files.delete(".obsidian/plugins/copilot/manifest.json");
    h.remote.files.delete(".obsidian/plugins/copilot/data.json");
    h.remote
      .put(".obsidian/plugins/nextclaw-copilot/manifest.json", '{"id":"nextclaw-copilot"}', 90000)
      .put(".obsidian/plugins/nextclaw-copilot/data.json", '{"device":"x"}', 90000)
      .put(list, JSON.stringify(["nextclaw-copilot", "dataview", "nextclaw-sync"]), 90000);
    h.remote.calls = [];

    assert.equal((await runSync(h.input)).ok, true);

    assert.deepEqual(JSON.parse(text(await h.local.readFile(list))), [
      "nextclaw-copilot",
      "dataview",
      "nextclaw-sync",
      "custom",
    ]);
    assert.ok(h.local.files.has(".obsidian/plugins/nextclaw-copilot/manifest.json"));
    assert.equal(text(await h.local.readFile(".obsidian/plugins/nextclaw-copilot/data.json")), '{"device":"x"}');
    assert.deepEqual(h.remote.writes(), [], "配置目录只拉不推");
  });

  it("设备上的旧目录 plugins/copilot/ 不会被删除（配置目录从不删本地，D10）", async () => {
    const h = await setupSynced();
    h.remote.files.delete(".obsidian/plugins/copilot/manifest.json");
    h.remote.files.delete(".obsidian/plugins/copilot/data.json");
    h.remote.put(list, JSON.stringify(["nextclaw-copilot", "dataview", "nextclaw-sync"]), 90000);
    h.local.calls = [];

    assert.equal((await runSync(h.input)).ok, true);

    assert.ok(h.local.files.has(".obsidian/plugins/copilot/manifest.json"), "旧目录留在设备上");
    assert.deepEqual(h.local.calls.filter((c) => c.op === "rm"), []);
    assert.ok(!JSON.parse(text(await h.local.readFile(list))).includes("copilot"), "但不再启用");
  });
});
