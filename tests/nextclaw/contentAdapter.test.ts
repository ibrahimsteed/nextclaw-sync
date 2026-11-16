import "fake-indexeddb/auto";
import { strict as assert } from "assert";
import { buildSync } from "esbuild";
import * as path from "path";
import { createClient } from "webdav";
import { createServer } from "http";
import { createHash } from "crypto";
function load(native = false, requestUrl?: (p:any)=>Promise<any>) {
  let patch: any;
  const code=buildSync({stdin:{contents:`export {FakeFsWebdav} from './src/fsWebdav'; export {runSync} from './src/nextclaw/syncEngine'; export {prepareDBs} from './src/localdb'; export {IdbConnectionPool} from './src/idbStore'; export {NativeWriteJournal} from './src/nextclaw/nativeWriteJournal';`,resolveDir:path.resolve(__dirname,"../.."),loader:"ts"},bundle:true,platform:"node",format:"cjs",write:false,external:["obsidian","webdav/dist/web/index.js"],logLevel:"silent"}).outputFiles[0].text;
  const mod={exports:{} as any};
  const requireHost=(n:string)=>n==="obsidian"?{Platform:{isAndroidApp:false},requireApiVersion:()=>native,requestUrl}:n==="webdav/dist/web/index.js"?{getPatcher:()=>({patch(_n:string, fn:any){patch=fn;}}),AuthType:{Password:"password",Digest:"digest"}}:require(n);
  new Function("require","module","exports",code)(requireHost,mod,mod.exports);return {...mod.exports, nativePatch:(options:any)=>patch(options)};
}
import { MemoryFs, bytes, text } from "./engine/helpers";
describe("default entry with actual WebDAV adapter, library HTTP and actual IndexedDB",()=>{
 it("binds conditional GET response/PUT receipt, parses DAV properties, classifies 412 and pins unknown 504",async()=>{
  const lib=load(), pool=new lib.IdbConnectionPool();let data="base\n",tag='"E1"',putStatus=201,omitGetTag=false,puts=0;
  const calls:{method:string;match?:string;none?:string}[]=[];
  const xml=(root:boolean)=>`<d:response><d:href>/vault/${root?"":"n.md"}</d:href><d:propstat><d:prop><d:resourcetype>${root?"<d:collection/>":""}</d:resourcetype><d:getcontentlength>${root?0:Buffer.byteLength(data)}</d:getcontentlength><d:getlastmodified>Wed, 21 Oct 2026 12:00:00 GMT</d:getlastmodified><d:getetag>${tag.replace(/"/g,"&quot;")}</d:getetag><oc:fileid>0012</oc:fileid><oc:checksums><oc:checksum>SHA256:${createHash("sha256").update(data).digest("hex")}</oc:checksum></oc:checksums></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const server=createServer((req,res)=>{
   calls.push({method:req.method!,match:req.headers["if-match"] as string,none:req.headers["if-none-match"] as string});
   if(req.method==="PROPFIND") {const root=!req.url?.endsWith("n.md");res.writeHead(207,{"Content-Type":"application/xml"});res.end(`<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${xml(root)}${root&&req.headers.depth!=="0"?xml(false):""}</d:multistatus>`);return;}
   if(req.method==="GET"){if(req.headers["if-match"]!==tag){res.writeHead(412);res.end();return;}res.writeHead(200,omitGetTag?{}:{ETag:tag});res.end(data);return;}
   if(req.method==="PUT"){puts++;let body="";req.on("data",c=>{body+=c;});req.on("end",()=>{if(putStatus===412){data="competitor";tag='"race"';res.writeHead(412);res.end();return;}data=body;tag=`"E${puts+1}"`;res.writeHead(putStatus,{ETag:tag});res.end();});return;}
   res.writeHead(405);res.end();
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address() as {port:number};
  const entries=new Map<string,string>(),journal=new lib.NativeWriteJournal({getItem:(k:string)=>entries.get(k)??null,setItem:(k:string,v:string)=>{entries.set(k,v);},removeItem:(k:string)=>{entries.delete(k);}},"native-http");
  const url=`http://127.0.0.1:${address.port}`;
  const remote=new lib.FakeFsWebdav({address:url,username:"synthetic",password:"synthetic",remoteBaseDir:"vault",depth:"manual_1"},"vault",async()=>{},journal);
  remote.client=createClient(url);remote.vaultFolderExists=true;
  const local=new MemoryFs().put("n.md","base\n");const {db,vaultRandomID}=await lib.prepareDBs("/http/"+crypto.randomUUID(),"","p",pool);
  const cb={markIsSyncing:()=>{},notify:()=>{},ribbon:()=>{},statusBar:()=>{},progress:()=>{},errNotify:()=>{},protectError:()=>"protect"};
  const input={mode:"B",fsLocal:local,fsRemote:remote,db,vaultRandomID,profileID:"p",configDir:".obsidian",syncConfigDir:false,ignorePaths:[],pluginId:"sync",protectModifyPercentage:100,triggerSource:"manual",callbacks:cb,
   contentRuntime:{pool,journal,assertActive:()=>pool.assertOpen(),requestRerun:()=>{}}};
  try{
   const e=await remote.stat("n.md");assert.equal(e.remoteFileId,"0012");assert.equal(e.remoteChecksum,createHash("sha256").update(data).digest("hex"));
   assert.equal((await lib.runSync(input)).fullyConverged,true);
   local.put("n.md","uploaded\n");const result=await lib.runSync(input);assert.equal(result.fullyConverged,true,result.errors.map((e:Error)=>e.message).join());assert.equal(data,"uploaded\n");assert.equal(entries.size,0);
   assert.ok(calls.some(c=>c.method==="PUT"&&c.match==='"E1"'));assert.ok(calls.filter(c=>c.method==="GET").every(c=>!!c.match));
   omitGetTag=true;const badRead=await lib.runSync(input);assert.equal(badRead.errors.length,0);assert.equal(badRead.fullyConverged,false);assert.ok(badRead.pendingContent.length);assert.equal(puts,1);omitGetTag=false;
   putStatus=412;local.put("n.md","racing");const race=await lib.runSync(input);assert.equal(race.errors.length,0);assert.equal(race.fullyConverged,false);assert.equal(data,"competitor");assert.equal(entries.size,0);
   putStatus=504;const unknown=await lib.runSync(input);assert.equal(unknown.contentSummary.blocked,true);assert.ok(entries.size);const count=puts;
   await lib.runSync(input);assert.equal(puts,count);assert.ok(text(await local.readFile("n.md")).includes("racing"));
  }finally{journal.retire();pool.dispose();await new Promise<void>(r=>server.close(()=>r()));}
 });
});

it("managed native transport uses exactly one journal registration per actual PUT, with explicit 412 versus unknown 504", async()=>{
 let data="base", tag='"N1"', status=201, puts=0; const entries=new Map<string,string>();
 const lib=load(true,async(p:any)=>{
  assert.equal(p.headers["x-nextclaw-native-owner"],undefined);
  if(p.method==="PUT"){
   puts++;const journal=JSON.parse([...entries.values()][0]);assert.equal(journal.operations.length,1,"no nested registration");
   assert.equal(journal.operations[0].path,"/vault/n.md");
   if(status===412){data="competitor";tag='"race"';return {status,headers:{},arrayBuffer:new ArrayBuffer(0)};}
   data=text(p.body);tag=`"N${puts+1}"`;return {status,headers:{etag:tag},arrayBuffer:new ArrayBuffer(0)};
  }
  assert.equal(p.method,"GET");assert.equal(p.headers["if-match"],tag);
  return {status:200,headers:{etag:tag},arrayBuffer:bytes(data)};
 });
 const journal=new lib.NativeWriteJournal({getItem:(k:string)=>entries.get(k)??null,setItem:(k:string,v:string)=>{entries.set(k,v);},removeItem:(k:string)=>{entries.delete(k);}},"native-managed");
 const pool=new lib.IdbConnectionPool();const {db,vaultRandomID}=await lib.prepareDBs("/native/"+crypto.randomUUID(),"","p",pool);
 const remote=new lib.FakeFsWebdav({address:"https://synthetic.invalid",username:"synthetic",password:"not-real",remoteBaseDir:"vault",depth:"manual_1"},"vault",async()=>{},journal);
 const file=(key:string)=>({filename:key,basename:"n.md",lastmod:"Wed, 21 Oct 2026 12:00:00 GMT",type:key.replace(/\/$/,"")==="/vault"?"directory":"file",size:bytes(data).byteLength,etag:tag.replace(/"/g,"")});
 remote.client={stat:async(k:string)=>({data:file(k)}),getDirectoryContents:async()=>({data:[file("/vault/n.md")]}),
  customRequest:async(k:string,o:any)=>lib.nativePatch({url:"https://synthetic.invalid"+k,method:o.method,headers:{"x-nextclaw-native-owner":journal.token,...o.headers},data:o.data})};remote.vaultFolderExists=true;
 const local=new MemoryFs().put("n.md","base");const input:any={mode:"B",fsLocal:local,fsRemote:remote,db,vaultRandomID,profileID:"p",configDir:".obsidian",syncConfigDir:false,ignorePaths:[],pluginId:"sync",protectModifyPercentage:100,triggerSource:"manual",
  callbacks:{markIsSyncing:()=>{},notify:()=>{},ribbon:()=>{},statusBar:()=>{},progress:()=>{},errNotify:()=>{},protectError:()=>"protect"},contentRuntime:{pool,journal,assertActive:()=>pool.assertOpen(),requestRerun:()=>{}}};
 try{
  assert.equal((await lib.runSync(input)).fullyConverged,true);local.put("n.md","local");
  const one=await lib.runSync(input);assert.equal(one.fullyConverged,true,one.errors.map((e:Error)=>e.message).join());assert.equal(puts,1);assert.equal(entries.size,0);
  local.put("n.md","next");status=412;const rejected=await lib.runSync(input);assert.equal(rejected.contentSummary.blocked,false);assert.equal(entries.size,0);assert.equal(data,"competitor");
  status=504;const unknown=await lib.runSync(input);assert.equal(unknown.contentSummary.blocked,true);assert.equal(entries.size,1);const count=puts;
  await lib.runSync(input);assert.equal(puts,count);
 }finally{journal.retire();pool.dispose();}
});

it("P2 actual HTTP adapter binds DELETE receipt and known-root reseed; unknown MKCOL is never replayed",async function(){
 this.timeout(15000);
 for(const restoreStatus of[201,504]){
  const lib=load(),pool=new lib.IdbConnectionPool();let data:string|undefined="base\n",tag='"P2E1"',rootPresent=true,deletes=0,mkdirs=0;
  const calls:{method:string;path:string;match?:string;none?:string}[]=[];
  const xml=(name:string,folder:boolean)=>`<d:response><d:href>${name}</d:href><d:propstat><d:prop><d:resourcetype>${folder?"<d:collection/>":""}</d:resourcetype><d:getcontentlength>${folder?0:Buffer.byteLength(data!)}</d:getcontentlength><d:getlastmodified>Wed, 21 Oct 2026 12:00:00 GMT</d:getlastmodified><d:getetag>${tag.replace(/"/g,"&quot;")}</d:getetag><oc:fileid>${folder?'1':'900'}</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const server=createServer((req,res)=>{
   calls.push({method:req.method!,path:req.url!,match:req.headers['if-match']as string,none:req.headers['if-none-match']as string});
   if(req.method==='MKCOL'){mkdirs++;rootPresent=true;res.writeHead(restoreStatus);res.end();return;}
   if(req.method==='PROPFIND'){
    if(req.url!=='/'&&(!rootPresent||(req.url?.endsWith('n.md')&&data===undefined))){res.writeHead(404);res.end();return;}
    const parent=req.url==='/',file=req.url?.endsWith('n.md');res.writeHead(207,{'Content-Type':'application/xml'});res.end(`<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${xml(parent?'/':file?'/vault/n.md':'/vault/',!file)}${!parent&&!file&&req.headers.depth!=='0'&&data!==undefined?xml('/vault/n.md',false):''}</d:multistatus>`);return;
   }
   if(req.method==='GET'){if(data===undefined){res.writeHead(404);res.end();return;}res.writeHead(200,{ETag:tag});res.end(data);return;}
   if(req.method==='DELETE'){deletes++;if(req.headers['if-match']!==tag){res.writeHead(412);res.end();return;}data=undefined;res.writeHead(204);res.end();return;}
   if(req.method==='PUT'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{if(data!==undefined&&req.headers['if-none-match']==='*'){res.writeHead(412);res.end();return;}data=body;tag='"P2E2"';res.writeHead(201,{ETag:tag});res.end();});return;}
   res.writeHead(405);res.end();
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address()as{port:number}).port}`;
  const entries=new Map<string,string>(),journal=new lib.NativeWriteJournal({getItem:(k:string)=>entries.get(k)??null,setItem:(k:string,v:string)=>{entries.set(k,v)},removeItem:(k:string)=>{entries.delete(k)}},crypto.randomUUID());
  const remote=new lib.FakeFsWebdav({address:url,username:'test',password:'synthetic',remoteBaseDir:'vault',depth:'manual_1'},'vault',async()=>{},journal);remote.client=createClient(url);remote.vaultFolderExists=true;
  const local=new MemoryFs().put('n.md','base\n'),{db,vaultRandomID}=await lib.prepareDBs('/p2http/'+crypto.randomUUID(),'','p',pool);
  const input={mode:'B',fsLocal:local,fsRemote:remote,db,vaultRandomID,profileID:'p',configDir:'.obsidian',syncConfigDir:false,ignorePaths:[],pluginId:'sync',protectModifyPercentage:100,triggerSource:'manual',contentRuntime:{pool,journal,assertActive:()=>pool.assertOpen(),requestRerun:()=>{}},callbacks:{markIsSyncing:()=>{},notify:()=>{},ribbon:()=>{},statusBar:()=>{},progress:()=>{},errNotify:()=>{},protectError:()=>"protect"}};
  try{
   assert.equal((await lib.runSync(input)).fullyConverged,true);local.files.delete('n.md');let r=await lib.runSync(input);assert.equal(r.fullyConverged,true,JSON.stringify(r,(k,v)=>v instanceof Error?v.message:v));assert.equal(deletes,1);assert.ok(calls.some(c=>c.method==='DELETE'&&c.match==='"P2E1"'));
   local.put('n.md','base\n');assert.equal((await lib.runSync(input)).fullyConverged,true);rootPresent=false;data=undefined;
   r=await lib.runSync(input);assert.equal(mkdirs,1);
   if(restoreStatus===201){assert.equal(r.fullyConverged,true,JSON.stringify(r,(k,v)=>v instanceof Error?v.message:v));assert.equal(data,'base\n');assert.ok(calls.some(c=>c.method==='PUT'&&c.none==='*'));assert.equal(deletes,1);}
   else{assert.equal(r.contentSummary.blocked,true);assert.equal(journal.blocked(),true);await lib.runSync(input);assert.equal(mkdirs,1);assert.equal(deletes,1);assert.ok(local.files.has('n.md'));}
  }finally{journal.retire();pool.dispose();await new Promise<void>(r=>server.close(()=>r()));}
 }
});

it("P2 explicitly requests optional Nextcloud identities: allprop-only server cannot silently erase fileid",async function(){
 this.timeout(15000);
 for(const allowId of[true,false]){
  const lib=load(),pool=new lib.IdbConnectionPool(),bodies:string[]=[];let data:string|undefined='base\n';const tag='"identity-E1"';
  const xml=(folder:boolean,identity:boolean)=>`<d:response><d:href>/vault/${folder?'':'n.md'}</d:href><d:propstat><d:prop><d:resourcetype>${folder?'<d:collection/>':''}</d:resourcetype><d:getcontentlength>${folder?0:Buffer.byteLength(data!)}</d:getcontentlength><d:getlastmodified>Wed, 21 Oct 2026 12:00:00 GMT</d:getlastmodified><d:getetag>&quot;identity-E1&quot;</d:getetag>${identity?`<oc:fileid>${folder?'root-01':'53130'}</oc:fileid>`:''}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const server=createServer((req,res)=>{
   if(req.method==='PROPFIND'){let request='';req.on('data',c=>request+=c);req.on('end',()=>{bodies.push(request);const file=req.url?.endsWith('n.md');if(file&&data===undefined){res.writeHead(404);res.end();return;}
    // Model actual Nextcloud: allprop and allprop+include omit oc:fileid; explicit prop is required.
    const identity=allowId&&request.includes('<d:prop>')&&request.includes('<oc:fileid/>');res.writeHead(207,{'Content-Type':'application/xml'});res.end(`<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${xml(!file,identity)}${!file&&data!==undefined&&req.headers.depth!=='0'?xml(false,identity):''}</d:multistatus>`);});return;}
   if(req.method==='GET'){if(data===undefined){res.writeHead(404);res.end();return;}assert.equal(req.headers['if-match'],tag);res.writeHead(200,{ETag:tag});res.end(data);return;}
   res.writeHead(405);res.end();
  });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address()as{port:number}).port}`;
  const state=new Map<string,string>(),journal=new lib.NativeWriteJournal({getItem:(k:string)=>state.get(k)??null,setItem:(k:string,v:string)=>state.set(k,v),removeItem:(k:string)=>state.delete(k)},crypto.randomUUID());const remote=new lib.FakeFsWebdav({address:url,username:'synthetic',password:'synthetic',remoteBaseDir:'vault',depth:'manual_1'},'vault',async()=>{},journal);remote.client=createClient(url);remote.vaultFolderExists=true;
  const local=new MemoryFs().put('n.md','base\n'),{db,vaultRandomID}=await lib.prepareDBs('/optional-id/'+crypto.randomUUID(),'','p',pool);const input={mode:'B',fsLocal:local,fsRemote:remote,db,vaultRandomID,profileID:'p',configDir:'.obsidian',syncConfigDir:false,ignorePaths:[],pluginId:'sync',protectModifyPercentage:100,triggerSource:'manual',contentRuntime:{pool,journal,assertActive:()=>pool.assertOpen(),requestRerun:()=>{}},callbacks:{markIsSyncing:()=>{},notify:()=>{},ribbon:()=>{},statusBar:()=>{},progress:()=>{},errNotify:()=>{},protectError:()=>"protect"}};
  try{
   assert.equal((await remote.stat('n.md')).remoteFileId,allowId?'53130':undefined);
   for(const depth of['manual_1','manual_infinity']){remote.webdavConfig.depth=depth;assert.equal((await remote.walk()).find((x:any)=>x.key==='n.md')?.remoteFileId,allowId?'53130':undefined);}
   assert.equal((await lib.runSync(input)).fullyConverged,true);const rec=await db.prevSyncRecordsTbl.getItem(vaultRandomID+'\tp\tn.md');assert.equal(rec.content.remoteFileId,allowId?'53130':undefined);
   data=undefined;const result=await lib.runSync(input);assert.equal(result.ok,true);assert.equal(result.fullyConverged,allowId);
   if(allowId){assert.equal(local.files.has('n.md'),false);assert.equal(text(local.trash.get('n.md')!),'base\n');}else{assert.equal(local.files.has('n.md'),true);assert.ok(result.pendingContent.some((x:any)=>x.reason==='suspected-file-move'));}
   assert.ok(bodies.length);assert.ok(bodies.every(x=>x.includes('<d:prop>')&&x.includes('<oc:fileid/>')));
  }finally{journal.retire();pool.dispose();await new Promise<void>(r=>server.close(()=>r()));}
 }
});
