import {bytes,hash,reviewBytes} from './policy.mjs';
import {createSourceVerifier} from './source-proof.mjs';
const must=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=s=>typeof s==='string'&&/^[0-9a-f]{128}$/.test(s)?Uint8Array.from(s.match(/../g),x=>parseInt(x,16)):null;
const valid=x=>typeof x==='string'&&x.length>0&&new TextEncoder().encode(x).length<=256;
const named=(kind,id)=>`${kind}:${encodeURIComponent(id)}`;
const head=(kind,id,field)=>named('field-head',JSON.stringify([kind,id,field]));
function endpointIdentity(value) {let u;try{u=new URL(value)}catch{throw Error('MALFORMED')}if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash||(u.search&&u.search!=='?alt=sse')||u.href!==value)throw Error('MALFORMED');return value;}
/** Only actual household pantry fields are selected. There is no free-form
 * payload, private-chat, credentials, recovery or shared-key input. */
export function disclosureGateway({runtime,service,provider,fetch:fetcher=fetch,randomId}) {
 if(typeof randomId!=='function')throw Error('MALFORMED');
 async function prepare(selection) {
  selection=structuredClone(selection);
  if(!selection||Object.keys(selection).sort().join(',')!=='endpoint,itemIds,model,purpose,recipient'||!Array.isArray(selection.itemIds)||!selection.itemIds.length||selection.itemIds.length>64||!selection.itemIds.every(valid)||new Set(selection.itemIds).size!==selection.itemIds.length||!selection.itemIds.every((x,i)=>!i||selection.itemIds[i-1]<x)||![selection.model,selection.purpose,selection.recipient].every(valid)||selection.purpose!=='cooking')throw Error('MALFORMED');
  const endpoint=endpointIdentity(selection.endpoint);if(selection.recipient!==endpoint)throw Error('RECIPIENT_ENDPOINT_MISMATCH');const {context,record}=await service.active(),{doc,revision}=await runtime.document();if(revision===null||runtime.scope.branchHead!==context.current.activeHead)throw Error('SOURCE_UNAVAILABLE');
  const sourceEffects=new Set(),ingredients=[],selected=[];
  for(const itemId of selection.itemIds){const create=doc.getMap('pantry-index').get(itemId),item=doc.getMap(named('pantry',itemId)).toJSON(),nameHead=doc.getMap(head('pantry',itemId,'name')).get('effect');if(!create||typeof item.name!=='string'||!item.name.trim()||item.removed||item.removedAt)throw Error('SOURCE_UNAVAILABLE');ingredients.push(item.name);selected.push({itemId,name:item.name,create,nameHead});sourceEffects.add(create);if(nameHead)sourceEffects.add(nameHead)}
  const policyHashes=new Set([record.policyHash]),effectIds=[...sourceEffects].sort(),verified=new Map(),verifySource=createSourceVerifier({runtime,service,context});
  for(const effect of effectIds){const proof=await verifySource(effect);verified.set(effect,proof);for(const policy of proof.policies)policyHashes.add(policy)}
  for(const item of selected){const created=verified.get(item.create)?.command;if(created?.kind!=='pantry-create'||created.data.itemId!==item.itemId)throw Error('INVALID_SOURCE_PROOF');if(item.nameHead){const named=verified.get(item.nameHead)?.command;if(named?.kind!=='pantry-field'||named.data.itemId!==item.itemId||named.data.field!=='name'||named.data.value!==item.name)throw Error('INVALID_SOURCE_PROOF')}else if(created.data.name!==item.name)throw Error('INVALID_SOURCE_PROOF');}
  const policies=[...policyHashes].sort(),disagreements=[];
  for(const policyHash of policies){const {policy}=await service.validateStored(policyHash,context);const allowed=policy.access.some(a=>a.actions.includes('disclose')&&a.recipients.includes(selection.recipient)&&a.destinations.includes('external')&&a.contentClasses.includes('shared-cooking')&&a.purposes.includes(selection.purpose));if(!allowed)throw Error('PROHIBITED');for(const rule of policy.rules){const matches=rule.recipient===selection.recipient&&rule.destinations.includes('external')&&rule.contentClasses.includes('shared-cooking')&&rule.purposes.includes(selection.purpose);if(!matches){if(rule.enforcement==='block')throw Error('BLOCKED_POLICY');disagreements.push({policyHash,ruleId:rule.id})}}}
  disagreements.sort((a,b)=>a.policyHash<b.policyHash?-1:a.policyHash>b.policyHash?1:a.ruleId<b.ruleId?-1:a.ruleId>b.ruleId?1:0);
  // This exact body is both displayed and transmitted. No tool calls, private
  // history, identities, timestamps, credentials or implicit context are added.
  const body=JSON.stringify({model:selection.model,messages:[{role:'user',content:JSON.stringify({task:'Suggest a meal using these ingredients.',ingredients})}],stream:false});
  if(new TextEncoder().encode(body).length>65536)throw Error('TOO_LARGE');
  const sourceRef=await hash(provider,'source',{scopeId:runtime.scope.scopeId,documentId:runtime.scope.documentId,checkpoint:runtime.scope.branchHead,revision,items:selection.itemIds,ingredients,effectIds});
  const payloadHash=await hash(provider,'http-body',body);
  return {version:2,scopeId:runtime.scope.scopeId,checkpoint:runtime.scope.branchHead,documentId:runtime.scope.documentId,documentRevision:revision,selection:structuredClone(selection),endpoint,recipient:selection.recipient,purpose:selection.purpose,model:selection.model,destination:{kind:'external',endpointIdentity:endpoint},sourceRefs:[sourceRef],sourceEffectIds:effectIds,policyHashes:policies,currentPolicyHash:record.policyHash,disagreements,body,payloadHash};
 }
 async function review(draft,explicit) {
  if(explicit!==true)throw Error('EXPLICIT_REVIEW_REQUIRED');draft=structuredClone(draft);const current=await prepare(draft.selection);if(!equal(current,draft))throw Error('REVIEW_DRIFT');
  const {context}=await service.active(),device=runtime.scope.authorDevice,author=context.verified.nodes.get(context.current.activeHead).devices.find(d=>d.deviceId===device&&d.active);if(!author)throw Error('INVALID_AUTHORITY');
  const id=randomId();if(!valid(id))throw Error('MALFORMED');const unsigned={id,requestNonce:id,...draft,actor:author.adultId,device,kind:draft.disagreements.length?'override':'review'};
  const signature=await provider.sign(context.resolved.signingKeyRefs[device],reviewBytes(unsigned));if(!(signature instanceof Uint8Array)||signature.length!==64)throw Error('INVALID_PROOF');
  const record={...unsigned,signature:hex(signature)};must(await runtime.storage.saveDisclosureReview({expectedAuthority:context.resolved.expectedAuthority,policyHash:draft.currentPolicyHash,documentId:draft.documentId,documentRevision:draft.documentRevision,record}));return record;
 }
 async function send(reviewId) {
  if(!valid(reviewId))throw Error('MALFORMED');
  const saved=must(await runtime.storage.readDisclosureReview(runtime.scope.scopeId,reviewId));if(!saved||saved.state!=='reviewed')throw Error('REVIEW_REQUIRED');const record=saved.record,{signature,...unsigned}=record;
  const draft=await prepare(record.selection);const {id,requestNonce,actor,device,kind,...oldDraft}=unsigned;if(id!==reviewId||requestNonce!==id)throw Error('INVALID_PROOF');if(!equal(draft,oldDraft))throw Error('REVIEW_DRIFT');
  const {context}=await service.active(),selected=context.verified.nodes.get(context.current.activeHead),author=selected.devices.find(d=>d.deviceId===device&&d.active&&d.adultId===actor),sig=unhex(signature);if(!author||device!==runtime.scope.authorDevice||!sig||!await provider.verify(context.resolved.signingKeyRefs[device],reviewBytes(unsigned),sig))throw Error('INVALID_PROOF');
  const transition={expectedAuthority:context.resolved.expectedAuthority,policyHash:draft.currentPolicyHash,documentId:draft.documentId,documentRevision:draft.documentRevision,reviewId,from:'reviewed',to:'unknown'};
  must(await runtime.storage.transitionDisclosureReview(transition));
  let response;try{response=await fetcher(draft.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:draft.body,redirect:'manual',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'})}catch(error){throw Object.assign(new Error('DELIVERY_UNKNOWN'),{cause:error})}
  const state=response.ok?'sent':'failed';try{must(await runtime.storage.transitionDisclosureReview({...transition,from:'unknown',to:state}))}catch{return {state:'unknown',status:response.status,observedState:state,completionPersistence:'unconfirmed'}}return {state,status:response.status};
 }
 return {prepare,review,send};
}
