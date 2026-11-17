import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, verify, createHash, randomBytes, createCipheriv, createDecipheriv} from 'node:crypto';
import {candidateCodec, SUITE} from './candidate.mjs';
import {candidatePairing, ceremonyBytes} from '../pairing/candidate.mjs';
// Test-only provider: Node's AES-GCM exercises the injectable boundary, not the named candidate suite.
const pair = generateKeyPairSync('ed25519'), key = randomBytes(32);
const p = {hash:async b=>new Uint8Array(createHash('sha256').update(b).digest()), sign:async (_,b)=>new Uint8Array(sign(null,b,pair.privateKey)),verify:async (_,b,s)=>verify(null,b,pair.publicKey,s),
 encrypt:async (_,plain,aad)=>{const n=randomBytes(12), c=createCipheriv('aes-256-gcm',key,n); c.setAAD(aad); return new Uint8Array(Buffer.concat([n,c.update(plain),c.final(),c.getAuthTag()]));},
 decrypt:async (_,e,aad)=>{const d=createDecipheriv('aes-256-gcm',key,e.slice(0,12)); d.setAAD(aad); d.setAuthTag(e.slice(-16)); return new Uint8Array(Buffer.concat([d.update(e.slice(12,-16)),d.final()]));},
 wrap:async (_,ref,aad)=>p.encrypt('',new TextEncoder().encode(ref),aad), unwrap:async (h,e,aad)=>new TextDecoder().decode(await p.decrypt(h,e,aad))};
const h={version:1,suiteId:SUITE,scopeId:'s',documentId:'d',documentGeneration:0,branchHead:'b',policyHashes:['p'],epochId:'e',authorDevice:'a',deviceSequence:0,predecessorRefs:[],semanticEffectIds:[],payloadKind:'update'};
test('candidate authenticated record, canonical encoding and tamper rejection',async()=>{const c=candidateCodec(p), sealed=await c.sealContent(h,new Uint8Array([1,2]),'k'); const opened=await c.openContent(sealed.bytes); assert.deepEqual(opened.value,new Uint8Array([1,2])); assert.equal(opened.object.id,sealed.id); const obj=JSON.parse(new TextDecoder().decode(sealed.bytes)); obj.header.scopeId='other'; await assert.rejects(c.openContent(new TextEncoder().encode(JSON.stringify(obj))),/INVALID_PROOF/); await assert.rejects(c.openContent(new TextEncoder().encode(' '+new TextDecoder().decode(sealed.bytes))),/MALFORMED/); await assert.rejects(c.sealContent({...h,policyHashes:['x','x']},new Uint8Array(),'k'),/MALFORMED/); });
test('candidate pairing binds complete ceremony and cannot release',async()=>{const role=(deviceId,n)=>({deviceId,signingKey:'ab'.repeat(32),wrappingKey:'cd'.repeat(32),nonce:n.repeat(64)}); const t={version:1,sessionId:'s',action:'pairOwnDevice',scopeKind:'household',scopeId:'h',parentHead:'p',authorizationSnapshot:'a',initiator:role('i','1'),responder:role('r','2'),signaling:['abcd']}; const original=ceremonyBytes(t); assert.notDeepEqual(original,ceremonyBytes({...t,signaling:['abce']})); const deps=Object.fromEntries(['outOfBand','confirmations','possession','authorize','replay'].map(k=>[k,async b=>Buffer.from(b).equals(Buffer.from(original))])); const pairing=candidatePairing(deps); await pairing.verify(t,[]); await assert.rejects(pairing.verify({...t,parentHead:'different'},[]),/INVALID_PROOF/); await assert.rejects(pairing.releaseKeys(),/RELEASE_UNAVAILABLE/); });

test('libsodium candidate transports real symmetric key material',async()=>{
 const sodium=(await import('libsodium-wrappers')).default; await sodium.ready;
 const {testProvider}=await import('./test-provider.mjs');
 const signing=sodium.crypto_sign_keypair(), recipient=sodium.crypto_box_keypair(), dataKey=sodium.randombytes_buf(32);
 const publicKeys={publicSigning:signing.publicKey,publicRecipient:recipient.publicKey};
 const sender=candidateCodec(testProvider(sodium,{...publicKeys,signing,initialKey:dataKey}));
 const receiver=candidateCodec(testProvider(sodium,{...publicKeys,recipient}));
 const ch={...h,authorDevice:'sender'};
 const kh={version:1,suiteId:SUITE,scopeId:'s',branchHead:'b',policyHashes:['p'],epochId:'e',recipientDevice:'recipient',keyPurpose:'data',senderDevice:'sender'};
 const content=await sender.sealContent(ch,new Uint8Array([7]),'data');
 await assert.rejects(receiver.openContent(content.bytes),/MISSING_KEY/);
 const wrapped=await sender.wrapKey(kh,'data');
 assert.equal(Buffer.from(wrapped.bytes).includes(Buffer.from(dataKey)),false);
 assert.equal(new TextDecoder().decode(wrapped.bytes).includes(Buffer.from(dataKey).toString('hex')),false);
 assert.equal((await receiver.openKey(wrapped.bytes)).value,'data');
 assert.deepEqual((await receiver.openContent(content.bytes)).value,new Uint8Array([7]));
 const record=JSON.parse(new TextDecoder().decode(wrapped.bytes));
 for (const [field,value] of Object.entries({scopeId:'other',branchHead:'other',policyHashes:['other'],epochId:'other',recipientDevice:'other',keyPurpose:'other',senderDevice:'other'})) {
  const altered=structuredClone(record); altered.header[field]=value;
  await assert.rejects(receiver.openKey(new TextEncoder().encode(JSON.stringify(altered))));
 }
 for (const field of ['encrypted','signature']) {const altered=structuredClone(record); altered[field]=(altered[field][0]==='0'?'1':'0')+altered[field].slice(1); await assert.rejects(receiver.openKey(new TextEncoder().encode(JSON.stringify(altered))));}
 for (const [field,value] of Object.entries({documentId:'other',documentGeneration:1,deviceSequence:1,predecessorRefs:['other'],semanticEffectIds:['other'],payloadKind:'other',scopeId:'other',branchHead:'other',policyHashes:['other'],epochId:'other',authorDevice:'other'})) {const altered=JSON.parse(new TextDecoder().decode(content.bytes)); altered.header[field]=value; await assert.rejects(receiver.openContent(new TextEncoder().encode(JSON.stringify(altered))));}
 // Valid signature over damaged ciphertext must still fail the AEAD tag.
 const damaged=JSON.parse(new TextDecoder().decode(content.bytes)); damaged.encrypted=damaged.encrypted.slice(0,-2)+(damaged.encrypted.endsWith('00')?'01':'00');
 const unsigned={kind:damaged.kind,header:damaged.header,encrypted:damaged.encrypted};
 const signed=new TextEncoder().encode(JSON.stringify(['creative-cooking/k2-candidate/v1','content/signature',unsigned]));
 damaged.signature=Buffer.from(sodium.crypto_sign_detached(signed,signing.privateKey)).toString('hex');
 await assert.rejects(receiver.openContent(new TextEncoder().encode(JSON.stringify(damaged))));
 const wrongDomain=structuredClone(record); const unsignedKey={kind:wrongDomain.kind,header:wrongDomain.header,encrypted:wrongDomain.encrypted};
 wrongDomain.signature=Buffer.from(sodium.crypto_sign_detached(new TextEncoder().encode(JSON.stringify(['other-domain','key/signature',unsignedKey])),signing.privateKey)).toString('hex');
 await assert.rejects(receiver.openKey(new TextEncoder().encode(JSON.stringify(wrongDomain))),/INVALID_PROOF/);
 const duplicate=new TextDecoder().decode(wrapped.bytes).replace('{\"kind\":','{\"kind\":\"key\",\"kind\":');
 await assert.rejects(receiver.openKey(new TextEncoder().encode(duplicate)),/MALFORMED/);
 const altered=structuredClone(record); altered.header.version=2; await assert.rejects(receiver.openKey(new TextEncoder().encode(JSON.stringify(altered))),/UNSUPPORTED_VERSION/);
 altered.header.version=1; altered.header.suiteId='other'; await assert.rejects(receiver.openKey(new TextEncoder().encode(JSON.stringify(altered))),/UNSUPPORTED_SUITE/);
 await assert.rejects(receiver.openKey(new Uint8Array(2100000)),/TOO_LARGE/);
 await assert.rejects(receiver.openKey(new TextEncoder().encode('{"kind":"key","kind":"key"}')),/MALFORMED/);
 await assert.rejects(receiver.openKey(new TextEncoder().encode(' ' + new TextDecoder().decode(wrapped.bytes))),/MALFORMED/);
});
