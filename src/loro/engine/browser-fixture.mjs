// Isolated browser validation only: public deterministic test secrets, not pairing.
import {LoroDoc, decodeImportBlobMeta} from 'loro-crdt/base64';
import sodium from 'libsodium-wrappers';
import {openIndexedDBStorage} from '../storage/indexeddb.ts';
import {candidateCodec, SUITE} from '../crypto/candidate.mjs';
import {testProvider} from '../crypto/test-provider.mjs';
import {OfflineRuntime} from './runtime.mjs';
await sodium.ready;
const signing=sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(1));
const recipient=sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(2));
const scope={scopeId:'house',documentId:'cooking',documentGeneration:0,branchHead:'head',authorizationSnapshot:'authority',policyHashes:['policy'],epochId:'epoch',authorDevice:'sender',acceptedAuthors:['sender'],acceptedRecipients:['peer'],suiteId:SUITE};
const codec=candidateCodec(testProvider(sodium,{signing,publicSigning:signing.publicKey,publicRecipient:recipient.publicKey,initialKey:new Uint8Array(32).fill(3)}));
let current, fault=false;
async function open() {
 current=await openIndexedDBStorage('loro-runtime-test',b=>{if(fault && b==='local') throw Error('injected');});
 const state=new TextEncoder().encode(JSON.stringify({acceptedAuthors:scope.acceptedAuthors,acceptedRecipients:scope.acceptedRecipients,epochId:scope.epochId,policyHashes:scope.policyHashes,documentId:scope.documentId,documentGeneration:scope.documentGeneration}));
 const record=await current.storage.readPairingAuthority({kind:'household',id:'house'});
 if (!record.ok) throw Error(record.error);
 if (!record.value) { const r=await current.storage.compareAndSwapPairingAuthority({expectedRevision:null,record:{scope:{kind:'household',id:'house'},revision:0,acceptedParent:'head',authorizationSnapshot:'authority',authorityState:state}}); if(!r.ok) throw Error(r.error); }
 current.runtime=new OfflineRuntime({storage:current.storage,codec,LoroDoc,decodeImportBlobMeta,scope,keyRef:'data'});
}
await open();
window.runtimeTest={
 fault:v=>{fault=v;},
 execute:(operationId,command,deviceSequence)=>current.runtime.execute({operationId,command,deviceSequence}),
 read:()=>current.runtime.read(),
 outbound:async()=> (await current.runtime.outboundFor('peer')).map(o=>({objectId:o.objectId,bytes:Array.from(o.bytes)})),
 stage:async(o,n)=>current.storage.stageInbox({scopeId:'house',object:{id:o.objectId,bytes:Uint8Array.from(o.bytes)},source:'peer',expectedCursor:n===0?null:String(n-1),cursor:String(n)}),
 recover:async()=> (await current.runtime.recoverInbox()).map(x=>({itemId:x.itemId,error:x.error?.message,replayed:x.result?.replayed})),
 reopen:async()=>{current.close();await open();},
};
