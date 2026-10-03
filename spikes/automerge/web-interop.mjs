import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as A from '@automerge/automerge';

const WEB_ACTOR = '77777777777777777777777777777777';
const WEB_AUTHOR = Buffer.from('web').toString('hex');

function writeDoc(path, doc) {
  writeFileSync(path, A.save(doc));
}

function readDoc(path, options = {}) {
  return A.load(readFileSync(path), options);
}

function writeState(path, state) {
  writeFileSync(path, A.encodeSyncState(state));
}

function readState(path) {
  return existsSync(path) && readFileSync(path).byteLength
    ? A.decodeSyncState(readFileSync(path))
    : A.initSyncState();
}

function baseDoc(withAuthor = false) {
  let doc = A.init(withAuthor ? { author: WEB_AUTHOR } : { actor: WEB_ACTOR });
  doc = A.change(doc, { message: 'web interop seed', time: 1700000000 }, (d) => {
    d.interop = {
      webCreated: true,
      nativeModified: '',
      webConcurrent: '',
      nativeConcurrent: '',
      resolvedBy: '',
      counter: 1
    };
  });
  return doc;
}

function assertNativeMutation(doc, label) {
  assert.equal(doc.interop.webCreated, true);
  assert.equal(doc.interop.nativeModified, label);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'create': {
    const [out] = args;
    writeDoc(out, baseDoc(false));
    console.log(JSON.stringify({ command, out, bytes: readFileSync(out).byteLength }));
    break;
  }
  case 'create-authored': {
    const [out] = args;
    writeDoc(out, baseDoc(true));
    console.log(JSON.stringify({ command, out, author: WEB_AUTHOR, bytes: readFileSync(out).byteLength }));
    break;
  }
  case 'verify-native': {
    const [input, expectedLabel] = args;
    const doc = readDoc(input, { actor: WEB_ACTOR });
    assertNativeMutation(doc, expectedLabel);
    console.log(JSON.stringify({ command, input, logical: JSON.parse(JSON.stringify(doc)), heads: A.getHeads(doc) }));
    A.free(doc);
    break;
  }
  case 'fork-edit': {
    const [input, out] = args;
    let doc = readDoc(input, { actor: WEB_ACTOR });
    doc = A.change(doc, { message: 'web concurrent edit', time: 1700000100 }, (d) => {
      d.interop.webConcurrent = 'web-edit-survived';
    });
    writeDoc(out, doc);
    console.log(JSON.stringify({ command, out, heads: A.getHeads(doc) }));
    A.free(doc);
    break;
  }
  case 'sync-generate': {
    const [docPath, statePath, messagePath] = args;
    const doc = readDoc(docPath, { actor: WEB_ACTOR });
    let state = readState(statePath);
    let message;
    [state, message] = A.generateSyncMessage(doc, state);
    writeState(statePath, state);
    writeFileSync(messagePath, message ?? new Uint8Array());
    console.log(JSON.stringify({ command, messageBytes: message?.byteLength ?? 0 }));
    A.free(doc);
    break;
  }
  case 'sync-receive': {
    const [docPath, statePath, messagePath] = args;
    let doc = readDoc(docPath, { actor: WEB_ACTOR });
    let state = readState(statePath);
    const message = readFileSync(messagePath);
    if (message.byteLength) {
      [doc, state] = A.receiveSyncMessage(doc, state, message);
    }
    writeDoc(docPath, doc);
    writeState(statePath, state);
    console.log(JSON.stringify({ command, messageBytes: message.byteLength, heads: A.getHeads(doc) }));
    A.free(doc);
    break;
  }
  case 'verify-converged': {
    const [webPath, nativePath] = args;
    const web = readDoc(webPath, { actor: WEB_ACTOR });
    const native = readDoc(nativePath, { actor: '88888888888888888888888888888888' });
    const a = JSON.parse(JSON.stringify(web));
    const b = JSON.parse(JSON.stringify(native));
    assert.deepEqual(a, b);
    assert.equal(a.interop.webConcurrent, 'web-edit-survived');
    assert.equal(a.interop.nativeConcurrent, 'native-edit-survived');
    console.log(JSON.stringify({ command, converged: true, logical: a, webHeads: A.getHeads(web), nativeHeads: A.getHeads(native) }));
    A.free(web);
    A.free(native);
    break;
  }
  case 'resolve': {
    const [input, out] = args;
    let doc = readDoc(input, { actor: WEB_ACTOR });
    doc = A.change(doc, { message: 'web resolution after cross-platform sync', time: 1700000300 }, (d) => {
      d.interop.resolvedBy = 'web-after-native-sync';
    });
    writeDoc(out, doc);
    console.log(JSON.stringify({ command, heads: A.getHeads(doc), resolvedBy: doc.interop.resolvedBy }));
    A.free(doc);
    break;
  }
  default:
    mkdirSync('artifacts', { recursive: true });
    throw new Error(
      'Usage: web-interop.mjs create|create-authored|verify-native|fork-edit|sync-generate|sync-receive|verify-converged|resolve ...'
    );
}
