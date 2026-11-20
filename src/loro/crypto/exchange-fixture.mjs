// Public deterministic identity seeds for cross-runtime test only; data keys and packets are fresh.
import {candidateCodec,SUITE} from './candidate.mjs';
import {testProvider} from './test-provider.mjs';
const enc=new TextEncoder(), dec=new TextDecoder();
const header={version:1,suiteId:SUITE,scopeId:'scope',documentId:'document',documentGeneration:1,branchHead:'branch',policyHashes:['policy'],epochId:'epoch',authorDevice:'sender',deviceSequence:1,predecessorRefs:[],semanticEffectIds:[],payloadKind:'update'};
const keyHeader={version:1,suiteId:SUITE,scopeId:'scope',branchHead:'branch',policyHashes:['policy'],epochId:'epoch',recipientDevice:'recipient',keyPurpose:'data',senderDevice:'sender'};
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=s=>Uint8Array.from(s.match(/../g),x=>parseInt(x,16));
export async function fixture(sodium) {
 await sodium.ready;
 const signing=sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(17));
 const recipient=sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(29));
 const publicKeys={publicSigning:signing.publicKey,publicRecipient:recipient.publicKey};
 return {
  async generate(message) {const codec=candidateCodec(testProvider(sodium,{...publicKeys,signing,initialKey:sodium.randombytes_buf(32)})); const wrapped=await codec.wrapKey(keyHeader,'data'), content=await codec.sealContent(header,enc.encode(message),'data'); return {wrapped:hex(wrapped.bytes),content:hex(content.bytes)};},
  async open(packet) {const codec=candidateCodec(testProvider(sodium,{...publicKeys,recipient})); await codec.openKey(unhex(packet.wrapped)); return dec.decode((await codec.openContent(unhex(packet.content))).value);},
 };
}
