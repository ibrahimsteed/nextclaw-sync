import {strict as assert} from "assert";
import {mutationPending} from "../../src/nextclaw/writeQuarantine";
describe("native-only build preserves legacy unknown-write quarantine",()=>{
 for(const suffix of ["",":recovery"]){
  for(const value of ["", "{}", "malformed", '{"operations":["old"]}']){
   it(`blocks an existing ${suffix || "write"} journal (${value})`,()=>{
    const entries=new Map([["vault"+suffix,value]]);
    assert.equal(mutationPending({getItem:k=>entries.get(k)??null},"vault"),true);
    assert.equal(entries.size,1);
   });
  }
 }
 it("allows only absence and propagates unavailable storage to the fail-closed caller",()=>{
  assert.equal(mutationPending({getItem:()=>null},"vault"),false);
  assert.throws(()=>mutationPending({getItem(){throw Error("storage unavailable");}},"vault"));
 });
});
