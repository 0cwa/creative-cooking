import {authorityBytes,snapshotId} from '../authority/chain.mjs';
import {domain} from '../authority/validator.mjs';
import {verifyRetainedPolicyBaseline} from '../authority/policy-baseline.mjs';
import {verifyStagedPolicyDocumentSet} from './stage-policy-document-set.mjs';
import {policyTargetKeySlot} from './prepare-policy-document-keys.mjs';

const canon=x=>x instanceof Uint8Array?Array.from(x):Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
const same=(a,b)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));

/** Authenticate a retained activation. The caller supplies an independent pin and local device. */
export async function readVerifiedActivatedPolicyDocumentSet({storage,LoroDoc,pin,provider,scope,deviceId,targetHead,keys}) {
 scope=structuredClone(scope);
 if(scope?.kind!=='household' || typeof deviceId!=='string') throw Error('INVALID_AUTHORITY');
 const loaded=await storage.readActivatedPolicyDocumentSet(scope.id,targetHead);
 if(!loaded.ok) throw Error(loaded.error.code);
 if(!loaded.value) throw Error('ACTIVATION_NOT_FOUND');
 const {receipt,staged,documents}=structuredClone(loaded.value);
 const current=await storage.readPairingAuthority(scope);
 if(!current.ok || !same(current.value,receipt.next) || !same(receipt.expected.scope,scope) || !same(receipt.next.scope,scope)) throw Error('INVALID_AUTHORITY');
 const view={readPairingAuthority:async requested=>same(requested,scope)?{ok:true,value:structuredClone(receipt.expected)}:{ok:false,error:'INVALID_AUTHORITY'}};
 let envelope;
 try {envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(staged.proof));} catch {throw Error('INVALID_STAGED_PROOF');}
 const manifest=envelope?.[2]?.signed?.body?.observation?.manifest;
 if(!manifest?.root) throw Error('INVALID_STAGED_PROOF');
 const route={scopeId:scope.id,branchHead:manifest.parentHead,documentId:manifest.root.documentId,epochId:manifest.epochId,documentGeneration:manifest.generation,authorDevice:deviceId};
 const proof=await verifyStagedPolicyDocumentSet({storage:view,LoroDoc,pin,provider,stage:staged,scope:route,targetHead});
 let parent,next;
 try {parent=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(receipt.expected.authorityState));next=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(receipt.next.authorityState));}catch{throw Error('INVALID_AUTHORITY');}
 const selection=next.selections?.at(-1), signer=proof.parent.devices.find(d=>d.active&&d.deviceId===deviceId);
 const extension=structuredClone(parent);
 extension.events.push(proof.item); extension.selections.push(selection); extension.activeHead=targetHead;
 const expectedNext={...receipt.expected,revision:receipt.expected.revision+1,acceptedParent:targetHead,authorizationSnapshot:await snapshotId(provider,extension),authorityState:authorityBytes(extension)};
 if(!same(receipt.next,expectedNext) || !same(next,extension) || !selection ||
   Object.keys(selection).sort().join(',')!=='deviceId,from,index,signature,to' ||
   selection.from!==parent.activeHead || selection.to!==targetHead || selection.deviceId!==deviceId ||
   selection.index!==parent.selections.length || !signer || typeof selection.signature!=='string' || !/^[a-f0-9]{128}$/.test(selection.signature)) throw Error('INVALID_SELECTION');
 const {signature,...body}=selection;
 if(!await provider.verify(signer.signingKeyRef,domain('select-head',{root:pin,householdId:scope.id,...body}),Uint8Array.from(signature.match(/../g),x=>parseInt(x,16)))) throw Error('INVALID_SELECTION');
 if(!Array.isArray(documents) || !Array.isArray(receipt.targets) || documents.length!==staged.mapping.length || receipt.targets.length!==staged.mapping.length) throw Error('INVALID_ACTIVATION');
 for(let i=0;i<documents.length;i++) {
  const row=staged.mapping[i],doc=documents[i],slot=await policyTargetKeySlot({scope:route,pin,provider,targetHead,row});
  if(doc.documentId!==row.targetDocumentId || !same(receipt.targets[i],{targetDocumentId:row.targetDocumentId,operationId:slot.operationId,identity:slot.identity})) throw Error('INVALID_ACTIVATION');
  await verifyRetainedPolicyBaseline(LoroDoc,doc,proof.signed.body.documents[i].baseline,provider);
  await keys.use(slot.operationId,slot.identity,()=>{});
 }
 const again=await storage.readPairingAuthority(scope);
 if(!again.ok || !same(again.value,receipt.next)) throw Error('STALE_SOURCE');
 return structuredClone({targetHead,sourceHead:staged.sourceHead,record:receipt.next,state:next,parent:proof.parent,item:proof.item,selection,
  documents:documents.map(({documentId,revision},i)=>({recipeId:staged.mapping[i].recipeId,documentId,revision,...receipt.targets[i]}))});
}
