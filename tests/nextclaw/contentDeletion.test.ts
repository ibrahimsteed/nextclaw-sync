import { strict as assert } from "assert";
import { environment } from "./contentEntry.test";
import { runSync } from "../../src/nextclaw/syncEngine";
import { assertContentResetSafe, checkVaultStages, contentRuntime } from "../../src/nextclaw/content/runtime";
import { text } from "./engine/helpers";
import type { Entity } from "../../src/baseTypes";
import { NativeWriteJournal } from "../../src/nextclaw/nativeWriteJournal";
import { IdbStore, IdbConnectionPool } from "../../src/idbStore";
import { deletionKey } from "../../src/nextclaw/content/deletion";
async function scene() {
 const t=await environment();let deletes=0,status=204;
 t.remote.deleteContent=async(path:string,e:Entity)=>{deletes++;const v=t.remote.files.get(path)?.entity;if(!v||v.etag!==e.etag)return{status:412};if([204,504].includes(status))t.remote.files.delete(path);return{status};};
 return{...t,deletes:()=>deletes,status:(n:number)=>{status=n;},async base(path="note.md",body="base\n"){
  t.local.put(path,body);t.remote.put(path,body);t.remote.files.get(path)!.entity.remoteFileId=String(1000+t.remote.revision);
  const r=await runSync(t.input);assert.equal(r.ok,true,JSON.stringify(r.errors));assert.equal((await t.rec(path))?.content?.remoteFileId,t.remote.files.get(path)!.entity.remoteFileId);
 }};
}
describe("P2 actual IndexedDB and complete sync entry",function(){
 this.timeout(15000);
 it("propagates local deletion with exact base/ETag then commits a non-replayed tombstone",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");const r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));assert.equal(t.deletes(),1);assert.equal(t.remote.files.has("note.md"),false);assert.equal((await t.rec("note.md"))?.content?.status,"deleted");await runSync(t.input);assert.equal(t.deletes(),1);}finally{t.stop();}
 });
 it("trashes unchanged local bytes, but restores a modified local page via conditional create",async()=>{
  const t=await scene();try{await t.base();t.remote.files.delete("note.md");let r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));assert.equal(text(t.local.trash.get("note.md")!),"base\n");await t.base("edit.md");t.remote.files.delete("edit.md");t.local.put("edit.md","new local\n");r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));assert.equal(text(await t.remote.readFile("edit.md")),"new local\n");}finally{t.stop();}
 });
 it("remote edits survive local deletion by guarded download rather than DELETE",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");t.remote.put("note.md","next\n");const r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));assert.equal(t.deletes(),0);assert.equal(text(await t.local.readFile("note.md")),"next\n");}finally{t.stop();}
 });
 it("has no new twenty-files/twenty-percent deletion cap and still uploads a safe page",async()=>{
  const t=await scene();try{for(let i=0;i<25;i++){t.local.put(`n${i}.md`,"base");t.remote.put(`n${i}.md`,"base");}t.local.put("safe.md","before");t.remote.put("safe.md","before");assert.equal((await runSync(t.input)).fullyConverged,true);for(let i=0;i<25;i++)t.local.files.delete(`n${i}.md`);t.local.put("safe.md","after");const r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));assert.equal(t.deletes(),25);assert.equal(text(await t.remote.readFile("safe.md")),"after");}finally{t.stop();}
 });
 it("list omission with per-file 403/500 is failure and never trashes local",async()=>{
  for(const status of[403,500]){const t=await scene();try{await t.base();t.remote.files.delete("note.md");const stat=t.remote.stat.bind(t.remote);t.remote.stat=async k=>{if(k==="note.md")throw Object.assign(Error("refusal"),{status});return stat(k);};const r=await runSync(t.input);assert.equal(r.ok,false);assert.ok(t.local.files.has("note.md"));assert.equal(t.deletes(),0);}finally{t.stop();}}
 });
 it("an empty full listing is not absence proof and root failure cannot mass-delete",async()=>{
  const t=await scene();try{await t.base();t.remote.walk=async()=>[];let r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));assert.ok(t.local.files.has("note.md"));t.remote.root=false;r=await runSync(t.input);assert.equal(r.ok,false);assert.ok(t.local.files.has("note.md"));assert.equal(t.deletes(),0);}finally{t.stop();}
 });
 it("same remote fileid at another path holds deletion without executing MOVE",async()=>{
  const t=await scene();try{await t.base();const v=t.remote.files.get("note.md")!;t.remote.files.delete("note.md");t.remote.files.set("moved.md",{...v,entity:{...v.entity,key:"moved.md",keyRaw:"moved.md"}});const r=await runSync(t.input);assert.equal(r.fullyConverged,false);assert.ok(r.pendingContent?.some(x=>x.reason==="suspected-file-move"));assert.ok(t.local.files.has("note.md"));assert.equal(t.deletes(),0);}finally{t.stop();}
 });
 it("persists ambiguous local move intent after the new path has uploaded",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");t.local.put("moved.md","base\n");for(let i=0;i<3;i++){const r=await runSync(t.input);assert.equal(r.fullyConverged,false);assert.equal(t.deletes(),0);assert.ok(t.remote.files.has("note.md"));}}finally{t.stop();}
 });
 it("412 rediscovery differs from unknown 504; later absence never unlocks or replays",async()=>{
  for(const status of[412,504]){const t=await scene();try{await t.base();t.local.files.delete("note.md");t.status(status);const r=await runSync(t.input);assert.equal(r.fullyConverged,false);assert.equal(t.deletes(),1);if(status===412){assert.equal(t.journal.blocked(),false);assert.equal(r.errors.length,0);}else{assert.equal(t.journal.blocked(),true);await assert.rejects(()=>checkVaultStages(t.db,t.input.vaultRandomID,()=>{}));await runSync(t.input);assert.equal(t.deletes(),1);assert.equal((await t.rec("note.md"))?.content?.status,"clean");}}finally{t.stop();}}
 });
 it("interrupted local trash cannot replay just because source is missing",async()=>{
  const t=await scene();try{await t.base();t.remote.files.delete("note.md");let calls=0;t.local.rmGuarded=async()=>{calls++;t.local.files.delete("note.md");throw Error("interrupted after rename");};const r=await runSync(t.input);assert.equal(r.contentSummary?.blocked,true);await runSync(t.input);assert.equal(calls,1);await assert.rejects(()=>checkVaultStages(t.db,t.input.vaultRandomID,()=>{}));}finally{t.stop();}
 });
 it("a tombstone cannot delete a recreated page or use old bytes as its ancestor",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");await runSync(t.input);t.local.put("note.md","new life\n");const r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));assert.equal(text(await t.remote.readFile("note.md")),"new life\n");}finally{t.stop();}
 });
 it("rejects changed immutable deletion intent despite a later matching 404",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");await runSync(t.input);const rt=contentRuntime(t.input),op=(await rt.deletions.list())[0];op.expectedEtag='"wrong"';await t.db.fileContentHistoryTbl.setItem(deletionKey(rt.scope,op.id),op);await assert.rejects(()=>checkVaultStages(t.db,t.input.vaultRandomID,()=>{}),/binding/);assert.equal(t.deletes(),1);}finally{t.stop();}
 });
 it("recovers an acknowledged delete after record publication interruption without dispatching twice",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");
   const set=t.db.fileContentHistoryTbl.setItem.bind(t.db.fileContentHistoryTbl);let once=true;
   t.db.fileContentHistoryTbl.setItem=async(k:any,v:any)=>{const out=await set(k,v);if(once&&v?.phase==="acknowledged"&&v?.action==="delete-remote"){once=false;throw Error("receipt saved, publication interrupted");}return out;};
   assert.equal((await runSync(t.input)).ok,false);assert.equal(t.deletes(),1);
   await runSync(t.input);const done=await runSync(t.input);assert.equal(t.deletes(),1);assert.equal(done.fullyConverged,true,JSON.stringify(done));assert.equal((await t.rec("note.md"))?.content?.status,"deleted");
  }finally{t.stop();}
 });
 it("never clears a newer record generation just because a DELETE was acknowledged",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");const remove=t.remote.deleteContent.bind(t.remote);
   t.remote.deleteContent=async(k,e)=>{const r=await remove(k,e);const old=await t.rec(k);await t.db.prevSyncRecordsTbl.setItem(`${t.input.vaultRandomID}\tp\t${k}`,{...old!,extraNewGeneration:true});return r;};
   const r=await runSync(t.input);assert.equal(r.fullyConverged,false);assert.equal((await t.rec("note.md"))?.content?.status,"clean");assert.equal(t.deletes(),1);
  }finally{t.stop();}
 });
 it("known conflict markers survive either-side deletion without creating delete operations",async()=>{
  const t=await scene();try{t.local.put("c.md","student");t.remote.put("c.md","agent");await runSync(t.input);t.remote.files.delete("c.md");const r=await runSync(t.input);assert.equal(r.fullyConverged,false);assert.equal(t.deletes(),0);assert.ok(text(await t.local.readFile("c.md")).includes("<<<<<<< Obsidian"));assert.equal((await contentRuntime(t.input).deletions.list()).length,0);
  }finally{t.stop();}
 });

 it("same root URL with a different Nextcloud identity never authorizes missing-file deletion",async()=>{
  const t=await scene();try{const stat=t.remote.stat.bind(t.remote);let rootId="11";t.remote.stat=async k=>{const r=await stat(k);return k==="/"?{...r,remoteFileId:rootId}:r;};await t.base();rootId="12";t.remote.files.clear();const r=await runSync(t.input);assert.equal(r.ok,false);assert.ok(r.errors.some(e=>e.message.includes("root-identity-changed")));assert.ok(t.local.files.has("note.md"));assert.equal(t.deletes(),0);}finally{t.stop();}
 });
 it("same content with a newer ETag may be deleted only with the newer ETag",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");t.remote.files.get("note.md")!.entity.etag='"new-tag"';let match="";const remove=t.remote.deleteContent.bind(t.remote);t.remote.deleteContent=async(k,e)=>{match=e.etag!;return remove(k,e);};assert.equal((await runSync(t.input)).fullyConverged,true);assert.equal(match,'"new-tag"');}finally{t.stop();}
 });
 it("same metadata and ETag with changed actual remote bytes is restored, not deleted",async()=>{
  const t=await scene();try{await t.base();const v=t.remote.files.get("note.md")!;v.bytes=new TextEncoder().encode("next\n").buffer;t.local.files.delete("note.md");const r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));assert.equal(t.deletes(),0);assert.equal(text(await t.local.readFile("note.md")),"next\n");}finally{t.stop();}
 });
 it("recreation during an acknowledged DELETE preserves the new local file and uses the existing rerun",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");const remove=t.remote.deleteContent.bind(t.remote);t.remote.deleteContent=async(k,e)=>{const r=await remove(k,e);t.local.put(k,"new after ack");return r;};const r=await runSync(t.input);assert.equal(r.fullyConverged,false);assert.ok(t.reruns()>0);const done=await runSync(t.input);assert.equal(done.fullyConverged,true,JSON.stringify(done));assert.equal(text(await t.remote.readFile("note.md")),"new after ack");assert.equal(t.deletes(),1);}finally{t.stop();}
 });
 it("retirement during DELETE receipt cannot commit a tombstone or make another mutation",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");const remove=t.remote.deleteContent.bind(t.remote);t.remote.deleteContent=async(k,e)=>{const r=await remove(k,e);t.stop();return r;};await runSync(t.input);assert.equal(t.deletes(),1);assert.equal(t.local.files.has("note.md"),false);
   const pool=new IdbConnectionPool();try{const d=await pool.database(t.db.prevSyncRecordsTbl.dbName,[t.db.prevSyncRecordsTbl.storeName,t.db.fileContentHistoryTbl.storeName]);
    const saved:any=await new Promise((resolve,reject)=>{const r=d.transaction(t.db.prevSyncRecordsTbl.storeName).objectStore(t.db.prevSyncRecordsTbl.storeName).get(`${t.input.vaultRandomID}\tp\tnote.md`);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});assert.equal(saved.content.status,"clean");
    const stages:any[]=await new Promise((resolve,reject)=>{const r=d.transaction(t.db.fileContentHistoryTbl.storeName).objectStore(t.db.fileContentHistoryTbl.storeName).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});assert.ok(stages.some(x=>x.action==="delete-remote"&&x.phase==="dispatched"));
    const next=new NativeWriteJournal({getItem:k=>t.entries.get(k)??null,setItem:(k,v)=>{t.entries.set(k,v)},removeItem:k=>{t.entries.delete(k)}},t.journal.key);assert.equal(next.blocked(),false);
    const history=new IdbStore(t.db.fileContentHistoryTbl.dbName,t.db.fileContentHistoryTbl.storeName,Array.from(d.objectStoreNames),pool);
    await assert.rejects(()=>checkVaultStages({...t.db,fileContentHistoryTbl:history},t.input.vaultRandomID,()=>{}));next.retire();
   }finally{pool.dispose();}
  }finally{t.stop();}
 });

 it("remote deletion above twenty and twenty percent still uses per-file trash and preserves a safe edit",async()=>{
  const t=await scene();try{for(let i=0;i<25;i++){t.local.put(`n${i}.md`,"base");t.remote.put(`n${i}.md`,"base");t.remote.files.get(`n${i}.md`)!.entity.remoteFileId=String(i+100);}t.local.put("safe.md","before");t.remote.put("safe.md","before");assert.equal((await runSync(t.input)).fullyConverged,true);for(let i=0;i<25;i++)t.remote.files.delete(`n${i}.md`);t.local.put("safe.md","after");const r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));assert.equal(t.local.trash.size,25);assert.equal(text(await t.remote.readFile("safe.md")),"after");assert.equal(t.deletes(),0);}finally{t.stop();}
 });
 it("scope mismatch or missing parent refuses root reconstruction before any MKCOL intent",async()=>{
  for(const wrongScope of[false,true]){const t=await scene();try{await t.base();const originalScope=contentRuntime(t.input).scope;t.remote.root=false;t.remote.files.clear();let restores=0;t.remote.restoreContentRoot=async()=>{restores++;return{status:201};};t.remote.checkContentRootParent=async()=>{if(!wrongScope)throw Error("parent missing");};if(wrongScope)t.remote.contentBinding=()=>({origin:"https://synthetic.invalid",account:"other",remoteRoot:"/vault",nativeManaged:false,journalToken:t.journal.token});const r=await runSync(t.input);assert.equal(r.ok,false);assert.ok(r.errors.some(e=>e.message.includes(wrongScope?"root-reseed-requires-bound-clean-scope":"parent missing")));assert.equal(restores,0);assert.equal(t.entries.size,0);assert.ok(t.local.files.has("note.md"));assert.equal((await t.db.fileContentHistoryTbl.keys()).filter(k=>{try{const a=JSON.parse(k);return a[0]==="nextclaw-content-root"&&a[2]===originalScope;}catch{return false;}}).length,0);}finally{t.stop();}}
 });
 it("missing remote fileid is migration pending rather than deletion authorization",async()=>{
  const t=await scene();try{t.local.put("note.md","base");t.remote.put("note.md","base");await runSync(t.input);t.remote.files.delete("note.md");const r=await runSync(t.input);assert.equal(r.ok,true);assert.equal(r.fullyConverged,false);assert.ok(t.local.files.has("note.md"));assert.equal(t.local.trash.size,0);}finally{t.stop();}
 });
 it("an explicitly enabled modification ceiling still rejects file deletion before dispatch",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");t.input.protectModifyPercentage=50;const r=await runSync(t.input);assert.equal(r.ok,false);assert.equal(t.deletes(),0);assert.ok(t.remote.files.has("note.md"));}finally{t.stop();}
 });

 it("recreated divergent pages cannot auto-merge against the pre-deletion ancestor",async()=>{
  const t=await scene();try{await t.base("note.md","one\ntwo\nthree\n");t.local.files.delete("note.md");await runSync(t.input);t.local.put("note.md","ONE\ntwo\nthree\n");t.remote.put("note.md","one\ntwo\nTHREE\n");const r=await runSync(t.input);assert.ok(r.contentSummary!.conflicts>0);const out=text(await t.local.readFile("note.md"));assert.ok(out.includes("<<<<<<< Obsidian")&&out.includes("ONE\ntwo\nthree\n")&&out.includes("one\ntwo\nTHREE\n"));}finally{t.stop();}
 });
 it("F1 on a recreated file retains the acknowledged upload but never inherits the dead old base",async()=>{
  const t=await scene();try{await t.base("note.md","one\ntwo\nthree\n");t.local.files.delete("note.md");await runSync(t.input);t.local.put("note.md","ONE\ntwo\nthree\n");t.remote.afterPut=()=>t.local.put("note.md","ONE\nTWO\nthree\n");const r=await runSync(t.input);assert.equal(r.fullyConverged,false);const rec=await t.rec("note.md");assert.equal(rec?.pendingLocalUpload,true);assert.equal(rec?.content?.status,"unbased");assert.equal(rec?.content?.cleanBaseRef,undefined);t.remote.afterPut=()=>{};t.remote.put("note.md","one\ntwo\nTHREE\n");const next=await runSync(t.input);assert.ok(next.contentSummary!.conflicts>0);assert.ok(text(await t.local.readFile("note.md")).includes("<<<<<<< Obsidian"));}finally{t.stop();}
 });

 it("binary attachments use actual bytes for deletion and restore, without weakening invalid Markdown protection",async()=>{
  const t=await scene();try{const original=new Uint8Array([0xff,0x00,0x01]).buffer,next=new Uint8Array([0xff,0x00,0x02]).buffer;t.local.put("a.bin","xxx");t.remote.put("a.bin","xxx");t.local.files.get("a.bin")!.bytes=original;t.remote.files.get("a.bin")!.bytes=original;t.remote.files.get("a.bin")!.entity.remoteFileId="900";let r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));t.local.files.delete("a.bin");t.remote.files.get("a.bin")!.bytes=next;r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));assert.deepEqual(new Uint8Array(await t.local.readFile("a.bin")),new Uint8Array(next));assert.equal(t.deletes(),0);t.remote.files.delete("a.bin");r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));assert.deepEqual(new Uint8Array(t.local.trash.get("a.bin")!),new Uint8Array(next));}finally{t.stop();}
 });

 it("committed deletion releases body budget but retains its exact tombstone proof",async()=>{
  const t=await scene();try{await t.base("note.md","x".repeat(128*1024));const rt=contentRuntime(t.input),before=(await t.rec("note.md"))!.content!.cleanBaseRef!;
   assert.ok(await t.db.fileContentHistoryTbl.getItem(before));t.local.files.delete("note.md");assert.equal((await runSync(t.input)).fullyConverged,true);
   assert.equal((await t.rec("note.md"))!.content!.cleanBaseRef,undefined);await rt.collect();
   assert.equal(await t.db.fileContentHistoryTbl.getItem(before),null);assert.equal((await rt.deletions.list())[0].phase,"committed");
   const keys=(await t.db.fileContentHistoryTbl.keys()).filter(k=>{try{const a=JSON.parse(k);return a[0]==="nextclaw-content"&&a[2]===rt.scope;}catch{return false;}});assert.equal(keys.length,0);
  }finally{t.stop();}
 });
 it("old deletion proof cannot collect inputs of a later rejected recreation",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");await runSync(t.input);const rt=contentRuntime(t.input),deletion=(await rt.deletions.list())[0];
   t.local.put("note.md","new rejected life");t.remote.status=412;await runSync(t.input);const ops=await rt.operations.list(rt.scope);const latest=ops.find(x=>x.phase==="rejected")!;assert.ok(latest);assert.equal(deletion.supersedes.includes(latest.id),false);
   await rt.collect();assert.equal((await rt.operations.list(rt.scope)).find(x=>x.id===latest.id)?.phase,"rejected");assert.ok(await t.db.fileContentHistoryTbl.getItem(latest.localRef!));
  }finally{t.stop();}
 });
 it("unknown deletion keeps the base pinned and refuses reset across a successful absence read",async()=>{
  const t=await scene();try{await t.base();const rt=contentRuntime(t.input),ref=(await t.rec("note.md"))!.content!.cleanBaseRef!;t.local.files.delete("note.md");t.status(504);await runSync(t.input);
   await assert.rejects(()=>rt.collect());assert.ok(await t.db.fileContentHistoryTbl.getItem(ref));await assert.rejects(()=>assertContentResetSafe(t.db,t.input.vaultRandomID,()=>{}));assert.equal(t.deletes(),1);
  }finally{t.stop();}
 });

 it("root reseed proves committed tombstones without retaining their deleted bodies",async()=>{
  const t=await scene();try{await t.base("old.md");t.local.files.delete("old.md");await runSync(t.input);await t.base("keep.md","keep local");t.remote.files.clear();t.remote.root=false;let calls=0;t.remote.checkContentRootParent=async()=>{};t.remote.restoreContentRoot=async()=>{calls++;t.remote.root=true;return{status:201};};
   const r=await runSync(t.input);assert.equal(r.fullyConverged,true,JSON.stringify(r));assert.equal(calls,1);assert.equal(t.remote.files.has("old.md"),false);assert.equal(text(await t.remote.readFile("keep.md")),"keep local");assert.equal((await contentRuntime(t.input).rootReseed.read())?.phase,"complete");
  }finally{t.stop();}
 });

 it("proven pre-dispatch ETag race remains pending and never creates unknown isolation",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");const set=t.db.fileContentHistoryTbl.setItem.bind(t.db.fileContentHistoryTbl);let once=true;
   t.db.fileContentHistoryTbl.setItem=async(k:any,v:any)=>{const out=await set(k,v);if(once&&v?.phase==="dispatched"&&v?.action==="delete-remote"){once=false;t.remote.put("note.md","edited just before DELETE");}return out;};
   const r=await runSync(t.input);assert.equal(r.contentSummary?.blocked,false);assert.equal(r.errors.length,0);assert.equal(t.journal.blocked(),false);assert.equal(t.deletes(),0);await checkVaultStages(t.db,t.input.vaultRandomID,()=>{});
   assert.equal((await runSync(t.input)).fullyConverged,true);assert.equal(text(await t.local.readFile("note.md")),"edited just before DELETE");
  }finally{t.stop();}
 });

 it("ordinary read failure before DELETE dispatch does not register an unknown write",async()=>{
  const t=await scene();try{await t.base();t.local.files.delete("note.md");const set=t.db.fileContentHistoryTbl.setItem.bind(t.db.fileContentHistoryTbl),read=t.remote.readContent.bind(t.remote);let failed=false;
   t.db.fileContentHistoryTbl.setItem=async(k:any,v:any)=>{const out=await set(k,v);if(v?.phase==="dispatched"&&v?.action==="delete-remote")failed=true;return out;};t.remote.readContent=async(k,e)=>{if(failed)throw Error("network unavailable before DELETE");return read(k,e);};
   assert.equal((await runSync(t.input)).ok,false);assert.equal(t.journal.blocked(),false);assert.equal(t.deletes(),0);await checkVaultStages(t.db,t.input.vaultRandomID,()=>{});failed=false;t.db.fileContentHistoryTbl.setItem=set;assert.equal((await runSync(t.input)).fullyConverged,true);assert.equal(t.deletes(),1);
  }finally{t.stop();}
 });

});
