// Stable action IDs and command IDs are supplied by the caller and retained
// across retries; saved commits are inspected before any allocation or sealing.
const must=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value};
export async function executeAction(runtime,sequences,actionId,commands) {
 if(typeof actionId!=='string'||!actionId||!Array.isArray(commands)||!commands.length||commands.some(c=>typeof c?.commandId!=='string'||!c.commandId)||new Set(commands.map(c=>c.commandId)).size!==commands.length)throw Error('MALFORMED');
 commands=structuredClone(commands);
 await runtime.authorize();
 const saved=must(await runtime.storage.getLocalOperation(runtime.scope.scopeId,actionId));
 let items;
 if(saved) {
  if(saved.commit.outbound.length!==commands.length)throw Error('CONFLICT');
  items=commands.map((command,i)=>{let header;try{header=JSON.parse(new TextDecoder().decode(saved.commit.outbound[i].object.bytes)).header}catch{throw Error('CORRUPT')}return {command,deviceSequence:header.deviceSequence}});
 } else {
  items=[];for(const command of commands)items.push({command,deviceSequence:await sequences.reserve(runtime.scope.scopeId,JSON.stringify([actionId,command.commandId]))});
 }
 try{return await runtime.executeBatch({operationId:actionId,items})}catch(error){
  if(error?.message!=='CONFLICT')throw error;
  // A concurrent tab may have committed the same action after our read.
  // Re-read first; executeBatch verifies the saved command and ciphertext header.
  const completed=must(await runtime.storage.getLocalOperation(runtime.scope.scopeId,actionId));
  if(!completed)throw error;return runtime.executeBatch({operationId:actionId,items});
 }
}
