// Public test-only keys; never use this provider for a real workspace.
import {candidateCodec,SUITE} from './compat-domain/candidate.mjs';
import {testProvider} from './compat-domain/test-provider.mjs';
const enc = new TextEncoder();
const dec = new TextDecoder();
const signingSeed = new Uint8Array(32).fill(3), boxSeed = new Uint8Array(32).fill(7), key = new Uint8Array(32).fill(9);
const header = {version:1,suiteId:SUITE,scopeId:'test-scope',documentId:'test-document',documentGeneration:1,branchHead:'test-head',policyHashes:[],epochId:'test-epoch',authorDevice:'sender',deviceSequence:1,predecessorRefs:[],semanticEffectIds:['test-effect'],payloadKind:'loro-update-v1'};
const keyHeader = {version:1,suiteId:SUITE,scopeId:'test-scope',branchHead:'test-head',policyHashes:[],epochId:'test-epoch',recipientDevice:'recipient',keyPurpose:'data',senderDevice:'sender'};
function codec(sodium,initial=true) {const signing=sodium.crypto_sign_seed_keypair(signingSeed),recipient=sodium.crypto_box_seed_keypair(boxSeed);return candidateCodec(testProvider(sodium,{signing,publicSigning:signing.publicKey,recipient,publicRecipient:recipient.publicKey,initialKey:initial ? key : undefined}));}
export async function generate(sodium,origin,update) {await sodium.ready;const c=codec(sodium);const content=await c.sealContent(header,enc.encode(JSON.stringify({origin,update:Array.from(update)})),'data');const wrapped=await c.wrapKey(keyHeader,'data');return {origin,content:dec.decode(content.bytes),wrapped:dec.decode(wrapped.bytes)};}
export async function verify(sodium, packet) {
 await sodium.ready;const c=codec(sodium,false), input=enc.encode(packet.content), wrap=enc.encode(packet.wrapped);
 const unwrapped=await c.openKey(wrap), opened=await c.openContent(input);
 const payload=JSON.parse(dec.decode(opened.value));if(payload.origin!==packet.origin || !Array.isArray(payload.update) || !payload.update.every(x=>Number.isInteger(x)&&x>=0&&x<=255) || unwrapped.value!=='data') throw Error('bad exchange');
 const mutate=(f)=>{const x=JSON.parse(dec.decode(input));f(x);return enc.encode(JSON.stringify(x));};
 for (const bad of [mutate(x=>x.encrypted=(x.encrypted[0]==='0'?'1':'0')+x.encrypted.slice(1)),mutate(x=>x.header.scopeId='wrong-domain'),mutate(x=>x.header.version=99)]) {let rejected=false;try{await c.openContent(bad)}catch{rejected=true}if(!rejected)throw Error('invalid input accepted');}
 return {content:true,wrapped:true,tamperRejected:true,domainRejected:true,versionRejected:true,update:payload.update};
}
