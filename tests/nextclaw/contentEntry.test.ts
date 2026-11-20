import { FIRST_B_DOWNLOAD_LIMIT, INITIAL_DOWNLOAD_BYTES } from "../../src/nextclaw/content/initialDownloadLimit";
import "fake-indexeddb/auto";
import { strict as assert } from "assert";
import { prepareDBs, type NextclawSyncRecord } from "../../src/localdb";
import { IdbConnectionPool } from "../../src/idbStore";
import { NativeWriteJournal } from "../../src/nextclaw/nativeWriteJournal";
import { runSync } from "../../src/nextclaw/syncEngine";
import { ContentStore, isAttachmentRef } from "../../src/nextclaw/content/store";
import { ATTACHMENT_LIMIT, ATTACHMENT_PROFILE_LIMIT, NOTE_LIMIT, PROFILE_LIMIT } from "../../src/nextclaw/content/identity";
import { contentRuntime, assertContentResetSafe, checkVaultStages } from "../../src/nextclaw/content/runtime";
import { mainHarness } from "./engine/mainHarness";
import { harness } from "./engine/helpers";
import { MemoryFs, bytes, text } from "./engine/helpers";
import { SyncConflict, etagHeader } from "../../src/nextclaw/engine/versionGuard";
import type { Entity } from "../../src/baseTypes";
import type { SyncInput } from "../../src/nextclaw/syncEngine";
class Local extends MemoryFs {
  current = () => {};
  override async writeFileGuarded(k: string, b: ArrayBuffer, m: number, c: number, e: Entity | null, before?: ArrayBuffer,
    current = () => {}, verifyStagedCreate?: () => Promise<void>) {
    current(); this.current();
    if (verifyStagedCreate) await verifyStagedCreate();
    current(); return super.writeFileGuarded(k, b, m, c, e, before);
  }
}
class Remote extends MemoryFs {
  revision = 0; puts = 0; status = 201;
  beforePut: () => Promise<void> = async () => {}; afterPut: () => void = () => {};
  constructor(readonly journal: NativeWriteJournal) { super("webdav"); }
  override put(k: string, s = "x", time = 10000) { super.put(k, s, time); this.files.get(k.normalize("NFC"))!.entity.etag = `"E${++this.revision}"`; return this; }
  contentBinding() { return { origin: "https://synthetic.invalid", account: "test", remoteRoot: "/vault", nativeManaged: false, journalToken: this.journal.token }; }
  contentEndpoint(k: string) { return `https://synthetic.invalid/vault/${encodeURIComponent(k)}`; }
  async readContent(k: string, e: Entity) { if ((await this.stat(k)).etag !== e.etag) throw new SyncConflict(); return { bytes: await this.readFile(k), etag: etagHeader(e) }; }
  async putContent(k: string, b: ArrayBuffer, expected: string | null) {
    this.puts++; await this.beforePut(); const previous = this.files.get(k.normalize("NFC"));
    if (expected === null ? !!previous : previous?.entity.etag !== expected) return { status: 412 };
    if (![201, 504].includes(this.status)) return { status: this.status };
    this.put(k, text(b)); this.files.get(k.normalize("NFC"))!.bytes = b.slice(0); this.afterPut();
    return { status: this.status, etag: this.files.get(k.normalize("NFC"))!.entity.etag };
  }
}
export async function environment() {
  const pool = new IdbConnectionPool(), entries = new Map<string,string>(); let active = true, reruns = 0;
  const journal = new NativeWriteJournal({ getItem:k=>entries.get(k)??null, setItem:(k,v)=>{entries.set(k,v);}, removeItem:k=>{entries.delete(k);} }, crypto.randomUUID());
  const { db, vaultRandomID } = await prepareDBs("/synthetic/" + crypto.randomUUID(), "", "p", pool);
  const local = new Local(), remote = new Remote(journal), statuses: unknown[][] = [], plans: unknown[] = [];
  const guard = () => { pool.assertOpen(); if (!active) throw Error("retired"); };
  const input: SyncInput = { mode: "B", fsLocal: local, fsRemote: remote, db, vaultRandomID, profileID: "p", configDir: ".obsidian",
    syncConfigDir: true, ignorePaths: [], pluginId: "nextclaw-sync", protectModifyPercentage: 100, triggerSource: "manual",
    contentRuntime: { pool, journal, assertActive: guard, requestRerun: () => { reruns++; } },
    callbacks: { markIsSyncing: () => {}, notify: () => {}, ribbon: () => {}, statusBar: (...args) => {statuses.push(args);}, progress: () => {}, errNotify: () => {}, protectError: () => "protect" } };
  return { pool, journal, db, local, remote, input, entries, statuses, plans, reruns: () => reruns,
    rec: (k: string) => db.prevSyncRecordsTbl.getItem<NextclawSyncRecord>(`${vaultRandomID}\tp\t${k}`),
    async seed(k: string) { const l=await local.stat(k),r=await remote.stat(k); await db.prevSyncRecordsTbl.setItem(`${vaultRandomID}\tp\t${k}`, {
      ...l,v:1,key:k,isFolder:false,local:{mtime:l.mtimeCli!,size:l.sizeRaw},remote:{mtime:r.mtimeSvr!,size:r.sizeRaw,etag:r.etag} }); },
    stop() { active=false; journal.retire(); pool.dispose(); }, guard };
}

describe("Mobile first B download", () => {
  async function fixture(count = 1) {
    const t = await environment();
    const stat = t.remote.stat.bind(t.remote);
    t.remote.stat = async key => key === "/" ? { ...await stat(key), remoteFileId: "root" } : stat(key);
    const paths = Array.from({ length: count }, (_, i) => `page-${i}.md`);
    const seed = (path: string, body: string) => {
      t.remote.put(path, body);
      t.remote.files.get(path)!.entity.remoteFileId = path;
    };
    for (const path of paths) seed(path, `remote ${path}`);
    t.input.androidInitialDownload = true;
    return { ...t, paths, seed };
  }

  function seedAttachment(t: Awaited<ReturnType<typeof fixture>>, path: string, size: number) {
    t.seed(path, "fixture");
    const row = t.remote.files.get(path)!;
    const body = new Uint8Array(size);
    body.set(path.endsWith(".gif") ? [71, 73, 70, 56, 57, 97] : [137, 80, 78, 71, 13, 10, 26, 10]);
    row.bytes = body.buffer;
    row.entity.size = row.entity.sizeRaw = size;
    return body.buffer;
  }

  it("traces a fast download waiting for a slow peer through protected write and durable readback", async () => {
    const t = await fixture(4);
    const events: { phase: string; path: string; sequence: number }[] = [];
    const host = globalThis as { __nextclawSmallFileProbe?: (payload: string) => void };
    const [fast, slow] = t.paths;
    let release!: () => void;
    const slowGate = new Promise<void>(resolve => { release = resolve; });
    host.__nextclawSmallFileProbe = payload => {
      const event = JSON.parse(payload) as typeof events[number];
      events.push(event);
      if (event.path === fast && event.phase === "download-ready") release();
    };
    const read = t.remote.readContent.bind(t.remote);
    t.remote.readContent = async (path, expected) => {
      if (path === slow) await slowGate;
      return read(path, expected);
    };
    try {
      assert.equal((await runSync(t.input)).fullyConverged, true);
      const at = (path: string, phase: string) => {
        const event = events.find(row => row.phase === phase && row.path === path);
        assert.ok(event, phase);
        return event.sequence;
      };
      assert.ok(at(fast, "get:ok") < at(fast, "download-ready"));
      assert.ok(at(fast, "download-ready") < at(slow, "download-ready"));
      assert.ok(at(slow, "download-ready") < at(fast, "group-released"));
      assert.ok(at(fast, "group-released") < at(fast, "guarded-write:start"));
      assert.ok(at(fast, "guarded-write:ok") < at(fast, "idb-write-complete"));
      assert.ok(at(fast, "idb-write-complete") < at(fast, "checkpoint-readback-verified"));
      assert.ok(events.some(row => row.path === fast && row.phase === "version:ok"));
    } finally {
      delete host.__nextclawSmallFileProbe;
      t.stop();
    }
  });

  it("resumes the four capacity holds from an existing B sweep and verifies imports after reload", async () => {
    const t = await fixture(0);
    const sizes = { "demo.gif": 10843290, "one.png": 1653277, "two.png": 1317257, "three.png": 1392586 };
    const files = new Map(Object.entries(sizes).map(([path, size]) => [path, seedAttachment(t, path, size)]));
    const runtime = contentRuntime(t.input);
    const schedule = `content-batch:${runtime.scope}`;
    await t.db.simpleKVForMiscTbl.setItem(schedule, {
      version: 1, remaining: [], completed: [],
      issues: [...files.keys()].map(path => ({ path, reason: "content-limit-pending" })),
    });
    const fetch = t.remote.readContent.bind(t.remote);
    let live = 0, peak = 0;
    t.remote.readContent = async (...args) => {
      peak = Math.max(peak, ++live);
      try { return await fetch(...args); }
      finally { live--; }
    };
    try {
      const imported = await runSync(t.input);
      assert.equal(imported.fullyConverged, true, JSON.stringify(imported.pendingContent));
      assert.equal(peak, 4);
      for (const [path, body] of files) {
        assert.deepEqual(await t.local.readFile(path), body);
        assert.ok(isAttachmentRef((await t.rec(path))?.content?.cleanBaseRef));
      }
      t.local.calls.length = 0;
      t.journal.retire();
      const reopened = new NativeWriteJournal({ getItem: k => t.entries.get(k) ?? null,
        setItem: (k, v) => { t.entries.set(k, v); }, removeItem: k => { t.entries.delete(k); } }, crypto.randomUUID());
      const oldBinding = t.remote.contentBinding.bind(t.remote);
      t.remote.contentBinding = () => ({ ...oldBinding(), journalToken: reopened.token });
      try {
        const input = { ...t.input, androidInitialDownload: undefined,
          contentRuntime: { ...t.input.contentRuntime!, journal: reopened } };
        assert.equal((await runSync({ ...input, androidFirstBRecovery: true, triggerSource: "auto_sync_on_save" })).fullyConverged, true);
        let settled = await runSync(input);
        for (let i = 1; !settled.fullyConverged && i < files.size; i++) {
          assert.ok(settled.pendingContent?.every(item => item.reason === "正文批次待续跑"));
          settled = await runSync(input);
        }
        assert.equal(settled.fullyConverged, true, JSON.stringify(settled.pendingContent));
        assert.deepEqual(t.local.writes(), []);
        assert.equal(t.remote.puts, 0);
      } finally { reopened.retire(); }
    } finally { t.stop(); }
  });

  for (const platform of ["Android", "iPad"]) it(`${platform} resumes first B with existing clean records and fetches only the four held attachments`, async () => {
    const t = await fixture(36);
    if (platform === "iPad") {
      delete t.input.androidInitialDownload;
      t.input.ipadInitialDownload = true;
    }
    try {
      assert.ok((await runSync(t.input)).fullyConverged);
      const attachments = new Map(Object.entries({"demo.gif":10843290,"one.png":1653277,"two.png":1317257,"three.png":1392586})
        .map(([path, size]) => [path, seedAttachment(t, path, size)]));
      const scope = contentRuntime(t.input).scope;
      await t.db.simpleKVForMiscTbl.setItem(`content-batch:${scope}`, {
        version: 1, remaining: t.paths, completed: [],
        issues: [...attachments.keys()].map(path => ({path, reason:"content-limit-pending"})),
      });
      t.remote.calls.length = t.local.calls.length = 0;
      const result = await runSync(t.input);
      assert.equal(result.fullyConverged, true, JSON.stringify(result.pendingContent));
      assert.deepEqual(t.remote.calls.filter(c=>c.op==="readFile").map(c=>c.key).sort(), [...attachments.keys()].sort());
      assert.deepEqual(t.local.writes().map(c=>c.key).sort(), [...attachments.keys()].sort());
      assert.equal(t.remote.puts,0);
      assert.equal(t.reruns(),0);
      for (const [path, body] of attachments) assert.deepEqual(await t.local.readFile(path), body);
    } finally { t.stop(); }
  });

  it("runs ordinary first-B planning for a missing record, changed version, and edited local bytes", async () => {
    const t = await fixture(6);
    try {
      assert.ok((await runSync(t.input)).fullyConverged);
      const [missing, replaced, edited, changedDuringCheck, changedIdentity, unchecked] = t.paths;
      await t.db.prevSyncRecordsTbl.removeItem(`${t.input.vaultRandomID}\tp\t${missing}`);
      t.seed(replaced,"remote edit");
      t.local.put(edited,`Remote ${edited}`);
      t.remote.files.get(changedIdentity)!.entity.remoteFileId="replacement-id";
      const stat = t.remote.stat.bind(t.remote);
      let observed = 0;
      t.remote.stat = async key => {
        if (key === changedDuringCheck && ++observed === 2) t.seed(key,"changed during verification");
        return stat(key);
      };
      t.remote.calls.length = 0;
      const result = await runSync(t.input);
      assert.equal(result.fullyConverged,true,JSON.stringify(result.pendingContent));
      const reads = t.remote.calls.filter(c=>c.op==="readFile").map(c=>c.key);
      for (const changed of [missing,replaced,edited,changedDuringCheck,changedIdentity]) assert.ok(reads.includes(changed),changed);
      assert.ok(!reads.includes(unchecked));
      assert.equal(text(await t.local.readFile(replaced)),"remote edit");
      assert.equal(text(await t.local.readFile(changedDuringCheck)),"changed during verification");
      assert.equal(text(await t.remote.readFile(edited)),`Remote ${edited}`);
      assert.equal(t.remote.puts,1);
    } finally { t.stop(); }
  });

  it("counts retained old and new bodies in the import budget and rejects a declared file above 50 MiB before GET", async () => {
    const t = await fixture(0);
    try {
      const rt = contentRuntime(t.input);
      const note = new ArrayBuffer(NOTE_LIMIT);
      for (let i = 0; i < PROFILE_LIMIT / NOTE_LIMIT; i++) {
        await rt.bodies.put(`page-${i}.md`, note, "clean-base");
      }
      await assert.rejects(rt.bodies.ensureCapacity(1), /content-limit-pending/);
      const bytes = seedAttachment(t, "image.gif", 6 * 1024 * 1024);
      const ref = await rt.attachments.put("image.gif", bytes, "clean-base");
      assert.ok(isAttachmentRef(ref));
      assert.deepEqual((await rt.bodies.read(ref, "image.gif")).bytes, bytes);
      await rt.attachments.ensureCapacity(ATTACHMENT_PROFILE_LIMIT - PROFILE_LIMIT - bytes.byteLength);
      await assert.rejects(rt.attachments.ensureCapacity(ATTACHMENT_PROFILE_LIMIT - PROFILE_LIMIT - bytes.byteLength + 1), /content-limit-pending/);
      await assert.rejects(rt.bodies.ensureCapacity(1), /content-limit-pending/);
      t.remote.files.delete("image.gif");
      seedAttachment(t, "too-big.gif", 8);
      const row = t.remote.files.get("too-big.gif")!;
      row.entity.size = row.entity.sizeRaw = ATTACHMENT_LIMIT + 1;
      t.remote.calls.length = 0;
      const result = await runSync(t.input);
      assert.deepEqual(result.pendingContent, [{ path: "too-big.gif", reason: "attachment-file-limit-pending" }]);
      assert.equal(t.remote.calls.some(c => c.op === "readFile" && c.key === "too-big.gif"), false);
      assert.deepEqual(t.local.writes(), []);
    } finally { t.stop(); }
  });

  it("commits an attachment exactly at the independent 50 MiB limit", async function () {
    this.timeout(20_000);
    const t = await fixture(0);
    const path = "boundary.gif";
    const expected = seedAttachment(t, path, ATTACHMENT_LIMIT);
    try {
      const result = await runSync(t.input);
      assert.equal(result.fullyConverged, true, JSON.stringify(result.pendingContent));
      assert.deepEqual(t.local.files.get(path)?.bytes, expected);
      assert.ok(isAttachmentRef((await t.rec(path))?.content?.cleanBaseRef));
      assert.equal(t.remote.puts, 0);
    } finally { t.stop(); }
  });

  it("rejects a changed remote version after the attachment operation is durable", async () => {
    const t = await fixture(0);
    const path = "changed.gif";
    seedAttachment(t, path, 6 * 1024 * 1024);
    const history = t.db.fileContentHistoryTbl;
    const persist = history.setItem.bind(history);
    let changedAfterStaging = false;
    history.setItem = async (key, value) => {
      const result = await persist(key, value);
      const operation = value as { path?: string; phase?: string } | null;
      if (operation?.path === path && operation.phase === "local-verified") {
        t.remote.files.get(path)!.entity.etag = '"changed"';
        changedAfterStaging = true;
      }
      return result;
    };
    try {
      const result = await runSync(t.input);
      assert.equal(changedAfterStaging, true);
      assert.deepEqual(result.pendingContent?.map(item => item.path), [path]);
      assert.equal(t.local.files.has(path), false);
      assert.equal(await t.rec(path), null);
      assert.equal(t.remote.puts, 0);
    } finally { t.stop(); }
  });

  it("keeps an attachment destination that appears at guarded publication", async () => {
    const t = await fixture(0);
    const path = "occupied.png";
    seedAttachment(t, path, 5 * 1024 * 1024);
    t.local.current = () => { if (!t.local.files.has(path)) t.local.put(path, "occupied bytes"); };
    try {
      const result = await runSync(t.input);
      assert.deepEqual(result.pendingContent?.map(item => item.path), [path]);
      assert.equal(text(await t.local.readFile(path)), "occupied bytes");
      assert.equal(await t.rec(path), null);
      assert.equal(t.remote.puts, 0);
    } finally { t.stop(); }
  });

  it("keeps a WebView quota failure pending without publishing or queuing an immediate rerun", async () => {
    const t = await fixture(0);
    const path = "no-space.gif";
    seedAttachment(t, path, 5 * 1024 * 1024);
    const history = t.db.fileContentHistoryTbl;
    const persist = history.setItem.bind(history);
    history.setItem = async (key, data) => {
      if (isAttachmentRef(key)) throw new DOMException("quota", "QuotaExceededError");
      return persist(key, data);
    };
    try {
      const result = await runSync(t.input);
      assert.deepEqual(result.pendingContent, [{ path, reason: "attachment-storage-quota-pending" }]);
      assert.equal(result.errors.length, 0);
      assert.equal(t.local.files.has(path), false);
      assert.equal(t.reruns(), 0);
      assert.equal(t.remote.puts, 0);
    } finally { t.stop(); }
  });

  it("recovers a published attachment after retiring before its checkpoint without rewriting data", async () => {
    const t = await fixture(0);
    const path = "handoff.gif";
    const body = seedAttachment(t, path, 5 * 1024 * 1024);
    let retired = false;
    t.input.contentRuntime!.assertActive = () => { if (retired) throw new Error("retired"); };
    const write = t.local.writeFileGuarded.bind(t.local);
    t.local.writeFileGuarded = async (...args) => {
      const result = await write(...args);
      retired = true;
      return result;
    };
    try {
      assert.equal((await runSync(t.input)).fullyConverged, false);
      assert.deepEqual(await t.local.readFile(path), body);
      assert.equal(await t.rec(path), null);
      t.journal.retire();
      const reopened = new NativeWriteJournal({ getItem: k => t.entries.get(k) ?? null,
        setItem: (k, v) => { t.entries.set(k, v); }, removeItem: k => { t.entries.delete(k); } }, crypto.randomUUID());
      const oldBinding = t.remote.contentBinding.bind(t.remote);
      t.remote.contentBinding = () => ({ ...oldBinding(), journalToken: reopened.token });
      t.local.calls.length = 0;
      try {
        const input = { ...t.input, contentRuntime: { ...t.input.contentRuntime!, assertActive: t.guard, journal: reopened } };
        const recovered = await runSync(input);
        assert.deepEqual(recovered.pendingContent, [{ path, reason: "操作已确认，待重新扫描" }]);
        assert.ok(isAttachmentRef((await t.rec(path))?.content?.cleanBaseRef));
        assert.equal((await runSync(input)).fullyConverged, true);
        assert.deepEqual(t.local.writes(), []);
        assert.equal(t.remote.puts, 0);
      } finally { reopened.retire(); }
    } finally { t.stop(); }
  });

  for (const platform of ["Android", "iPad"]) {
    for (const changedVersion of [false, true]) {
      it(`${platform} first B ${changedVersion ? "stops at an unconfirmed recovery" : "recovers independent operations before one rescan and imports a remote-only PNG"}`, async () => {
        const t = await fixture(3);
        if (platform === "iPad") {
          delete t.input.androidInitialDownload;
          t.input.ipadInitialDownload = true;
        }
        const history = t.db.fileContentHistoryTbl;
        const persist = history.setItem.bind(history);
        const runtime = contentRuntime(t.input);
        history.setItem = async (key, value) => {
          const result = await persist(key, value);
          const operation = value as { path?: string; phase?: string } | null;
          if (operation?.phase === "local-verified") throw Error("interrupted before checkpoint");
          return result;
        };
        try {
          assert.equal((await runSync(t.input)).fullyConverged, false);
          history.setItem = persist;
          const staged = (await runtime.operations.list(runtime.scope)).filter(o => o.phase === "local-verified");
          assert.equal(staged.length, 3);
          const png = "remaining.png";
          const body = seedAttachment(t, png, 128);
          if (changedVersion) t.seed(staged[1].path, "new remote version");
          const before = t.reruns();
          const input = { ...t.input, triggerSource: "auto_sync_on_save" as const };
          const recovered = await runSync(input);
          assert.equal(recovered.fullyConverged, false);
          assert.equal(recovered.errors.length, 0);
          assert.equal(t.local.files.has(png), false);
          assert.equal(t.remote.puts, 0);
          if (changedVersion) {
            assert.deepEqual(recovered.pendingContent, [
              { path: staged[0].path, reason: "操作已确认，待重新扫描" },
              { path: staged[1].path, reason: "remote-changed-after-ack" },
            ]);
            assert.equal(t.reruns(), before);
            assert.equal(await t.rec(staged[1].path), null);
            assert.equal(await t.rec(staged[2].path), null);
            assert.equal((await runtime.operations.get(staged[2].id))?.phase, "local-verified");
          } else {
            assert.deepEqual(recovered.pendingContent, staged.map(({ path }) => ({ path, reason: "操作已确认，待重新扫描" })));
            assert.equal(t.reruns(), before + 1);
            for (const operation of staged) {
              assert.equal((await runtime.operations.get(operation.id))?.phase, "committed");
              assert.equal((await t.rec(operation.path))?.content?.status, "clean");
            }
            assert.equal((await runSync(input)).fullyConverged, true);
            assert.deepEqual(await t.local.readFile(png), body);
            assert.equal((await t.rec(png))?.content?.status, "clean");
            assert.equal(t.reruns(), before + 1);
            assert.equal(t.remote.puts, 0);
          }
        } finally { t.stop(); }
      });
    }
  }

  for (const platform of ["Android", "iPad"]) it(`${platform} downloads beyond a normal batch with one full scan and the configured GET ceiling`, async () => {
    const t = await fixture(35);
    if (platform === "iPad") {
      delete t.input.androidInitialDownload;
      t.input.ipadInitialDownload = true;
    }
    let active = 0, peak = 0, reads = 0, fileStats = 0, recordScans = 0, capacityScans = 0;
    const records = t.db.prevSyncRecordsTbl;
    const iterate = records.iterate.bind(records);
    records.iterate = (...args) => {
      recordScans++;
      return iterate(...args);
    };
    const history = t.db.fileContentHistoryTbl;
    const iterateHistory = history.iterate.bind(history);
    history.iterate = (...args) => {
      if (typeof args[1]?.lower === "string" && args[1].lower.startsWith('["nextclaw-content",')) capacityScans++;
      return iterateHistory(...args);
    };
    const stat = t.remote.stat.bind(t.remote);
    t.remote.stat = async key => {
      if (key !== "/") fileStats++;
      return stat(key);
    };
    const read = t.remote.readContent.bind(t.remote);
    t.remote.readContent = async (path, expected) => {
      reads++;
      peak = Math.max(peak, ++active);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        return await read(path, expected);
      } finally { active--; }
    };
    try {
      assert.equal((await runSync(t.input)).fullyConverged, true);
      assert.equal(peak, FIRST_B_DOWNLOAD_LIMIT);
      assert.equal(reads, 35);
      // The test transport validates each conditional GET with an extra stat.
      assert.equal(fileStats - reads, 35 * 5);
      assert.equal(recordScans, 3);
      assert.equal(capacityScans, 1);
      assert.equal(t.remote.calls.filter(x => x.op === "walk").length, 1);
      assert.equal(t.local.calls.filter(x => x.op === "walk").length, 1);
      assert.equal(t.reruns(), 0);
      assert.equal(t.remote.puts, 0);
      for (const path of t.paths) {
        assert.equal(text(await t.local.readFile(path)), `remote ${path}`);
        assert.equal((await t.rec(path))?.content?.status, "clean");
      }
    } finally { t.stop(); }
  });

  for (const platform of ["Android", "iPad"]) it(`${platform} imports mixed formats with ten GETs and the shared larger budget`, async () => {
    const t = await fixture(0);
    if (platform === "iPad") {
      delete t.input.androidInitialDownload;
      t.input.ipadInitialDownload = true;
    }
    const source = new Map<string, ArrayBuffer>();
    source.set("a.md", bytes("x".repeat(NOTE_LIMIT + 1)));
    source.set("b.jpeg", Uint8Array.of(0xff, 0xd8, 0xff, 1).buffer);
    source.set("c.png", seedAttachment(t, "c.png", 20));
    source.set("d.gif", seedAttachment(t, "d.gif", 20));
    source.set("e.html", Uint8Array.of(0xef, 0xbb, 0xbf, 60, 62, 13, 10, 0xff).buffer);
    source.set("f.pdf", bytes("%PDF-1.7"));
    for (const [path, value] of [["g.any", ""], ["h.bin", "opaque"], ["i.md", "# hi"], ["j.htm", "html"]]) {
      source.set(path, bytes(value));
    }
    for (const [path, body] of source) {
      t.seed(path, "");
      const row = t.remote.files.get(path)!;
      row.bytes = body;
      row.entity.size = row.entity.sizeRaw = body.byteLength;
    }
    const read = t.remote.readContent.bind(t.remote);
    let active = 0, peak = 0;
    t.remote.readContent = async (...args) => {
      peak = Math.max(peak, ++active);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        return await read(...args);
      } finally { active--; }
    };
    try {
      const result = await runSync(t.input);
      assert.equal(result.fullyConverged, true, JSON.stringify(result.pendingContent));
      assert.equal(peak, 10);
      assert.equal(t.remote.calls.filter(c=>c.op==="readFile").length, 10);
      for (const [path, body] of source) {
        assert.deepEqual(await t.local.readFile(path), body);
        assert.ok(isAttachmentRef((await t.rec(path))?.content?.cleanBaseRef));
      }
    } finally { t.stop(); }
  });

  it("limits simultaneous whole responses even when ten download slots are available", async () => {
    const t = await fixture(2);
    for (const path of t.paths) {
      const row = t.remote.files.get(path)!;
      row.entity.size = row.entity.sizeRaw = 33 * 1024 * 1024;
    }
    const host = globalThis as { __nextclawSmallFileProbe?: (payload: string) => void };
    const held: number[] = [];
    host.__nextclawSmallFileProbe = payload => {
      const row = JSON.parse(payload) as { phase: string; bytes: number };
      if (row.phase === "download-byte-reserve" || row.phase === "download-byte-release") held.push(row.bytes);
    };
    try {
      const result = await runSync(t.input);
      assert.equal(result.fullyConverged, false);
      assert.deepEqual(held, [33 * 1024 * 1024, 0, 33 * 1024 * 1024, 0]);
      assert.equal(t.local.writes().length, 0, "mismatched bodies never publish");
    } finally { delete host.__nextclawSmallFileProbe; t.stop(); }
  });

  it("prefetches the next group while the first group publishes", async () => {
    const t = await fixture(2 * FIRST_B_DOWNLOAD_LIMIT);
    const held: number[] = [];
    let nextPath: string | undefined;
    const host = globalThis as { __nextclawSmallFileProbe?: (payload: string) => void };
    host.__nextclawSmallFileProbe = payload => {
      const row = JSON.parse(payload) as { phase: string; bytes: number; group: number; path: string };
      if (row.phase === "group-dispatch" && row.group === FIRST_B_DOWNLOAD_LIMIT) nextPath ??= row.path;
      if (row.phase === "download-byte-reserve" || row.phase === "download-byte-release") held.push(row.bytes);
    };
    let nextStarted = false;
    let release!: () => void;
    const firstWrite = new Promise<void>(resolve => { release = resolve; });
    const read = t.remote.readContent.bind(t.remote);
    t.remote.readContent = async (path, expected) => {
      if (path === nextPath) {
        nextStarted = true;
        await firstWrite;
      }
      return read(path, expected);
    };
    t.local.current = () => {
      release();
      assert.equal(nextStarted, true);
    };
    try {
      assert.equal((await runSync(t.input)).fullyConverged, true);
      assert.deepEqual(t.local.writes().map(op => op.key).sort(), [...t.paths].sort());
      assert.equal(t.remote.puts, 0);
      assert.equal(Math.max(...held), t.paths.reduce((sum, path) => sum + t.remote.files.get(path)!.bytes.byteLength, 0));
      assert.ok(Math.max(...held) <= INITIAL_DOWNLOAD_BYTES);
      assert.equal(held.at(-1), 0);
    } finally { delete host.__nextclawSmallFileProbe; release(); t.stop(); }
  });

  it("validates independent paths concurrently with at most four guarded writers", async () => {
    const t = await fixture(FIRST_B_DOWNLOAD_LIMIT);
    const stat = t.remote.stat.bind(t.remote);
    const write = t.local.writeFileGuarded.bind(t.local);
    let checksInFlight = 0, checkPeak = 0, writers = 0, writerPeak = 0;
    let release!: () => void, releaseWriters!: () => void;
    const concurrentChecks = new Promise<void>(resolve => { release = resolve; });
    const concurrentWriters = new Promise<void>(resolve => { releaseWriters = resolve; });
    const guard = setTimeout(() => { release(); releaseWriters(); }, 750);
    t.remote.stat = async path => {
      if (!t.local.files.has(path)) return stat(path);
      checkPeak = Math.max(checkPeak, ++checksInFlight);
      if (checksInFlight === 2) release();
      try {
        await concurrentChecks;
        return await stat(path);
      } finally { checksInFlight--; }
    };
    t.local.writeFileGuarded = async (...args) => {
      writerPeak = Math.max(writerPeak, ++writers);
      if (writers === 4) releaseWriters();
      try {
        await concurrentWriters;
        return await write(...args);
      } finally { writers--; }
    };
    try {
      assert.equal((await runSync(t.input)).fullyConverged, true);
      assert.equal(writerPeak, 4);
      assert.ok(checkPeak >= 2);
      assert.equal(t.remote.puts, 0);
    } finally { clearTimeout(guard); release(); releaseWriters(); t.stop(); }
  });

  it("does not publish queued or in-flight paths after retirement during their write checks", async () => {
    const t = await fixture(5);
    const stat = t.remote.stat.bind(t.remote);
    const queries = new Map<string, number>();
    const atWrite = new Set<string>();
    let retired = false, release!: () => void;
    const inFlight = new Promise<void>(resolve => { release = resolve; });
    const limit = setTimeout(release, 750);
    t.input.contentRuntime!.assertActive = () => { if (retired) throw Error("retired"); };
    t.remote.stat = async path => {
      const call = (queries.get(path) ?? 0) + 1;
      queries.set(path, call);
      if (path !== "/" && call === 3) {
        // The fake conditional GET uses stat once, then prefetch and write each recheck.
        atWrite.add(path);
        if (atWrite.size === 4) { retired = true; release(); }
        await inFlight;
      }
      return stat(path);
    };
    try {
      assert.equal((await runSync(t.input)).fullyConverged, false);
      assert.equal(atWrite.size, 4);
      assert.equal(t.local.writes().length, 0);
      assert.equal(t.remote.puts, 0);
    } finally { clearTimeout(limit); release(); t.stop(); }
  });

  for (const { count, byteSize, quota, scans } of [
    { count: 45, byteSize: 300 * 1024, quota: 35 * 1024 * 1024, scans: 4 },
    { count: 3, byteSize: 4 * 1024 * 1024 - 128, quota: 12 * 1024 * 1024, scans: 5 },
  ]) it(`collects between reservations when WebView has room for only part of ${count} files`, async function () {
    this.timeout(15000);
    const t = await fixture(count);
    for (const path of t.paths) t.seed(path, "x".repeat(byteSize));
    const original = Object.getOwnPropertyDescriptor(navigator, "storage");
    Object.defineProperty(navigator, "storage", { configurable: true, value: { estimate: async () => ({quota, usage: 0}) } });
    const records = t.db.prevSyncRecordsTbl;
    const iterate = records.iterate.bind(records);
    let recordScans = 0;
    records.iterate = (...args) => {
      recordScans++;
      return iterate(...args);
    };
    try {
      assert.equal((await runSync(t.input)).fullyConverged, true);
      assert.equal(recordScans, scans);
      assert.equal(t.remote.puts, 0);
      assert.equal(t.local.writes().length, t.paths.length);
    } finally {
      if (original) Object.defineProperty(navigator, "storage", original);
      else Reflect.deleteProperty(navigator, "storage");
      t.stop();
    }
  });

  it("discards a downloaded version that changes before publication and uses normal rediscovery", async () => {
    const t = await fixture();
    const [path] = t.paths;
    const read = t.remote.readContent.bind(t.remote);
    let reads = 0;
    t.remote.readContent = async (key, expected) => {
      const incoming = await read(key, expected);
      if (++reads === 1) t.seed(key, "new remote version");
      return incoming;
    };
    try {
      assert.equal((await runSync(t.input)).fullyConverged, false);
      assert.equal(t.local.files.has(path), false);
      assert.equal(await t.rec(path), null);
      assert.equal(t.reruns(), 1);
      assert.equal((await runSync(t.input)).fullyConverged, true);
      assert.equal(text(await t.local.readFile(path)), "new remote version");
      assert.equal(reads, 2, "rediscovery downloads the new, independently verified version");
      assert.equal(t.remote.puts, 0);
    } finally { t.stop(); }
  });

  it("keeps an occupied target and completes its independent group peer", async () => {
    const t = await fixture(2);
    const [path, peer] = t.paths;
    const write = t.local.writeFileGuarded.bind(t.local);
    t.local.writeFileGuarded = (...args) => {
      if (args[0] === path) t.local.put(path, "concurrent edit");
      return write(...args);
    };
    try {
      const result = await runSync(t.input);
      assert.equal(result.fullyConverged, false);
      assert.equal(t.reruns(), 1);
      assert.equal(text(await t.local.readFile(path)), "concurrent edit");
      assert.equal(await t.rec(path), null);
      assert.equal(text(await t.local.readFile(peer)), `remote ${peer}`);
      assert.equal((await t.rec(peer))?.content?.status, "clean");
      assert.equal(t.remote.puts, 0);
    } finally { t.stop(); }
  });

  it("rechecks the remote version after staging and before the local writer", async () => {
    const t = await fixture();
    const [path] = t.paths;
    const stat = t.local.stat.bind(t.local);
    const content = t.db.fileContentHistoryTbl;
    let changed = false;
    t.local.stat = async key => {
      if (key === path && !changed) {
        const stages = await Promise.all((await content.keys()).map(id => content.getItem<{ phase?: string }>(id)));
        if (stages.some(stage => stage?.phase === "local-verified")) {
          changed = true;
          t.seed(path, "changed after staging");
        }
      }
      return stat(key);
    };
    try {
      const result = await runSync(t.input);
      assert.equal(changed, true);
      assert.equal(result.fullyConverged, false);
      assert.equal(t.local.writes().some(op => op.key === path), false);
      assert.equal(await t.rec(path), null);
      assert.equal(t.reruns(), 1);
    } finally { t.stop(); }
  });

  it("does not publish a clean checkpoint if the remote changes during local publication", async () => {
    const t = await fixture();
    const [path] = t.paths;
    const write = t.local.writeFileGuarded.bind(t.local);
    t.local.writeFileGuarded = async (...args) => {
      const result = await write(...args);
      t.seed(path, "new remote after local publication");
      return result;
    };
    try {
      const result = await runSync(t.input);
      assert.equal(result.fullyConverged, false);
      assert.equal(await t.rec(path), null);
      assert.equal(text(await t.local.readFile(path)), `remote ${path}`);
      assert.equal(text(await t.remote.readFile(path)), "new remote after local publication");
      assert.equal(t.remote.puts, 0);
      assert.equal(t.reruns(), 1);
    } finally { t.stop(); }
  });

  it("does not report convergence when the remote changes after the checkpoint commits", async () => {
    const t = await fixture();
    const [path] = t.paths;
    const history = t.db.fileContentHistoryTbl;
    const setItem = history.setItem.bind(history);
    history.setItem = async (key, value) => {
      const result = await setItem(key, value);
      if ((value as { phase?: string })?.phase === "committed") t.seed(path, "new remote after checkpoint");
      return result;
    };
    try {
      const result = await runSync(t.input);
      assert.equal(result.fullyConverged, false);
      assert.equal((await t.rec(path))?.content?.status, "clean");
      assert.equal(text(await t.local.readFile(path)), `remote ${path}`);
      assert.equal(text(await t.remote.readFile(path)), "new remote after checkpoint");
      assert.equal(t.remote.puts, 0);
      assert.ok(t.reruns() > 0);
    } finally { t.stop(); }
  });

  it("pauses if a stage from the key inventory is missing at the batched read", async () => {
    const t = await fixture();
    try {
      assert.equal((await runSync(t.input)).fullyConverged, true);
      const history = t.db.fileContentHistoryTbl;
      const scope = (await t.rec(t.paths[0]))?.content?.scopeKey;
      assert.ok(scope);
      const prefix = JSON.stringify(["nextclaw-content-operation", 1, scope]).slice(0, -1) + ",";
      const slots = (await history.keys()).filter(key => key.startsWith(prefix));
      assert.equal(slots.length, 1);
      const read = history.getEntries.bind(history);
      history.getEntries = async range => {
        await history.removeItem(slots[0]);
        return read(range);
      };
      await assert.rejects(checkVaultStages(t.db, t.input.vaultRandomID, t.guard), /同步已暂停/);
      assert.equal(t.remote.puts, 0);
    } finally { t.stop(); }
  });

  it("resumes after retirement without rewriting the file already committed", async () => {
    const t = await fixture(FIRST_B_DOWNLOAD_LIMIT + 1);
    const first = [...t.paths].sort()[0];
    const last = [...t.paths].sort().at(-1)!;
    let retired = false;
    t.input.contentRuntime!.assertActive = () => { if (retired) throw Error("retired"); };
    const history = t.db.fileContentHistoryTbl;
    const setItem = history.setItem.bind(history);
    history.setItem = async (key, value) => {
      const result = await setItem(key, value);
      const row = value as { path?: string; phase?: string } | null;
      if (row?.path === first && row.phase === "committed") retired = true;
      return result;
    };
    const resumed = new NativeWriteJournal({ getItem: k => t.entries.get(k) ?? null,
      setItem: (k, v) => { t.entries.set(k, v); }, removeItem: k => { t.entries.delete(k); } }, crypto.randomUUID());
    try {
      assert.equal((await runSync(t.input)).fullyConverged, false);
      assert.equal((await t.rec(first))?.content?.status, "clean");
      const published = new Set(t.paths.filter(path => t.local.files.has(path)));
      assert.ok(published.has(first));
      assert.equal(t.local.files.has(last), false);
      t.journal.retire();
      history.setItem = setItem;
      t.local.calls.length = 0;
      const binding = t.remote.contentBinding.bind(t.remote);
      t.remote.contentBinding = () => ({ ...binding(), journalToken: resumed.token });
      const resumeInput = { ...t.input, contentRuntime: { ...t.input.contentRuntime!, journal: resumed, assertActive: t.guard } };
      for (let runs = 0; runs <= t.paths.length; runs++) {
        if ((await runSync(resumeInput)).fullyConverged) break;
      }
      for (const path of t.paths) {
        assert.equal(text(await t.local.readFile(path)), `remote ${path}`);
        assert.equal((await t.rec(path))?.content?.status, "clean");
      }
      assert.equal(t.local.writes().some(x => published.has(x.key)), false);
      assert.equal(t.remote.puts, 0);
    } finally { resumed.retire(); t.stop(); }
  });

  it("passes the initial-download signal from the real Android and iPad B cutover entry only while reload is pending", async () => {
    const t = await fixture();
    const entries: SyncInput[] = [];
    const m = mainHarness({ ...harness(), local: t.local, remote: t.remote, input: t.input }, async input => {
      entries.push(input);
      return { ok: true, fullyConverged: false, pendingDirectories: [], counts: {}, errors: [] };
    });
    m.plugin.databaseConnections = t.pool;
    m.plugin.nativeWrites = t.journal;
    m.plugin.vaultRandomID = t.input.vaultRandomID;
    m.plugin.settings.webdav = { address: "https://synthetic.invalid/vault", username: "s00000", password: "synthetic" };
    m.plugin.settings.nextclawPendingSwitchToB = true;
    m.platform.isAndroidApp = true;
    try {
      assert.equal(await m.run(), "ok");
      assert.equal(m.plugin.settings.nextclawPendingSwitchToB, false);
      assert.equal(entries.at(-1)?.androidInitialDownload, true);
      m.platform.isAndroidApp = false;
      assert.equal(await m.run(), "ok");
      assert.equal(entries.at(-1)?.androidInitialDownload, undefined);
      m.platform.isIosApp = true;
      assert.equal(await m.run(), "ok");
      assert.equal(entries.at(-1)?.ipadInitialDownload, undefined);
      m.platform.isTablet = true;
      assert.equal(await m.run(), "ok");
      assert.equal(entries.at(-1)?.ipadInitialDownload, true);
      assert.equal(entries.at(-1)?.androidInitialDownload, undefined);
      m.platform.isAndroidApp = true;
      m.plugin.settings.nextclawReloadAfterFirstBSync = false;
      assert.equal(await m.run(), "ok");
      assert.equal(entries.at(-1)?.androidInitialDownload, undefined);
      assert.equal(entries.at(-1)?.ipadInitialDownload, undefined);
    } finally { t.stop(); }
  });

  for (const platform of ["Android", "iPad"]) it(`${platform} daily B uses the raised budget for local and remote file changes`, async function () {
    this.timeout(20000);
    const t = await fixture(0);
    if (platform === "iPad") {
      delete t.input.androidInitialDownload;
      t.input.ipadInitialDownload = true;
    }
    const path = "imported.md";
    const base = "x".repeat(NOTE_LIMIT + 1);
    t.seed(path, base);
    try {
      assert.equal((await runSync(t.input)).fullyConverged, true);
      assert.ok(isAttachmentRef((await t.rec(path))?.content?.cleanBaseRef));
      const m = mainHarness({...harness(), local:t.local, remote:t.remote, input:t.input}, runSync);
      m.plugin.databaseConnections = t.pool;
      m.plugin.nativeWrites = t.journal;
      m.plugin.vaultRandomID = t.input.vaultRandomID;
      m.plugin.settings.webdav = {address:"https://synthetic.invalid/vault", username:"s00000", password:"synthetic"};
      m.plugin.settings.nextclawReloadAfterFirstBSync = false;
      if (platform === "Android") m.platform.isAndroidApp = true;
      else { m.platform.isIosApp = true; m.platform.isTablet = true; }
      const upload = "L" + base;
      t.local.put(path, upload);
      assert.equal(await m.run("manual"), "ok");
      assert.equal(t.remote.puts, 1);
      assert.equal(text(await t.remote.readFile(path)), upload);
      assert.equal((await t.rec(path))?.content?.status, "clean");
      assert.ok(!isAttachmentRef((await t.rec(path))?.content?.cleanBaseRef));
      const download = "R" + base;
      t.seed(path, download);
      assert.equal(await m.run("auto"), "ok");
      assert.equal(text(await t.local.readFile(path)), download);
      assert.equal(m.plugin.pendingContent.pending, 0);
      assert.equal(await m.run("manual"), "ok", "a later sweep can verify the new large baseline");
      assert.equal(m.plugin.pendingContent.pending, 0);
      assert.equal(t.remote.puts, 1);
    } finally { t.stop(); }
  });

  it("limits enlarged daily B to Android and iPad", async () => {
    const t = await fixture();
    const seen: SyncInput[] = [];
    const m = mainHarness({...harness(), local:t.local, remote:t.remote, input:t.input}, async input => {
      seen.push(input);
      return {ok:true, fullyConverged:false, pendingDirectories:[], counts:{}, errors:[]};
    });
    m.plugin.databaseConnections=t.pool;
    m.plugin.nativeWrites=t.journal;
    m.plugin.vaultRandomID=t.input.vaultRandomID;
    m.plugin.settings.webdav={address:"https://synthetic.invalid/vault", username:"s00000", password:"synthetic"};
    try {
      m.platform.isIosApp = true;
      await m.run();
      assert.equal(seen.at(-1)?.mobileDailyContentBudget, undefined);
      m.platform.isTablet = true;
      m.plugin.settings.nextclawReloadAfterFirstBSync = true;
      await m.run();
      assert.equal(seen.at(-1)?.mobileDailyContentBudget, undefined);
      assert.equal(seen.at(-1)?.ipadInitialDownload, true);
      m.plugin.settings.nextclawReloadAfterFirstBSync = false;
      await m.run();
      assert.equal(seen.at(-1)?.mobileDailyContentBudget, true);
      m.platform.isIosApp = m.platform.isTablet = false;
      await m.run();
      assert.equal(seen.at(-1)?.mobileDailyContentBudget, undefined);
    } finally { t.stop(); }
  });

  it("rejects daily B files above 50 MiB before GET and charges both stores to 1,000 MiB", async () => {
    const t = await fixture(0);
    delete t.input.androidInitialDownload;
    t.input.mobileDailyContentBudget = true;
    const rt = contentRuntime(t.input);
    const old = bytes("imported");
    const daily = bytes("daily update");
    try {
      await rt.attachments.put("old.html", old, "clean-base");
      await rt.bodies.put("today.md", daily, "clean-base");
      assert.equal(rt.bodies.fileLimit, ATTACHMENT_LIMIT);
      await rt.bodies.ensureCapacity(ATTACHMENT_PROFILE_LIMIT - old.byteLength - daily.byteLength);
      await assert.rejects(rt.bodies.ensureCapacity(ATTACHMENT_PROFILE_LIMIT - old.byteLength - daily.byteLength + 1), /content-limit-pending/);
      t.seed("oversized.pdf", "fixture");
      const row = t.remote.files.get("oversized.pdf")!;
      row.entity.size = row.entity.sizeRaw = ATTACHMENT_LIMIT + 1;
      const result = await runSync(t.input);
      assert.deepEqual(result.pendingContent, [{path:"oversized.pdf", reason:"内容超过安全预算，待处理"}]);
      assert.equal(t.remote.calls.some(c=>c.op==="readFile"), false);
      assert.deepEqual(t.local.writes(), []);
    } finally { t.stop(); }
  });

  it("rechecks the clean first-B vault in one run with four read-only lanes", async () => {
    const t = await fixture(35);
    try {
      assert.ok((await runSync(t.input)).fullyConverged);
      t.local.calls.length = 0;
      t.remote.calls.length = 0;
      const stat = t.remote.stat.bind(t.remote);
      let active = 0, peak = 0, started = 0;
      let releaseFirstBatch!: () => void;
      const firstBatch = new Promise<void>(resolve => { releaseFirstBatch = resolve; });
      t.remote.stat = async path => {
        if (path === "/") return stat(path);
        const position = ++started;
        peak = Math.max(peak, ++active);
        try {
          if (position === 4) releaseFirstBatch();
          if (position <= 4) await firstBatch;
          else await new Promise<void>(resolve => setImmediate(resolve));
          return await stat(path);
        } finally { active--; }
      };
      const recovery = { ...t.input, androidInitialDownload: undefined, androidFirstBRecovery: true as const,
        triggerSource: "auto_sync_on_save" as const };
      assert.ok((await runSync(recovery)).fullyConverged);
      assert.equal(peak,4);
      assert.equal(t.remote.calls.filter(x=>x.op==="stat" && x.key!=="/").length,70);
      assert.equal(t.remote.calls.filter(x=>x.op==="walk").length,1);
      assert.equal(t.remote.calls.filter(x=>x.op==="readFile").length,0);
      assert.deepEqual(t.local.writes(),[]);
      assert.equal(t.remote.puts,0);
      assert.equal(t.reruns(),0);
    } finally { t.stop(); }
  });

  it("falls back to ordinary planning on a version change during the second read-only query", async () => {
    const t = await fixture(4);
    try {
      assert.ok((await runSync(t.input)).fullyConverged);
      const path = t.paths[0], stat = t.remote.stat.bind(t.remote);
      let observations = 0;
      t.remote.stat = async key => {
        if (key === path && ++observations === 2) t.seed(path,"replacement");
        return stat(key);
      };
      assert.ok((await runSync({ ...t.input, androidInitialDownload: undefined, androidFirstBRecovery: true,
        triggerSource: "auto_sync_on_save" })).fullyConverged);
      assert.equal(text(await t.local.readFile(path)),"replacement");
      assert.equal(t.remote.puts,0);
    } finally { t.stop(); }
  });

  it("retains the config and real edit paths, then respects an outstanding native write", async () => {
    const t = await fixture(4);
    const recovery = { ...t.input, androidInitialDownload: undefined, androidFirstBRecovery: true as const,
      triggerSource: "auto_sync_on_save" as const };
    try {
      t.remote.put(".obsidian/app.json",'{"showLineNumber":false}');
      assert.ok((await runSync(t.input)).fullyConverged);
      const path = t.paths[0];
      t.local.put(path, `Remote ${path}`);
      t.remote.put(".obsidian/app.json",'{"showLineNumber":true}');
      assert.ok((await runSync(recovery)).fullyConverged);
      assert.equal(text(await t.local.readFile(".obsidian/app.json")),'{"showLineNumber":true}');
      assert.equal(text(await t.remote.readFile(path)),`Remote ${path}`);
      assert.equal(t.remote.puts,1);

      await assert.rejects(t.journal.send("PUT","https://synthetic.invalid/vault/unknown.md",null,
        async () => { throw Error("reply lost"); }));
      const registration = t.entries.get(t.journal.key);
      assert.ok(registration);
      t.remote.calls.length = 0;
      const result = await runSync(recovery);
      assert.equal(result.contentSummary?.blocked,true);
      assert.deepEqual(t.remote.calls,[]);
      assert.equal(t.entries.get(t.journal.key),registration);
    } finally { t.stop(); }
  });

  it("binds the first-B recovery signal to Android, the same scope and the recovery trigger", async () => {
    const t = await fixture();
    const seen: SyncInput[] = [];
    const m = mainHarness({ ...harness(), local: t.local, remote: t.remote, input: t.input }, async input => {
      seen.push(input);
      return { ok: true, fullyConverged: true, pendingDirectories: [], counts: {}, errors: [] };
    });
    m.plugin.databaseConnections = t.pool;
    m.plugin.nativeWrites = t.journal;
    m.plugin.vaultRandomID = t.input.vaultRandomID;
    m.plugin.settings.webdav = { address: "https://synthetic.invalid/vault", username: "s00000", password: "synthetic" };
    try {
      m.platform.isAndroidApp = true;
      await m.run("auto_sync_on_save", false, "fixture-first-b-scope");
      assert.equal(seen.at(-1)?.androidFirstBRecovery,true);
      await m.run("auto_sync_on_save", false, "different-scope");
      assert.equal(seen.at(-1)?.androidFirstBRecovery,undefined);
      await m.run("manual", false, "fixture-first-b-scope");
      assert.equal(seen.at(-1)?.androidFirstBRecovery,undefined);
      m.platform.isAndroidApp = false;
      await m.run("auto_sync_on_save", false, "fixture-first-b-scope");
      assert.equal(seen.at(-1)?.androidFirstBRecovery,undefined);
    } finally { t.stop(); }
  });
});

describe("Android save sync skips only verified clean remote bodies", () => {
  async function cleanFiles(paths: string[] = ["page.md"]) {
    const t = await environment();
    const stat = t.remote.stat.bind(t.remote);
    t.remote.stat = async key => {
      const entry = await stat(key);
      return key === "/" ? { ...entry, remoteFileId: "root" } : entry;
    };
    for (const path of paths) {
      const body = "x".repeat(path.endsWith(".bin") ? 65 * 1024 : 4);
      t.local.put(path, body); t.remote.put(path, body);
      t.remote.files.get(path)!.entity.remoteFileId = path;
    }
    while (!(await runSync(t.input)).fullyConverged) {
      assert.ok(t.reruns() > 0 && t.reruns() < paths.length);
    }
    const reads: string[] = [];
    const original = t.remote.readContent.bind(t.remote);
    t.remote.readContent = async (key, entity) => { reads.push(key); return original(key, entity); };
    t.remote.calls.length = 0;
    const save: SyncInput = {...t.input, triggerSource: "auto_sync_on_save", androidSaveOnly: true };
    return { ...t, save, reads };
  }

  it("retains the full walk and both version probes while omitting the body and any write", async () => {
    const t = await cleanFiles();
    try {
      assert.ok((await runSync(t.save)).fullyConverged);
      assert.equal(t.remote.calls.filter(x => x.op === "walk").length, 1);
      assert.equal(t.remote.calls.filter(x => x.op === "stat" && x.key === "page.md").length, 2);
      assert.deepEqual(t.reads, []);
      assert.equal(t.remote.puts, 0);
    } finally { t.stop(); }
  });

  for (const [label, mutate] of [
    ["missing ID", (e: Entity) => { delete e.remoteFileId; }],
    ["replacement ID", (e: Entity) => { e.remoteFileId = "replacement"; }],
    ["new strong ETag", (e: Entity) => { e.etag = '"next"'; }],
    ["weak ETag", (e: Entity) => { e.etag = 'W/"E1"'; }],
    ["missing ETag", (e: Entity) => { delete e.etag; }],
  ] as const) {
    it(`runs the existing remote read path for ${label}`, async () => {
      const t = await cleanFiles();
      try {
        mutate(t.remote.files.get("page.md")!.entity);
        await runSync(t.save);
        assert.ok(t.reads.includes("page.md"));
        assert.equal(t.remote.puts, 0);
      } finally { t.stop(); }
    });
  }

  it("keeps guarded upload for a same-size same-mtime local edit", async () => {
    const t = await cleanFiles();
    try {
      t.local.put("page.md", "edit");
      await runSync(t.save);
      assert.ok(t.reads.includes("page.md"));
      assert.equal(t.remote.puts, 1);
      assert.equal(text(await t.remote.readFile("page.md")), "edit");
    } finally { t.stop(); }
  });

  it("rechecks the new body if the second probe sees a replacement", async () => {
    const t = await cleanFiles();
    try {
      const stat = t.remote.stat.bind(t.remote);
      let probes = 0;
      t.remote.stat = async key => {
        if (key === "page.md" && ++probes === 2) {
          t.remote.put(key, "edit");
          t.remote.files.get(key)!.entity.remoteFileId = "replacement";
        }
        return stat(key);
      };
      assert.ok((await runSync(t.save)).fullyConverged);
      assert.ok(t.reads.includes("page.md"));
      assert.equal(text(await t.local.readFile("page.md")), "edit");
      assert.equal(t.remote.puts, 0);
    } finally { t.stop(); }
  });

  it("does a full periodic sweep even when an unfinished save sweep already served a large file", async () => {
    const t = await cleanFiles(["first.bin", "second.bin"]);
    try {
      assert.equal((await runSync(t.save)).fullyConverged, false);
      assert.equal(t.reads.length, 0);
      const file = t.remote.files.get("first.bin")!;
      // Change bytes without changing the entity metadata or validator.
      file.bytes = bytes("z".repeat(file.bytes.byteLength));
      const periodic = { ...t.input, triggerSource: "auto" as const };
      assert.equal((await runSync(periodic)).fullyConverged, false);
      assert.ok(t.reads.includes("first.bin"));
      assert.deepEqual(await t.local.readFile("first.bin"), file.bytes);
      // A newly arriving save cannot downgrade the unfinished periodic sweep.
      assert.ok((await runSync(t.save)).fullyConverged);
      assert.ok(t.reads.includes("second.bin"));
    } finally { t.stop(); }
  });

  it("uses full reads for a generic queued run or a failed remote walk", async () => {
    const t = await cleanFiles();
    try {
      assert.ok((await runSync({ ...t.save, androidSaveOnly: undefined })).fullyConverged);
      assert.ok(t.reads.includes("page.md"));
      t.reads.length = 0;
      t.remote.fail = op => op === "walk";
      assert.equal((await runSync(t.save)).ok, false);
      assert.deepEqual(t.reads, []);
      assert.equal(t.remote.puts, 0);
    } finally { t.stop(); }
  });

  it("threads save provenance through the real plugin entry only for Android save runs", async () => {
    const t = await cleanFiles();
    try {
      const base = harness();
      const m = mainHarness({ ...base, local: t.local, remote: t.remote, input: t.input }, runSync);
      m.plugin.databaseConnections = t.pool;
      m.plugin.nativeWrites = t.journal;
      m.plugin.vaultRandomID = t.input.vaultRandomID;
      m.plugin.settings.webdav = { address: "https://synthetic.invalid/vault", username: "s00000", password: "synthetic" };
      assert.equal(await m.run("auto_sync_on_save", true), "ok");
      assert.equal(t.reads.length, 1);
      m.platform.isAndroidApp = true;
      assert.equal(await m.run("auto_sync_on_save", true), "ok");
      assert.equal(t.reads.length, 1);
      assert.equal(await m.run("auto", true), "ok");
      assert.equal(t.reads.length, 2);
    } finally { t.stop(); }
  });
});

describe("default runSync B content entry / real IndexedDB", () => {
  it("commits safe page before even starting a blocked large read; bounded continuation drains backlog",async()=>{
    const t=await environment();try{
      for(let i=0;i<3;i++) t.remote.put(`a${i}.bin`,"x".repeat(70*1024));
      t.local.put("z-safe.md","safe");let release!:()=>void,entered!:()=>void;
      const gate=new Promise<void>(r=>release=r),start=new Promise<void>(r=>entered=r);
      const read=t.remote.readContent.bind(t.remote);let first=true;
      t.remote.readContent=async(k,e)=>{if(k==="a0.bin"&&first){first=false;entered();await gate;}return read(k,e);};
      const run=runSync(t.input);await start;
      assert.equal(text(await t.remote.readFile("z-safe.md")),"safe");
      release();const r=await run;assert.equal(r.fullyConverged,false);assert.equal(r.errors.length,0);
      assert.ok(t.reruns()>0);assert.equal(t.local.files.has("a1.bin"),false);
      t.remote.put("a1.bin","new bytes after batch");
      // New runtime object over the same persistent DB models loss of scheduling memory.
      const input={...t.input,contentRuntime:{...t.input.contentRuntime!}};
      let drained=false;for(let i=0;i<5;i++){const r=await runSync(input);assert.equal(r.errors.length,0);if(r.fullyConverged){drained=true;break;}}
      assert.equal(text(await t.local.readFile("a1.bin")),"new bytes after batch");
      assert.ok(t.local.files.has("a2.bin"));assert.equal(drained,true);
    }finally{t.stop();}
  });
  it("enabled modification protection still rejects the complete plan before any safe write",async()=>{
    const t=await environment();try{
      t.input.protectModifyPercentage=50;t.local.put("x.md","local");t.remote.put("x.md","remote");
      t.local.put("z.md","safe");const r=await runSync(t.input);
      assert.equal(r.ok,false);assert.equal(t.remote.puts,0);assert.equal(t.remote.files.has("z.md"),false);
    }finally{t.stop();}
  });
  it("full working-set budget rejection occurs before replacing local bytes or creating an operation",async()=>{
    const t=await environment();try{
      const rt=contentRuntime(t.input); // Pinned foreign-path objects simulate real retained conflict inputs.
      for(let i=0;i<10;i++)await rt.bodies.put(`pin${i}`,bytes("x".repeat(3*1024*1024)),"merge-input");
      // Do not GC these synthetic pins away: test the real executor capacity boundary directly.
      t.remote.put("large.bin","y".repeat(1024*1024));
      const {planContent}=await import("../../src/nextclaw/content/decision");
      const entity=await t.remote.stat("large.bin"), f=rt.file("large.bin",undefined,entity);
      const remote=await f.io.readRemote();const p=await planContent({scope:rt.scope,path:"large.bin",store:rt.bodies,
        mode:"B",configDir:".obsidian",ownerActive:()=>true,unknownWrite:false,remote:remote as any});
      const before=(await t.db.fileContentHistoryTbl.keys()).length;
      const out=await f.executor.execute(p);assert.equal(out.status,"pending");assert.equal(out.reason,"content-limit-pending");
      assert.equal(t.local.files.has("large.bin"),false);assert.equal(t.remote.puts,0);
      assert.equal((await rt.operations.list(rt.scope)).length,0);
      assert.equal((await t.db.fileContentHistoryTbl.keys()).length,before);
    }finally{t.stop();}
  });
  it("carries a prior batch pending result until rechecked, never reports all converged at sweep end",async()=>{
    const t=await environment();try{
      t.remote.put("a.bin","x".repeat(4*1024*1024+1));t.remote.put("b.bin","y".repeat(70*1024));
      const first=await runSync(t.input);assert.equal(first.fullyConverged,false);
      const final=await runSync({...t.input,contentRuntime:{...t.input.contentRuntime!}});
      assert.equal(final.fullyConverged,false);assert.ok(final.pendingContent!.some(x=>x.path==="a.bin"));
      assert.equal(final.errors.length,0);assert.ok(t.local.files.has("b.bin"));
    }finally{t.stop();}
  });
  it("retirement between batch items prevents any later read or write, reload rediscovers actual bytes",async()=>{
    const t=await environment();try{
      t.local.put("small.md","small");t.remote.put("big.bin","x".repeat(70*1024));
      let active=true,reads=0;const normal=t.input.contentRuntime!.assertActive;
      t.input.contentRuntime!.assertActive=()=>{normal();if(!active)throw Error("retired");};
      const read=t.remote.readContent.bind(t.remote);t.remote.readContent=async(k,e)=>{if(k==="big.bin")reads++;return read(k,e);};
      t.remote.afterPut=()=>{active=false;};
      assert.equal((await runSync(t.input)).fullyConverged,false);assert.equal(reads,0);
      active=true;t.remote.afterPut=()=>{};
      // The dispatched operation lacks a durable receipt after retirement: must not resume writes.
      const resumed=await runSync(t.input);assert.equal(resumed.contentSummary!.blocked,true);assert.equal(reads,0);
    }finally{t.stop();}
  });
  it("F1 small tail and same-metadata later edits are revisited before a large sweep ends",async()=>{
    const t=await environment();try{
      for(let i=0;i<4;i++)t.remote.put(`a${i}.bin`,"b".repeat(70*1024));
      t.local.put("z-tail.md","first");
      t.remote.afterPut=()=>{t.local.put("z-tail.md","last!");};
      await runSync(t.input);assert.equal((await t.rec("z-tail.md"))!.pendingLocalUpload,true);
      t.remote.afterPut=()=>{};await runSync(t.input);
      assert.equal(text(await t.remote.readFile("z-tail.md")),"last!");assert.equal(t.local.files.has("a3.bin"),false);
      // Same metadata, same length, new bytes; scheduling must not use signatures as a skip.
      t.local.put("z-tail.md","again");await runSync(t.input);
      assert.equal(text(await t.remote.readFile("z-tail.md")),"again");
      assert.equal([...t.local.files.keys()].filter(k=>k.includes("conflict")).length,0);
    }finally{t.stop();}
  });
  it("creates both directions then hashes unchanged files without new PUTs or body/operation growth", async () => {
    const t=await environment(); try {
      t.local.put("local.md","local\n"); t.remote.put("remote.md","remote\n");
      const first=await runSync(t.input); assert.equal(first.fullyConverged,true, first.errors.map(e=>e.message).join());
      assert.equal(text(await t.remote.readFile("local.md")),"local\n"); assert.equal(text(await t.local.readFile("remote.md")),"remote\n");
      const count=(await t.db.fileContentHistoryTbl.keys()).length, puts=t.remote.puts;
      assert.equal((await runSync(t.input)).fullyConverged,true); assert.equal(t.remote.puts,puts);
      assert.equal((await t.db.fileContentHistoryTbl.keys()).length,count);
    } finally {t.stop();}
  });
  it("legacy same-size/same-mtime differences become actual registered markers; pending is visible, no mtime winner",async()=>{
    const t=await environment();try {
      t.local.put("n.md","cat\n",1000);t.remote.put("n.md","dog\n",1000);await t.seed("n.md");
      const r=await runSync(t.input);assert.equal(r.ok,true,r.errors.map(e=>e.message).join());assert.equal(r.fullyConverged,false);assert.equal(r.contentSummary!.conflicts,1);
      assert.equal((await t.rec("n.md"))!.content!.status,"content-conflict");assert.ok(text(await t.local.readFile("n.md")).includes("<<<<<<< Obsidian"));
      assert.equal(text(await t.local.readFile("n.md")),text(await t.remote.readFile("n.md")));
      const puts=t.remote.puts;const second=await runSync(t.input);assert.equal(second.fullyConverged,false);assert.equal(t.remote.puts,puts);
      t.local.put("n.md","学习计划\n=======\n正文\n");assert.equal((await runSync(t.input)).fullyConverged,true);
      assert.equal(text(await t.remote.readFile("n.md")),"学习计划\n=======\n正文\n");
    }finally{t.stop();}
  });
  it("merges genuine disjoint edits, keeps common base and bounds retired body AND stage metadata across many edits",async()=>{
    const t=await environment();try {
      t.local.put("n.md","a\nb\nc\n");t.remote.put("n.md","a\nb\nc\n");assert.equal((await runSync(t.input)).fullyConverged,true);
      t.local.put("n.md","A\nb\nc\n");t.remote.put("n.md","a\nb\nC\n");assert.equal((await runSync(t.input)).fullyConverged,true);
      assert.equal(text(await t.local.readFile("n.md")),"A\nb\nC\n");
      for(let i=0;i<12;i++){t.local.put("n.md",`version${i}\n`);const r=await runSync(t.input);assert.equal(r.fullyConverged,true,r.errors.map(e=>e.message).join());}
      const keys=(await t.db.fileContentHistoryTbl.keys()).filter(k=>{try{return JSON.parse(k)[2]===contentRuntime(t.input).scope;}catch{return false;}});assert.equal(keys.filter(k=>JSON.parse(k)[0]==="nextclaw-content").length,1);
      assert.equal(keys.filter(k=>JSON.parse(k)[0]==="nextclaw-content-operation").length,1);
    }finally{t.stop();}
  });
  it("GC never retires a newer rejected attempt using an older clean commit as proof",async()=>{
    const t=await environment();try{
      t.local.put("n.md","base");t.remote.put("n.md","base");await runSync(t.input);t.local.put("n.md","attempted");
      t.remote.beforePut=async()=>{t.remote.put("n.md","competitor");};await runSync(t.input);
      const rt=contentRuntime(t.input), rejected=(await rt.operations.list(rt.scope)).find(o=>o.phase==="rejected")!;
      assert.ok(rejected);assert.equal(text((await rt.bodies.read(rejected.localRef!,"n.md")).bytes),"attempted");
      await rt.collect();assert.equal((await rt.operations.get(rejected.id))!.phase,"rejected");
      t.remote.beforePut=async()=>{};await runSync(t.input);t.local.put("n.md","resolved");
      assert.equal((await runSync(t.input)).fullyConverged,true);
      assert.equal((await rt.operations.list(rt.scope)).length,1);
    }finally{t.stop();}
  });
  it("GC preserves foreign scopes and fails before deleting any body when an active base is corrupt",async()=>{
    const t=await environment();try{
      t.local.put("n.md","base");t.remote.put("n.md","base");await runSync(t.input);const rt=contentRuntime(t.input);
      const foreign=new ContentStore(t.db.fileContentHistoryTbl,"foreign-scope",t.guard);const ref=await foreign.put("n.md",bytes("foreign"),"clean-base");
      const orphan=await rt.bodies.put("n.md",bytes("orphan"),"merge-input");await rt.collect();
      assert.equal(await t.db.fileContentHistoryTbl.getItem(orphan),null);assert.ok(await t.db.fileContentHistoryTbl.getItem(ref));
      const orphan2=await rt.bodies.put("n.md",bytes("orphan2"),"merge-input");const record=(await t.rec("n.md"))!;
      await t.db.fileContentHistoryTbl.removeItem(record.content!.cleanBaseRef!);await assert.rejects(rt.collect());
      assert.ok(await t.db.fileContentHistoryTbl.getItem(orphan2));
    }finally{t.stop();}
  });
  it("over 10 attachment conflicts and pending deletions never exhaust fatal budget or stop a safe page",async()=>{
    const t=await environment();try{
      for(let i=0;i<12;i++){t.local.put(`a${i}.bin`,"L");t.remote.put(`a${i}.bin`,"R");}
      t.local.put("new.md","page");const r=await runSync(t.input);assert.equal(r.errors.length,0);assert.equal(r.contentSummary!.pending,12);
      assert.equal(text(await t.remote.readFile("new.md")),"page");
      t.remote.files.delete("new.md");const next=await runSync(t.input);assert.equal(next.fullyConverged,false);assert.ok(t.local.files.has("new.md"));
    }finally{t.stop();}
  });
  it("F1: explicit own upload plus tail edit persists pending and reruns final bytes, no extra conflict file",async()=>{
    const t=await environment();try{
      t.local.put("n.md","base");t.remote.put("n.md","base");await runSync(t.input);t.local.put("n.md","first");
      t.remote.afterPut=()=>t.local.put("n.md","last");const r=await runSync(t.input);assert.equal(r.fullyConverged,false);
      assert.equal((await t.rec("n.md"))!.pendingLocalUpload,true);assert.equal(t.reruns(),1);t.remote.afterPut=()=>{};
      assert.equal((await runSync(t.input)).fullyConverged,true);assert.equal(text(await t.remote.readFile("n.md")),"last");
      assert.deepEqual([...t.local.files.keys()],["n.md"]);
    }finally{t.stop();}
  });
  it("unknown PUT blocks all later content/config/mkdir, reads/reload do not clear journal or GC pins",async()=>{
    const t=await environment();try{
      t.local.put("a.md","x");t.local.put("z.md","z");t.remote.status=504;
      const r=await runSync(t.input);assert.equal(r.contentSummary!.blocked,true);assert.equal(t.remote.puts,1);const raw=[...t.entries];
      const before=(await t.db.fileContentHistoryTbl.keys()).sort();await t.remote.readFile("a.md");
      const again=await runSync(t.input);assert.equal(again.contentSummary!.blocked,true);assert.deepEqual([...t.entries],raw);
      assert.deepEqual((await t.db.fileContentHistoryTbl.keys()).sort(),before);
    }finally{t.stop();}
  });
  it("a missing durable ack pauses A and B even with an empty native journal; no read-success unlock",async()=>{
    const t=await environment();try{
      t.local.put("n.md","x");const rt=contentRuntime(t.input);const original=rt.operations.put.bind(rt.operations);
      // Persist the real inputs/dispatched intent, then retire before the ack can be stored.
      const put=t.remote.putContent.bind(t.remote);t.remote.putContent=async(...a)=>{const receipt=await put(...a);t.input.contentRuntime!.assertActive=()=>{throw Error("load retired");};return receipt;};
      await runSync(t.input);t.input.contentRuntime!.assertActive=t.guard;assert.equal(t.journal.blocked(),false);
      assert.ok((await rt.operations.list(rt.scope)).some(o=>o.phase==="remote-dispatched"));
      const r=await runSync(t.input);assert.equal(r.contentSummary!.blocked,true);
      t.input.mode="A";assert.equal((await runSync(t.input)).contentSummary!.blocked,true);assert.equal(t.remote.puts,1);
      await assert.rejects(assertContentResetSafe(t.db,t.input.vaultRandomID,t.guard));void original;
    }finally{t.stop();}
  });
  it("A remains pull only; B config and installed student plugins keep legacy merge protection",async()=>{
    const t=await environment();try{
      t.input.mode="A";t.local.put("local.md","mine");t.remote.put("server.md","cloud");
      assert.equal((await runSync(t.input)).ok,true);assert.equal(t.remote.files.has("local.md"),false);assert.equal(text(await t.local.readFile("server.md")),"cloud");
      t.input.mode="B";t.local.put(".obsidian/settings.json","local");t.remote.put(".obsidian/settings.json","remote");
      t.local.put(".obsidian/community-plugins.json",'["student"]');t.local.put(".obsidian/plugins/student/manifest.json",'{}');
      t.remote.put(".obsidian/community-plugins.json",'[]');const r=await runSync(t.input);assert.equal(r.errors.length,0,r.errors.map(e=>e.message).join());
      assert.equal(text(await t.local.readFile(".obsidian/settings.json")),"remote");
      assert.ok(JSON.parse(text(await t.local.readFile(".obsidian/community-plugins.json"))).includes("student"));
      assert.ok(t.local.files.has(".obsidian/plugins/student/manifest.json"));
    }finally{t.stop();}
  });
  it("dry-run never seeds a base or performs GC, and missing content adapter fails closed",async()=>{
    const t=await environment();try{
      t.local.put("n.md","local");t.remote.put("n.md","remote");t.input.triggerSource="dry";
      await runSync(t.input);assert.equal(t.remote.puts,0);assert.equal((await t.db.fileContentHistoryTbl.keys()).filter(k=>{try{return JSON.parse(k)[2]===contentRuntime(t.input).scope;}catch{return false;}}).length,0);
      t.input.triggerSource="manual";delete t.input.contentRuntime;const r=await runSync(t.input);assert.equal(r.ok,false);assert.equal(t.remote.puts,0);
    }finally{t.stop();}
  });
  it("oversized content is visible pending before any download and does not block another page", async()=>{
    const t=await environment();try{
      t.remote.put("large.bin","x");t.remote.files.get("large.bin")!.entity.size=4*1024*1024+1;t.remote.files.get("large.bin")!.entity.sizeRaw=4*1024*1024+1;
      t.local.put("small.md","safe");const read=t.remote.readContent.bind(t.remote);let largeReads=0;
      t.remote.readContent=async(k,e)=>{if(k==="large.bin")largeReads++;return read(k,e);};
      const r=await runSync(t.input);assert.equal(r.ok,true);assert.equal(r.fullyConverged,false);assert.equal(r.pendingContent!.length,1);
      assert.equal(largeReads,0);assert.equal(text(await t.remote.readFile("small.md")),"safe");
    }finally{t.stop();}
  });
  it("read races remain pending rather than exhausting the fatal error budget", async()=>{
    const t=await environment();try{
      for(let i=0;i<12;i++)t.remote.put(`race${i}.md`,"r");t.local.put("safe.md","s");
      const read=t.remote.readContent.bind(t.remote);t.remote.readContent=async(k,e)=>{if(k.startsWith("race"))throw new SyncConflict();return read(k,e);};
      const r=await runSync(t.input);assert.equal(r.errors.length,0);assert.equal(r.pendingContent!.length,12);assert.equal(r.fullyConverged,false);
      assert.equal(text(await t.remote.readFile("safe.md")),"s");
    }finally{t.stop();}
  });
  it("actual main.syncRun method calls the new default entry and persists pending/clear summaries",async()=>{
    const t=await environment();try{
      t.local.put("n.md","student");t.remote.put("n.md","agent");
      const base=harness();const m=mainHarness({...base,local:t.local,remote:t.remote,input:t.input},runSync);
      m.plugin.databaseConnections=t.pool;m.plugin.nativeWrites=t.journal;m.plugin.vaultRandomID=t.input.vaultRandomID;
      m.plugin.settings.nextclawReloadAfterFirstBSync=true;
      m.plugin.settings.webdav={address:"https://cloud.nextclaw.chat/remote.php/dav/files/s00000",username:"s00000",password:"synthetic-only-not-a-credential"};
      assert.equal(await m.run(),"ok");assert.equal(m.executed.length,0);assert.equal(m.plugin.pendingContent.pending,1);assert.equal(m.plugin.pendingContent.conflicts,1);
      assert.equal((await t.db.simpleKVForMiscTbl.getItem<any>(`content-summary:${t.input.vaultRandomID}`)).pending,1);
      t.local.put("n.md","resolved\n");assert.equal(await m.run("auto"),"ok");assert.equal(m.executed.length,1);assert.equal(m.plugin.pendingContent.pending,0);
      assert.equal((await t.db.simpleKVForMiscTbl.getItem<any>(`content-summary:${t.input.vaultRandomID}`)).pending,0);
    }finally{t.stop();}
  });
  it("ordinary read-offline failure recovers on next queue/auto run without any unknown write",async()=>{
    const t=await environment();try{
      t.local.put("n.md","new");t.remote.fail=op=>op==="walk";assert.equal((await runSync(t.input)).ok,false);assert.equal(t.entries.size,0);
      t.remote.fail=()=>false;assert.equal((await runSync(t.input)).fullyConverged,true);assert.equal(text(await t.remote.readFile("n.md")),"new");
    }finally{t.stop();}
  });
  it("overlapping full-entry runs never dispatch in parallel, and an acknowledged tail still requests the existing rerun",async()=>{
    const t=await environment();try{
      t.local.put("n.md","base");t.remote.put("n.md","base");await runSync(t.input);t.local.put("n.md","first");
      let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r), gate=new Promise<void>(r=>release=r);
      t.remote.beforePut=async()=>{entered();await gate;};
      const one=runSync(t.input);await started;
      const two=await runSync({...t.input,triggerSource:"auto"});assert.equal(two.fullyConverged,false);assert.equal(t.remote.puts,1);
      t.local.put("n.md","last");release();assert.equal((await one).fullyConverged,false);assert.ok(t.reruns());
      t.remote.beforePut=async()=>{};assert.equal((await runSync(t.input)).fullyConverged,true);
      assert.equal(text(await t.remote.readFile("n.md")),"last");assert.equal(t.local.files.size,1);
    }finally{t.stop();}
  });
  it("retirement during actual dispatch cannot commit, replace local bytes or issue a later write; reload remains paused",async()=>{
    const t=await environment();try{
      t.local.put("n.md","base");t.remote.put("n.md","base");await runSync(t.input);t.local.put("n.md","send");
      let active=true;const normal=t.input.contentRuntime!.assertActive;
      t.input.contentRuntime!.assertActive=()=>{normal();if(!active)throw Error("retired");};
      t.remote.afterPut=()=>{active=false;t.local.put("n.md","edited after unload");};
      const result=await runSync(t.input);assert.equal(result.fullyConverged,false);assert.equal(text(await t.local.readFile("n.md")),"edited after unload");
      assert.equal(t.remote.puts,1);active=true;t.remote.afterPut=()=>{};
      assert.equal((await runSync(t.input)).contentSummary!.blocked,true);assert.equal(t.remote.puts,1);
    }finally{t.stop();}
  });
  it("an explicitly configured modification ceiling still stops the new content decision before PUT",async()=>{
    const t=await environment();try{
      t.local.put("n.md","base");t.remote.put("n.md","base");await runSync(t.input);t.local.put("n.md","edit");
      const r=await runSync({...t.input,protectModifyPercentage:50});assert.equal(r.ok,false);assert.equal(t.remote.puts,0);
      assert.equal(text(await t.remote.readFile("n.md")),"base");
    }finally{t.stop();}
  });

  it("path collisions stay real failures in the complete default entry, never hidden as convergence",async()=>{
    const t=await environment();try{
      t.local.put("NOTE.md","first");t.local.put("note.md","second");
      const r=await runSync(t.input);assert.equal(r.ok,false);assert.equal(r.fullyConverged,false);assert.ok(r.errors.length>=2);assert.equal(t.remote.puts,0);
    }finally{t.stop();}
  });

});
