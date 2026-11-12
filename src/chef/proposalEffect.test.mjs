import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_STATE } from '../domain/defaults.ts';
import { planChefProposalEffect } from './proposalEffect.ts';

const at = '2026-10-03T12:00:00.000Z';

test('Chef proposal planning is pure and produces stable effect identities and timestamps', () => {
  const source = structuredClone({
    ...DEFAULT_STATE,
    activeConversationId: 'chat-one',
    chatMessages: [
      { id: 'assistant-message', role: 'assistant', content: 'I can add it.', createdAt: at,
        proposals: [{ id: 'proposal-one', toolName: 'pantry_add', arguments: '{"names":["Flour"]}', status: 'pending' }] }
    ]
  });
  const before = structuredClone(source);
  const first = planChefProposalEffect(source, 'household-a', 'chat-one', source.chatMessages[0].proposals[0]);
  const replay = planChefProposalEffect(source, 'household-a', 'chat-one', source.chatMessages[0].proposals[0]);

  assert.deepEqual(source, before);
  assert.deepEqual(first.state.pantry, replay.state.pantry);
  assert.equal(first.state.pantry.length, 1);
  assert.equal(first.state.pantry[0].name, 'Flour');
  assert.equal(first.state.pantry[0].createdAt, at);
  assert.equal(first.state.pantry[0].id, replay.state.pantry[0].id);
});
