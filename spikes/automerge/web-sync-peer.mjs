import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import * as A from '@automerge/automerge';

const [docPath] = process.argv.slice(2);
if (!docPath) throw new Error('usage: node web-sync-peer.mjs <document.am>');

let doc = A.load(readFileSync(docPath), { actor: '77777777777777777777777777777777' });
let state = A.initSyncState();

function reply(line) {
  process.stdout.write(line + '\n');
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line === 'GEN') {
    let message;
    [state, message] = A.generateSyncMessage(doc, state);
    reply('MSG ' + (message ? Buffer.from(message).toString('base64') : '-'));
    continue;
  }
  if (line.startsWith('RECV ')) {
    const encoded = line.slice(5);
    if (encoded !== '-') {
      const message = Buffer.from(encoded, 'base64');
      [doc, state] = A.receiveSyncMessage(doc, state, message);
    }
    reply('OK');
    continue;
  }
  if (line === 'DOC') {
    reply('DOC ' + Buffer.from(A.save(doc)).toString('base64'));
    continue;
  }
  if (line === 'HEADS') {
    reply('HEADS ' + Buffer.from(JSON.stringify(A.getHeads(doc))).toString('base64'));
    continue;
  }
  if (line === 'QUIT') {
    reply('BYE');
    break;
  }
  reply('ERR unknown-command');
}

A.free(doc);
