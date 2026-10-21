import "fake-indexeddb/auto";
import { strict as assert } from "assert";
import { IdbConnectionPool, IdbStore } from "../../src/idbStore";
import { prepareDBs } from "../../src/localdb";

let sequence = 0;
const name = () => `lifecycle-${++sequence}`;
const raw = (key: string, version?: number) => new Promise<IDBDatabase>((ok,no) => {
  const r=version===undefined?indexedDB.open(key):indexedDB.open(key,version);
  r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains("items"))r.result.createObjectStore("items");};
  r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);r.onblocked=()=>no(Error("blocked"));
});
const fixture = () => {const pool=new IdbConnectionPool();const key=name();return {pool,key,table:new IdbStore(key,"items",["items"],pool)};};

describe("database connection ownership",()=>{
  it("closes native handles on disposal without deleting persisted records",async()=>{
    const {pool,key,table}=fixture();await table.setItem("note",{pending:true});pool.dispose();pool.dispose();
    const db=await raw(key,2);assert.equal(db.version,2);db.close();
    await assert.rejects(table.setItem("late","no"),/disposed/);
    const next=new IdbConnectionPool();const current=new IdbStore(key,"items",["items"],next);
    assert.deepEqual(await current.getItem("note"),{pending:true});next.dispose();
  });
  it("does not close or invalidate another owner's handle",async()=>{
    const {pool,key,table}=fixture();await table.setItem("note","old");const newer=new IdbConnectionPool();const next=new IdbStore(key,"items",["items"],newer);
    await next.getItem("note");pool.dispose();await next.setItem("note","new");await assert.rejects(table.getItem("note"),/disposed/);assert.equal(await next.getItem("note"),"new");newer.dispose();
  });
  it("closes an open that completes only after disposal",async()=>{
    const {pool,key,table}=fixture();const open=indexedDB.open.bind(indexedDB);let release!:()=>void;let ready!:()=>void;const held=new Promise<void>(r=>ready=r);
    const replacement=(...args:Parameters<IDBFactory["open"]>)=>{
      const req=open(...args);
      return new Proxy(req,{get(target,prop){return Reflect.get(target,prop,target);},set(target,prop,value){
        if(prop==="onsuccess"&&args[0]===key){target.onsuccess=(event)=>{release=()=>value.call(target,event);ready();};return true;}
        Reflect.set(target,prop,value,target);return true;
      }});
    };
    indexedDB.open=replacement;
    try{const read=table.getItem("note");const rejection=assert.rejects(read,/disposed|cancelled/);await held;pool.dispose();indexedDB.open=open;release();await rejection;
      const db=await raw(key,2);db.close();
    }finally{indexedDB.open=open;pool.dispose();}
  });
  it("allows a transaction already admitted before close to commit",async()=>{
    const {pool,key,table}=fixture();await table.getItem("note");const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore["put"]>){pool.dispose();return put.apply(this,args);};
    try{await table.setItem("note","committed");}finally{IDBObjectStore.prototype.put=put;}
    const next=new IdbConnectionPool();assert.equal(await new IdbStore(key,"items",["items"],next).getItem("note"),"committed");next.dispose();
  });
  it("can retry an open failure while the owner remains active",async()=>{
    const {pool,table}=fixture();const open=indexedDB.open.bind(indexedDB);indexedDB.open=()=>{throw Error("injected open failure");};
    try{await assert.rejects(table.getItem("note"),/injected/);}finally{indexedDB.open=open;}
    await table.setItem("note","retry");assert.equal(await table.getItem("note"),"retry");pool.dispose();
  });
  it("does not finish a rejected blocked upgrade after its owner is disposed",async()=>{
    const key=name(),external=await raw(key);const pool=new IdbConnectionPool();const table=new IdbStore(key,"extra",["items","extra"],pool);
    await assert.rejects(table.keys(),/blocked/);pool.dispose();external.close();
    const next=new IdbConnectionPool();const current=new IdbStore(key,"items",["items"],next);assert.deepEqual(await current.keys(),[]);next.dispose();
  });
  it("does not admit a transaction if disposal races the resolved connection",async()=>{
    const {pool,key,table}=fixture();await table.getItem("note");const database=pool.database.bind(pool);
    pool.database=async(...args)=>{const db=await database(...args);pool.dispose();return db;};
    await assert.rejects(table.setItem("late","not admitted"),/disposed/);
    const next=new IdbConnectionPool();assert.equal(await new IdbStore(key,"items",["items"],next).getItem("late"),null);next.dispose();
  });
  it("can retry a blocked schema open without retaining its rejected handle",async()=>{
    const key=name(),external=await raw(key);const pool=new IdbConnectionPool();const table=new IdbStore(key,"extra",["items","extra"],pool);
    await assert.rejects(table.keys(),/blocked/);external.close();await table.setItem("note","after retry");assert.equal(await table.getItem("note"),"after retry");pool.dispose();
  });
  it("reopens after versionchange for an active owner",async()=>{
    const {pool,key,table}=fixture();await table.setItem("note",1);const upgraded=await raw(key,2);upgraded.close();assert.equal(await table.getItem("note"),1);pool.dispose();
  });
  it("wires all production tables to the supplied owner",async()=>{
    const pool=new IdbConnectionPool();const path=`/lifecycle-vault-${++sequence}`;const first=await prepareDBs(path,"","webdav-default-1",pool);await first.db.simpleKVForMiscTbl.setItem("lifecycle-note","saved");pool.dispose();
    for(const table of Object.values(first.db))await assert.rejects(table.keys(),/disposed/);
    const next=new IdbConnectionPool();const second=await prepareDBs(path,"","webdav-default-1",next);assert.equal(second.vaultRandomID,first.vaultRandomID);assert.equal(await second.db.simpleKVForMiscTbl.getItem("lifecycle-note"),"saved");next.dispose();
  });
});
