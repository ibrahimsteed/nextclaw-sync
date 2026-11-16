import {strict as assert} from "assert";
import {RootReseed,checkRootStages,RootStagePaused}from"../../src/nextclaw/content/rootReseed";
import {NativeWriteJournal}from"../../src/nextclaw/nativeWriteJournal";
import type{ContentTable}from"../../src/nextclaw/content/store";
describe("P2 root completion evidence independent of native journal",()=>{
 it("lost durable completion after a settled MKCOL cannot be unlocked by a new owner or root read",async()=>{
  const rows=new Map<string,unknown>(),storage=new Map<string,string>();let active=true,calls=0;
  const table:ContentTable={getItem:async<T>(k:string)=>(structuredClone(rows.get(k))??null)as T|null,setItem:async<T>(k:string,v:T)=>{rows.set(k,structuredClone(v));return v},keys:async()=>[...rows.keys()]};
  const store={getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{storage.set(k,v)},removeItem:(k:string)=>{storage.delete(k)}};
  const journal=new NativeWriteJournal(store,"root");const scope=JSON.stringify(["v","p","https://synthetic.invalid","test","/vault",".obsidian",1]);const guard=()=>{if(!active)throw Error("retired")};
  const root=new RootReseed(table,scope,"https://synthetic.invalid/vault/",journal,guard);
  await assert.rejects(()=>root.restore(async()=>{calls++;active=false;return{status:201}},false),/retired/);
  const next=new NativeWriteJournal(store,"root");assert.equal(next.blocked(),false);
  await assert.rejects(()=>checkRootStages(table,"v",()=>{}),RootStagePaused);
  await assert.rejects(()=>checkRootStages(table,"v",()=>{}),RootStagePaused);assert.equal(calls,1);
  next.retire();journal.retire();
 });
});
