import {authorityBytes,readAuthority,verifyAuthority} from '../authority/chain.mjs';
import {checkAdmissionAgreement} from '../authority/grant.mjs';
import {verifyPublicParent} from '../pairing/household-recipient-proof.mjs';
import {verifyCurrentDocumentSet} from '../projection/current-document-set.mjs';

const same=(a,b)=>{const x=authorityBytes(a),y=authorityBytes(b);return x.length===y.length&&x.every((v,i)=>v===y[i]);};

/** Verify the publisher's exact snapshot and this device's independently pinned
 * parent. Selection histories can differ; the selected authority cannot. */
export async function verifyDocumentSetAtPublisher({storage,scope,pin,provider,item,grant,manifest,documents,publisherParent,LoroDoc}){
 const local=await readAuthority(storage,scope,pin,provider),localVerified=await verifyAuthority(local.state,pin,provider);
 if(!publisherParent){const current=await storage.readPairingAuthority(scope);if(!current.ok||!current.value)throw Error('INVALID_AUTHORITY');publisherParent=current.value;}
 const publisherStorage={readPairingAuthority:async()=>({ok:true,value:structuredClone(publisherParent)})};
 const published=await verifyPublicParent(publisherStorage,scope,pin,provider);
 const parent=localVerified.nodes.get(local.activeHead),publisher=published.nodes.get(published.state.activeHead);
 if(!parent||local.activeHead!==item?.event?.parentHead||!same(parent,publisher))throw Error('INVALID_AUTHORITY');
 let delegated=false;
 for(const agreement of local.state.agreements??[]){
  if(agreement.parentHead!==parent.head||!same(agreement.sourcePolicyHashes,grant?.sourcePolicyHashes))continue;
  const result=await checkAdmissionAgreement(parent,agreement,provider);
  if(result.status==='accepted'&&result.delegationHash===grant.delegationHash)delegated=true;
 }
 if(!delegated)throw Error('DELEGATION_REQUIRED');
 const checked=await verifyCurrentDocumentSet({storage:publisherStorage,scope,pin,provider,item,grant,manifest,documents,LoroDoc});
 return {...checked,localRevision:local.revision};
}
