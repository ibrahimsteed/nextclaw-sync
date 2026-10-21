import {strict as assert} from "assert";
import {readFileSync} from "fs";
import {resolve} from "path";
import ts from "typescript";
import {getPendingDirectoryCountByVault,upsertPendingDirectoryCountByVault} from "../../src/localdb";
import {relativeTimeText} from "../../src/statusBarTime";
const source=ts.createSourceFile("main.ts",readFileSync(resolve(__dirname,"../../src/main.ts"),"utf8"),ts.ScriptTarget.Latest,true);
let method="";function visit(n:ts.Node){if(ts.isMethodDeclaration(n)&&n.name.getText(source)==="updateLastSyncMsg")method=n.getText(source);ts.forEachChild(n,visit);}visit(source);
const js=ts.transpileModule(method.replace(/^updateLastSyncMsg/,"function updateLastSyncMsg"),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
const run=new Function("relativeTimeText","getStatusBarShortMsgFromSyncSource","navigator",js+"return updateLastSyncMsg;")(relativeTimeText,()=>"",{language:"zh"});
function fixture(count:number){let text="",label="";const states:any[]=[];const p:any={transportBlocked:()=>false,deferredTasks:{disposed:false},pendingDirectoryCount:count,i18n:{t:(k:string)=>k},statusBarElement:{setText(x:string){text=x;},setAttribute(_k:string,x:string){label=x;}},refreshMobileStatusBarVisibility(x:any){states.push(x);}};return {p,states,text:()=>text,label:()=>label};}
describe("pending directories stay visible without becoming fatal errors",()=>{
 it("keeps the pending status visible after the normal success fade interval",()=>{
  const h=fixture(24);run.call(h.p,undefined,"not_syncing",Date.now()-60000,null);
  assert.match(h.text(),/文件同步成功.*目录待处理 24.*未全部收敛/);
  assert.match(h.label(),/安全跳过/);assert.equal(h.states[0].isSuccess,false);
 });
 it("does not hide real failures behind a pending status",()=>{
  const h=fixture(24);run.call(h.p,undefined,"not_syncing",1,Date.now());
  assert.match(h.text(),/同步失败.*目录待处理/);
 });
 it("clears the pending label only when the stored count has been cleared",()=>{
  const h=fixture(0);run.call(h.p,undefined,"not_syncing",Date.now(),null);
  assert(!h.text().includes("待处理"));assert.equal(h.states[0].isSuccess,true);
 });
 it("persists the count for a replacement plugin load and clears it explicitly",async()=>{
  const data=new Map<string,unknown>();const db:any={simpleKVForMiscTbl:{async setItem(k:string,v:unknown){data.set(k,v);},async getItem(k:string){return data.get(k)??null;}}};
  assert.equal(await getPendingDirectoryCountByVault(db,"v"),0);
  await upsertPendingDirectoryCountByVault(db,"v",24);assert.equal(await getPendingDirectoryCountByVault(db,"v"),24);
  await upsertPendingDirectoryCountByVault(db,"v",0);assert.equal(await getPendingDirectoryCountByVault(db,"v"),0);
 });
 it("does not mutate a disposed status element from a delayed callback",()=>{
  const h=fixture(24);h.p.deferredTasks.disposed=true;run.call(h.p,undefined,"not_syncing",Date.now(),null);
  assert.equal(h.text(),"");assert.deepEqual(h.states,[]);
 });
});
