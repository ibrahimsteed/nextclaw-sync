import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import { DEFAULT_DB_NAME } from "../../src/localdb";

const localdb = readFileSync(
  path.join(__dirname, "..", "..", "src", "localdb.ts"),
  "utf8"
);

describe("NextClaw：本地数据库与上游隔离", () => {
  it("数据库名不是上游的 remotelysavedb", () => {
    // IndexedDB 跨插件共享；同名则与 remotely-save 同装一个库时 prevSync 完全重叠。
    assert.notEqual(DEFAULT_DB_NAME, "remotelysavedb");
    assert.equal(DEFAULT_DB_NAME, "nextclawsyncdb");
  });

  it("所有 localforage 表都走 DEFAULT_DB_NAME，没有另起炉灶的写死名", () => {
    const instances = [...localdb.matchAll(/createInstance\(\{\s*name:\s*([^,]+),/g)]
      .map((m) => m[1].trim());
    assert.ok(instances.length >= 6, `期望至少 6 张表，实到 ${instances.length}`);
    const rogue = instances.filter((n) => n !== "DEFAULT_DB_NAME");
    assert.deepEqual(rogue, [], `有表没走统一库名: ${rogue.join(", ")}`);
  });
});
