// Deliberately finite, input-driven illustration; proof booleans stand in for verification.
export function decide(r) {
  const result = (result, reason) => ({ result, reasons: [reason] });
  const keys = ['action','policy','accepted','conflict','proof','admitted','recipient','destination','content','purpose','rules','consents','requiredPeople','quorums','local','retention'];
  if (!r || Object.keys(r).some(k => !keys.includes(k)) || keys.some(k => !(k in r)) ||
      !['editLocal','restorePrivate','releasePrivatePackage','releaseSharedKey','disclose','approve','publish','enrollHost'].includes(r.action) ||
      !['valid','missing','invalid'].includes(r.proof) ||
      ![r.accepted,r.conflict,r.admitted,r.local].every(x => typeof x === 'boolean') ||
      ![r.policy,r.recipient,r.destination,r.content,r.purpose].every(x => typeof x === 'string') ||
      ![r.rules,r.consents,r.requiredPeople,r.quorums].every(Array.isArray) || !r.requiredPeople.every(v => typeof v === 'string') ||
      r.rules.some(x => !x || Object.keys(x).sort().join() !== 'actions,contents,destinations,purposes,recipients' || ![x.actions,x.contents,x.destinations,x.purposes,x.recipients].every(a => Array.isArray(a) && a.every(v => typeof v === 'string'))) ||
      r.consents.some(x => !x || Object.keys(x).sort().join() !== 'content,person,policy,purpose,recipient,scope' || Object.values(x).some(v => typeof v !== 'string')) ||
      r.quorums.some(x => !x || Object.keys(x).sort().join() !== 'approvals,electorate,threshold' || !Array.isArray(x.approvals) || !Array.isArray(x.electorate) || !x.approvals.every(v => typeof v === 'string') || !x.electorate.every(v => typeof v === 'string') || !Number.isInteger(x.threshold) || x.threshold < 1 || x.threshold > new Set(x.electorate).size) ||
      (r.retention !== null && (!Array.isArray(r.retention) || r.retention.some(x => !x || Object.keys(x).sort().join() !== 'max,min' || !Number.isFinite(x.min) || !Number.isFinite(x.max) || x.min < 0 || x.max < x.min)))) return result('Deny','INVALID_INPUT');
  if (r.proof === 'invalid') return result('Deny','INVALID_INPUT');
  if (r.action === 'editLocal') return result('LocalOnly','LOCAL_EDIT');
  if (r.proof === 'missing') return result('Pending','MISSING_EVIDENCE');
  if (!r.accepted || r.conflict) return result('Pending','POLICY_UNRESOLVED');
  if (['releaseSharedKey','approve','publish'].includes(r.action) && !r.admitted) return result('Pending','ADMISSION_REQUIRED');
  if (r.rules.some(x => !x.actions.includes(r.action) || !x.recipients.includes(r.recipient) || !x.destinations.includes(r.destination) || !x.contents.includes(r.content) || !x.purposes.includes(r.purpose))) return r.local ? result('LocalOnly','LOCAL_ALTERNATIVE') : result('Deny','PROHIBITED');
  if (r.retention?.length && Math.max(...r.retention.map(x => x.min)) > Math.min(...r.retention.map(x => x.max))) return result('Deny','INCOMPATIBLE');
  if (r.requiredPeople.some(person => !r.consents.some(x => x.person === person && x.policy === r.policy && x.recipient === r.recipient && x.content === r.content && x.purpose === r.purpose && x.scope === r.action))) return result('RequireConsent','CONSENT_REQUIRED');
  if (r.quorums.some(x => new Set(x.approvals.filter(a => x.electorate.includes(a))).size < x.threshold)) return result('Pending','QUORUM_REQUIRED');
  return result('Allow','OK');
}
