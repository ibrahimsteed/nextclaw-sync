import { strict as assert } from "assert";
import { harness, record, text } from "./helpers";
import { runSync } from "../../../src/nextclaw/syncEngine";
import { SyncQueue } from "../../../src/nextclaw/syncQueue";

function pendingFixture() {
  const h = harness();
  for (let i = 0; i < 12; i++) {
    h.local.put(`local-${i}/`); h.seed(record(`local-${i}/`));
    h.remote.put(`remote-${i}/`); h.seed(record(`remote-${i}/`));
  }
  return h;
}
describe("directory deletion policy is pending, not an I/O failure", () => {
  it("keeps >10 deletions on each side pending while creating, modifying and deleting safe files", async () => {
    const h = pendingFixture();
    h.local.put("create-local.md", "new local"); h.remote.put("create-remote.md", "new remote");
    h.local.put("push.md", "local edit", 30000); h.remote.put("push.md"); h.seed(record("push.md"));
    h.remote.put("pull.md", "remote edit", 30000); h.local.put("pull.md"); h.seed(record("pull.md"));
    h.local.put("delete-local.md"); h.seed(record("delete-local.md"));
    h.remote.put("delete-remote.md"); h.seed(record("delete-remote.md"));
    const result = await runSync(h.input);
    assert.equal(result.ok, true); assert.equal(result.fullyConverged, false);
    assert.equal(result.pendingDirectories.length, 24); assert.deepEqual(result.errors, []);
    assert.equal(text(await h.remote.readFile("create-local.md")), "new local");
    assert.equal(text(await h.local.readFile("create-remote.md")), "new remote");
    assert.equal(text(await h.remote.readFile("push.md")), "local edit");
    assert.equal(text(await h.local.readFile("pull.md")), "remote edit");
    assert.equal(h.local.files.has("delete-local.md"), false);
    assert.equal(h.remote.files.has("delete-remote.md"), false);
    assert(![...h.local.calls, ...h.remote.calls].some(c => c.op === "rm" && c.key.endsWith("/")));
    for (const key of result.pendingDirectories) {
      assert(h.rec(key)); assert.equal(h.last()[key].pending, "directory-delete-deferred");
      assert.equal(h.last()[key].error, undefined);
    }
    assert.equal(h.last()["/$@meta"].outcome, "pending");
    assert(!h.events.some(e => e[0] === "error" || (e[0] === "notify" && e[1] === 8)));
    const next = await runSync(h.input);
    assert.equal(next.pendingDirectories.length, 24); assert.equal(next.ok, true);
    assert.equal(next.fullyConverged, false); // Repeat scan is not false convergence.
  });
  it("keeps real permission failures fatal and observable alongside pending directories", async () => {
    const h = pendingFixture(); h.remote.put("delete.md"); h.seed(record("delete.md"));
    h.remote.rmGuarded = async () => { throw Object.assign(new Error("permission denied"), {status:403}); };
    const r = await runSync(h.input);
    assert.equal(r.ok, false); assert.equal(r.fullyConverged, false);
    assert.equal(r.pendingDirectories.length, 24); assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].message, /permission denied/); assert(h.remote.files.has("delete.md"));
    assert.equal(h.last()["/$@meta"].outcome, "failed");
  });
  it("does not waive the ten-error budget for actual file transfer failures", async () => {
    const h = pendingFixture(); h.input.concurrency = 1;
    for(let i=0;i<12;i++) h.local.put(`fail-${i}.md`);
    let attempts=0; h.remote.writeFileGuarded = async () => {attempts++;throw Error("network failure");};
    const r = await runSync(h.input);
    assert.equal(attempts,10); assert.equal(r.errors.length,10); assert.equal(r.ok,false);
    assert.equal(r.pendingDirectories.length,24);
    assert.equal(h.remote.files.has("fail-11.md"),false);
  });
  it("never downgrades scan failures or content races to pending", async () => {
    const h = pendingFixture(); h.remote.walk = async () => {throw Error("network unavailable");};
    const r = await runSync(h.input); assert.equal(r.ok,false); assert.equal(r.pendingDirectories.length,0);
    assert.match(r.errors[0].message,/network unavailable/);
  });
  it("reports full convergence only after no pending directory remains", async () => {
    const h = pendingFixture(); await runSync(h.input);
    // An explicit fixture repair restores matching directories, not automatic deletion.
    for(let i=0;i<12;i++){h.remote.put(`local-${i}/`);h.local.put(`remote-${i}/`);}
    const r=await runSync(h.input); assert.equal(r.ok,true);assert.equal(r.fullyConverged,true);
    assert.deepEqual(r.pendingDirectories,[]);assert.equal(h.last()["/$@meta"].outcome,"converged");
  });
  it("does not schedule failure retries for a successful file run with pending directories", async () => {
    const h=pendingFixture(), timers=new Map<number,()=>void>();let id=0;
    let done!:()=>void;const finished=new Promise<void>(r=>done=r);
    const q=new SyncQueue(async()=>{const r=await runSync(h.input);q.finished(r.ok?"ok":"failed");done();return r.ok?"ok":"failed";},{setTimeout(fn){timers.set(++id,fn);return id as any;},clearTimeout(n){timers.delete(n);}});
    q.request();const [key,fire]=[...timers][0];timers.delete(key);fire();await finished;
    assert.equal(timers.size,0);q.dispose();
  });
  it("lists policy skips in a read-only dry plan without deleting directories", async () => {
    const h=pendingFixture();h.input.triggerSource="dry";
    const r=await runSync(h.input);assert.equal(r.pendingDirectories.length,24);assert.equal(r.fullyConverged,false);
    assert.equal(h.saved(),0);assert(![...h.local.calls,...h.remote.calls].some(c=>c.op==="rm"));
  });
});
