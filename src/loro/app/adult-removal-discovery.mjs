import {PAIRING_LIMITS} from '../contracts/pairing.ts';
import {domain} from '../authority/validator.mjs';

/** Untrusted selected-event locator; callers must authenticate the retained receipt. */
export async function discoverSelectedAdultRemoval(record,provider) {
 if(!record)return null;
 if(!(record.authorityState instanceof Uint8Array)||record.authorityState.length>PAIRING_LIMITS.itemBytes)throw Error('INVALID_AUTHORITY');
 let state;try{state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.authorityState));}catch{throw Error('INVALID_AUTHORITY');}
 if(!Array.isArray(state?.events)||state.events.length>128||!Array.isArray(state.selections)||state.selections.length>128)throw Error('INVALID_AUTHORITY');
 const matches=[];
 for(const item of state.events){
  if(item?.event?.version!==2||item.event.kind!=='removeAdult'||item.rotation?.grant?.version!==3)continue;
  const hash=await provider.hash(domain('event',item.event));
  if(!(hash instanceof Uint8Array)||hash.length!==32)throw Error('INVALID_AUTHORITY');
  if(Array.from(hash,x=>x.toString(16).padStart(2,'0')).join('')===record.acceptedParent)matches.push(item);
 }
 if(!matches.length)return null;
 const item=matches[0],last=state.selections.at(-1),operationId=item.event.proposalId,authorDeviceId=item.event.authorDeviceId;
 if(matches.length!==1||state.activeHead!==record.acceptedParent||last?.to!==record.acceptedParent||typeof operationId!=='string'||!operationId||new TextEncoder().encode(operationId).length>PAIRING_LIMITS.idBytes||typeof authorDeviceId!=='string'||!authorDeviceId)throw Error('INVALID_AUTHORITY');
 return {operationId,authorDeviceId};
}
