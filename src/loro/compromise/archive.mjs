// Explicit inspection of durable old-generation outbound envelopes. No deletion or re-signing.
export async function inspectArchivedOutbound(runtime){
 if(!runtime?.storage||!runtime.scope)throw Error('MALFORMED');const required=r=>{if(!r.ok)throw Error(typeof r.error==='string'?r.error:r.error.code);return r.value},authority=await runtime.authorization(),objects=required(await runtime.storage.listOutboundObjects(runtime.scope.scopeId)),receipts=required(await runtime.storage.listReceiptStates(runtime.scope.scopeId));
 if(objects.length>256||objects.reduce((n,o)=>n+o.bytes.length,0)>1024*1024)throw Error('TOO_LARGE');
 const archived=objects.filter(o=>o.branchHead!==runtime.scope.branchHead||o.epochId!==runtime.scope.epochId).map(o=>({objectId:o.objectId,branchHead:o.branchHead,epochId:o.epochId,bytes:new Uint8Array(o.bytes),receipts:receipts.filter(r=>r.objectId===o.objectId).map(r=>({...r})),status:'preserved-for-review'}));
 const current=await runtime.authorization();if(JSON.stringify(current.expectedAuthority)!==JSON.stringify(authority.expectedAuthority))throw Error('STALE_AUTHORITY');return {archived,complete:false};
}
