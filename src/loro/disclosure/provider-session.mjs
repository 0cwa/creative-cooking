import {hash,reviewBytes} from './policy.mjs';
const SYSTEM='You are Chef. Suggest cooking ideas using only the selected ingredients. Do not infer private household information.';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const must=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};
export const sharedChefSystemPrompt=SYSTEM;
/** This session is owned by the built-in provider run. Its only app-sourced
 * input is the selected, verified pantry projection; private messages and
 * settings are never passed to that run. Every tool round calls this gate. */
export function createReviewedProviderSession({gateway,runtime,service,provider,selection,providerId,confirm,onOutcome,randomId}) {
 selection=structuredClone(selection);if(typeof confirm!=='function'||typeof randomId!=='function')throw Error('MALFORMED');
 let round=0;
 const check=(base,request)=>{
  if(!request||Object.keys(request).sort().join(',')!=='body,endpoint,model'||request.endpoint!==base.endpoint||request.model!==base.model||typeof request.body!=='string'||new TextEncoder().encode(request.body).length>65536)throw Error('MALFORMED_REQUEST');
  let body;try{body=JSON.parse(request.body)}catch{throw Error('MALFORMED_REQUEST')};const prompt=JSON.parse(base.body).messages[0].content;
  if(['openai','openrouter','mistral'].includes(providerId)){
   if(Object.keys(body).some(k=>!['model','messages','tools','tool_choice','stream'].includes(k))||body.model!==base.model||!Array.isArray(body.messages)||!same(body.messages[0],{role:'system',content:SYSTEM})||!same(body.messages[1],{role:'user',content:prompt})||body.messages.slice(2).some(x=>!x||!['assistant','tool'].includes(x.role)))throw Error('PRIVATE_CONTEXT_PROHIBITED');
  }else if(providerId==='anthropic'){
   if(Object.keys(body).some(k=>!['model','max_tokens','system','messages','tools','stream'].includes(k))||body.model!==base.model||body.system!==SYSTEM||!Array.isArray(body.messages)||!same(body.messages[0],{role:'user',content:prompt})||body.messages.slice(1).some(x=>!x||!['assistant','user'].includes(x.role)||x.role==='user'&&(!Array.isArray(x.content)||x.content.some(y=>y?.type!=='tool_result'))))throw Error('PRIVATE_CONTEXT_PROHIBITED');
  }else if(providerId==='gemini'){
   if(Object.keys(body).some(k=>!['systemInstruction','contents','tools'].includes(k))||!same(body.systemInstruction,{parts:[{text:SYSTEM}]})||!Array.isArray(body.contents)||!same(body.contents[0],{role:'user',parts:[{text:prompt}]})||body.contents.slice(1).some(x=>!x||!['model','user'].includes(x.role)||x.role==='user'&&(!Array.isArray(x.parts)||x.parts.some(y=>!y?.functionResponse))))throw Error('PRIVATE_CONTEXT_PROHIBITED');
  }else throw Error('UNSUPPORTED_PROVIDER');
  if(round===0&&((body.messages?.length??body.contents?.length)!==(providerId==='anthropic'||providerId==='gemini'?1:2)))throw Error('PRIVATE_CONTEXT_PROHIBITED');
 };
 return async(request,send)=>{
  request=structuredClone(request);if(typeof send!=='function')throw Error('MALFORMED');const initial=await gateway.prepare(selection);check(initial,request);
  const draft={...initial,body:request.body,payloadHash:await hash(provider,'http-body',request.body)};if(await confirm(structuredClone(draft))!==true)throw Error('REVIEW_DECLINED');
  const fresh=await gateway.prepare(selection);if(!same(initial,fresh))throw Error('REVIEW_DRIFT');check(fresh,request);
  const {context}=await service.active(),device=runtime.scope.authorDevice,author=context.verified.nodes.get(context.current.activeHead).devices.find(d=>d.deviceId===device&&d.active);if(!author)throw Error('INVALID_AUTHORITY');const id=randomId();if(typeof id!=='string'||!id)throw Error('MALFORMED');const unsigned={id,requestNonce:id,...draft,actor:author.adultId,device,kind:draft.disagreements.length?'override':'review'},signature=await provider.sign(context.resolved.signingKeyRefs[device],reviewBytes(unsigned));if(!(signature instanceof Uint8Array)||signature.length!==64)throw Error('INVALID_PROOF');const record={...unsigned,signature:hex(signature)};
  must(await runtime.storage.saveDisclosureReview({expectedAuthority:context.resolved.expectedAuthority,policyHash:draft.currentPolicyHash,documentId:draft.documentId,documentRevision:draft.documentRevision,record}));
  const transition={expectedAuthority:context.resolved.expectedAuthority,policyHash:draft.currentPolicyHash,documentId:draft.documentId,documentRevision:draft.documentRevision,reviewId:id,from:'reviewed',to:'unknown'};must(await runtime.storage.transitionDisclosureReview(transition));
  let response;try{response=await send()}catch(error){onOutcome?.({state:'unknown'});throw Object.assign(new Error('DELIVERY_UNKNOWN'),{cause:error})}const state=response.ok?'sent':'failed';try{must(await runtime.storage.transitionDisclosureReview({...transition,from:'unknown',to:state}))}catch{onOutcome?.({state:'unknown',status:response.status});throw Error('DELIVERY_PERSISTENCE_UNKNOWN')}onOutcome?.({state,status:response.status});round++;return response;
 };
}
