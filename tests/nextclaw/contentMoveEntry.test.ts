import { strict as assert } from "assert";
import { readFileSync } from "fs";
import { join } from "path";
import ts from "typescript";
import { IdbConnectionPool } from "../../src/idbStore";
import { prepareDBs } from "../../src/localdb";
import { NativeWriteJournal } from "../../src/nextclaw/nativeWriteJournal";
import { contentRuntime, contentScope } from "../../src/nextclaw/content/runtime";
import { runSync } from "../../src/nextclaw/syncEngine";
import { environment } from "./contentEntry.test";
import { text } from "./engine/helpers";

// Run the plugin's registered Vault callback with the same event and file-object contract.
const main = ts.createSourceFile("main.ts", readFileSync(join(__dirname, "../../src/main.ts"), "utf8"), ts.ScriptTarget.Latest, true);
let register = "", callback = "";
function visit(node: ts.Node) {
  if (ts.isMethodDeclaration(node) && node.name.getText(main) === "onVaultRename")
    callback = node.getText(main).replace(/^private onVaultRename/, "function onVaultRename");
  if (ts.isExpressionStatement(node) && node.getText(main).startsWith('this.registerEvent(this.app.vault.on("rename"'))
    register = node.getText(main);
  ts.forEachChild(node, visit);
}
visit(main);
assert.ok(register && callback);
const attach = new Function("contentScope", "getClient",
  ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText +
  "return function () { this.onVaultRename = onVaultRename; " + register + " };");

async function scene() {
  const t = await environment();
  const stat = t.remote.stat.bind(t.remote), binding = t.remote.contentBinding.bind(t.remote);
  t.remote.contentBinding = () => ({ ...binding(), nativeManaged: true });
  t.remote.supportsSingleAttemptMove = () => true;
  t.remote.stat = async path => path === "/" ? { ...await stat(path), remoteFileId: "root-id" } : stat(path);
  const from = "old.md", to = "new.md";
  t.local.put(from, "base");
  t.remote.put(from, "base");
  t.remote.files.get(from)!.entity.remoteFileId = "41";
  const seeded = await runSync(t.input);
  assert.equal(seeded.fullyConverged, true, JSON.stringify(seeded));
  let deletes = 0, moves = 0, reply = 201, auto = 0;
  let beforeMove = () => {}, afterMove = () => {};
  t.remote.deleteContent = async () => { deletes++; throw new Error("rename path reached DELETE"); };
  t.remote.moveContent = (source, target, etag) =>
    t.journal.send("MOVE", t.remote.contentEndpoint(source), etag, async () => {
      moves++;
      beforeMove();
      const current = t.remote.files.get(source);
      if (current?.entity.etag !== etag || t.remote.files.has(target)) return { status: 412 };
      if ([201, 504].includes(reply)) {
        t.remote.files.set(target, { ...current, entity: { ...current.entity, key: target, keyRaw: target } });
        t.remote.files.delete(source);
      }
      afterMove();
      return { status: reply };
    }, t.remote.contentEndpoint(target));
  const file = { path: from, extension: "md" };
  let currentFile = file, emit!: (value: typeof file, oldPath: string) => void;
  const owner = {
    settings: { syncDirection: "bidirectional", syncOnSaveAfterMilliseconds: 30000 },
    app: { vault: { configDir: ".obsidian", getName: () => "vault",
      getAbstractFileByPath: (path: string) => path === currentFile.path ? currentFile : null,
      on: (event: string, cb: typeof emit) => { assert.equal(event, "rename"); emit = cb; return cb; } } },
    vaultRandomID: t.input.vaultRandomID, getCurrProfileID: () => t.input.profileID,
    registerEvent: () => {}, renameIntents: [] as NonNullable<NonNullable<typeof t.input.contentRuntime>["renames"]>,
    deferredTasks: { disposed: false }, _syncOnSaveEvent2: () => { auto++; },
  };
  attach(contentScope, () => t.remote).call(owner);
  return { ...t, owner, from, to, moves: () => moves, deletes: () => deletes,
    auto: () => auto, reply: (status: number) => { reply = status; },
    beforeMove: (fn: () => void) => { beforeMove = fn; },
    afterMove: (fn: () => void) => { afterMove = fn; },
    replaceObject: () => { currentFile = { ...currentFile }; },
    rename(observed = true) {
      t.local.files.delete(from);
      t.local.put(to, "base");
      file.path = to;
      if (observed) emit(file, from);
    },
    renameAgain(target: string) {
      const oldPath = file.path;
      t.local.files.delete(oldPath);
      t.local.put(target, "base");
      file.path = target;
      emit(file, oldPath);
    },
    run: () => runSync({ ...t.input, contentRuntime: { ...t.input.contentRuntime!, renames: owner.renameIntents.slice() } }),
  };
}

describe("P3 local rename event at the B sync entry", () => {
  it("keeps both collision paths protected during unrelated writes, reload and database reopen", async () => {
    const t = await scene();
    const pool = new IdbConnectionPool();
    try {
      t.rename();
      t.remote.put(t.to, "existing target");
      const check = async (input = t.input) => {
        const r = await runSync(input);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.pendingContent?.filter(p => [t.from, t.to].includes(p.path)).sort((a, b) => a.path.localeCompare(b.path)), [
          { path: t.from, reason: "move-target-occupied" }, { path: t.to, reason: "move-target-occupied" },
        ].sort((a, b) => a.path.localeCompare(b.path)));
        assert.equal(text(await t.remote.readFile(t.to)), "existing target");
        assert.equal(text(await t.remote.readFile(t.from)), "base");
        assert.equal(text(await t.local.readFile(t.to)), "base");
        assert.equal(t.local.files.has(t.from), false);
      };
      const binding = t.remote.contentBinding.bind(t.remote);
      // First use the real rename input. No transport capability is needed for the hold.
      t.remote.supportsSingleAttemptMove = () => false;
      await check({ ...t.input, contentRuntime: { ...t.input.contentRuntime!, renames: t.owner.renameIntents.slice() } });
      t.owner.renameIntents = [];
      t.local.put("safe.md", "safe");
      await check();
      assert.equal(text(await t.remote.readFile("safe.md")), "safe");
      t.stop();
      const journal = new NativeWriteJournal({ getItem: k => t.entries.get(k) ?? null,
        setItem: (k, v) => { t.entries.set(k, v); }, removeItem: k => { t.entries.delete(k); } }, t.journal.key);
      try {
        t.remote.contentBinding = () => ({ ...binding(), journalToken: journal.token });
        const { db } = await prepareDBs("/reopened/" + t.input.vaultRandomID, t.input.vaultRandomID, t.input.profileID, pool);
        const reopened = { ...t.input, db,
          contentRuntime: { ...t.input.contentRuntime!, pool, journal, assertActive: () => pool.assertOpen() } };
        t.local.put("ordinary.md", "local only change\n");
        t.remote.put("ordinary.md", "remote only change\n");
        await check(reopened);
        const marker = text(await t.remote.readFile("ordinary.md"));
        assert.ok(marker.includes("<<<<<<< Obsidian") && marker.includes("local only change") && marker.includes("remote only change"));
        assert.equal(text(await t.local.readFile("ordinary.md")), marker);
        assert.equal(t.remote.puts, 2, "only the safe file and ordinary conflict may upload");
        assert.equal(t.moves(), 0);
        assert.equal(t.deletes(), 0);
        assert.ok(t.local.writes().every(call => ![t.from, t.to].includes(call.key)));
      } finally { journal.retire(); }
    } finally { pool.dispose(); t.stop(); }
  });

  it("keeps a destination that appears at dispatch protected after the 412 and a reload", async () => {
    const t = await scene();
    try {
      t.rename();
      t.beforeMove(() => { t.remote.put(t.to, "appeared during MOVE"); });
      const first = await t.run();
      assert.equal(first.ok, true);
      assert.ok(first.pendingContent?.some(p => p.path === t.to && p.reason === "move-target-occupied"));
      t.owner.renameIntents = [];
      const after = await t.run();
      assert.ok(after.pendingContent?.some(p => p.path === t.to && p.reason === "move-target-occupied"));
      assert.equal(text(await t.remote.readFile(t.from)), "base");
      assert.equal(text(await t.remote.readFile(t.to)), "appeared during MOVE");
      assert.equal(text(await t.local.readFile(t.to)), "base");
      assert.equal(t.moves(), 1);
      assert.equal(t.remote.puts, 0);
      assert.equal(t.deletes(), 0);
    } finally { t.stop(); }
  });

  it("keeps a collision after the target disappears and releases it after an exact local undo", async () => {
    const t = await scene();
    try {
      t.rename();
      t.remote.put(t.to, "occupied");
      await t.run();
      t.owner.renameIntents = [];
      t.remote.files.delete(t.to);
      assert.ok((await t.run()).pendingContent?.some(p => p.path === t.to && p.reason === "move-target-occupied"));
      assert.equal(t.remote.puts, 0);
      t.local.files.delete(t.to);
      t.local.put(t.from, "different bytes");
      assert.ok((await t.run()).pendingContent?.some(p => p.path === t.from && p.reason === "move-target-occupied"));
      assert.equal(text(await t.remote.readFile(t.from)), "base");
      t.renameAgain(t.from);
      assert.equal((await t.run()).fullyConverged, true);
      assert.equal(t.moves(), 0);
      assert.equal(t.deletes(), 0);
    } finally { t.stop(); }
  });

  it("keeps a valid rename pending without a verified single-attempt transport", async () => {
    const t = await scene();
    try {
      t.rename();
      t.remote.supportsSingleAttemptMove = () => false;
      const r = await t.run();
      assert.equal(r.contentSummary?.blocked, false);
      assert.ok(r.pendingContent?.some(p => p.path === t.to && p.reason === "suspected-file-move"));
      assert.equal(t.moves(), 0);
      assert.equal(t.remote.puts, 0);
      assert.equal(t.deletes(), 0);
      assert.equal(t.entries.size, 0);
      assert.equal(await contentRuntime(t.input).move("root-id")?.pendingCommit(), undefined);
    } finally { t.stop(); }
  });

  it("binds the real Vault event contract, emits one MOVE and converges twice without DELETE or PUT", async () => {
    const t = await scene();
    try {
      t.rename();
      const predecessor = (await contentRuntime(t.input).file(t.from).checkpoint.read()).commitId;
      assert.equal(t.auto(), 1);
      assert.equal(t.owner.renameIntents.length, 1);
      const dry = await runSync({ ...t.input, triggerSource: "dry",
        contentRuntime: { ...t.input.contentRuntime!, renames: t.owner.renameIntents } });
      assert.ok(dry.pendingContent?.some(i => i.reason === "move-planned"));
      assert.equal(t.moves(), 0);
      const moved = await t.run();
      assert.deepEqual(moved.errors, []);
      assert.deepEqual([...t.remote.files.keys()], [t.to]);
      assert.equal(text(await t.remote.readFile(t.to)), "base");
      assert.equal(await t.rec(t.from), null);
      assert.equal((await t.rec(t.to))?.content?.remoteFileId, "41");
      assert.ok(t.reruns() > 0);
      assert.equal(t.owner.renameIntents.length, 0);
      for (let i = 0; i < 2; i++) assert.equal((await t.run()).fullyConverged, true);
      if (predecessor) assert.equal(await contentRuntime(t.input).operations.get(predecessor), undefined);
      assert.equal(t.moves(), 1);
      assert.equal(t.deletes(), 0);
      assert.equal(t.remote.puts, 0);
    } finally { t.stop(); }
  });

  for (const obstacle of ["remote-edit", "target-occupied", "file-replaced", "no-event"] as const) {
    it("preserves the source and reports pending when " + obstacle, async () => {
      const t = await scene();
      try {
        t.rename(obstacle !== "no-event");
        if (obstacle === "remote-edit") t.remote.put(t.from, "peer edit").files.get(t.from)!.entity.remoteFileId = "41";
        if (obstacle === "target-occupied") t.remote.put(t.to, "occupied");
        if (obstacle === "file-replaced") t.replaceObject();
        t.local.put("independent.md", "safe");
        const outcome = await t.run();
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.equal(outcome.fullyConverged, false);
        assert.ok(outcome.pendingContent?.some(p => p.path === t.from));
        assert.equal(text(await t.remote.readFile(t.from)), obstacle === "remote-edit" ? "peer edit" : "base");
        assert.equal(text(await t.local.readFile(t.to)), "base");
        if (obstacle === "target-occupied") assert.equal(text(await t.remote.readFile(t.to)), "occupied");
        assert.equal(text(await t.remote.readFile("independent.md")), "safe");
        assert.equal(t.moves(), 0);
        assert.equal(t.deletes(), 0);
      } finally { t.stop(); }
    });
  }

  it("keeps only the original and final paths across consecutive events for the same file object", async () => {
    const t = await scene();
    try {
      t.rename();
      t.renameAgain("final.md");
      assert.deepEqual(t.owner.renameIntents.map(({ source, target }) => [source, target]), [[t.from, "final.md"]]);
      const result = await t.run();
      assert.deepEqual(result.errors, []);
      assert.deepEqual([...t.remote.files.keys()], ["final.md"]);
      assert.equal(t.moves(), 1);
      assert.equal(t.deletes(), 0);
    } finally { t.stop(); }
  });

  it("persists an unknown MOVE even if the next load sees the renamed file", async () => {
    const t = await scene();
    try {
      t.rename();
      t.reply(504);
      assert.equal((await t.run()).contentSummary?.blocked, true);
      assert.ok(t.remote.files.has(t.to));
      t.owner.renameIntents = [];
      t.local.put("must-wait.md", "pending");
      assert.equal((await runSync(t.input)).contentSummary?.blocked, true);
      assert.equal(t.moves(), 1);
      assert.equal(t.deletes(), 0);
      assert.equal(t.remote.files.has("must-wait.md"), false);
    } finally { t.stop(); }
  });

  it("does not let a retired owner publish a late successful MOVE or dispatch another mutation", async () => {
    const t = await scene();
    try {
      t.rename();
      t.local.put("must-wait.md", "pending");
      let retired = false;
      const active = t.input.contentRuntime!.assertActive;
      t.input.contentRuntime!.assertActive = () => {
        active();
        if (retired) throw new Error("unloaded");
      };
      t.afterMove(() => { retired = true; t.journal.retire(); });
      assert.equal((await t.run()).contentSummary?.blocked, true);
      assert.ok(await t.rec(t.from));
      assert.equal(await t.rec(t.to), null);
      assert.equal(t.remote.files.has("must-wait.md"), false);
      assert.equal(t.moves(), 1);
      assert.equal(t.deletes(), 0);
    } finally { t.stop(); }
  });

  it("retains a later target edit and both index stages until a confirmed MOVE can commit", async () => {
    const t = await scene();
    try {
      t.rename();
      t.afterMove(() => { t.local.put(t.to, "tail"); });
      const outcome = await t.run();
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assert.ok(outcome.pendingContent?.some(p => p.path === t.to && p.reason === "move-target-content-changed"));
      assert.equal(text(await t.local.readFile(t.to)), "tail");
      assert.equal(text(await t.remote.readFile(t.to)), "base");
      assert.ok(await t.rec(t.from));
      assert.equal(await t.rec(t.to), null);
      // Reload loses the in-memory event. The durable receipt still reserves both paths.
      t.owner.renameIntents = [];
      t.local.put("independent.md", "safe");
      const next = await runSync(t.input);
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.equal(next.fullyConverged, false);
      assert.equal(text(await t.remote.readFile("independent.md")), "safe");
      assert.equal(t.moves(), 1);
      assert.equal(t.deletes(), 0);
    } finally { t.stop(); }
  });
});
