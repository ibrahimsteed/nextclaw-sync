import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import { switchAtoB, formatReceipt } from "../../src/nextclaw/switchAtoB";

const VID = "vault1";
const PID = "prof1";

/** 假的 prevSync 表。记录调用顺序，用来验"读必须在清之前"。 */
const fakeDb = (keys: string[]) => {
  const calls: string[] = [];
  let items: Record<string, any> = {};
  for (const k of keys) {
    items[`${VID}\t${PID}\t${k}`] = { key: k, keyRaw: k, sizeRaw: 1 };
  }
  return {
    calls,
    db: {
      prevSyncRecordsTbl: {
        async getItems() {
          calls.push("read");
          return items;
        },
        async keys() {
          calls.push("keys");
          return Object.getOwnPropertyNames(items);
        },
        async removeItems(ks: string[]) {
          calls.push("clear");
          for (const k of ks) delete items[k];
        },
      },
    } as any,
  };
};

/**
 * 假的本地文件系统，形状照 `FakeFsLocal.walk()`：文件夹带尾斜杠，
 * 配置目录的文件由 syncConfigDir 补进来，`.trash` 等隐藏目录默认不出现。
 */
const fakeFs = (
  local: string[],
  opts: { missing?: string[]; erroring?: string[]; walkThrows?: boolean } = {}
) => {
  const removed: string[] = [];
  const calls: string[] = [];
  return {
    removed,
    calls,
    fsLocal: {
      async walk() {
        calls.push("walk");
        if (opts.walkThrows) {
          throw new Error("Your file has last modified time 0: x.md");
        }
        return local.map((k) => ({ key: k, keyRaw: k }));
      },
      async rm(key: string) {
        calls.push("rm");
        if (opts.missing?.includes(key)) {
          throw new Error(`ENOENT: no such file or directory, ${key}`);
        }
        if (opts.erroring?.includes(key)) {
          throw new Error("EPERM: operation not permitted");
        }
        removed.push(key);
      },
    },
  };
};

const run = async (
  local: string[],
  opts: { prevSync?: string[]; missing?: string[]; erroring?: string[]; walkThrows?: boolean; configDir?: string } = {}
) => {
  const { db, calls: dbCalls } = fakeDb(opts.prevSync ?? []);
  const { fsLocal, removed, calls: fsCalls } = fakeFs(local, opts);
  const receipt = await switchAtoB({
    db,
    vaultRandomID: VID,
    fsLocal,
    configDir: opts.configDir ?? ".obsidian",
  });
  return { receipt, removed, db, dbCalls, fsCalls };
};

describe("NextClaw 阶段 3：A→B 切换", () => {
  it("A 阶段新建、prevSync 里没有的笔记也删", async () => {
    // 同步记录只记两边都有的文件；A 分支只拉不推，用户新建的笔记远端永远没有，
    // 所以 prevSync 里只有欢迎库的文件。
    // 按 prevSync 删会漏掉用户笔记，切到双向后它被推进学生库。
    const { removed, receipt } = await run(
      ["请阅读.md", "My Note.md", "My another Note.md"],
      { prevSync: ["请阅读.md"] }
    );
    assert.deepEqual(removed.sort(), ["My Note.md", "My another Note.md", "请阅读.md"].sort());
    assert.equal(receipt.deleted.length, 3);
  });

  it("清单不来自 prevSync：prevSync 有、本地没有的，不去碰", async () => {
    const { removed, fsCalls } = await run(["a.md"], {
      prevSync: ["a.md", "早就删了.md"],
    });
    assert.deepEqual(removed, ["a.md"]);
    assert.equal(fsCalls.filter((c) => c === "rm").length, 1);
  });

  it("文件夹整体删顶层，子项不单独删，传给回收站的路径不带尾斜杠", async () => {
    const { removed, receipt } = await run([
      "attachments/",
      "attachments/qr.png",
      "attachments/deep/",
      "attachments/deep/x.png",
      "top.md",
    ]);
    assert.deepEqual(removed.sort(), ["attachments", "top.md"]);
    assert.deepEqual(receipt.deleted.sort(), ["attachments/", "top.md"]);
  });

  it("子路径缺父文件夹条目时，按首段归并到顶层，不漏", async () => {
    const { removed } = await run(["notes/a.md", "notes/sub/b.md"]);
    assert.deepEqual(removed, ["notes"]);
  });

  it("跳过配置目录，不删 .obsidian/", async () => {
    const { receipt, removed } = await run([
      "请阅读.md",
      ".obsidian/",
      ".obsidian/graph.json",
      ".obsidian/plugins/nextclaw-sync/main.js",
    ]);
    assert.deepEqual(removed, ["请阅读.md"]);
    assert.deepEqual(receipt.skipped, [".obsidian/"]);
  });

  it("不删 .trash——删除就是挪进它", async () => {
    const { removed, receipt } = await run([".trash/", ".trash/old.md", "a.md"]);
    assert.deepEqual(removed, ["a.md"]);
    assert.deepEqual(receipt.skipped, [".trash/"]);
  });

  it("配置目录名不写死，跟随 vault 的实际取值", async () => {
    const { removed } = await run(
      ["a.md", ".myconfig/graph.json", ".obsidian-looking/x.md"],
      { configDir: ".myconfig" }
    );
    assert.deepEqual(removed.sort(), [".obsidian-looking", "a.md"]);
  });

  it("名字以配置目录开头的普通文件夹照删，不被误当配置目录", async () => {
    const { removed } = await run([".obsidian-backup/x.md", ".obsidian/app.json"]);
    assert.deepEqual(removed, [".obsidian-backup"]);
  });

  it("枚举抛异常时整体抛出、不清记录——调用方据此保留标记下次重来", async () => {
    const { db } = fakeDb(["a.md"]);
    const { fsLocal, removed } = fakeFs(["a.md"], { walkThrows: true });
    await assert.rejects(
      switchAtoB({ db, vaultRandomID: VID, fsLocal, configDir: ".obsidian" }),
      /modified time 0/
    );
    assert.deepEqual(removed, []);
    assert.equal((await db.prevSyncRecordsTbl.keys()).length, 1);
  });

  it("枚举时在、删时已不存在——算正常，不算失败", async () => {
    const { receipt } = await run(["gone.md", "here.md"], { missing: ["gone.md"] });
    assert.deepEqual(receipt.alreadyGone, ["gone.md"]);
    assert.deepEqual(receipt.deleted, ["here.md"]);
    assert.equal(receipt.failed.length, 0);
  });

  it("真失败会进回执，且不中断其余删除", async () => {
    const { receipt, removed } = await run(["bad.md", "ok.md"], { erroring: ["bad.md"] });
    assert.equal(receipt.failed.length, 1);
    assert.equal(receipt.failed[0].key, "bad.md");
    assert.deepEqual(removed, ["ok.md"]);
  });

  it("删完之后 prevSync 真的空了", async () => {
    const { receipt, db } = await run(["a.md"], { prevSync: ["a.md", "b.md"] });
    assert.equal(receipt.clearedPrevSync, true);
    assert.deepEqual(await db.prevSyncRecordsTbl.keys(), []);
  });

  it("本地只剩配置目录也能跑完，不抛", async () => {
    const { receipt } = await run([".obsidian/app.json"]);
    assert.equal(receipt.deleted.length, 0);
    assert.equal(receipt.clearedPrevSync, true);
  });

  it("回执摘要含失败明细与跳过项", () => {
    const line = formatReceipt({
      deleted: ["a.md"],
      skipped: [".obsidian/"],
      alreadyGone: [],
      failed: [{ key: "b.md", error: "EPERM" }],
      clearedPrevSync: true,
    });
    assert.ok(line.includes("b.md"));
    assert.ok(line.includes("EPERM"));
    assert.ok(line.includes(".obsidian/"));
    assert.ok(line.includes("已清空"));
  });
});

describe("NextClaw 阶段 3：接线", () => {
  const src = (f: string) =>
    readFileSync(path.join(__dirname, "..", "..", "src", f), "utf8");

  it("切换在 syncRun 里、同步开始之前触发", () => {
    const m = src("main.ts");
    assert.match(m, /nextclawPendingSwitchToB === true/);
    // main.ts 里真正跑同步的是同步引擎入口 runSync()。
    const iSwitch = m.indexOf("switchAtoB({");
    const iSyncer = m.indexOf("await runSync(");
    assert.ok(iSwitch > 0 && iSyncer > 0, "两个锚点都得存在");
    assert.ok(iSwitch < iSyncer, "切换必须早于 runSync() 调用");
  });

  it("标记只在切换成功后清掉", () => {
    const m = src("main.ts");
    // 必须"有且只有一处"清标记：只查"之后存在一处"的话，
    // 在前面**额外**插一处照样通过。
    const clears = (m.match(/nextclawPendingSwitchToB\s*=\s*false/g) ?? []).length;
    assert.equal(clears, 1, `期望恰好 1 处清标记，实到 ${clears}`);
    const i = m.indexOf("await switchAtoB({");
    const j = m.indexOf("nextclawPendingSwitchToB = false");
    assert.ok(j > i, "清标记必须在 switchAtoB 之后——中途抛异常应保留标记以便重来");
  });

});
