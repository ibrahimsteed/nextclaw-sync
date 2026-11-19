import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {journal,summarize} from './trace.mjs';

test('each row is recoverable before close and an unfinished write stays incomplete',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nextclaw-trace-'));
  const file=path.join(dir,'events.jsonl');
  const log=journal(file,{doc:1,paths:new Set(['a.md','b.md'])});
  try {
    const events=[
      ['a.md','group-dispatch',0],['b.md','group-dispatch',1],
      ['a.md','download-ready',10],['b.md','download-ready',40],
      ['a.md','group-released',43],['b.md','group-released',43],
      ['a.md','guarded-write:start',50],
    ];
    events.forEach(([path,phase,ms],i)=>log.append(JSON.stringify({doc:1,path,phase,ms,sequence:i+1,group:0,span:i+1})));
    const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
    const [fast,slow]=summarize(rows);
    assert.equal(fast.waitingForPeersMs,30);
    assert.equal(fast.settledToReleaseMs,3);
    assert.equal(fast.releaseToWriteMs,7);
    assert.equal(fast.readyToWriteMs,40);
    assert.deepEqual(fast.guardedWrite,[{ms:null,outcome:'incomplete'}]);
    assert.equal(slow.readyToWriteMs,null);
    assert.throws(()=>log.append(JSON.stringify({doc:1,path:'a.md',ms:60,sequence:9})),/sequence/);
    assert.throws(()=>log.append(JSON.stringify({doc:2,path:'a.md',ms:60,sequence:8})),/identity/);
    assert.equal(fs.readFileSync(file,'utf8').trim().split('\n').length,7);
  } finally {log.close();fs.rmSync(dir,{recursive:true,force:true});}
});
