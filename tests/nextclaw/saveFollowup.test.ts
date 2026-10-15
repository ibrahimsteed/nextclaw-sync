import { strict as assert } from "assert";
import { readFileSync } from "fs";
import * as path from "path";
import ts from "typescript";

// Execute the production method, not a reimplementation of its timestamp gate.
const source = ts.createSourceFile(
  "main.ts",
  readFileSync(path.resolve(__dirname, "../../src/main.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true
);
let method = "";
let done = "";
const visit = (node: ts.Node) => {
  if (
    ts.isMethodDeclaration(node) &&
    node.name.getText(source) === "_checkCurrFileModified"
  )
    method = node.getText(source);
  if (
    ts.isPropertyDeclaration(node) &&
    node.name.getText(source) === "_syncOnSaveEvent1"
  )
    done = node.initializer!.getText(source);
  ts.forEachChild(node, visit);
};
visit(source);
assert.ok(method && done);
function harness(mtime = 90) {
  const calls: string[] = [];
  const microtasks: Array<() => void> = [];
  const compile = (text: string) =>
    ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText;
  const check = new Function(
    "getLastSuccessSyncTimeByVault",
    "console",
    `${compile(method.replace(/^async _checkCurrFileModified/, "async function check"))}; return check;`
  )(async () => 100, { debug() {} });
  const plugin: any = {
    app: {
      workspace: {
        getActiveFile: () => ({ path: "synthetic.md", stat: { mtime } }),
      },
    },
    db: {},
    vaultRandomID: "synthetic",
    isSyncing: false,
    hasPendingSyncOnSave: false,
    syncRun: async () => {
      calls.push("final version");
      plugin.isSyncing = true;
    },
    _checkCurrFileModified: check,
  };
  // Bind the production arrow property in the same lexical this as the plugin.
  const event = new Function(
    "queueMicrotask",
    `${compile(`const callback = ${done};`)}; return callback;`
  ).call(plugin, (fn: () => void) => microtasks.push(fn));
  return { plugin, calls, microtasks, event };
}

describe("save follow-up cannot lose a final edit behind sync completion time", () => {
  it("runs a delayed save event even if the previous sync finished after its mtime", async () => {
    const h = harness(90); // prior run read the intermediate version, completed at100.
    await h.plugin._checkCurrFileModified("FILE_CHANGES");
    assert.deepEqual(h.calls, ["final version"]);
  });
  it("does not lose a real save after a wall-clock correction", async () => {
    const h = harness(-10);
    await h.plugin._checkCurrFileModified("FILE_CHANGES");
    assert.equal(h.calls.length, 1);
  });
  it("coalesces edits during an active sync, then drains one follow-up", async () => {
    const h = harness();
    h.plugin.isSyncing = true;
    await h.plugin._checkCurrFileModified("FILE_CHANGES");
    await h.plugin._checkCurrFileModified("FILE_CHANGES");
    assert.equal(h.calls.length, 0);
    h.plugin.isSyncing = false;
    await h.plugin._checkCurrFileModified("SYNC");
    assert.equal(h.calls.length, 1);
    assert.equal(h.plugin.hasPendingSyncOnSave, false);
  });
  it("a completion without a new edit does not create another sync", async () => {
    const h = harness();
    await h.plugin._checkCurrFileModified("SYNC");
    assert.equal(h.calls.length, 0);
  });
  it("preserves the existing requirement for an active file", async () => {
    const h = harness();
    h.plugin.app.workspace.getActiveFile = () => null;
    await h.plugin._checkCurrFileModified("FILE_CHANGES");
    assert.equal(h.calls.length, 0);
  });
  it("defers SYNC_DONE until the old sync finally releases its running guard", async () => {
    const h = harness();
    h.plugin.hasPendingSyncOnSave = true;
    h.plugin.isSyncing = true;
    h.event();
    assert.equal(h.microtasks.length, 1);
    h.plugin.isSyncing = false; // old syncRun finally
    h.microtasks.shift()!();
    await Promise.resolve();
    assert.equal(h.calls.length, 1);
    assert.equal(h.plugin.isSyncing, true); // new run keeps ownership of the guard
  });
});

describe("save events interleaved with other sync triggers", () => {
  for (const trigger of ["manual", "auto", "auto_once_init"]) {
    it(`retains one follow-up while ${trigger} owns the sync guard`, async () => {
      const h = harness();
      await h.plugin.syncRun(trigger);
      await h.plugin._checkCurrFileModified("FILE_CHANGES");
      await h.plugin._checkCurrFileModified("FILE_CHANGES");
      assert.equal(h.calls.length, 1);
      h.event();
      h.plugin.isSyncing = false;
      h.microtasks.shift()!();
      await Promise.resolve();
      assert.equal(h.calls.length, 2);
      h.plugin.isSyncing = false;
      h.event();
      h.microtasks.shift()!();
      await Promise.resolve();
      assert.equal(
        h.calls.length,
        2,
        "completion must not loop without new edits"
      );
    });
  }
});
