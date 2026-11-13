/** Return the operation results that cannot justify applying a Chef proposal. */
export function unappliedProposalEffectResults(value: unknown, expectedOpId: string): unknown[] {
  const operations = value && typeof value === 'object'
    ? (value as { operations?: unknown }).operations
    : null;
  if (!Array.isArray(operations) || operations.length === 0) {
    return [{ reason: 'missing_operation_results' }];
  }

  const matching = operations.filter((result) => (
    result && typeof result === 'object' && 'opId' in result
      && result.opId === expectedOpId
  ));
  const failures = operations.filter((result) => (
    !result || typeof result !== 'object'
      || !('opId' in result) || typeof result.opId !== 'string'
      || !('status' in result) || result.status !== 'applied'
  ));
  if (matching.length !== 1) {
    failures.push({ reason: 'effect_operation_missing_or_ambiguous', effectOpId: expectedOpId });
  }
  return failures;
}
