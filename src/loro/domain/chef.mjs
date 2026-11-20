import {planChefProposalEffect} from '../../chef/proposalEffect.ts';
import {DEFAULT_STATE} from '../../domain/defaults.ts';
import {bytes,proposalMapName} from './registry.mjs';
const must=r=>{if(!r.ok) throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};
const same=(a,b)=>{const x=bytes(a),y=bytes(b);return x.length===y.length && x.every((v,i)=>v===y[i])};
const mapName=(kind,id)=>`${kind}:${encodeURIComponent(id)}`;
const decode=new TextDecoder('utf-8',{fatal:true});
function entities(doc,kind) {
 return Object.keys(doc.getMap(`${kind}-index`).toJSON()).sort().map(id=> {
  const item={id,...doc.getMap(mapName(kind,id)).toJSON()};
  if(kind==='recipe') {
   item.ingredients=Object.keys(doc.getMap(mapName('recipe-ingredient-index',id)).toJSON()).map(memberId=>({id:memberId,...doc.getMap(mapName('recipe-ingredient',JSON.stringify([id,memberId]))).toJSON()})).filter(x=>!x.removed).sort((a,b)=>a.position-b.position || a.id.localeCompare(b.id)).map(({position,removed,...rest})=>rest);
   const steps=Object.keys(doc.getMap(mapName('recipe-step-index',id)).toJSON()).map(memberId=>({id:memberId,...doc.getMap(mapName('recipe-step',JSON.stringify([id,memberId]))).toJSON()})).filter(x=>!x.removed).sort((a,b)=>a.position-b.position || a.id.localeCompare(b.id));
   item.steps=steps.map(x=>x.text);item.stepIds=steps.map(x=>x.id);
  }
  return item;
 }).filter(x=>!x.removed && (kind!=='pantry'||!x.removedAt));
}
function mutations(before,after,collection) {
 const old=new Map(before.map(x=>[x.id,x])), next=new Map(after.map(x=>[x.id,x]));
 const changes=[];
 for(const id of [...new Set([...old.keys(),...next.keys()])].sort()) {
  const a=old.get(id),b=next.get(id);
  if(!b) {changes.push({collection,id,field:'removed',value:true});continue;}
  for(const field of Object.keys(b).filter(k=>k!=='id').sort()) {
   if(b[field]===undefined) continue;
   if(!a || !same(a[field]??null,b[field])) changes.push({collection,id,field,value:JSON.parse(JSON.stringify(b[field]))});
  }
 }
 return changes;
}
/** Accept a stored private proposal using the existing Chef planner. */
export async function acceptChef(input) {
 const keys=['storage','groupId','personal','household','conversationId','proposalId','personalOperationId','householdOperationId','personalCommandId','personalEffectId','householdCommandId','householdEffectId','personalSequence','householdSequence'];
 if(!input || Object.keys(input).length!==keys.length || !keys.every(k=>Object.hasOwn(input,k))) throw Error('MALFORMED');
 const {storage,groupId,personal,household,conversationId,proposalId,personalOperationId,householdOperationId,personalCommandId,personalEffectId,householdCommandId,householdEffectId,personalSequence,householdSequence}=input;
 const values=[groupId,conversationId,proposalId,personalOperationId,householdOperationId,personalCommandId,personalEffectId,householdCommandId,householdEffectId];
 if(!values.every(x=>typeof x==='string' && x.length) || ![personalSequence,householdSequence].every(x=>Number.isSafeInteger(x)&&x>=0)) throw Error('MALFORMED');
 if(personal.storage!==storage || household.storage!==storage) throw Error('STORAGE_MISMATCH');
 const pa=await personal.authorize(),ha=await household.authorize();
 if(pa.scope.kind!=='personal'||ha.scope.kind!=='household'||personal.scope.scopeId===household.scope.scopeId) throw Error('INVALID_AUTHORITY');
 const saved=must(await storage.getLocalGroup(groupId));
 if(saved) {
  const children=saved.group.children;
  if(children.length!==2) throw Error('CONFLICT');
  for(const [child,runtime,op,cid,eid,seq] of [[children[0],personal,personalOperationId,personalCommandId,personalEffectId,personalSequence],[children[1],household,householdOperationId,householdCommandId,householdEffectId,householdSequence]]) {
   let header;try {header=JSON.parse(decode.decode(child.outbound[0].object.bytes)).header}catch{throw Error('CORRUPT')}
   const c=child.commands[0];
   if(child.scopeId!==runtime.scope.scopeId||child.operationId!==op||child.commands.length!==1||child.outbound.length!==1||c.documentId!==runtime.scope.documentId||c.commandId!==cid||c.effectId!==eid||header.deviceSequence!==seq||header.authorDevice!==runtime.scope.authorDevice||header.scopeId!==runtime.scope.scopeId||header.documentId!==runtime.scope.documentId||header.suiteId!==runtime.scope.suiteId||!same(header.policyHashes,runtime.scope.policyHashes)||header.documentGeneration!==runtime.scope.documentGeneration||header.branchHead!==runtime.scope.branchHead||header.epochId!==runtime.scope.epochId) throw Error('CONFLICT');
  }
  let p;try {p=JSON.parse(decode.decode(children[0].commands[0].payload))}catch{throw Error('CORRUPT')}
  if(p.kind!=='chef-accept'||p.data.conversationId!==conversationId||p.data.proposalId!==proposalId||!same(p.data.effectIds,[householdEffectId])||children[1].commands[0].kind!=='chef-effect'||!same(p.data.effect,JSON.parse(decode.decode(children[1].commands[0].payload)))) throw Error('CONFLICT');
  return {outcomes:saved.outcomes,replayed:true};
 }
 const {doc:personalDoc,revision:personalRevision}=await personal.document();
 const map=personalDoc.getMap(proposalMapName(conversationId,proposalId)), proposal=map.get('proposal');
 if(!proposal||proposal.status!=='pending'||map.get('acceptance')) throw Error('PROPOSAL_NOT_PENDING');
 const {doc,revision:householdRevision}=await household.document(), pantry=entities(doc,'pantry'),recipes=entities(doc,'recipe');
 const state=structuredClone(DEFAULT_STATE);state.pantry=pantry;state.recipes=recipes;
 const settings=doc.getMap('settings').toJSON();state.settings={...state.settings,...settings};
 state.activeConversationId=conversationId;state.chatMessages=[{id:'proposal-message',role:'assistant',content:'',createdAt:proposal.createdAt,proposals:[{id:proposalId,toolName:proposal.toolName,arguments:proposal.arguments,status:'pending'}]}];
 const planned=planChefProposalEffect(state,household.scope.scopeId,conversationId,state.chatMessages[0].proposals[0]);
 const changes=[...mutations(pantry,planned.state.pantry,'pantry'),...mutations(recipes,planned.state.recipes,'recipe')];
 if(!changes.length) throw Error('NO_EFFECT');
 const hc={version:1,kind:'chef-effect',commandId:householdCommandId,effectId:householdEffectId,dependencyEffectIds:Object.entries(doc.getMap('domain-effects').toJSON()).filter(([,value])=>proposal.toolName.startsWith('pantry_') && value?.touches?.includes('pantry')).map(([id])=>id).sort(),data:{mutations:changes}};
 const pc={version:1,kind:'chef-accept',commandId:personalCommandId,effectId:personalEffectId,dependencyEffectIds:[proposal.effectId],data:{conversationId,proposalId,effectIds:[householdEffectId],status:'applied',effect:hc,proposal}};
 const pp=await personal.prepare({operationId:personalOperationId,deviceSequence:personalSequence,command:pc});
 const hp=await household.prepare({operationId:householdOperationId,deviceSequence:householdSequence,command:hc});
 if(pp.previous||hp.previous||pp.commit.documents[0].expectedRevision!==personalRevision||hp.commit.documents[0].expectedRevision!==householdRevision) throw Error('CONFLICT');
 return must(await storage.commitLocalGroup({groupId,children:[pp.commit,hp.commit]}));
}
