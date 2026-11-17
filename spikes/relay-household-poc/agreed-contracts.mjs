// Interview-agreed decision examples, not a production authorization engine.
// IDs, identity mappings, payload hashes, measured sizes and proof states are
// supplied by a hypothetical verified adapter. No cryptography or I/O runs here.
const answer = (result, reason, details = {}) => ({ result, reason, ...details });
const id = value => typeof value === 'string' && value.length > 0;
const ids = value => Array.isArray(value) && value.every(id);
const integer = value => Number.isSafeInteger(value) && value >= 0;

export function admission(request) {
  if (!request || !ids(request.roster) || !request.roster.length ||
      new Set(request.roster).size !== request.roster.length || !ids(request.approvals) ||
      !id(request.parent) || !id(request.proposalParent) ||
      !['allMinusOne', 'unanimous', 'fixed'].includes(request.parentPolicy?.kind)) {
    return answer('Deny', 'INVALID_INPUT');
  }
  if (request.parent !== request.proposalParent) return answer('Pending', 'PARENT_UNRESOLVED');
  const count = request.roster.length;
  const threshold = request.parentPolicy.kind === 'allMinusOne' ? Math.max(1, count - 1) :
    request.parentPolicy.kind === 'unanimous' ? count : request.parentPolicy.threshold;
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > count ||
      request.approvals.some(person => !request.roster.includes(person))) {
    return answer('Deny', 'INVALID_ELECTORATE_OR_THRESHOLD');
  }
  const approvals = new Set(request.approvals).size;
  return answer(approvals >= threshold ? 'Allow' : 'Pending',
    approvals >= threshold ? 'PARENT_QUORUM_MET' : 'QUORUM_REQUIRED', { threshold, approvals });
}

export function disclosure(request) {
  if (!request || ![request.actor, request.owner, request.contentHash, request.provider,
      request.purpose, request.policyHash].every(id) ||
      !['sharedCooking', 'private', 'secret', 'sharedKey'].includes(request.scope) ||
      !['aiProcess', 'otherDisclosure'].includes(request.action) ||
      !['onDevice', 'networkLocal', 'external'].includes(request.destination) ||
      !['preference', 'block'].includes(request.mode) ||
      !['accepted', 'unresolved'].includes(request.policyState) ||
      ![request.readable, request.permitted].every(value => typeof value === 'boolean') ||
      (request.override !== null && (typeof request.override !== 'object' ||
        Array.isArray(request.override) || !['action', 'actor', 'contentHash', 'provider', 'purpose', 'policyHash', 'destination']
          .every(key => id(request.override[key]))))) return answer('Deny', 'INVALID_INPUT');
  // This models content processing, never credential use or key distribution.
  if (!request.readable || ['secret', 'sharedKey'].includes(request.scope) ||
      (request.scope === 'private' && request.owner !== request.actor)) return answer('Deny', 'PROTECTED_SCOPE');
  if (request.destination === 'onDevice') return answer('Allow', 'ON_DEVICE_PROCESSING');
  if (request.policyState !== 'accepted') return answer('Pending', 'POLICY_UNRESOLVED');
  if (request.permitted) return answer('Allow', 'PERMITTED_DISCLOSURE');
  if (request.mode === 'block' || request.scope !== 'sharedCooking' || request.action !== 'aiProcess') {
    return answer('Deny', 'BLOCKING_RULE');
  }
  if (!request.override || !['action', 'actor', 'contentHash', 'provider', 'purpose', 'policyHash', 'destination']
      .every(key => request.override[key] === request[key])) return answer('RequireReview', 'EXACT_PAYLOAD_REVIEW_REQUIRED');
  return answer('AllowWithOverride', 'DISCLOSED_AGAINST_PREFERENCE',
    { disagreement: true, householdConsent: false });
}

export function newcomerGrant(request) {
  if (!request || !['approved', 'pending'].includes(request.membership) ||
      !['currentCooking', 'none'].includes(request.delegation) ||
      !['freshProjection', 'historicalSnapshot', 'historicalKey', 'archive'].includes(request.material) ||
      !ids(request.classes) || typeof request.freshKey !== 'boolean' ||
      typeof request.newDocument !== 'boolean') return answer('Deny', 'INVALID_INPUT');
  if (request.membership !== 'approved') return answer('Pending', 'ADMISSION_REQUIRED');
  if (request.delegation !== 'currentCooking') return answer('Pending', 'SHARING_GRANT_REQUIRED');
  if (request.material !== 'freshProjection' || !request.newDocument || !request.freshKey ||
      request.classes.some(value => !['recipe', 'pantry', 'shopping'].includes(value))) {
    return answer('Deny', 'HISTORY_OR_SCOPE_LEAK');
  }
  return answer('Allow', 'CURRENT_STATE_ONLY');
}

// Initial per-batch engineering budgets, to measure before release. They do not
// bound the entire inbox, the relay or transport receive buffer.
export const REVIEW_LIMITS = Object.freeze({ objects: 256, bytes: 8 * 1024 * 1024,
  objectBytes: 1024 * 1024, dependencies: 64 });

export function freezeReviewBatch(request) {
  if (!request || ![request.id, request.checkpoint, request.suspectDevice].every(id) ||
      !ids(request.trustedBase) || !Array.isArray(request.changes)) return answer('Deny', 'INVALID_INPUT');
  if (request.changes.length > REVIEW_LIMITS.objects || request.trustedBase.length > REVIEW_LIMITS.objects) {
    return answer('Pending', 'BATCH_LIMIT');
  }
  let bytes = 0;
  const seen = new Set();
  for (const change of request.changes) {
    if (!change || !id(change.id) || !id(change.authorDevice) || !integer(change.measuredBytes) ||
        !ids(change.dependencies) || seen.has(change.id) || request.trustedBase.includes(change.id)) {
      return answer('Deny', 'INVALID_INPUT');
    }
    if (change.dependencies.length > REVIEW_LIMITS.dependencies ||
        change.measuredBytes > REVIEW_LIMITS.objectBytes) return answer('Pending', 'BATCH_LIMIT');
    bytes += change.measuredBytes;
    if (bytes > REVIEW_LIMITS.bytes) return answer('Pending', 'BATCH_LIMIT');
    seen.add(change.id);
  }
  // Freeze copies; future mutations of the supplied list cannot extend a review.
  const changes = request.changes.map(change => Object.freeze({ id: change.id,
    authorDevice: change.authorDevice, measuredBytes: change.measuredBytes,
    dependencies: Object.freeze([...change.dependencies]) }));
  return Object.freeze({ result: 'Frozen', id: request.id, checkpoint: request.checkpoint,
    suspectDevice: request.suspectDevice, changes: Object.freeze(changes),
    trustedBase: Object.freeze([...request.trustedBase]), bytes, completeness: 'unverified' });
}

export function reviewDisposition(batch, changeId) {
  if (batch?.result !== 'Frozen' || !id(changeId)) return answer('Deny', 'INVALID_INPUT');
  const changes = new Map(batch.changes.map(change => [change.id, change]));
  if (!changes.has(changeId)) return answer('OutsideBatch', 'EXPLICIT_FETCH_REQUIRED');
  const suspect = new Set(batch.changes.filter(change => change.authorDevice === batch.suspectDevice)
    .map(change => change.id));
  const dependent = new Set();
  // Bounded transitive closure, independent of supplied delivery order.
  for (let pass = 0; pass < batch.changes.length; pass++) {
    for (const change of batch.changes) {
      if (change.dependencies.some(value => suspect.has(value) || dependent.has(value))) dependent.add(change.id);
    }
  }
  if (suspect.has(changeId)) return answer('Review', 'SUSPECT_AUTHOR');
  if (dependent.has(changeId)) return answer('Review', 'DISPUTED_DEPENDENCY');
  // Resolve only from trusted base or already resolved ancestors; a cycle or
  // unknown ancestor stays pending rather than looking independent.
  const resolved = new Set(batch.trustedBase);
  for (let pass = 0; pass < batch.changes.length; pass++) {
    for (const change of batch.changes) {
      if (!suspect.has(change.id) && !dependent.has(change.id) &&
          change.dependencies.every(value => resolved.has(value))) resolved.add(change.id);
    }
  }
  return resolved.has(changeId) ? answer('Eligible', 'EXPLICIT_SELECTION_STILL_REQUIRED') :
    answer('Pending', 'MISSING_OR_CYCLIC_DEPENDENCY');
}
