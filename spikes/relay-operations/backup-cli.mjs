#!/usr/bin/env node
// Operator-driven OFFLINE backup verification utility. No live snapshot support.
import { snapshot, verify, restore } from './store.mjs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const [,,cmd,source,dest,ack] = process.argv;
function main() {
  if (cmd === 'verify') {
    if (!source || dest) throw Error('Usage: backup-cli.mjs verify BACKUP');
    console.log(JSON.stringify({status:'verified',...verify(resolve(source))},null,2));return;
  }
  if (cmd === 'backup' || cmd === 'restore') {
    if (!source || !dest || ack !== '--server-stopped') throw Error(
      'Usage: backup-cli.mjs '+cmd+' SOURCE DEST --server-stopped\n' +
      'Stop the Rust process first. This switch is an operator assertion, NOT process detection.');
    const src=resolve(source),dst=resolve(dest);
    if (src === dst) throw Error('Source and destination must differ');
    if (cmd === 'backup') console.log(JSON.stringify(snapshot(src,dst,{serverStopped:true}),null,2));
    else console.log(JSON.stringify({status:'restored',files:restore(src,dst,{serverStopped:true}).length},null,2));
    return;
  }
  throw Error('Usage: backup-cli.mjs backup SOURCE DEST --server-stopped | verify BACKUP | restore BACKUP NEW_DIR --server-stopped');
}
try{main();}catch(e){console.error('Unsafe/incomplete operation: '+String(e));process.exitCode=1;}
