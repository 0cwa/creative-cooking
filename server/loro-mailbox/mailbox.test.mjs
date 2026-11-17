import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,verify,createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {openMailbox,randomMailboxSecrets} from './server.mjs';
import {relayClient,ed25519ReceiptVerifier} from '../../src/loro/relay/client.mjs';
import {candidateCodec,SUITE} from '../../src/loro/crypto/candidate.mjs';
import {testProvider} from '../../src/loro/crypto/test-provider.mjs';
import sodium from 'libsodium-wrappers';
await sodium.ready;
const hash=b=>createHash('sha256').update(b).digest();
const hashProvider={hash:async b=>sodium.crypto_generichash(32,b)};
const encoder=new TextEncoder();
test('HTTP encrypted candidate, durable retry, quota, cursors, expiry and verified relay receipt',async()=>{
 const root=process.env.MAILBOX_TEST_ROOT;if(!root) throw Error('MAILBOX_TEST_ROOT required');const dir=await mkdtemp(join(root,'mailbox-'));const path=join(dir,'mailbox.sqlite');
 const relayKeys=generateKeyPairSync('ed25519'), deviceKeys=generateKeyPairSync('ed25519'), key=randomBytes(32), secrets=randomMailboxSecrets();let now=1000, service;
 const signing=sodium.crypto_sign_keypair(),recipient=sodium.crypto_box_keypair();
 const provider=testProvider(sodium,{signing,recipient,publicSigning:signing.publicKey,publicRecipient:recipient.publicKey,initialKey:sodium.randombytes_buf(32)});
 const codec=candidateCodec(provider),h={version:1,suiteId:SUITE,scopeId:'scope',documentId:'doc',documentGeneration:0,branchHead:'head',policyHashes:[],epochId:'epoch',authorDevice:'sender',deviceSequence:1,predecessorRefs:[],semanticEffectIds:[],payloadKind:'update'};
 const one=await codec.sealContent(h,encoder.encode('secret recipe'),'data'),two=await codec.sealContent({...h,deviceSequence:2},encoder.encode('second'),'data'),three=await codec.sealContent({...h,deviceSequence:3},encoder.encode('third'),'data');
 const {relayId,verifyReceipt}=await ed25519ReceiptVerifier(new Uint8Array(relayKeys.publicKey.export({type:'spki',format:'der'})));
 assert.equal(relayId,hash(relayKeys.publicKey.export({type:'spki',format:'der'})).toString('hex'));
 async function start(){service=openMailbox({path,signingKey:relayKeys.privateKey,hashProvider,now:()=>now});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const baseUrl=`http://127.0.0.1:${service.server.address().port}`;return {baseUrl,client:relayClient({baseUrl,mailbox:secrets.id,relayId,...secrets,hashProvider,verifyReceipt})};}
 async function stop(){await new Promise((resolve,reject)=>service.server.close(e=>e?reject(e):resolve()));service.close();}
 try {let {baseUrl,client}=await start();service.provision({...secrets,quota:one.bytes.length+two.bytes.length,expires:2000});
  const receipt=await client.put(one);assert.equal(receipt.claims.kind,'relay-stored');assert.deepEqual(await client.put(one),receipt);assert.deepEqual((await codec.openContent((await client.get(one.id)).bytes)).value,encoder.encode('secret recipe'));
  await client.put(two);await assert.rejects(client.put(three),/QUOTA_FULL/);const first=await client.list({limit:1}),second=await client.list({after:first.cursor,limit:1});assert.equal(first.objects[0].id,one.id);assert.equal(second.objects[0].id,two.id);assert.deepEqual(await client.list({after:second.cursor,limit:1}),{objects:[],cursor:two.id});await assert.rejects(client.list({after:'f'.repeat(64)}),/CURSOR/);
  const bad=await fetch(`${baseUrl}/v1/mailboxes/${secrets.id}/objects/${one.id}`,{method:'PUT',headers:{authorization:`Bearer ${secrets.appendCapability}`},body:new Uint8Array([1])});assert.equal(bad.status,400);assert.equal((await bad.json()).error,'HASH_MISMATCH');
  const unauthorized=await fetch(`${baseUrl}/v1/mailboxes/${secrets.id}/objects/${one.id}`,{headers:{authorization:`Bearer ${secrets.appendCapability}`}});assert.equal(unauthorized.status,401);
  const distrust=relayClient({baseUrl,mailbox:secrets.id,relayId,...secrets,hashProvider,verifyReceipt:async()=>false});await assert.rejects(distrust.put(one),/INVALID_PROOF/);
  await stop();({client}=await start());assert.deepEqual(await client.put(one),receipt);assert.deepEqual((await client.get(two.id)).bytes,two.bytes);now=2000;await assert.rejects(client.get(one.id),/EXPIRED/);await stop();service=null;
 } finally {if(service){await new Promise(r=>service.server.close(r));service.close();}await rm(dir,{recursive:true,force:true});}
});

test('colliding identity cannot replace different durable bytes',async()=>{const root=process.env.MAILBOX_TEST_ROOT;const dir=await mkdtemp(join(root,'mailbox-'));const pair=generateKeyPairSync('ed25519'),secrets=randomMailboxSecrets(),id='aa'.repeat(32),hashProvider={hash:async()=>new Uint8Array(32).fill(170)};const service=openMailbox({path:join(dir,'db'),signingKey:pair.privateKey,hashProvider});try{service.provision({...secrets,quota:100,expires:Date.now()+10000});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${service.server.address().port}/v1/mailboxes/${secrets.id}/objects/${id}`;const put=body=>fetch(url,{method:'PUT',headers:{authorization:`Bearer ${secrets.appendCapability}`},body});assert.equal((await put('one')).status,201);assert.equal((await put('two')).status,409);}finally{await new Promise(r=>service.server.close(r));service.close();await rm(dir,{recursive:true,force:true});}});
