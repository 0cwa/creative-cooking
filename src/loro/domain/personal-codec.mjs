// Personal commands require personal authority and a separate personal data key.
const encoder=new TextEncoder();
const id=x=>typeof x==='string'&&x.length>0&&encoder.encode(x).length<=256;
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const json=(x,depth=0)=>depth<=16&&(x===null||typeof x==='boolean'||typeof x==='string'||(typeof x==='number'&&Number.isFinite(x))||(Array.isArray(x)&&x.length<=10000&&Array.from({length:x.length},(_,i)=>Object.hasOwn(x,i)&&json(x[i],depth+1)).every(Boolean))||(x&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).length<=10000&&Object.values(x).every(v=>json(v,depth+1))));
const preferenceKeys=new Set(['mealContext','systemPrompt','allergies','sendLocalTime','city','providerId','model','dictationEngine','theme','activeConversationId','recoveryReminderDismissed']);
const validPreference=(key,v)=>{
 if(key==='mealContext')return exact(v,['willingToShop','portions','cooks'])&&typeof v.willingToShop==='boolean'&&Number.isSafeInteger(v.portions)&&v.portions>0&&Array.isArray(v.cooks)&&v.cooks.every(x=>['low','medium','high'].includes(x));
 if(key==='allergies')return Array.isArray(v)&&v.every(x=>typeof x==='string');
 if(key==='sendLocalTime'||key==='recoveryReminderDismissed')return typeof v==='boolean';
 if(key==='activeConversationId')return v===null||id(v);
 if(key==='providerId')return ['openrouter','openai','anthropic','gemini','mistral','webllm'].includes(v);
 if(key==='theme')return ['system','light','dark'].includes(v);
 if(key==='dictationEngine')return ['browser','whisper'].includes(v);
 return typeof v==='string';
};
const validMessage=m=>{
 if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(k=>!['id','role','content','createdAt','proposals'].includes(k))||!id(m.id)||!['user','assistant'].includes(m.role)||typeof m.content!=='string'||!Number.isFinite(Date.parse(m.createdAt)))return false;
 return m.proposals===undefined||(Array.isArray(m.proposals)&&m.proposals.every(p=>exact(p,['id','toolName','arguments','status'])&&id(p.id)&&id(p.toolName)&&typeof p.arguments==='string'&&['pending','applied'].includes(p.status)));
};
const kinds=new Set(['personal-conversation-create','personal-conversation-delete','personal-message-add','personal-preference-put']);
export const isPersonalCommand=kind=>kinds.has(kind);
const mapName=(kind,id)=>`${kind}:${encodeURIComponent(id)}`;
export function validatePersonalCommand(c) {
 if(!exact(c,['version','kind','commandId','effectId','dependencyEffectIds','data'])||c.version!==1||!isPersonalCommand(c.kind)||!id(c.commandId)||!id(c.effectId)||!Array.isArray(c.dependencyEffectIds)||!c.dependencyEffectIds.every(id)||new Set(c.dependencyEffectIds).size!==c.dependencyEffectIds.length||c.dependencyEffectIds.includes(c.effectId))throw Error('MALFORMED_COMMAND');
 const d=c.data;
 if(c.kind==='personal-conversation-create') {if(!exact(d,['conversationId','title','createdAt'])||!id(d.conversationId)||typeof d.title!=='string'||!Number.isFinite(Date.parse(d.createdAt)))throw Error('MALFORMED_COMMAND');}
 if(c.kind==='personal-conversation-delete') {if(!exact(d,['conversationId'])||!id(d.conversationId))throw Error('MALFORMED_COMMAND');}
 if(c.kind==='personal-message-add') {if(!exact(d,['conversationId','message'])||!id(d.conversationId)||!json(d.message)||!validMessage(d.message))throw Error('MALFORMED_COMMAND');}
 if(c.kind==='personal-preference-put'&&(!exact(d,['key','value'])||!preferenceKeys.has(d.key)||!json(d.value)||!validPreference(d.key,d.value)))throw Error('MALFORMED_COMMAND');
 if(encoder.encode(JSON.stringify(c)).length>1024*1024)throw Error('MALFORMED_COMMAND');return structuredClone(c);
}
export function personalOperations(input) {
 const c=validatePersonalCommand(input),d=c.data;let op;
 if(c.kind==='personal-conversation-create')op={container:'personal-conversations',key:d.conversationId,value:{title:d.title,createdAt:d.createdAt,effectId:c.effectId}};
 else if(c.kind==='personal-conversation-delete')op={container:'personal-conversation-deletions',key:d.conversationId,value:c.effectId};
 else if(c.kind==='personal-message-add')op={container:mapName('personal-messages',d.conversationId),key:d.message.id,value:{message:d.message,effectId:c.effectId}};
 else op={container:'personal-preferences',key:d.key,value:d.value};
 return [op,{container:'domain-effects',key:c.effectId,value:{version:2,touches:[],dependencyEffectIds:c.dependencyEffectIds,command:c}}];
}
export function checkPersonalPreconditions(doc,c) {
 if(c.kind==='personal-preference-put')return;
 const d=c.data,existing=doc.getMap('personal-conversations').get(d.conversationId),deleted=doc.getMap('personal-conversation-deletions').get(d.conversationId);
 if(c.kind==='personal-conversation-create'){if(existing||deleted)throw Error('CONFLICT');return;}
 if(!existing||!c.dependencyEffectIds.includes(existing.effectId))throw Error('MISSING_DEPENDENCY');
 if(deleted)throw Error('CONVERSATION_DELETED');
 if(c.kind==='personal-message-add'&&doc.getMap(mapName('personal-messages',d.conversationId)).get(d.message.id))throw Error('CONFLICT');
}
export function assertCommandScope(kind,scopeKind) {
 if(!['personal','household'].includes(scopeKind))throw Error('INVALID_AUTHORITY');
 if(isPersonalCommand(kind)&&scopeKind!=='personal')throw Error('INVALID_AUTHORITY');
 if(!isPersonalCommand(kind)&&scopeKind==='personal'&&!['chef-proposal-create','chef-accept'].includes(kind))throw Error('INVALID_AUTHORITY');
}
export function projectPersonal(doc) {
 const deleted=doc.getMap('personal-conversation-deletions').toJSON();
 const conversations=Object.entries(doc.getMap('personal-conversations').toJSON()).filter(([id])=>!deleted[id]).sort(([a],[b])=>a.localeCompare(b)).map(([id,header])=>{const messages=Object.values(doc.getMap(mapName('personal-messages',id)).toJSON()).map(x=>x.message).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));return {id,title:header.title,createdAt:header.createdAt,updatedAt:messages.at(-1)?.createdAt??header.createdAt,messages};});
 return {conversations,preferences:doc.getMap('personal-preferences').toJSON()};
}
