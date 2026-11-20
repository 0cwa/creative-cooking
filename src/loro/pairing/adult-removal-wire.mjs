import {authorityBytes} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {PAIRING_LIMITS,validatePairingAuthority} from '../contracts/pairing.ts';
import {MAX_SELECTED_SET_BYTES} from '../contracts/runtime-storage.ts';
import {MAX_PERSONAL_PAIRING_FILE} from './personal-copy.mjs';

// Matches the existing native exchange share and household file picker limit.
export const MAX_ADULT_REMOVAL_FILE=16*1024*1024+48;
const magic=new Uint8Array([0x43,0x43,0x41,0x52,1]), prefix=21, maxHeader=4096;
const decoder=new TextDecoder('utf-8',{fatal:true});
const sameBytes=(a,b)=>a.length===b.length&&a.every((value,i)=>value===b[i]);
const same=(a,b)=>sameBytes(authorityBytes(a),authorityBytes(b));
const fields=(o,names)=>o&&typeof o==='object'&&!Array.isArray(o)&&!(o instanceof Uint8Array)&&Object.keys(o).length===names.length&&names.every(k=>Object.hasOwn(o,k));
const parse=bytes=>{try{return JSON.parse(decoder.decode(bytes));}catch{throw Error('INVALID_FILE');}};

/** Structural only: the returned proposal must be verified by the recipient. */
function parts({bytes,proof,publisherRecord,proposal},checkProposal=true) {
 if(!(bytes instanceof Uint8Array)||bytes.length<=112||bytes.length>MAX_PERSONAL_PAIRING_FILE||
    !(proof instanceof Uint8Array)||!proof.length||proof.length>MAX_SELECTED_SET_BYTES||
    !validatePairingAuthority(publisherRecord).ok||publisherRecord.scope.kind!=='household')throw Error('INVALID_FILE');
 const {authorityState,...header}=publisherRecord;
 const encodedHeader=authorityBytes(header);
 if(!encodedHeader.length||encodedHeader.length>maxHeader)throw Error('INVALID_FILE');
 const size=prefix+encodedHeader.length+authorityState.length+proof.length+bytes.length;
 if(size>MAX_ADULT_REMOVAL_FILE)throw Error('TOO_LARGE');
 const state=parse(authorityState);
 if(!state || typeof state!=='object'||Array.isArray(state)||!sameBytes(authorityState,authorityBytes(state))||
    state.activeHead!==publisherRecord.acceptedParent||state.root?.householdId!==publisherRecord.scope.id||
    !Array.isArray(state.events)||!Array.isArray(state.selections))throw Error('INVALID_FILE');
 const envelope=parse(proof);
 if(!Array.isArray(envelope)||envelope.length!==3||envelope[0]!=='creative-cooking/authority-candidate/v1'||
    envelope[1]!=='adult-removal-publication-v1'||!fields(envelope[2],['body','signature'])||
    !/^[0-9a-f]{128}$/.test(envelope[2].signature)||!sameBytes(proof,domain(envelope[1],envelope[2])))throw Error('INVALID_FILE');
 const body=envelope[2].body;
 if(!fields(body,['version','operationId','scope','deviceId','parentSnapshot','nextSnapshot','item','grant','manifest','recipientBindings','documents','keyCommitments','fileCommitments'])||
    body.version!==1||!same(body.scope,publisherRecord.scope)||body.nextSnapshot!==publisherRecord.authorizationSnapshot||
    !body.item?.event||body.item.event.kind!=='removeAdult'||body.item.event.version!==2||body.item.event.proposalId!==body.operationId||
    body.grant?.version!==3||!body.manifest||!Array.isArray(body.recipientBindings))throw Error('INVALID_FILE');
 const recovered={item:body.item,grant:body.grant,manifest:body.manifest,recipientBindings:body.recipientBindings};
 if(checkProposal && !same(proposal,recovered))throw Error('INVALID_FILE');
 return {size,encodedHeader,proposal:recovered};
}

/** Check the exact encoded size before publication without allocating the frame. */
export function adultRemovalReleaseSize(release) {return parts(release).size;}

export function encodeAdultRemovalRelease(release) {
 if(!fields(release,['bytes','proof','publisherRecord','proposal']))throw Error('INVALID_FILE');
 const {size,encodedHeader}=parts(release),state=release.publisherRecord.authorityState;
 const out=new Uint8Array(size),view=new DataView(out.buffer);out.set(magic);
 for(const [i,length] of [encodedHeader.length,state.length,release.proof.length,release.bytes.length].entries())view.setUint32(5+i*4,length,false);
 let offset=prefix;for(const section of [encodedHeader,state,release.proof,release.bytes]){out.set(section,offset);offset+=section.length;}
 return out;
}

export function decodeAdultRemovalRelease(file) {
 if(!(file instanceof Uint8Array)||file.length<prefix||file.length>MAX_ADULT_REMOVAL_FILE)throw Error('INVALID_FILE');
 if(!sameBytes(file.subarray(0,magic.length),magic))throw Error('INVALID_FILE');
 const view=new DataView(file.buffer,file.byteOffset,file.byteLength),lengths=Array.from({length:4},(_,i)=>view.getUint32(5+i*4,false));
 const [headerLength,stateLength,proofLength,cipherLength]=lengths;
 if(!headerLength||headerLength>maxHeader||!stateLength||stateLength>PAIRING_LIMITS.itemBytes||!proofLength||proofLength>MAX_SELECTED_SET_BYTES||cipherLength<=112||cipherLength>MAX_PERSONAL_PAIRING_FILE||prefix+lengths.reduce((a,b)=>a+b,0)!==file.length)throw Error('INVALID_FILE');
 let offset=prefix;const section=length=>{const result=file.subarray(offset,offset+length);offset+=length;return result};
 const headerBytes=section(headerLength),state=section(stateLength),proof=section(proofLength),bytes=section(cipherLength);
 const header=parse(headerBytes);
 if(!fields(header,['scope','revision','acceptedParent','authorizationSnapshot'])||!sameBytes(headerBytes,authorityBytes(header)))throw Error('INVALID_FILE');
 const publisherRecord={...header,authorityState:state};
 const verified=parts({bytes,proof,publisherRecord},false);
 return {bytes:bytes.slice(),proof:proof.slice(),publisherRecord:{...header,authorityState:state.slice()},proposal:verified.proposal};
}
