import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverAndActivateWorkspace } from './workspaceExit.ts';

test('workspace archive failure cannot keep the old account visible or block guest activation', async () => {
  const events = [];
  const result = await recoverAndActivateWorkspace({
    hidePreviousAccount: () => events.push('hide-account'),
    persistPrevious: async () => { events.push('persist-account'); },
    archivePrevious: async () => {
      events.push('archive-account');
      throw new Error('Synthetic archive write failure.');
    },
    activateNext: async (failures) => {
      events.push('activate-guest');
      return { scope: 'guest', failures };
    }
  });

  assert.deepEqual(events, ['hide-account', 'persist-account', 'archive-account', 'activate-guest']);
  assert.deepEqual(result.failures, ['archive']);
  assert.deepEqual(result.value, { scope: 'guest', failures: ['archive'] });
});
