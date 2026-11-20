/**
 * Bind a device confirmation to the verified household view that displayed it.
 * @param {{runtime:import('../engine/runtime.mjs').OfflineRuntime,
 *   withCurrent:<T>(use:(selectionRevision:number)=>Promise<T>)=>Promise<T>}} options
 */
export function householdLocalTrust({runtime,withCurrent}) {
  const {scopeId,authorDevice:localDeviceId} = runtime.scope;
  const reviews = runtime.storage.compromise;
  return {
    list: () => withCurrent(async selectionRevision => {
      const {expectedAuthority,signingKeyRefs} = await runtime.authorization();
      return Promise.all(Object.keys(signingKeyRefs).map(async deviceId => ({
        deviceId, local:deviceId === localDeviceId,
        quarantined:await reviews.isQuarantined(scopeId,deviceId),
        confirmation:{scopeId,deviceId,selectionRevision,authority:expectedAuthority.record}
      })));
    }),
    quarantine: input => {
      const {deviceId,confirmation,explicit} = structuredClone(input);
      return withCurrent(async selectionRevision => {
        const {expectedAuthority,signingKeyRefs} = await runtime.authorization();
        const reviewed = confirmation?.authority, current = expectedAuthority.record;
        if (explicit !== true || confirmation?.scopeId !== scopeId || confirmation.deviceId !== deviceId || confirmation.selectionRevision !== selectionRevision ||
          !reviewed || !current || reviewed.revision !== current.revision || reviewed.acceptedParent !== current.acceptedParent ||
          reviewed.authorizationSnapshot !== current.authorizationSnapshot) throw Error('STALE_DEVICE_CONFIRMATION');
        if (deviceId === localDeviceId || typeof deviceId !== 'string' || !Object.hasOwn(signingKeyRefs,deviceId)) {
          throw Error('INVALID_QUARANTINE_DEVICE');
        }
        return reviews.quarantine(scopeId,deviceId,{expectedAuthority,localDeviceId});
      });
    }
  };
}
