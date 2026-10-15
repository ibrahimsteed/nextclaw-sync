import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import ts from "typescript";
const source = ts.createSourceFile(
  "main.ts",
  readFileSync(path.resolve(__dirname, "../../src/main.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true
);
let method = "";
const visit = (n: ts.Node) => {
  if (
    ts.isMethodDeclaration(n) &&
    n.name.getText(source) === "requestRecoverySync"
  )
    method = n.getText(source);
  ts.forEachChild(n, visit);
};
visit(source);
assert.ok(method);
const compiled = ts.transpileModule(
  method.replace(/^requestRecoverySync/, "function recover"),
  { compilerOptions: { target: ts.ScriptTarget.ES2020 } }
).outputText;
const recover = new Function(`${compiled};return recover;`)();
describe("production recovery trigger policy", () => {
  for (const source of ["save", "interval", "startup"]) {
    it(`rescan after reload/online/foreground with only ${source} enabled`, () => {
      const delays: number[] = [];
      const settings: any = {
        syncDirection: "bidirectional",
        syncOnSaveAfterMilliseconds: -1,
        autoRunEveryMilliseconds: -1,
        initRunAfterMilliseconds: -1,
      };
      settings[
        source === "save"
          ? "syncOnSaveAfterMilliseconds"
          : source === "interval"
            ? "autoRunEveryMilliseconds"
            : "initRunAfterMilliseconds"
      ] = 30000;
      recover.call({
        settings,
        syncQueue: { request: (delay: number) => delays.push(delay) },
      });
      assert.deepEqual(delays, [3000]);
    });
  }
  for (const settings of [
    {
      syncDirection: "bidirectional",
      syncOnSaveAfterMilliseconds: -1,
      autoRunEveryMilliseconds: -1,
      initRunAfterMilliseconds: -1,
    },
    {
      syncDirection: "incremental_pull_only",
      syncOnSaveAfterMilliseconds: 30000,
    },
  ]) {
    it(`does not introduce unsolicited automatic sync for ${JSON.stringify(settings)}`, () => {
      const delays: number[] = [];
      recover.call({
        settings,
        syncQueue: { request: (n: number) => delays.push(n) },
      });
      assert.deepEqual(delays, []);
    });
  }
});
