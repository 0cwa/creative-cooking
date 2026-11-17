import {MAX_OBJECT} from '../transport/adapter.mjs';
import {importCookingWithPolicy,validateCookingHeader} from '../disclosure/cooking.mjs';
const must=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};
/** A user-selected encrypted object is staged durably before the authorized
 * runtime applies it. Staged bytes survive missing dependencies and failures. */
export function cookingFiles({runtime,service}){
 const scopeId=runtime.scope.scopeId;
 async function list(){const rows=must(await runtime.storage.listOutboundObjects(scopeId));return rows.filter(x=>x.branchHead===runtime.scope.branchHead&&x.epochId===runtime.scope.epochId).map(x=>({objectId:x.objectId}));}
 async function download(objectId){if(typeof objectId!=='string'||!objectId)throw Error('MALFORMED');await runtime.authorize();const rows=must(await runtime.storage.listOutboundObjects(scopeId)),row=rows.find(x=>x.objectId===objectId);if(!row||row.branchHead!==runtime.scope.branchHead||row.epochId!==runtime.scope.epochId)throw Error('INVALID_AUTHORITY');return new Uint8Array(row.bytes);}
 async function receive(raw){if(!(raw instanceof Uint8Array))throw Error('MALFORMED');if(raw.length>MAX_OBJECT)throw Error('TOO_LARGE');const bytes=new Uint8Array(raw),auth=await runtime.authorization(),opened=await runtime.codec.openContent(bytes,auth.signingKeyRefs),id=opened.object.id;validateCookingHeader(opened,id,runtime.scope);const source=`file:${id}`,cursors=must(await runtime.storage.listCursors(scopeId)),expectedCursor=cursors.find(x=>x.source===source)?.cursor??null;must(await runtime.storage.stageInbox({scopeId,object:{id,bytes},source,expectedCursor,cursor:id}));return importCookingWithPolicy({runtime,service,item:{itemId:id,bytes}});}
 async function pending(){const [cursors,items,policyPending]=await Promise.all([runtime.storage.listCursors(scopeId),runtime.storage.listStagedInbox(scopeId),runtime.storage.listDisclosurePending(scopeId)]),reasons=new Map(must(policyPending).map(x=>[x.objectId,x.reason])),sources=new Set(must(cursors).filter(x=>x.source===`file:${x.cursor}`).map(x=>x.cursor)),pending=[];for(const item of must(items)){if(sources.has(item.itemId)&&!must(await runtime.storage.getInboxApplication(scopeId,item.itemId)))pending.push({itemId:item.itemId,reason:reasons.get(item.itemId)??null})}return pending;}
 async function retry(itemId){const items=must(await runtime.storage.listStagedInbox(scopeId)),item=items.find(x=>x.itemId===itemId);if(!item)throw Error('MISSING_UPDATE');const sources=must(await runtime.storage.listCursors(scopeId));if(!sources.some(x=>x.source===`file:${itemId}`&&x.cursor===itemId))throw Error('INVALID_AUTHORITY');return importCookingWithPolicy({runtime,service,item});}
 return {list,download,receive,pending,retry};
}
