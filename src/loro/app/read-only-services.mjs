// Retain the shape of optional services while preventing operations at a
// policy head whose ordinary disclosure and pairing authorities are unsupported.
export function unavailableInReadOnly(value) {
 if(typeof value==='function')return async()=>{throw Error('READ_ONLY_WORKSPACE')};
 if(!value || typeof value!=='object' || Array.isArray(value))return value;
 return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,unavailableInReadOnly(item)]));
}
export function readOnlyPairing(pairing) {
 return {...unavailableInReadOnly(pairing),selection:pairing.selection,
  selectedHousehold:pairing.selectedHousehold,onInstalled:pairing.onInstalled,
  acceptedParents:pairing.acceptedParents};
}
