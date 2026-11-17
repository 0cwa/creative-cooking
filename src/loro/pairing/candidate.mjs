// Candidate ceremony validation only; release requires an atomic durable storage contract.
const enc = new TextEncoder();
const keys = ['version','sessionId','action','scopeKind','scopeId','parentHead','authorizationSnapshot','initiator','responder','signaling'];
const roleKeys = ['deviceId','signingKey','wrappingKey','nonce'];
const exact = (x,k) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === k.length && k.every(v => Object.hasOwn(x,v));
const str = x => typeof x === 'string' && x.length > 0 && enc.encode(x).length <= 256;
const hex = (x,n) => typeof x === 'string' && new RegExp(`^[0-9a-f]{${n*2}}$`).test(x);
export function ceremonyBytes(t) {
  if (!exact(t,keys)) throw Error('MALFORMED');
  if (t.version !== 1) throw Error('UNSUPPORTED_VERSION');
  if (![t.sessionId,t.scopeId,t.parentHead,t.authorizationSnapshot].every(str) || !['personal','household'].includes(t.scopeKind) || !['pairOwnDevice','inviteAdult','recoverDevice'].includes(t.action)) throw Error('MALFORMED');
  for (const role of [t.initiator,t.responder]) {
    if (!exact(role,roleKeys) || !str(role.deviceId) || !hex(role.signingKey,32) || !hex(role.wrappingKey,32) || !hex(role.nonce,32)) throw Error('MALFORMED');
  }
  if (t.initiator.deviceId === t.responder.deviceId || t.initiator.nonce === t.responder.nonce || !Array.isArray(t.signaling) || !t.signaling.length || t.signaling.length > 64 || t.signaling.reduce((n,x) => n + (typeof x === 'string' ? x.length : 0),0) > 2097152 || !t.signaling.every(x => typeof x === 'string' && /^[0-9a-f]*$/.test(x) && x.length % 2 === 0 && x.length <= 131072)) throw Error('MALFORMED');
  const role = r => Object.fromEntries(roleKeys.map(k => [k,r[k]]));
  const normalized = {...t,initiator:role(t.initiator),responder:role(t.responder)};
  return enc.encode(JSON.stringify(['creative-cooking/k2-candidate/v1','pairing',Object.fromEntries(keys.map(k => [k,normalized[k]]))]));
}
// Verification dependencies must perform pinned OOB, both role-specific signatures,
// encrypted wrapping-key possession, parent authorization, and durable replay checks.
// A successful verification is candidate evidence, never C0 Verified<T>.
export function candidatePairing(deps) {
  return {
    async verify(transcript, evidence) {
      const bytes = ceremonyBytes(transcript);
      for (const check of ['outOfBand','confirmations','possession','authorize','replay']) {
        if (typeof deps[check] !== 'function' || await deps[check](bytes.slice(),evidence) !== true) throw Error('INVALID_PROOF');
      }
      return {transcriptBytes:bytes};
    },
    async releaseKeys() { throw Error('RELEASE_UNAVAILABLE'); },
  };
}
