import {authorityBytes,snapshotId,verifyAuthority} from '../authority/chain.mjs';
import {domain,removedDevice,validParent} from '../authority/validator.mjs';
import {verifyAdultRemovalGrant} from './adult-removal-grant.mjs';
import {verifyAdultRemovalDocumentSet} from '../projection/current-document-set.mjs';

const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const same=(a,b)=>hex(authorityBytes(a))===hex(authorityBytes(b));

async function parentContext({record,pin,provider}) {
 let state;
 try { state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.authorityState)); } catch { throw Error('INVALID_AUTHORITY'); }
 if (!same(record.authorityState,authorityBytes(state)) || record.scope?.kind!=='household' || record.scope.id!==state.root?.householdId ||
  record.acceptedParent!==state.activeHead || record.authorizationSnapshot!==await snapshotId(provider,state) || !Number.isSafeInteger(record.revision) || record.revision<0) throw Error('INVALID_AUTHORITY');
 const verified=await verifyAuthority(state,pin,provider);
 return {...verified,parent:verified.nodes.get(state.activeHead)};
}

async function expected(options) {
 const {record,pin,provider,item,grant,manifest,recipientBindings,documents,LoroDoc}=options;
 const context=await parentContext({record,pin,provider});
 const args={...context,pin,provider,item,grant,manifest,recipientBindings,documents,LoroDoc};
 const checked=await verifyAdultRemovalGrant({...args,requireQuorum:true});
 await verifyAdultRemovalDocumentSet(args);
 const {parent,state,nodes}=context, subject=item.event.subject;
 if(item.event.authorDeviceId!==options.deviceId || !grant.recipients.includes(options.deviceId) || nodes.has(checked.eventHash)) throw Error('INVALID_SUCCESSOR');
 const child=structuredClone(parent);
 child.head=checked.eventHash; child.roster=item.event.frozenAdultRoster.filter(id=>id!==subject.adultId);
 child.devices=child.devices.map(d=>removedDevice(item.event,d)?{...d,active:false}:d);
 child.epochId=subject.newEpochId; child.generation=subject.newGeneration;
 child.runtime.documentId=subject.documentId;
 child.runtime.authorPeers=Object.fromEntries(subject.devices.map(d=>[d.deviceId,d.peerId]));
 child.runtime.acceptedRecipients=subject.devices.map(d=>d.deviceId);
 if(!validParent(child)) throw Error('INVALID_SUCCESSOR');
 const event={...structuredClone(item),rotation:{grant:structuredClone(grant),manifest:structuredClone(manifest),recipientBindings:structuredClone(recipientBindings)}};
 return {state,parent,child,event,head:checked.eventHash};
}

export async function verifyAdultRemovalSuccessor(options) {
 options={...options,...structuredClone({record:options.record,item:options.item,grant:options.grant,manifest:options.manifest,recipientBindings:options.recipientBindings,documents:options.documents,candidate:options.candidate})};
 const {record,pin,provider,candidate}=options, e=await expected(options);
 const state=structuredClone(e.state), selection=candidate?.state?.selections?.at(-1);
 const body={from:e.parent.head,to:e.head,deviceId:options.deviceId,index:state.selections.length};
 if(!selection || !same(Object.keys(selection).sort(),['deviceId','from','index','signature','to']) ||
  !same({...selection,signature:undefined},{...body,signature:undefined}) || !/^[0-9a-f]{128}$/.test(selection.signature)) throw Error('INVALID_SELECTION');
 const signer=e.parent.devices.find(d=>d.active && d.deviceId===body.deviceId);
 if(!signer || !await provider.verify(signer.signingKeyRef,domain('select-head',{root:pin,householdId:e.parent.householdId,...body}),Uint8Array.from(selection.signature.match(/../g),x=>parseInt(x,16)))) throw Error('INVALID_SELECTION');
 state.events.push(e.event); state.selections.push(selection); state.activeHead=e.head;
 const next={scope:record.scope,revision:record.revision+1,acceptedParent:e.head,authorizationSnapshot:await snapshotId(provider,state),authorityState:authorityBytes(state)};
 if(!same(candidate,{state,record:next,child:e.child})) throw Error('INVALID_SUCCESSOR');
 return {state,record:next,child:e.child};
}

export async function authorAdultRemovalSuccessor(options) {
 options={...options,...structuredClone({record:options.record,item:options.item,grant:options.grant,manifest:options.manifest,recipientBindings:options.recipientBindings,documents:options.documents})};
 const e=await expected(options), {record,pin,provider,deviceId,signingKey}=options;
 const body={from:e.parent.head,to:e.head,deviceId,index:e.state.selections.length};
 const signature=hex(await provider.sign(signingKey,domain('select-head',{root:pin,householdId:e.parent.householdId,...body})));
 const state=structuredClone(e.state); state.events.push(e.event); state.selections.push({...body,signature}); state.activeHead=e.head;
 const candidate={state,record:{scope:record.scope,revision:record.revision+1,acceptedParent:e.head,authorizationSnapshot:await snapshotId(provider,state),authorityState:authorityBytes(state)},child:e.child};
 return verifyAdultRemovalSuccessor({...options,candidate});
}

/** Reconstruct the candidate from the retained authority record, then verify it. */
export async function verifyRetainedAdultRemovalSuccessor(options) {
 const e=await expected(options);
 let state;
 try { state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(options.next.authorityState)); }
 catch { throw Error('INVALID_AUTHORITY'); }
 return verifyAdultRemovalSuccessor({...options,candidate:{state,record:options.next,child:e.child}});
}
