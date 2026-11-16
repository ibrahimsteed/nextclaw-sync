import { strict as assert } from "assert";
import { harness, record, text } from "./helpers";
import { runLegacySync as runSync } from "../../../src/nextclaw/engine/legacy";
import { SyncConflict } from "../../../src/nextclaw/engine/versionGuard";
import { SyncQueue } from "../../../src/nextclaw/syncQueue";
const copies = (h: ReturnType<typeof harness>) => [...h.local.files].filter(([k]) => k.includes(".sync-conflict-"));

describe("F1: only durable acknowledged own uploads suppress a duplicate copy", () => {
  it("retains the real remote loser, not our acknowledged intermediate version", async () => {
    const h = harness(); h.local.put("note.md", "first", 40000); h.remote.put("note.md", "other", 30000); h.seed(record());
    const write = h.remote.writeFileGuarded.bind(h.remote);
    h.remote.writeFileGuarded = async (...args) => { const result = await write(...args); h.remote.writeFileGuarded = write; h.local.put("note.md", "later", 41000); return result; };
    assert.equal((await runSync(h.input)).ok, false);
    assert.equal(h.rec("note.md")?.pendingLocalUpload, true);
    assert.deepEqual(copies(h).map(([,v]) => text(v.bytes)), ["other"]);
    assert.equal((await runSync(h.input)).ok, true);
    assert.equal(text(await h.remote.readFile("note.md")), "later");
    assert.deepEqual(copies(h).map(([,v]) => text(v.bytes)), ["other"]);
  });
  it("does not suppress preservation if persisting the acknowledged pending record fails", async () => {
    const h = harness(); h.local.put("note.md", "first", 30000); h.remote.put("note.md"); h.seed(record());
    const before = structuredClone(h.records), write = h.remote.writeFileGuarded.bind(h.remote);
    h.remote.writeFileGuarded = async (...args) => { const result = await write(...args); h.local.put("note.md", "later", 31000); return result; };
    h.input.db.prevSyncRecordsTbl.setItem = async () => { throw new SyncConflict("pending record unavailable"); };
    assert.equal((await runSync(h.input)).ok, false);
    assert.deepEqual(h.records, before);
    assert.ok(copies(h).some(([,v]) => text(v.bytes) === "first"));
    assert.equal(text(await h.local.readFile("note.md")), "later");
  });
  it("keeps a competing remote write and attempted local version protected", async () => {
    const h = harness(); h.local.put("note.md", "first", 30000); h.remote.put("note.md"); h.seed(record()); const before = structuredClone(h.records);
    h.remote.writeFileGuarded = async () => { h.remote.put("note.md", "competitor", 50000); h.local.put("note.md", "later", 31000); throw Object.assign(new Error("precondition failed"), {status: 412}); };
    assert.equal((await runSync(h.input)).ok, false); assert.deepEqual(h.records, before);
    assert.ok(copies(h).some(([,v]) => text(v.bytes) === "first"));
    assert.equal(text(await h.remote.readFile("note.md")), "competitor"); assert.equal(text(await h.local.readFile("note.md")), "later");
  });
  for (const status of [202, 504]) {
    it(`does not acknowledge an unknown upload result (HTTP ${status})`, async () => {
      const h = harness(); h.local.put("note.md", "first", 30000);
      h.remote.writeFileGuarded = async () => {
        h.remote.put("note.md", "first", 30000);
        h.local.put("note.md", "later", 31000);
        throw Object.assign(new Error("unknown write result"), {status});
      };
      assert.equal((await runSync(h.input)).ok, false);
      assert.equal(h.rec("note.md"), undefined);
      assert.equal(text(await h.local.readFile("note.md")), "later");
    });
  }
  it("coalesces overlapping triggers while the real engine retries the final edit without concurrent runs", async () => {
    const h = harness(); h.local.put("note.md","first",30000);
    let entered!:()=>void, release!:()=>void; const admitted = new Promise<void>(r=>{entered=r;}), gate = new Promise<void>(r=>{release=r;});
    const write = h.remote.writeFileGuarded.bind(h.remote);
    h.remote.writeFileGuarded = async (...args) => {entered();await gate;h.remote.writeFileGuarded=write;return await write(...args);};
    let id=0,active=0,peak=0; const timers = new Map<number,()=>void>();
    const clock={setTimeout(fn:()=>void){timers.set(++id,fn);return id as any;},clearTimeout(n:any){timers.delete(n);}};
    const runs:Array<Promise<"ok"|"failed">>=[];
    const queue = new SyncQueue(()=>{
      if(active)return Promise.resolve("blocked");
      const task=(async()=>{peak=Math.max(peak,++active);const result=await runSync(h.input);active--;const outcome=result.ok?"ok":"failed";queue.finished(outcome);return outcome;})();runs.push(task);return task;
    },clock);
    const fire=()=>{const entry=[...timers][0];assert.ok(entry);timers.delete(entry[0]);entry[1]();};
    queue.request();fire();await admitted;h.local.put("note.md","later",30000);
    queue.request();queue.request();fire();await Promise.resolve();await Promise.resolve();assert.equal(runs.length,1);
    release();assert.equal(await runs[0],"failed");assert.equal(h.rec("note.md")?.pendingLocalUpload,true);assert.equal(copies(h).length,0);
    fire();assert.equal(await runs[1],"ok");assert.equal(text(await h.remote.readFile("note.md")),"later");assert.equal(h.rec("note.md")?.pendingLocalUpload,undefined);
    assert.equal(copies(h).length,0);assert.equal(runs.length,2);assert.equal(peak,1);assert.equal(timers.size,0);queue.dispose();
  });
});
