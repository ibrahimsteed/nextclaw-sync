import fs from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {connect} from './cdp.mjs';
import {journal,summarize} from './trace.mjs';

const [port,vault,fixture,output] = process.argv.slice(2);
const paths = new Set(JSON.parse(fs.readFileSync(fixture)).files.map(f=>f.path));
const c = await connect(Number(port));
const binding = '__nextclawSmallFileProbe';
let log;
try {
  const identity = await c.evaluate('({doc:performance.timeOrigin,vault:window.app?.vault?.getName?.()})');
  if (identity.vault!==vault) throw Error('wrong probe vault');
  log = journal(output,{doc:identity.doc,paths});
  let failure;
  const verified = new Set();
  c.on('Runtime.bindingCalled',event=>{
    if(event.name!==binding || failure)return;
    try {
      log.append(event.payload);
      const row = JSON.parse(event.payload);
      if (row.phase==='checkpoint-readback-verified') verified.add(row.path);
    } catch(error) {failure=error;}
  });
  await c.call('Runtime.enable');
  await c.call('Runtime.addBinding',{name:binding});
  fs.writeFileSync(output+'.ready',JSON.stringify(identity)+'\n',{flag:'wx',mode:0o600});
  const start = performance.now();
  while(!failure && verified.size<paths.size && c.open() && performance.now()-start<180000 && !fs.existsSync(output+'.stop')) await sleep(100);
  if (failure) throw failure;
  if (verified.size<paths.size) throw Error(c.open()?'probe observation stopped before all readbacks':'probe document disconnected');
} finally {
  c.close();
  if(log){
    log.close();
    const rows=fs.readFileSync(output,'utf8').split('\n').filter(Boolean).map(JSON.parse);
    fs.writeFileSync(output+'.summary.json',JSON.stringify(summarize(rows),null,2)+'\n',{flag:'wx',mode:0o600});
  }
}
