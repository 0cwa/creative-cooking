import {authorityBytes,snapshotId,verifyAuthority} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {sameOwnDevice} from './household-own-device.mjs';

const hex=bytes=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');

// Shared verification also retains the local state privately for the installer.
async function checkTransition({sodium,provider,pin,localParent,publisherParent,publisherNext,deviceId}) {
 ({localParent,publisherParent,publisherNext}=structuredClone({localParent,publisherParent,publisherNext}));
 const parse=async record=>{
  const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.authorityState));
  if(!sameOwnDevice(sodium,authorityBytes(state),record.authorityState)||state.activeHead!==record.acceptedParent||
     state.root?.householdId!==record.scope.id||await snapshotId(provider,state)!==record.authorizationSnapshot)throw Error('INVALID_AUTHORITY');
  return {state,verified:await verifyAuthority(state,pin,provider)};
 };
 const local=await parse(localParent),publisher=await parse(publisherParent);
 if(!sameOwnDevice(sodium,localParent.scope,publisherParent.scope)||localParent.acceptedParent!==publisherParent.acceptedParent||
    !sameOwnDevice(sodium,local.verified.nodes.get(local.state.activeHead),publisher.verified.nodes.get(publisher.state.activeHead)))throw Error('INVALID_AUTHORITY');
 const localNode=local.verified.nodes.get(local.state.activeHead);
 if(!localNode.runtime.acceptedRecipients.includes(deviceId)||!localNode.devices.some(device=>device.active&&device.deviceId===deviceId))throw Error('INVALID_AUTHORITY');
 const child=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(publisherNext.authorityState));
 const item=child.events.at(-1),publisherSelection=child.selections.at(-1),head=publisherNext.acceptedParent;
 if(!item||item.event.parentHead!==publisherParent.acceptedParent||item.event.subject?.parentSnapshot!==publisherParent.authorizationSnapshot||
    !sameOwnDevice(sodium,publisherNext.scope,publisherParent.scope)||publisherNext.revision!==publisherParent.revision+1||
    !sameOwnDevice(sodium,child,{...publisher.state,events:[...publisher.state.events,item],selections:[...publisher.state.selections,publisherSelection],activeHead:head})||
    !sameOwnDevice(sodium,authorityBytes(child),publisherNext.authorityState)||await snapshotId(provider,child)!==publisherNext.authorizationSnapshot)throw Error('INVALID_AUTHORITY');
 await verifyAuthority(child,pin,provider,{pendingOwnDeviceSet:head});
 return {localParent,local,localNode,item,head};
}

/** Verify the two retained parents and signed successor without signing a selection.
 * This checks authority metadata, not the complete copy set. */
export async function preflightOwnDeviceLocalTransition(args) {
 const {localParent,localNode,item,head}=await checkTransition(args);
 return structuredClone({scope:localParent.scope,parent:localNode,head,event:item.event});
}

/** Build or verify a recipient's selection without replacing its retained history.
 * The publisher successor must already have passed the complete set verifier. */
export async function verifyOwnDeviceLocalTransition({sodium,provider,pin,localParent,publisherParent,publisherNext,deviceId,signingSecret,selection}) {
 const checked=await checkTransition({sodium,provider,pin,localParent,publisherParent,publisherNext,deviceId});
 ({localParent}=checked);
 const {local,item,head}=checked;
 selection=structuredClone(selection);
 const body={root:pin,householdId:localParent.scope.id,from:local.state.activeHead,to:head,deviceId,index:local.state.selections.length};
 if(!selection){
  if(!(signingSecret instanceof Uint8Array))throw Error('INVALID_KEY');
  selection={from:body.from,to:head,deviceId,index:body.index,signature:hex(sodium.crypto_sign_detached(domain('select-head',body),signingSecret))};
 }
 if(selection.from!==body.from||selection.to!==head||selection.deviceId!==deviceId||selection.index!==body.index)throw Error('INVALID_SELECTION');
 const state={...local.state,events:[...local.state.events,item],selections:[...local.state.selections,selection],activeHead:head};
 await verifyAuthority(state,pin,provider,{pendingOwnDeviceSet:head});
 return {scope:localParent.scope,revision:localParent.revision+1,acceptedParent:head,authorityState:authorityBytes(state),authorizationSnapshot:await snapshotId(provider,state)};
}
