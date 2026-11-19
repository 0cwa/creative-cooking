import {authorityBytes,snapshotId} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {MAX_AUTHORITY_HISTORY} from '../contracts/pairing.ts';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {withOpenedAdultRemovalFile} from '../pairing/adult-removal-file.mjs';
import {verifyAdultRemovalGrant} from './adult-removal-grant.mjs';
import {verifyRetainedAdultRemovalSuccessor} from './adult-removal-successor.mjs';
import {hex,verifySignature} from './revocation.mjs';

const same=(a,b)=>hex(authorityBytes(a))===hex(authorityBytes(b));

/** Verify the signed ciphertext address before asking the recipient to install. */
export async function verifyAdultRemovalFileAddress({scope,provider,sodium,parent,release,recipientDeviceId}) {
 const {proposal,publisherRecord,bytes}=release,{item,grant,manifest}=proposal;
 if(recipientDeviceId===item.event.authorDeviceId||!grant.recipients.includes(recipientDeviceId)||
  !parent.devices.some(d=>d.active&&d.deviceId===recipientDeviceId))throw Error('INVALID_RECIPIENT');
 let signed;
 try {signed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(release.proof));}catch{throw Error('INVALID_PROOF');}
 const author=parent.devices.find(d=>d.active&&d.deviceId===item.event.authorDeviceId),proof=signed?.[2],body=proof?.body;
 if(!Array.isArray(signed)||signed.length!==3||signed[0]!=='creative-cooking/authority-candidate/v1'||
  signed[1]!=='adult-removal-publication-v1'||!body||!same(release.proof,domain(signed[1],proof))||!author||
  !await verifySignature(provider,author.signingKeyRef,signed[1],body,proof.signature)||
  !same({item:body.item,grant:body.grant,manifest:body.manifest,recipientBindings:body.recipientBindings},proposal)||
  body.nextSnapshot!==publisherRecord.authorizationSnapshot||body.parentSnapshot!==manifest.authorizationSnapshot||
  body.deviceId!==item.event.authorDeviceId||!same(body.scope,scope)||body.operationId!==item.event.proposalId||
  !(bytes instanceof Uint8Array)||!Array.isArray(body.fileCommitments))throw Error('INVALID_PROOF');
 const addressed=body.fileCommitments.filter(f=>f?.recipientDeviceId===recipientDeviceId);
 if(addressed.length!==1||addressed[0].fileHash!==hex(sodium.crypto_generichash(32,bytes)))throw Error('INVALID_RECIPIENT');
}

/** Verify an addressed release and derive, but do not install, the local successor. */
export async function withOpenedAdultRemovalRelease({storage,scope,pin,provider,sodium,LoroDoc,release,recipientDeviceId,wrappingSecret,signSelection,localSelection,confirmedHead,confirmedGrantHash,expectedRevision},callback) {
 if(typeof callback!=='function')throw Error('MALFORMED');
 ({scope,release,localSelection}=structuredClone({scope,release,localSelection}));
 const {proposal,publisherRecord,bytes}=release, {item,grant,manifest,recipientBindings}=proposal;
 const local=await verifyPublicParent(storage,scope,pin,provider);
 if(local.record.revision!==expectedRevision || !Number.isSafeInteger(expectedRevision) || expectedRevision<0 || expectedRevision>=Number.MAX_SAFE_INTEGER)throw Error('STALE_AUTHORITY');
 if(local.state.events.length>=MAX_AUTHORITY_HISTORY||local.state.selections.length>=MAX_AUTHORITY_HISTORY)throw Error('AUTHORITY_HISTORY_FULL');
 let published;
 try {published=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(publisherRecord.authorityState));} catch {throw Error('INVALID_AUTHORITY');}
 if(!Array.isArray(published.events)||!published.events.length||!Array.isArray(published.selections)||!published.selections.length||!Number.isSafeInteger(publisherRecord.revision)||publisherRecord.revision<1)throw Error('INVALID_AUTHORITY');
 const prior=structuredClone(published);
 prior.events.pop(); prior.selections.pop(); prior.activeHead=manifest.parentHead;
 const parentRecord={scope,revision:publisherRecord.revision-1,acceptedParent:manifest.parentHead,authorizationSnapshot:manifest.authorizationSnapshot,authorityState:authorityBytes(prior)};
 const publisher=await verifyPublicParent({readPairingAuthority:async()=>({ok:true,value:parentRecord})},scope,pin,provider);
 const parent=publisher.nodes.get(publisher.state.activeHead), localParent=local.nodes.get(local.state.activeHead);
 if(local.state.activeHead!==publisher.state.activeHead || !same(parent,localParent))throw Error('INVALID_PARENT');
 const recipient=localParent.devices.find(d=>d.active&&d.deviceId===recipientDeviceId);
 if(!recipient)throw Error('INVALID_RECIPIENT');
 await verifyAdultRemovalFileAddress({scope,provider,sodium,parent,release,recipientDeviceId});
 const options={provider,pin,parent,state:publisher.state,nodes:publisher.nodes,item,grant,manifest,recipientBindings,LoroDoc};
 const checked=await verifyAdultRemovalGrant(options);
 if(checked.eventHash!==confirmedHead || checked.grantHash!==confirmedGrantHash)throw Error('REVIEW_CHANGED');
 return withOpenedAdultRemovalFile({...options,sodium,file:bytes,wrappingSecret,recipientId:recipientDeviceId},async opened=>{
  const verified=await verifyRetainedAdultRemovalSuccessor({...options,record:parentRecord,next:publisherRecord,deviceId:item.event.authorDeviceId,documents:opened.documents});
  const body={from:localParent.head,to:checked.eventHash,deviceId:recipientDeviceId,index:local.state.selections.length};
  let selection=localSelection;
  if(!selection){
   if(typeof signSelection!=='function')throw Error('INVALID_SELECTION');
   const signature=await signSelection(domain('select-head',{root:pin,householdId:scope.id,...body}));
   if(!(signature instanceof Uint8Array))throw Error('INVALID_SELECTION');
   selection={...body,signature:hex(signature)};
  }
  if(!selection || !same(Object.keys(selection).sort(),['deviceId','from','index','signature','to']) || !same({...selection,signature:undefined},{...body,signature:undefined}) || !/^[0-9a-f]{128}$/.test(selection.signature) || !await provider.verify(recipient.signingKeyRef,domain('select-head',{root:pin,householdId:scope.id,...body}),Uint8Array.from(selection.signature.match(/../g),x=>parseInt(x,16))))throw Error('INVALID_SELECTION');
  const state=structuredClone(local.state);
  state.events.push(structuredClone(verified.state.events.at(-1)));state.selections.push(structuredClone(selection));state.activeHead=checked.eventHash;
  const record={scope,revision:expectedRevision+1,acceptedParent:checked.eventHash,authorizationSnapshot:await snapshotId(provider,state),authorityState:authorityBytes(state)};
  const now=await verifyPublicParent(storage,scope,pin,provider);
  if(!same(now.record,local.record))throw Error('STALE_AUTHORITY');
  return callback({documents:opened.documents,keys:opened.keys,selection:structuredClone(selection),record,child:structuredClone(verified.child),expected:structuredClone(local.record)});
 });
}
