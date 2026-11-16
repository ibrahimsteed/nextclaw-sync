import {strict as assert} from "assert";
import {selectBatch, type BatchState} from "../../src/nextclaw/content/batches";
describe("bounded content scheduling",()=>{
 it("selects small pages before the oldest large file regardless of lexical name",()=>{
  const r=selectBatch([{path:"a.bin",size:3*1024*1024},{path:"z.md",size:20}]);
  assert.deepEqual(r.selected,["z.md","a.bin"]);assert.equal(r.next.remaining.length,0);
 });
 it("revisits completed small pages and prioritizes durable tails even beyond the small-page lane",()=>{
  const e=[...Array.from({length:40},(_,i)=>({path:`small${i}`,size:5})),{path:"old-big",size:3000000},{path:"next-big",size:3000000}];
  const first=selectBatch(e);const next=selectBatch(e.map(x=>({...x,urgent:x.path==="small0"})),first.next);
  assert.equal(next.selected[0],"small0");assert.ok(next.selected.includes("old-big"));
  assert.equal(new Set(next.next.completed).size,next.next.completed.length);
 });
 it("bounds each admission to 32 small files plus one oldest item",()=>{
  const entries=Array.from({length:100},(_,i)=>({path:`${i}.md`,size:30}));
  assert.equal(selectBatch(entries).selected.length,33);
 });
 it("persists a finite sweep across reloads and new small arrivals cannot starve old large files",()=>{
  let entries=Array.from({length:5},(_,i)=>({path:`big${i}`,size:3000000}));
  let state:BatchState|undefined;const served=new Set<string>();
  for(let n=0;n<5;n++){
   entries=[...entries,...Array.from({length:40},(_,i)=>({path:`new${n}-${i}`,size:10}))];
   const b=selectBatch(entries,state);state=JSON.parse(JSON.stringify(b.next));
   b.selected.filter(x=>x.startsWith("big")).forEach(x=>served.add(x));
  }
  assert.equal(served.size,5);
 });
 it("does not perpetually reappend already served files in a continuation",()=>{
  const e=Array.from({length:10},(_,i)=>({path:`big${i}`,size:3000000}));
  let state:BatchState|undefined;let n=0;
  do {const b=selectBatch(e,state);n+=b.selected.length;state=b.next;}while(state.remaining.length);
  assert.equal(n,10);assert.equal(selectBatch(e,state).selected.length,1);
 });
 it("rejects corrupt persisted hints; filters deleted paths and does not reuse observations",()=>{
  assert.throws(()=>selectBatch([],{version:2} as any));
  const b=selectBatch([{path:"x",size:10}],{version:1,remaining:["deleted","x"],completed:[]});
  assert.deepEqual(b.selected,["x"]);
 });
});
