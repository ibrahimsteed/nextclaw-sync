import {strict as assert} from "assert";
import {readFileSync} from "fs";
import {resolve} from "path";
import ts from "typescript";
import {DeferredTasks} from "../../src/nextclaw/deferredTasks";

// Execute production initialization through its final asynchronous version write.
const source=ts.createSourceFile("main.ts",readFileSync(resolve(__dirname,"../../src/main.ts"),"utf8"),ts.ScriptTarget.Latest,true);
let method="";
function visit(node:ts.Node){if(ts.isMethodDeclaration(node)&&node.name.getText(source)==="initialize")method=node.getText(source);ts.forEachChild(node,visit);}visit(source);
function initialization(){
  let entered!:()=>void, fail!:(e:Error)=>void;
  const started=new Promise<void>(r=>entered=r), pending=new Promise<void>((_,r)=>fail=r);
  const globals:Record<string,unknown>={
    window:{},document:{},waitForRetiredLoad:async()=>{},Events:class{},
    I18n:class{t(){return "test";}},Platform:{isMobile:true},iconNameSyncWait:"sync",iconNameLogs:"logs",
    SyncQueue:class{},NextclawSyncSettingTab:class{},
    upsertPluginVersionByVault:()=>{entered();return pending;},
  };
  const code=ts.transpileModule(method.replace(/^private async initialize/,"async function initialize"),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  const run=new Function(...Object.keys(globals),code+"return initialize;")(...Object.values(globals));
  const noop=()=>{};
  const plugin:any={deferredTasks:new DeferredTasks({setTimeout(){return 1;},clearTimeout(){}}),settings:{enableMobileStatusBar:false,enableStatusBarInfo:false},manifest:{name:"test",version:"0.1.12"},app:{workspace:{onLayoutReady:noop}},loadSettings:async()=>{},getCurrProfileID:()=>"p",getVaultBasePath:()=>"fixture",tryToAddIgnoreFile:noop,prepareDBAndVaultRandomID:async()=>{},enableAutoClearOutputToDBHistIfSet:noop,enableAutoClearSyncPlanHist:noop,enableMobileStatusBarIfSet:noop,addRibbonIcon:noop,addCommand:noop,addSettingTab:noop,registerDomEvent:noop,enableAutoSyncIfSet:noop,enableInitSyncIfSet:noop,toggleSyncOnSaveIfSet:noop};
  return {plugin,started,fail,run:()=>run.call(plugin)};
}
describe("load initialization closing race",()=>{
  it("settles when unload closes the database during final initialization write",async()=>{
    const h=initialization(),run=h.run();await Promise.race([h.started,run.then(()=>{throw Error("initialization returned before version write");})]);h.plugin.deferredTasks.dispose();h.fail(Error("database disposed"));await run;
  });
  it("still rejects an initialization storage failure on a live load",async()=>{
    const h=initialization(),run=h.run();const rejected=assert.rejects(run,/storage failure/);await Promise.race([h.started,run.then(()=>{throw Error("initialization returned before version write");})]);h.fail(Error("storage failure"));await rejected;h.plugin.deferredTasks.dispose();
  });
});
