import {chatConversationFromMessages} from '../../domain/conversations.ts';
const named=(kind,id)=>`${kind}:${encodeURIComponent(id)}`;
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const preferences=['systemPrompt','allergies','sendLocalTime','city','providerId','model','dictationEngine','theme'];
const conversations=state=>{const result=new Map(state.chatHistory.map(c=>[c.id,c]));if(state.activeConversationId&&state.chatMessages.length){const active=chatConversationFromMessages(state.activeConversationId,state.chatMessages);if(active)result.set(active.id,active)}return result;};
/** Plan independent private messages and per-key personal preferences. */
export function planPersonalAction({doc,before,after,actionId}) {
 if(!doc||!before||!after||typeof actionId!=='string'||!actionId)throw Error('MALFORMED');
 const commands=[];let n=0;const add=(kind,data,deps=[])=>{const effectId=`${actionId}:${++n}`;commands.push({version:1,kind,commandId:effectId,effectId,dependencyEffectIds:[...new Set(deps)].sort(),data});return effectId};
 for(const key of preferences)if(!same(before.settings[key],after.settings[key]))add('personal-preference-put',{key,value:after.settings[key]});
 if(!same(before.mealContext,after.mealContext))add('personal-preference-put',{key:'mealContext',value:after.mealContext});
 if(before.activeConversationId!==after.activeConversationId)add('personal-preference-put',{key:'activeConversationId',value:after.activeConversationId});
 const old=conversations(before),next=conversations(after),index=doc.getMap('personal-conversations'),deletions=doc.getMap('personal-conversation-deletions');
 for(const id of [...new Set([...old.keys(),...next.keys()])].sort()) {
  const a=old.get(id),b=next.get(id),existing=index.get(id);
  if(!b) {if(!a||!existing||deletions.get(id))throw Error('CONFLICT');add('personal-conversation-delete',{conversationId:id},[existing.effectId]);continue;}
  let create=existing?.effectId;
  if(!existing){if(a||deletions.get(id))throw Error('CONFLICT');create=add('personal-conversation-create',{conversationId:id,title:b.title,createdAt:b.createdAt});}
  else if(!a)throw Error('REBASE_REQUIRED');
  const oldMessages=new Map((a?.messages??[]).map(m=>[m.id,m])),newMessages=new Map(b.messages.map(m=>[m.id,m]));
  if(oldMessages.size!==(a?.messages.length??0)||newMessages.size!==b.messages.length)throw Error('MALFORMED');
  for(const [id,message] of oldMessages)if(!newMessages.has(id)||!same(message,newMessages.get(id)))throw Error('UNSUPPORTED_EDIT');
  const stored=doc.getMap(named('personal-messages',b.id));
  for(const message of b.messages)if(!oldMessages.has(message.id)){if(stored.get(message.id))throw Error('CONFLICT');add('personal-message-add',{conversationId:b.id,message},[create]);}
 }
 return commands;
}
