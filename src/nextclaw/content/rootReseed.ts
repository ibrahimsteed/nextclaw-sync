import { nanoid } from "nanoid";
import type { ContentTable } from "./store";
import { hashBytes } from "./identity";
import type { NativeWriteJournal } from "../nativeWriteJournal";
import { terminalReceipt } from "../nativeWriteJournal";
export class RootStagePaused extends Error {}
export interface RootIntent {
 version: 1; id: string; scope: string; endpoint: string; owner: string;
 intent: string; phase: "prepared" | "dispatched" | "reseed" | "complete" | "rejected";
 receipt?: { id: string; intent: string; owner: string; status: number };
}
const prefix="nextclaw-content-root";
const key=(scope:string)=>JSON.stringify([prefix,1,scope]);
const digest=(o:RootIntent)=>hashBytes(new TextEncoder().encode(JSON.stringify([o.version,o.id,o.scope,o.endpoint,o.owner])).buffer);
export class RootReseed {
 constructor(private table:ContentTable,readonly scope:string,private endpoint:string,private journal:NativeWriteJournal,private guard:()=>void){}
 async read() {
  this.guard();const o=await this.table.getItem<RootIntent>(key(this.scope));this.guard();if(o===null)return;
  if(o.version!==1||o.scope!==this.scope||o.endpoint!==this.endpoint||!o.id||!o.owner||!["prepared","dispatched","reseed","complete","rejected"].includes(o.phase)||o.intent!==await digest(o))throw Error("invalid-root-intent");
  this.guard();if(["reseed","complete","rejected"].includes(o.phase)){
   const a=o.receipt;if(!a||a.id!==o.id||a.intent!==o.intent||a.owner!==o.owner||
    (o.phase==="rejected" ? !terminalReceipt("MKCOL",a.status)||a.status===201 : a.status!==201))throw Error("invalid-root-receipt");
  }
  return structuredClone(o);
 }
 private async save(o:RootIntent) {
  const old=await this.read();this.guard();
  const next:Record<RootIntent["phase"],string[]>={prepared:["dispatched"],dispatched:["reseed","rejected"],reseed:["complete"],complete:["prepared"],rejected:["prepared"]};
  if(old ? !next[old.phase].includes(o.phase)||(!["complete","rejected"].includes(old.phase)&&old.intent!==o.intent) : o.phase!=="prepared")throw Error("invalid-root-transition");
  this.guard();await this.table.setItem(key(this.scope),structuredClone(o));this.guard();if(JSON.stringify(await this.read())!==JSON.stringify(o))throw Error("root-readback-failed");
 }
 async restore(send:()=>Promise<{status:number}>,nativeManaged:boolean) {
  const old=await this.read();this.guard();
  if(old&&!["complete","rejected"].includes(old.phase))throw Error("root-restore-already-started-no-replay");
  const o:RootIntent={version:1,id:nanoid(),scope:this.scope,endpoint:this.endpoint,owner:this.journal.token,intent:"",phase:"prepared"};
  o.intent=await digest(o);this.guard();await this.save(o);o.phase="dispatched";await this.save(o);
  const response=await(nativeManaged?send():this.journal.send("MKCOL",this.endpoint,null,send));this.guard();
  o.receipt={id:o.id,owner:o.owner,intent:o.intent,status:response.status};o.phase=response.status===201?"reseed":"rejected";await this.save(o);
  if(o.phase!=="reseed")throw Error(`root-restore-rejected-${response.status}`);
 }
 async active(){return(await this.read())?.phase==="reseed";}
 async finish(){const o=await this.read();this.guard();if(o?.phase==="reseed"){o.phase="complete";await this.save(o);}}
}
/** Root state also blocks A/config across unload, including a lost MKCOL receipt. */
export async function checkRootStages(table:ContentTable,vault:string,guard:()=>void) {
 for(const k of await table.keys()){
  guard();let parts:unknown;try{parts=JSON.parse(k);}catch{continue;}
  if(!Array.isArray(parts)||parts[0]!==prefix)continue;
  if(parts.length!==3||parts[1]!==1||typeof parts[2]!=="string")throw Error("invalid-root-stage-key");
  const scope:unknown=JSON.parse(parts[2]);if(!Array.isArray(scope))throw Error("invalid-root-stage-scope");if(scope[0]!==vault)continue;
  const o=await table.getItem<RootIntent>(k);guard();
  if(!o||o.scope!==parts[2]||o.version!==1||o.intent!==await digest(o)||!o.owner||!o.id||
   !["prepared","dispatched","reseed","complete","rejected"].includes(o.phase))throw Error("invalid-root-stage");
  guard();if(o.phase==="dispatched"||o.phase==="prepared")throw new RootStagePaused("root-completion-unknown-no-replay");
  if(["reseed","complete","rejected"].includes(o.phase)){
   const a=o.receipt;if(!a||a.id!==o.id||a.intent!==o.intent||a.owner!==o.owner||
    (o.phase==="rejected" ? !terminalReceipt("MKCOL",a.status)||a.status===201 : a.status!==201))throw Error("invalid-root-stage-receipt");
  }
 }
}
