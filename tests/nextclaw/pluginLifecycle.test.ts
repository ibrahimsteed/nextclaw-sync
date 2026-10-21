import { fence, retireLoad, waitForRetiredLoad } from "../../src/nextclaw/loadFence";
import { strict as assert } from "assert";
import { readFileSync } from "fs";
import { resolve } from "path";
import ts from "typescript";
import { DeferredTasks } from "../../src/nextclaw/deferredTasks";

function clock() {
  let next=0;const live=new Map<number,()=>void>();const all=new Map<number,()=>void>();
  return {live,all,setTimeout(fn:()=>void,_delay:number){live.set(++next,fn);all.set(next,fn);return next;},clearTimeout(id:number){live.delete(id);},fire(){for(const [id,fn] of [...live]){live.delete(id);fn();}}};
}
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
describe("deferred tasks belong to one load",()=>{
  it("cancels delayed startup work and refuses new work after unload",async()=>{
    const c=clock(),tasks=new DeferredTasks(c);let calls=0;tasks.schedule(()=>{calls++;},30000);tasks.schedule(()=>{calls++;},45000);assert.equal(c.live.size,2);tasks.dispose();tasks.dispose();assert.equal(c.live.size,0);
    for(const fn of c.all.values())fn();tasks.schedule(()=>{calls++;},1);tasks.run(()=>{calls++;});await flush();assert.equal(calls,0);assert.equal(c.live.size,0);
  });
  it("suppresses a timer callback already queued before dispose",async()=>{
    const c=clock(),tasks=new DeferredTasks(c);let calls=0;tasks.schedule(()=>{calls++;},1);c.fire();tasks.dispose();await flush();assert.equal(calls,0);
  });
  it("reports active failures but handles disposed in-flight work",async()=>{
    const c=clock(),tasks=new DeferredTasks(c);const original=console.error;const logged:unknown[]=[];console.error=(...args:unknown[])=>{logged.push(args);};
    try{tasks.run(async()=>{throw Error("active maintenance failure");});await flush();assert.equal(logged.length,1);
      let fail!:(e:Error)=>void;const work=new Promise<void>((_,no)=>fail=no);tasks.run(()=>work);await flush();tasks.dispose();fail(Error("owner disposed during maintenance"));await flush();assert.equal(logged.length,1);
    }finally{console.error=original;}
  });
  it("new loads still run scheduled work",async()=>{
    const c=clock(),old=new DeferredTasks(c);old.dispose();const next=new DeferredTasks(c);let calls=0;next.schedule(()=>{calls++;},1);c.fire();await flush();assert.equal(calls,1);next.dispose();
  });
});

// Execute the actual production lifecycle methods without loading Obsidian's UI.
const source=ts.createSourceFile("main.ts",readFileSync(resolve(__dirname,"../../src/main.ts"),"utf8"),ts.ScriptTarget.Latest,true);
const wanted=new Set(["onunload","enableInitSyncIfSet","enableAutoClearOutputToDBHistIfSet","enableAutoClearSyncPlanHist","prepareDBAndVaultRandomID","tryToAddIgnoreFile"]);const found:string[]=[];
function visit(n:ts.Node){if(ts.isMethodDeclaration(n)&&wanted.has(n.name.getText(source)))found.push(n.getText(source));ts.forEachChild(n,visit);}visit(source);assert.equal(found.length,wanted.size);
function production() {
  const c=clock(),layouts:Array<()=>void>=[],calls:string[]=[];const owner={dispose(){calls.push("db-dispose");}};const deferredTasks=new DeferredTasks(c);
  const compile=ts.transpileModule(`const methods={${found.join(",")}};`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  const methods=new Function("retireLoad","window","clearAllLoggerOutputRecords","clearExpiredSyncPlanRecords","prepareDBs",compile+"return methods;")(
    retireLoad, {clearTimeout(){},setInterval(){calls.push("interval");return 1;}},async()=>{calls.push("logs");},async()=>{calls.push("plans");},async(...args:unknown[])=>{assert.equal(args[3],owner);return {db:{},vaultRandomID:"same-id"};}
  );
  const plugin:any={...methods,_syncOnSaveEvent2:{cancel(){calls.push("debounce-cancel");}},getVaultBasePath:()=>"test",transportBlocked:()=>false,deferredTasks,databaseConnections:owner,settings:{initRunAfterMilliseconds:30000},app:{workspace:{onLayoutReady(fn:()=>void){layouts.push(fn);}}},registerInterval(){},syncRun:async()=>{calls.push("sync");},syncQueue:{dispose(){calls.push("queue-dispose");}}};
  return {plugin,c,layouts,calls};
}
describe("production plugin lifecycle wiring",()=>{
  it("cancels all three startup timers and closes the database owner on unload",async()=>{
    const {plugin,c,layouts,calls}=production();plugin.enableInitSyncIfSet();plugin.enableAutoClearOutputToDBHistIfSet();plugin.enableAutoClearSyncPlanHist();for(const cb of layouts)cb();assert.equal(c.live.size,3);plugin.onunload();assert.equal(c.live.size,0);for(const fn of c.all.values())fn();await flush();assert.ok(calls.includes("db-dispose"));assert.ok(!calls.some(x=>["sync","logs","plans"].includes(x)));
  });
  it("ignores layout-ready callbacks delivered after unload",async()=>{
    const {plugin,c,layouts,calls}=production();plugin.enableInitSyncIfSet();plugin.enableAutoClearOutputToDBHistIfSet();plugin.enableAutoClearSyncPlanHist();plugin.onunload();for(const cb of layouts)cb();await flush();assert.equal(c.live.size,0);assert.deepEqual(calls,["debounce-cancel","db-dispose","queue-dispose"]);
  });
  it("passes the same load's database owner into production prepareDBs",async()=>{
    const {plugin}=production();await plugin.prepareDBAndVaultRandomID("synthetic-path","webdav-default-1");assert.equal(plugin.vaultRandomID,"same-id");
  });
});

describe("retired I/O and delayed reload fence", () => {
  it("lets an admitted request settle but rejects later operations", async () => {
    let stopped=false, finish!:()=>void; const calls:string[]=[];
    const fs=fence({async write(){calls.push("write");await new Promise<void>(r=>finish=r);},read(){calls.push("read");}},()=>stopped);
    const request=fs.write();stopped=true;assert.throws(()=>fs.read(),/unloaded/);finish();await request;assert.deepEqual(calls,["write"]);
  });
  it("new loads wait for retired work and release the host reference",async()=>{
    const host={} as Window;let finish!:()=>void;const pending=new Promise<void>(r=>finish=r);retireLoad(host,"vault",pending);
    let ready=false;const next=waitForRetiredLoad(host,"vault").then(()=>{ready=true;});await flush();assert.equal(ready,false);finish();await next;
    assert.equal("nextclawRetiredLoads" in host,false);
  });
  it("unload rejects a pending reload delay even if the timer arrives late",async()=>{
    const c=clock(),tasks=new DeferredTasks(c);let commands=0;
    const pending=tasks.wait(2500).then(()=>{commands++;});const rejected=assert.rejects(pending,/unloaded/);
    tasks.dispose();for(const fn of c.all.values())fn();await rejected;assert.equal(commands,0);assert.equal(c.live.size,0);
  });
});


describe("deferred ignore-file setup cannot write after quarantine",()=>{
  it("rechecks after asynchronous existence checks",async()=>{
    const {plugin}=production();let paused=false,writes=0,checks=0;
    plugin.manifest={dir:".obsidian/plugins/nextclaw-sync"};plugin.transportBlocked=()=>paused;
    plugin.app.vault={adapter:{async exists(){checks++;if(checks===2){paused=true;return false;}return true;},async write(){writes++;}}};
    await plugin.tryToAddIgnoreFile();assert.equal(writes,0);
  });
});


describe("deferred error logging does not retain receiver objects",()=>{
  it("logs only string diagnostics for a failed maintenance callback",async()=>{
    const c=clock(),tasks=new DeferredTasks(c),original=console.error,logged:unknown[][]=[];console.error=(...args:unknown[])=>{logged.push(args);};
    try{tasks.run(()=>{throw Error("synthetic maintenance failure");});await flush();assert.equal(logged.length,1);assert.ok(logged[0].every(x=>typeof x==="string"));assert.match(String(logged[0][1]),/synthetic maintenance failure/);}
    finally{tasks.dispose();console.error=original;}
  });
});
