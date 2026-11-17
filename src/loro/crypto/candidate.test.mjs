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

test('libsodium candidate signs, encrypts and wraps with real primitives',async()=>{
 const sodium=(await import('libsodium-wrappers')).default; await sodium.ready;
 const signing=sodium.crypto_sign_keypair(), recipient=sodium.crypto_box_keypair(), dataKey=sodium.randombytes_buf(32);
 const provider={hash:async b=>sodium.crypto_generichash(32,b),sign:async (_,b)=>sodium.crypto_sign_detached(b,signing.privateKey),verify:async (_,b,s)=>sodium.crypto_sign_verify_detached(s,b,signing.publicKey),
 encrypt:async (_,v,a)=>{const n=sodium.randombytes_buf(24); return sodium.memcmp(n,n) && new Uint8Array([...n,...sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(v,a,null,n,dataKey)]);},
 decrypt:async (_,v,a)=>sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,v.slice(24),a,v.slice(0,24),dataKey),
 wrap:async (_,ref)=>sodium.crypto_box_seal(new TextEncoder().encode(ref),recipient.publicKey),unwrap:async (_,v)=>new TextDecoder().decode(sodium.crypto_box_seal_open(v,recipient.publicKey,recipient.privateKey))};
 const c=candidateCodec(provider), content=await c.sealContent(h,new Uint8Array([7]),'data'); assert.deepEqual((await c.openContent(content.bytes)).value,new Uint8Array([7]));
 const kh={version:1,suiteId:SUITE,scopeId:'s',branchHead:'b',policyHashes:['p'],epochId:'e',recipientDevice:'r',keyPurpose:'data',senderDevice:'a'};
 const wrapped=await c.wrapKey(kh,'key-ref'); assert.equal((await c.openKey(wrapped.bytes)).value,'key-ref');
 const obj=JSON.parse(new TextDecoder().decode(wrapped.bytes)); obj.header.recipientDevice='other'; await assert.rejects(c.openKey(new TextEncoder().encode(JSON.stringify(obj))),/INVALID_PROOF/);
});
