import { ed25519 } from '@noble/curves/ed25519.js';
import { commitment, confirmation, acknowledgement, accept } from './ceremony.mjs';
const hex = x=>Array.from(x,b=>b.toString(16).padStart(2,'0')).join('');
export async function ceremonyProbe(sodium) {
await sodium.ready;
const a=new Uint8Array(32).fill(1), b=new Uint8Array(32).fill(2);
const ka=sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(11)), kb=sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(12));
const c={household:'fixture',parent:'parent-1',action:'invite',initiator:{sign:hex(ed25519.getPublicKey(a)),wrap:hex(ka.publicKey),nonce:'04'.repeat(32)},responder:{sign:hex(ed25519.getPublicKey(b)),wrap:hex(kb.publicKey),nonce:'06'.repeat(32)},transcript:['offer','answer']};
const h=commitment(c), secrets={initiator:new Uint8Array(32).fill(7),responder:new Uint8Array(32).fill(8)};
const cipher={initiator:sodium.crypto_box_seal(secrets.initiator,ka.publicKey),responder:sodium.crypto_box_seal(secrets.responder,kb.publicKey)};
const challenge={initiator:hex(sodium.crypto_box_seal_open(cipher.initiator,ka.publicKey,ka.privateKey)),responder:hex(sodium.crypto_box_seal_open(cipher.responder,kb.publicKey,kb.privateKey))};
const args={ceremony:c,pins:{initiator:h,responder:h},confirmations:{initiator:confirmation(h,'initiator',a),responder:confirmation(h,'responder',b)},challenges:challenge,acknowledgements:{initiator:acknowledgement(h,'initiator',challenge.initiator,a),responder:acknowledgement(h,'responder',challenge.responder,b)},possession:async (_c,_h,answers)=>answers.initiator===hex(secrets.initiator) && answers.responder===hex(secrets.responder),authority:async()=>true,persist:async()=>true};
const deny=async x=>{try{await accept(x);}catch{return;}throw Error('invalid ceremony accepted');};
if (!(await accept(args)).releasePermitted) throw Error('valid fixture rejected');
for (const ceremony of [{...c,action:'own-device'},{...c,parent:'other'},{...c,household:'other'},{...c,transcript:['answer','offer']},{...c,initiator:{...c.initiator,wrap:'09'.repeat(32)}},{...c,responder:{...c.responder,sign:c.initiator.sign}}]) await deny({...args,ceremony});
await deny({...args,confirmations:{initiator:args.confirmations.initiator}});
await deny({...args,acknowledgements:{...args.acknowledgements,responder:args.acknowledgements.initiator}});
await deny({...args,possession:async()=>false}); await deny({...args,authority:async()=>false}); await deny({...args,persist:async()=>false});
let seen=false; const replay={...args,persist:async()=>{if(seen)return false;seen=true;return true;}}; await accept(replay); await deny(replay);
return 'ceremony fixture: sealed challenges, signatures, changed context, authority and replay gates passed';
}
