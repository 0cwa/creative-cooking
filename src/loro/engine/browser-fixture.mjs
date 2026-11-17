// Isolated browser validation only: public deterministic test secrets, not pairing.
import {LoroDoc, decodeImportBlobMeta} from 'loro-crdt/base64';
import sodium from 'libsodium-wrappers';
import {openIndexedDBStorage} from '../storage/indexeddb.ts';
import {candidateCodec, SUITE} from '../crypto/candidate.mjs';
import {testProvider} from '../crypto/test-provider.mjs';
import {FixtureOfflineRuntime} from './runtime.mjs';
await sodium.ready;
const signing=sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(1));
const signingB=sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(4));
const recipient=sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(2));
const scope={scopeId:'house',documentId:'cooking',documentGeneration:0,branchHead:'head',authorizationSnapshot:'authority',policyHashes:['policy'],epochId:'epoch',authorDevice:new URL(location.href).searchParams.get('device')==='b'?'sender-b':'sender',acceptedAuthors:['sender','sender-b'],authorPeers:{sender:'1','sender-b':'2'},acceptedRecipients:['peer'],suiteId:SUITE};
const provider=testProvider(sodium,{signing,publicSigning:signing.publicKey,publicRecipient:recipient.publicKey,initialKey:new Uint8Array(32).fill(3)});
provider.sign=async (who,bytes)=>sodium.crypto_sign_detached(bytes,who==='sender'?signing.privateKey:signingB.privateKey);
provider.verify=async (who,bytes,signature)=>sodium.crypto_sign_verify_detached(signature,bytes,who==='sender'?signing.publicKey:signingB.publicKey);
const codec=candidateCodec(provider);
let current, fault=false;
async function open() {
 current=await openIndexedDBStorage('loro-runtime-test',b=>{if(fault && b==='local') throw Error('injected');});
 const state=new TextEncoder().encode(JSON.stringify({acceptedAuthors:scope.acceptedAuthors,authorPeers:scope.authorPeers,acceptedRecipients:scope.acceptedRecipients,epochId:scope.epochId,policyHashes:scope.policyHashes,documentId:scope.documentId,documentGeneration:scope.documentGeneration}));
 const record=await current.storage.readPairingAuthority({kind:'household',id:'house'});
 if (!record.ok) throw Error(record.error);
 if (!record.value) { const r=await current.storage.compareAndSwapPairingAuthority({expectedRevision:null,record:{scope:{kind:'household',id:'house'},revision:0,acceptedParent:'head',authorizationSnapshot:'authority',authorityState:state}}); if(!r.ok) throw Error(r.error); }
 current.runtime=new FixtureOfflineRuntime({storage:current.storage,codec,LoroDoc,decodeImportBlobMeta,scope,keyRef:'data'});
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
