import {authorityBytes,snapshotId,verifyAuthority} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {readHistoricalPolicyActivationEvidence} from './read-activated-policy-document-set.mjs';

const canon=x=>x instanceof Uint8Array?Array.from(x):Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
const same=(a,b)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));

/** Verify candidate metadata only; this neither selects nor commits authority. */
export async function verifyPolicyReturnCandidate({candidate,...args}) {
 candidate=structuredClone(candidate);
 const evidence=await readHistoricalPolicyActivationEvidence(args);
 let state,parentState;
 try {
  state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(evidence.next.authorityState));
  parentState=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(evidence.expected.authorityState));
 } catch {throw Error('INVALID_AUTHORITY');}
 const verified=await verifyAuthority(parentState,args.pin,args.provider);
 const source=verified.nodes.get(evidence.expected.acceptedParent);
 if(!source || source.head!==evidence.sourceHead || state.activeHead!==args.targetHead) throw Error('INVALID_AUTHORITY');
 let returned;
 try {returned=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(candidate.authorityState));} catch {throw Error('INVALID_AUTHORITY');}
 const selection=returned.selections?.at(-1);
 if(!selection || Object.keys(selection).sort().join(',')!=='deviceId,from,index,signature,to' ||
  selection.from!==args.targetHead || selection.to!==source.head || selection.deviceId!==args.deviceId ||
  selection.index!==state.selections.length || typeof selection.signature!=='string' || !/^[a-f0-9]{128}$/.test(selection.signature)) throw Error('INVALID_SELECTION');
 const signer=source.devices.find(d=>d.active && d.deviceId===args.deviceId);
 const {signature,...body}=selection;
 if(!signer || !await args.provider.verify(signer.signingKeyRef,domain('select-head',{root:args.pin,householdId:args.scope.id,...body}),Uint8Array.from(signature.match(/../g),x=>parseInt(x,16)))) throw Error('INVALID_SELECTION');
 const extension={...state,selections:[...state.selections,selection],activeHead:source.head};
 const expected={...evidence.next,revision:evidence.next.revision+1,acceptedParent:source.head,
  authorizationSnapshot:await snapshotId(args.provider,extension),authorityState:authorityBytes(extension)};
 if(!same(returned,extension) || !same(candidate,expected)) throw Error('INVALID_AUTHORITY');
 return structuredClone({source,selection,candidate:expected});
}
