/** An older authenticated policy remains evidence after a household transition,
 * but cannot authorize new external disclosure at the new head. */
export async function bootstrapDisclosurePolicy(storage,scopeId,service){
 const pointer=await storage.readDisclosureActive(scopeId);if(!pointer.ok)throw Error(typeof pointer.error==='string'?pointer.error:pointer.error.code);if(!pointer.value)return {needsSetup:true,needsRenewal:false};
 const context=await service.authority(),record=await service.validateStored(pointer.value,context);return {needsSetup:false,needsRenewal:record.policy.checkpoint!==context.current.activeHead};
}
