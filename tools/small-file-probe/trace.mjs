import fs from 'node:fs';

export function journal(path, {doc, paths}) {
  const fd = fs.openSync(path, 'wx', 0o600);
  let last = 0, time = -1;
  return {
    append(payload) {
      const row = JSON.parse(payload);
      if (row.doc !== doc || !Number.isFinite(row.ms) || row.ms < time ||
          !Number.isSafeInteger(row.sequence) || (last && row.sequence !== last+1))
        throw Error('trace identity or sequence mismatch');
      last = row.sequence;
      time = row.ms;
      if (!paths.has(row.path)) throw Error('trace path outside fixture');
      fs.writeSync(fd, JSON.stringify(row)+'\n');
      fs.fsyncSync(fd);
    },
    close() {fs.closeSync(fd);},
  };
}

export function summarize(rows) {
  const paths = new Map(), groups = new Map();
  for (const row of rows) {
    if (!paths.has(row.path)) paths.set(row.path, []);
    paths.get(row.path).push(row);
    if (row.phase==='group-dispatch' || row.phase==='download-ready' || row.phase==='download-rejected') {
      const group = groups.get(row.group) ?? {dispatched:new Set(), settled:new Map()};
      groups.set(row.group,group);
      if (row.phase==='group-dispatch') group.dispatched.add(row.path);
      else group.settled.set(row.path,row.ms);
    }
  }
  const timestamp = (events, phase) => events.find(x=>x.phase===phase)?.ms;
  return [...paths].map(([path,events]) => {
    const ready = events.find(x=>x.phase==='download-ready');
    const group = groups.get(ready?.group);
    const write = timestamp(events,'guarded-write:start');
    const released = timestamp(events,'group-released');
    const settled = released!==undefined && group?.settled.size===group?.dispatched.size && group?.settled.size
      ? Math.max(...group.settled.values()) : undefined;
    const diff = (end,start) => end!==undefined && start!==undefined ? end-start : null;
    const spans = phase => events.filter(x=>x.phase===phase+':start').map(start=>{
      const end=events.find(x=>x.span===start.span && x.phase!==start.phase);
      return {ms:diff(end?.ms,start.ms),outcome:end?.phase.split(':').at(-1)??'incomplete'};
    });
    return {path,bytes:ready?.bytes??null,version:spans('version'),get:spans('get'),
      readyToWriteMs:diff(write,ready?.ms),waitingForPeersMs:diff(settled,ready?.ms),
      settledToReleaseMs:diff(released,settled),releaseToWriteMs:diff(write,released),
      guardedWrite:spans('guarded-write'),idbWrite:spans('idb-write'),
      idbRead:spans('idb-read'),checkpointReadback:spans('checkpoint-readback')};
  });
}
