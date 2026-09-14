import { strict as assert } from "assert";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..", "..");

/** 递归列出目录下的 .ts 文件。 */
const tsFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });

/**
 * 本插件不包含、不引用 `pro/` 目录（该目录的代码不以开源许可提供）。
 * 这组测试防止它以任何途径被重新引入。
 */
describe("NextClaw：不含 pro/", () => {
  it("仓库里没有 pro/ 目录", () => {
    assert.equal(existsSync(path.join(ROOT, "pro")), false);
  });

  it("src/ 与 tests/ 没有任何指向 pro/ 的 import 或 require", () => {
    const hits = [
      ...tsFiles(path.join(ROOT, "src")),
      ...tsFiles(path.join(ROOT, "tests")),
    ].flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ f: path.relative(ROOT, f), i: i + 1, line }))
        .filter(({ line }) =>
          /(from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.\.\/)+pro\//.test(line)
        )
    );
    assert.deepEqual(
      hits.map((h) => `${h.f}:${h.i}`),
      [],
      "仍在引用 pro/"
    );
  });

  it("测试脚本不再跑 pro/tests", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.doesNotMatch(pkg.scripts.test, /pro\//);
  });

  it("同步入口来自自有引擎，不来自 pro/", () => {
    const main = readFileSync(path.join(ROOT, "src", "main.ts"), "utf8");
    assert.match(main, /import \{ runSync \} from "\.\/nextclaw\/syncEngine";/);
  });
});
