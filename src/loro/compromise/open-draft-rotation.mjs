import {authorityBytes,snapshotId} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {MAX_AUTHORITY_HISTORY} from '../contracts/pairing.ts';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {withOpenedDraftRotationFile} from '../pairing/draft-rotation-file.mjs';
import {verifyDraftRotationGrant} from './draft-rotation-grant.mjs';
import {verifyRetainedDraftRotationSuccessor} from './draft-rotation-successor.mjs';
import {draftRotationKeySlot} from './publish-draft-rotation.mjs';
import {hex,verifySignature} from './revocation.mjs';

const same=(a,b)=>hex(authorityBytes(a))===hex(authorityBytes(b));

/** Authenticate the publication and the ordered addresses of all survivor files. */
export async function verifyDraftRotationFileAddress({scope,provider,sodium,parent,release,recipientDeviceId}) {
 const {proposal,publisherRecord,bytes}=release,{item,grant,manifest}=proposal;
 let signed;
 try {signed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(release.proof));}catch{throw Error('INVALID_PROOF');}
 const proof=signed?.[2],body=proof?.body, author=parent.devices.find(d=>d.active&&d.deviceId===item.event.authorDeviceId);
 const fields=(o,n)=>o && typeof o==='object' && !Array.isArray(o) && same(Object.keys(o).sort(),n.slice().sort());
 if(!Array.isArray(signed)||signed.length!==3||signed[0]!=='creative-cooking/authority-candidate/v1'||signed[1]!=='draft-rotation-publication-v1'||
  !fields(proof,['body','signature'])||!fields(body,['version','operationId','scope','deviceId','parentSnapshot','nextSnapshot','item','grant','manifest','recipientBindings','documents','keyCommitments','fileCommitments'])||body.version!==1||
  !same(release.proof,domain(signed[1],proof))||!author||!await verifySignature(provider,author.signingKeyRef,signed[1],body,proof.signature)||
  !same({item:body.item,grant:body.grant,manifest:body.manifest,recipientBindings:body.recipientBindings},proposal)||body.nextSnapshot!==publisherRecord.authorizationSnapshot||body.parentSnapshot!==manifest.authorizationSnapshot||
  body.deviceId!==item.event.authorDeviceId||!same(body.scope,scope)||body.operationId!==item.event.proposalId||!(bytes instanceof Uint8Array))throw Error('INVALID_PROOF');
 const recipients=grant.recipients.filter(id=>id!==body.deviceId);
 if(!recipients.includes(recipientDeviceId)||!parent.devices.some(d=>d.active&&d.deviceId===recipientDeviceId)||!Array.isArray(body.fileCommitments)||body.fileCommitments.length!==recipients.length||
  body.fileCommitments.some((f,i)=>!fields(f,['recipientDeviceId','fileHash'])||f.recipientDeviceId!==recipients[i]||!/^[0-9a-f]{64}$/.test(f.fileHash))||
  body.fileCommitments[recipients.indexOf(recipientDeviceId)].fileHash!==hex(sodium.crypto_generichash(32,bytes)))throw Error('INVALID_RECIPIENT');
 return body;
}

/** Verify the public release and its exact local parent before asking for confirmation. */
export async function verifyDraftRotationRelease({storage,scope,pin,provider,sodium,LoroDoc,release,recipientDeviceId,recipientAdultId,expectedRevision}) {
 const {proposal,publisherRecord}=release, {item,grant,manifest,recipientBindings}=proposal;
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
 if(!recipient || recipient.adultId!==recipientAdultId || !localParent.roster.includes(recipientAdultId))throw Error('INVALID_RECIPIENT');
 const evidence=await verifyDraftRotationFileAddress({scope,provider,sodium,parent,release,recipientDeviceId});
 const options={provider,pin,parent,state:publisher.state,nodes:publisher.nodes,item,grant,manifest,recipientBindings,LoroDoc};
 const checked=await verifyDraftRotationGrant(options);
 return {local,parentRecord,parent,localParent,recipient,evidence,options,checked};
}

/** Verify an addressed release and derive, but do not install, the local successor. */
export async function withOpenedDraftRotationRelease({storage,scope,pin,provider,sodium,LoroDoc,release,recipientDeviceId,recipientAdultId,wrappingSecret,signSelection,localSelection,confirmedHead,confirmedGrantHash,expectedRevision},callback) {
 if(typeof callback!=='function')throw Error('MALFORMED');
 ({scope,release,localSelection}=structuredClone({scope,release,localSelection}));
 const {proposal,publisherRecord,bytes}=release, {item,grant,manifest,recipientBindings}=proposal;
 const {local,parentRecord,parent,localParent,recipient,evidence,options,checked}=await verifyDraftRotationRelease({storage,scope,pin,provider,sodium,LoroDoc,release,recipientDeviceId,recipientAdultId,expectedRevision});
 if(checked.eventHash!==confirmedHead || checked.grantHash!==confirmedGrantHash)throw Error('REVIEW_CHANGED');
 return withOpenedDraftRotationFile({...options,sodium,file:bytes,wrappingSecret,recipientId:recipientDeviceId},async opened=>{
  if(!Array.isArray(evidence.documents)||!Array.isArray(evidence.keyCommitments)||evidence.documents.length!==opened.documents.length||evidence.keyCommitments.length!==opened.keys.length)throw Error('INVALID_PROOF');
  for(const [i,document] of opened.documents.entries()) {
   const {snapshot,...seed}=document.seed;
   const commitment=evidence.keyCommitments[i], slot=await draftRotationKeySlot(provider,scope,manifest,item.event.authorDeviceId,document.documentId);
   if(!same(evidence.documents[i],{documentId:document.documentId,seed,policyBundle:document.policyBundle})||!commitment||!same(Object.keys(commitment).sort(),['documentId','identity','keyHash','operationId','wrappedHash'])||commitment.documentId!==document.documentId||!same(slot,{operationId:commitment.operationId,identity:commitment.identity})||!/^[0-9a-f]{64}$/.test(commitment.wrappedHash)||commitment.keyHash!==hex(sodium.crypto_generichash(32,opened.keys[i])))throw Error('INVALID_PROOF');
  }
  const verified=await verifyRetainedDraftRotationSuccessor({...options,record:parentRecord,next:publisherRecord,deviceId:item.event.authorDeviceId,documents:opened.documents});
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
