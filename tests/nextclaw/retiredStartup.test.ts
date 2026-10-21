import {strict as assert} from "assert";
import {readFileSync} from "fs";
import {resolve} from "path";
import ts from "typescript";
import {DeferredTasks} from "../../src/nextclaw/deferredTasks";
import {hasRetiredLoad,retireLoad} from "../../src/nextclaw/loadFence";
const source=ts.createSourceFile("main.ts",readFileSync(resolve(__dirname,"../../src/main.ts"),"utf8"),ts.ScriptTarget.Latest,true);
let method="";function visit(n:ts.Node){if(ts.isMethodDeclaration(n)&&n.name.getText(source)==="onload")method=n.getText(source);ts.forEachChild(n,visit);}visit(source);
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function fixture(pending?:Promise<void>){
 const host={},timers=new Map<number,{fn:()=>void,delay:number}>();let id=0;const calls:string[]=[];
 const tasks=new DeferredTasks({setTimeout(fn,delay){timers.set(++id,{fn,delay});return id;},clearTimeout(key){timers.delete(key);}});
 if(pending)retireLoad(host,"vault",pending);
 const code=ts.transpileModule(method.replace(/^async onload/,"async function onload"),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
 const run=new Function("window","hasRetiredLoad","iconNameSyncWait","Notice",code+"return onload;")(host,hasRetiredLoad,"sync",class{constructor(){calls.push("notice");}});
 const plugin:any={deferredTasks:tasks,getVaultBasePath:()=>"vault",initialize:async()=>{calls.push("initialize");},requestRecoverySync(){calls.push("recovery");},addRibbonIcon(){calls.push("waiting-ribbon");return {remove(){calls.push("remove-ribbon");}};}};
 async function tick(){for(const [key,x] of [...timers])if(x.delay===1000){timers.delete(key);x.fn();}await flush();}
 return {plugin,host,tasks,calls,timers,tick,run:()=>run.call(plugin)};
}
describe("retired native request startup",()=>{
 it("returns from onload without initializing storage while old native work never settles",async()=>{
  const h=fixture(new Promise(()=>{}));await h.run();await h.tick();assert.deepEqual(h.calls,["waiting-ribbon"]);assert.equal(h.plugin.initializationWaiting,true);assert.equal(h.timers.size,2);h.tasks.dispose();assert.equal(h.timers.size,0);
 });
 it("initializes once and requests automatic recovery only after the actual old promise settles",async()=>{
  let finish!:()=>void;const h=fixture(new Promise<void>(r=>finish=r));await h.run();await h.tick();finish();await flush();await h.tick();await h.tick();assert.deepEqual(h.calls,["waiting-ribbon","remove-ribbon","initialize","recovery"]);assert.equal(h.plugin.initializationWaiting,false);h.tasks.dispose();
 });
 it("unloading a waiting replacement cancels polling and never initializes it later",async()=>{
  let finish!:()=>void;const h=fixture(new Promise<void>(r=>finish=r));await h.run();const late=[...h.timers.values()];h.tasks.dispose();finish();await flush();for(const x of late)x.fn();await flush();assert.deepEqual(h.calls,["waiting-ribbon"]);assert.equal(h.timers.size,0);
 });
 it("does not attach replacement-load continuations to a permanently pending native promise",async()=>{
  let subscriptions=0;const old=new Promise<void>(()=>{});const original=old.then.bind(old);old.then=((...args:Parameters<Promise<void>["then"]>)=>{subscriptions++;return original(...args);}) as Promise<void>["then"];
  const h=fixture(old);await flush();const before=subscriptions;await h.run();for(let i=0;i<5;i++)await h.tick();assert.equal(subscriptions,before);h.tasks.dispose();
 });
 it("keeps normal initialization awaited and surfaces its active failure",async()=>{
  const h=fixture();h.plugin.initialize=async()=>{throw Error("storage failure");};await assert.rejects(h.run(),/storage failure/);h.tasks.dispose();
 });
 it("keeps storage fenced after the waiting notice and prolonged timer expiry",async()=>{
  const h=fixture(new Promise(()=>{}));await h.run();
  for(const [key,x] of [...h.timers])if(x.delay===15000){h.timers.delete(key);x.fn();}
  for(let i=0;i<180;i++)await h.tick();
  assert.deepEqual(h.calls,["waiting-ribbon","notice"]);
  assert.equal(h.plugin.initializationWaiting,true);assert.equal(hasRetiredLoad(h.host,"vault"),true);
  h.tasks.dispose();assert.equal(h.timers.size,0);
 });
 it("ignores late native rejection after waiting-load disposal without resurrecting callbacks",async()=>{
  let fail!:(error:Error)=>void;const h=fixture(new Promise<void>((_,reject)=>fail=reject));await h.run();
  const late=[...h.timers.values()];h.tasks.dispose();fail(Error("native transport finally closed"));await flush();
  for(const x of late)x.fn();await flush();
  assert.deepEqual(h.calls,["waiting-ribbon"]);assert.equal(h.timers.size,0);assert.equal(hasRetiredLoad(h.host,"vault"),false);
 });

});
