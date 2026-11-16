import { strict as assert } from "assert";
import { NativeWriteJournal, NativeWritePaused, dispatchNative, terminalReceipt } from "../../src/nextclaw/nativeWriteJournal";
import { mutationPending } from "../../src/nextclaw/writeQuarantine";
import { SyncQueue } from "../../src/nextclaw/syncQueue";
import { runLegacySync as runSync } from "../../src/nextclaw/engine/legacy";
import { harness } from "./engine/helpers";
function setup() {
  const entries = new Map<string, string>();
  const storage = { getItem: (k: string) => entries.get(k) ?? null,
    setItem: (k: string, v: string) => { entries.set(k, v); }, removeItem: (k: string) => { entries.delete(k); } };
  return { entries, storage, owner: new NativeWriteJournal(storage, "vault") };
}
const url = "https://synthetic.invalid/vault/page.md?not-stored=secret";
function deferred<T>() { let resolve!: (x: T) => void; let reject!: (x: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
describe("native pre-dispatch persistent write isolation", () => {
  for (const method of ["PUT", "DELETE", "MKCOL", "MOVE", "COPY", "PATCH"]) {
    it(`${method}: is durable before dispatch; clears only explicit terminal receipt`, async () => {
      const t = setup(); const d = deferred<{status:number}>();
      const p = dispatchNative(t.owner.token, method, url, '"v1"', () => {
        assert.equal(mutationPending(t.storage, "vault"), true);
        const raw = t.storage.getItem("vault")!; assert.ok(!raw.includes("secret"));
        assert.equal(JSON.parse(raw).operations[0].method, method); return d.promise;
      });
      assert.equal(t.owner.blocked(), false, "own live registrations permit coalesced intent");
      assert.equal(new NativeWriteJournal(t.storage,"vault").blocked(), true, "a new load cannot adopt registrations");
      d.resolve({status:method === "MKCOL" ? 201 : 204}); await p;
      assert.equal(mutationPending(t.storage,"vault"),false); t.owner.retire();
    });
  }
  for (const status of [202, 207, 301, 408, 429, 500, 502, 503, 504]) {
    it(`${status} is unknown: read, wait, reload and new owner cannot release it`, async () => {
      const t=setup(); let sends=0;
      await assert.rejects(t.owner.send("PUT",url,null,async()=>{sends++;return {status};}), NativeWritePaused);
      const raw=t.storage.getItem("vault"); assert.ok(raw); assert.equal(t.owner.blocked(),true);
      await assert.rejects(dispatchNative(t.owner.token,"GET",url,null,async()=>({status:200})),NativeWritePaused);
      await Promise.resolve(); t.owner.retire(); const reloaded=new NativeWriteJournal(t.storage,"vault");
      await assert.rejects(reloaded.send("PUT",url,null,async()=>{sends++;return {status:201};}),NativeWritePaused);
      assert.equal(t.storage.getItem("vault"),raw); assert.equal(sends,1); reloaded.retire();
    });
  }
  for(const status of [400,401,403,404,405,412,413,415,423]) it(`explicit rejection ${status} preserves normal classification`,async()=>{
    const t=setup(); assert.equal((await t.owner.send("PUT",url,null,async()=>({status}))).status,status);
    assert.equal(t.owner.blocked(),false); assert.equal(mutationPending(t.storage,"vault"),false); t.owner.retire();
  });
  it("a network rejection after dispatch keeps the write and prevents every further mutation",async()=>{
    const t=setup(); await assert.rejects(t.owner.send("PUT",url,null,async()=>{throw Error("connection lost");}),NativeWritePaused);
    let sends=0; await assert.rejects(t.owner.send("DELETE",url,null,async()=>{sends++;return {status:204};}),NativeWritePaused);
    assert.equal(sends,0);t.owner.retire();
  });
  it("concurrent successful completion clears only itself, never its unknown peer",async()=>{
    const t=setup();const a=deferred<{status:number}>(),b=deferred<{status:number}>();
    const first=t.owner.send("PUT",url,null,()=>a.promise); const second=t.owner.send("PUT",url+"2",null,()=>b.promise);
    a.resolve({status:504}); await assert.rejects(first,NativeWritePaused);b.resolve({status:201});await second;
    const ops=JSON.parse(t.storage.getItem("vault")!).operations;assert.equal(ops.length,1);assert.equal(ops[0].path,"/vault/page.md");assert.equal(t.owner.blocked(),true);t.owner.retire();
  });
  it("a true late final receipt may settle its own registration after unload; new owner never dispatches first",async()=>{
    const t=setup();const d=deferred<{status:number}>();const p=t.owner.send("PUT",url,null,()=>d.promise);t.owner.retire();
    const next=new NativeWriteJournal(t.storage,"vault");assert.equal(next.blocked(),true);d.resolve({status:201});await p;
    assert.equal(next.blocked(),false);await assert.rejects(dispatchNative(t.owner.token,"PUT",url,null,async()=>({status:201})),NativeWritePaused);next.retire();
  });
  for(const phase of ["write","readback","remove"]) it(`storage ${phase} failure is fail closed`,async()=>{
    const t=setup();let sends=0;
    if(phase==="write")t.storage.setItem=()=>{throw Error("full");};
    if(phase==="readback") {const real=t.storage.setItem;t.storage.setItem=(k,v)=>{real(k,v);t.storage.getItem=()=>{throw Error("readback");};};}
    if(phase==="remove")t.storage.removeItem=()=>{throw Error("remove");};
    await assert.rejects(t.owner.send("PUT",url,null,async()=>{sends++;return {status:201};}),NativeWritePaused);
    assert.equal(sends,phase==="remove"?1:0);assert.equal(t.owner.blocked(),true);t.owner.retire();
  });
  it("legacy, malformed and recovery records are never overwritten",async()=>{
    for(const key of ["vault","vault:recovery"]) {const t=setup();t.entries.set(key,"legacy");let sends=0;
      await assert.rejects(t.owner.send("PUT",url,null,async()=>{sends++;return {status:201};}),NativeWritePaused);
      assert.equal(sends,0);assert.equal(t.entries.get(key),"legacy");t.owner.retire();}
  });
  it("unowned mutations fail closed but pre-write read failures remain ordinary offline failures",async()=>{
    let sends=0;await assert.rejects(dispatchNative(undefined,"PUT",url,null,async()=>{sends++;return {status:201};}),NativeWritePaused);assert.equal(sends,0);
    const t=setup();await assert.rejects(dispatchNative(t.owner.token,"GET",url,null,async()=>{throw Error("offline read");}),/offline read/);
    assert.equal(t.owner.blocked(),false);assert.equal(t.entries.size,0);t.owner.retire();
  });
  it("engine stops subsequent files and does not make spurious conflict copies for unknown writes",async()=>{
    const t=setup(),h=harness();h.input.concurrency=1;h.local.put("a.md","first");h.local.put("b.md","second");let sends=0;
    h.remote.writeFileGuarded=async()=>{await t.owner.send("PUT",url,null,async()=>{sends++;return {status:504};});throw Error("unreachable");};
    const r=await runSync(h.input);assert.equal(r.ok,false);assert.equal(sends,1);
    assert.equal([...h.local.files.keys()].filter(k=>k.includes("sync-conflict")).length,0);assert.equal(h.rec("a.md"),undefined);assert.equal(h.rec("b.md"),undefined);t.owner.retire();
  });
  it("quarantine disposal cancels an already queued tail trigger and failures cannot revive it",()=>{
    let scheduled=0;const timers=new Map<number,()=>void>();const q=new SyncQueue(async()=>{throw Error("must not dispatch");},{setTimeout(fn){timers.set(++scheduled,fn);return scheduled as any;},clearTimeout(id){timers.delete(id as any);}});
    q.request(3000);q.dispose();q.finished("failed");q.request();assert.equal(timers.size,0);
  });
  it("PUT 201 is terminal independently of ETag/stat, while 202 is never terminal",()=>{
    assert.equal(terminalReceipt("PUT",201),true);assert.equal(terminalReceipt("PUT",202),false);
  });
});


describe("native receipt is bound to the complete recorded operation", () => {
  for (const field of ["path", "method", "expected", "at", "extra"]) {
    it(`refuses a changed ${field} even when the stored id is unchanged`, async () => {
      const t=setup(),d=deferred<{status:number}>();const pending=t.owner.send("PUT",url,'"v1"',()=>d.promise);
      const stored=JSON.parse(t.storage.getItem("vault")!);stored.operations[0][field]=field==="at"?0:"altered";
      const changed=JSON.stringify(stored);t.entries.set("vault",changed);
      assert.equal(t.owner.blocked(),true);
      d.resolve({status:201});await assert.rejects(pending,NativeWritePaused);
      assert.equal(t.entries.get("vault"),changed);t.owner.retire();
    });
  }
});
