import {MAX_OBJECT} from '../transport/adapter.mjs';
import {importCookingWithPolicy,validateCookingHeader} from '../disclosure/cooking.mjs';
const must=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};
/** A user-selected encrypted object is staged durably before the authorized
 * runtime applies it. Staged bytes survive missing dependencies and failures. */
export function cookingFiles({runtime,service}){
 const {scopeId,branchHead,epochId}=runtime.scope;
 const onBranch=value=>value?.branchHead===branchHead&&value?.epochId===epochId;
 const outbound=async()=>must(await runtime.storage.listOutboundObjects(scopeId)).filter(onBranch);
 const cookingSource=({source,cursor})=>source===`file:${cursor}`||source===`direct:${cursor}`;
 async function list(){await runtime.authorize();return (await outbound()).map(x=>({objectId:x.objectId}));}
 async function download(objectId){if(typeof objectId!=='string'||!objectId)throw Error('MALFORMED');await runtime.authorize();const row=(await outbound()).find(x=>x.objectId===objectId);if(!row)throw Error('INVALID_AUTHORITY');return new Uint8Array(row.bytes);}
 async function verifyUnderAuthority(bytes,expectedId,expectedAuthor){
  if(!(bytes instanceof Uint8Array))throw Error('MALFORMED');
  if(bytes.length>MAX_OBJECT)throw Error('TOO_LARGE');
  const auth=await runtime.authorization(),opened=await runtime.codec.openContent(bytes,auth.signingKeyRefs);
  validateCookingHeader(opened,expectedId??opened.object.id,runtime.scope);
  if(expectedAuthor!==undefined&&opened.header.authorDevice!==expectedAuthor)throw Error('INVALID_AUTHORITY');
  return {...opened.object,authorDevice:opened.header.authorDevice,expectedAuthority:auth.expectedAuthority};
 }
 const applyStaged=item=>importCookingWithPolicy({runtime,service,item});
 async function receive(raw){
  if(!(raw instanceof Uint8Array))throw Error('MALFORMED');
  if(raw.length>MAX_OBJECT)throw Error('TOO_LARGE');
  const bytes=new Uint8Array(raw),{id,expectedAuthority,authorDevice}=await verifyUnderAuthority(bytes);
  const source=`file:${id}`,cursors=must(await runtime.storage.listCursors(scopeId));
  const expectedCursor=cursors.find(x=>x.source===source)?.cursor??null;
  must(await runtime.storage.stageInbox({scopeId,object:{id,bytes},source,expectedCursor,cursor:id},expectedAuthority,authorDevice));
  return applyStaged({itemId:id,bytes});
 }
 async function pending(){
  await runtime.authorize();
  const [cursors,items,policyPending]=await Promise.all([runtime.storage.listCursors(scopeId),runtime.storage.listStagedInbox(scopeId),runtime.storage.listDisclosurePending(scopeId)]);
  const reasons=new Map(must(policyPending).map(x=>[x.objectId,x.reason])),sources=new Set(must(cursors).filter(cookingSource).map(x=>x.cursor)),pending=[];
  const decode=new TextDecoder('utf-8',{fatal:true});
  for(const item of must(items)){
   if(!sources.has(item.itemId))continue;
   const {header}=JSON.parse(decode.decode(item.bytes));
   if(!onBranch(header)||must(await runtime.storage.getInboxApplication(scopeId,item.itemId)))continue;
   const quarantined=await runtime.storage.compromise.isQuarantined(scopeId,header.authorDevice);
   pending.push({itemId:item.itemId,reason:quarantined?'QUARANTINED':reasons.get(item.itemId)??null});
  }
  return pending;
 }
 async function retry(itemId){await runtime.authorize();const items=must(await runtime.storage.listStagedInbox(scopeId)),item=items.find(x=>x.itemId===itemId);if(!item)throw Error('MISSING_UPDATE');const sources=must(await runtime.storage.listCursors(scopeId));if(!sources.some(x=>x.cursor===itemId&&cookingSource(x)))throw Error('INVALID_AUTHORITY');return applyStaged(item);}
 async function directBatch(peerId,limit,attempts) {
  await runtime.authorize();
  const [rows,states]=await Promise.all([outbound(),runtime.storage.listReceiptStates(scopeId)]);
  const receipts=new Map(must(states).filter(x=>x.destination==='peer'&&x.recipientId===peerId).map(x=>[x.objectId,x.state]));
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const pending=rows.filter(row=>receipts.get(row.objectId)!=='applied').map(row=>{
   const {header}=JSON.parse(decoder.decode(row.bytes));
   if(header.authorDevice!==runtime.scope.authorDevice||!Number.isSafeInteger(header.deviceSequence))throw Error('CORRUPT');
   return {...row,sequence:header.deviceSequence,attempts:attempts.get(row.objectId)??(receipts.get(row.objectId)==='stored'?1:0)};
  });
  // Keep each pass in writer order while giving untried updates a turn.
  pending.sort((a,b)=>a.attempts-b.attempts||a.sequence-b.sequence);
  return {objects:pending.slice(0,limit),more:pending.length>limit};
 }
 return {list,download,receive,pending,retry,verify:verifyUnderAuthority,applyStaged,directBatch};
}
