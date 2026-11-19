import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const dir=process.argv[2];
fs.mkdirSync(dir,{mode:0o700});
const files=[];
const sizes=[2048,4096,8192,16384,32768,65536,131072,262144];
for(let i=0;i<64;i++){
  const name='small-'+String(i).padStart(3,'0')+'.md';
  const header=Buffer.from('# Small file '+i+'\n\n');
  const bytes=Buffer.alloc(sizes[(i*3+Math.floor(i/8))%sizes.length],0x61);
  header.copy(bytes);
  bytes[bytes.length-1]=10;
  fs.writeFileSync(path.join(dir,name),bytes,{flag:'wx',mode:0o600});
  files.push({path:name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
fs.writeFileSync(dir+'.json',JSON.stringify({files},null,2)+'\n',{flag:'wx',mode:0o600});
