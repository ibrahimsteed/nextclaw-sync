import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";

const langs = ["en", "zh_cn", "zh_tw"] as const;
const load = (l: string) =>
  JSON.parse(
    readFileSync(path.join(__dirname, "..", "..", "src", "langs", `${l}.json`), "utf8")
  ) as Record<string, string>;

// 已停用的上游弹窗：文案写着"从这个版本开始，插件更新了同步算法"，
// 对我们是假话，换上我们的名字等于把假话署上我们的名。原样留给上游。
const UPSTREAM_ONLY = /^syncalgov3_/;

describe("NextClaw：用户可见处不应残留上游品牌", () => {
  for (const l of langs) {
    it(`${l}.json 里除已停用的上游弹窗外，不再出现 "Remotely Save"`, () => {
      const d = load(l);
      const leaks = Object.entries(d)
        .filter(([k, v]) => !UPSTREAM_ONLY.test(k) && typeof v === "string")
        .filter(([, v]) => v.includes("Remotely Save"))
        .map(([k]) => k);
      assert.deepEqual(leaks, [], `残留: ${leaks.join(", ")}`);
    });

    it(`${l}.json 的同步进度通知已改名——学生每次同步都会看到它`, () => {
      const d = load(l);
      for (const k of ["syncrun_step1", "syncrun_step8", "syncrun_shortstep1", "syncrun_shortstep2"]) {
        assert.ok(d[k].includes("NextClaw Sync"), `${k} 未改名`);
      }
    });
  }

  it("三种语言的 key 集合完全一致", () => {
    const [a, b, c] = langs.map((l) => Object.keys(load(l)).sort());
    assert.deepEqual(b, a);
    assert.deepEqual(c, a);
  });

  it("每个 key 都被源码用到，源码用到的 key 都有翻译", () => {
    const { readdirSync } = require("fs") as typeof import("fs");
    const root = path.join(__dirname, "..", "..", "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(readFileSync(p, "utf8"));
      }
    };
    walk(root);
    const code = files.join("\n");
    const keys = Object.keys(load("en"));
    const unused = keys.filter((k) => !code.includes(`"${k}"`));
    assert.deepEqual(unused, [], `未使用：${unused.join(", ")}`);
    const called = [...code.matchAll(/\bt\("([a-z0-9_]+)"/g)].map((m) => m[1]);
    const missing = [...new Set(called)].filter((k) => !keys.includes(k));
    assert.deepEqual(missing, [], `缺翻译：${missing.join(", ")}`);
  });
});
