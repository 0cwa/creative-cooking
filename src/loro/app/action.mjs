import {commitCookingBatchWithPolicy,recoverCookingBatchWithPolicy} from '../disclosure/cooking.mjs';
// Stable action IDs and command IDs are supplied by the caller and retained
// across retries; saved commits are inspected before any allocation or sealing.
const must=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};
const queues=new WeakMap(),listeners=new WeakMap();
export function subscribeActions(runtime,listener) {
 let set=listeners.get(runtime);if(!set){set=new Set();listeners.set(runtime,set)}set.add(listener);
 return ()=>{set.delete(listener);if(!set.size)listeners.delete(runtime)};
}

export function executeAction(runtime,sequences,actionId,commands,disclosure=null) {
 const input=structuredClone(commands);
 const previous=queues.get(runtime)??Promise.resolve();
 const current=previous.catch(()=>{}).then(()=>execute(runtime,sequences,actionId,input,disclosure)).then(result=>{for(const listener of listeners.get(runtime)??[]){try{listener()}catch{}}return result});
 queues.set(runtime,current);
 void current.finally(()=>{if(queues.get(runtime)===current)queues.delete(runtime)}).catch(()=>{});
 return current;
}
async function execute(runtime,sequences,actionId,commands,disclosure) {
 if(typeof actionId!=='string'||!actionId||!Array.isArray(commands)||!commands.length||commands.some(c=>typeof c?.commandId!=='string'||!c.commandId)||new Set(commands.map(c=>c.commandId)).size!==commands.length)throw Error('MALFORMED');
 commands=structuredClone(commands);
 if(runtime.authority?.kind==='household'&&!disclosure)throw Error('POLICY_REQUIRED');
 const saved=must(await runtime.storage.getLocalOperation(runtime.scope.scopeId,actionId));
 let items;
 if(saved) {
  if(saved.commit.outbound.length!==commands.length)throw Error('CONFLICT');
  items=commands.map((command,i)=>{let header;try{header=JSON.parse(new TextDecoder().decode(saved.commit.outbound[i].object.bytes)).header}catch{throw Error('CORRUPT')}return {command,deviceSequence:header.deviceSequence}});
 } else {
  await runtime.authorize();
  items=[];for(const command of commands)items.push({command,deviceSequence:await sequences.reserve(runtime.scope.scopeId,JSON.stringify([actionId,command.commandId]))});
 }
 if(saved&&disclosure)return recoverCookingBatchWithPolicy({runtime,service:disclosure,operationId:actionId,items});
 if(saved)await runtime.authorize();
 const commit=()=>disclosure?commitCookingBatchWithPolicy({runtime,service:disclosure,operationId:actionId,items}):runtime.executeBatch({operationId:actionId,items});
 try{return await commit()}catch(error){
  if(error?.message!=='CONFLICT')throw error;
  // A concurrent tab may have committed the same action after our read.
  // Re-read first; executeBatch verifies the saved command and ciphertext header.
  const completed=must(await runtime.storage.getLocalOperation(runtime.scope.scopeId,actionId));
  if(!completed)throw error;return commit();
 }
}
