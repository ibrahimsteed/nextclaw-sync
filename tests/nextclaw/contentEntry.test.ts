import "fake-indexeddb/auto";
import { strict as assert } from "assert";
import { prepareDBs, type NextclawSyncRecord } from "../../src/localdb";
import { IdbConnectionPool } from "../../src/idbStore";
import { NativeWriteJournal } from "../../src/nextclaw/nativeWriteJournal";
import { runSync } from "../../src/nextclaw/syncEngine";
import { ContentStore } from "../../src/nextclaw/content/store";
import { contentRuntime, assertContentResetSafe, checkVaultStages } from "../../src/nextclaw/content/runtime";
import { mainHarness } from "./engine/mainHarness";
import { harness } from "./engine/helpers";
import { MemoryFs, bytes, text } from "./engine/helpers";
import { SyncConflict, etagHeader } from "../../src/nextclaw/engine/versionGuard";
import type { Entity } from "../../src/baseTypes";
import type { SyncInput } from "../../src/nextclaw/syncEngine";
class Local extends MemoryFs {
  current = () => {};
  override async writeFileGuarded(k: string, b: ArrayBuffer, m: number, c: number, e: Entity | null, before?: ArrayBuffer, current = () => {}) {
    current(); this.current(); return super.writeFileGuarded(k, b, m, c, e, before);
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
