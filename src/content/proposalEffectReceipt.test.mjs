import assert from 'node:assert/strict';
import test from 'node:test';
import { unappliedProposalEffectResults } from './proposalEffectReceipt.ts';

test('a selected ignored Chef effect is not considered applied', () => {
  const response = {
    operations: [{ opId: 'effect-op', status: 'ignored', reason: 'not_found' }]
  };
  assert.deepEqual(unappliedProposalEffectResults(response, 'effect-op'), response.operations);
});

test('a later ignored operation is not hidden by the selected first applied operation', () => {
  const ignored = { opId: 'second-op', status: 'ignored', reason: 'not_found' };
  const response = {
    operations: [
      { opId: 'selected-first-op', status: 'applied' },
      ignored
    ]
  };
  assert.deepEqual(unappliedProposalEffectResults(response, 'selected-first-op'), [ignored]);
});

test('an exact accepted operation receipt remains usable on replay', () => {
  const response = {
    operations: [
      { opId: 'selected-op', status: 'applied' },
      { opId: 'second-op', status: 'applied' }
    ]
  };
  assert.deepEqual(unappliedProposalEffectResults(response, 'selected-op'), []);
});
