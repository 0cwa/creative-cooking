import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_STATE } from '../domain/defaults.ts';
import { remapGuestPersonalStateForWorkspace } from './adoptionMapping.ts';
import { buildPersonalMutationOperations } from './personalMutations.ts';
import { decodePersonalRows, encodePersonalRows } from './personalRecordCodec.ts';
import { AppSchema } from './powerSyncSchema.ts';

const at = '2026-10-02T10:00:00.000Z';
const personalA = '4b5cde80-1f15-455e-a7ab-7f51e0965f32';
const personalB = 'a0c24cef-8fd3-4b46-8ff6-91e7ac46031c';

function guestState() {
  return structuredClone({
    ...DEFAULT_STATE,
    activeConversationId: 'guest-chat',
    chatMessages: [
      { id: 'guest-user', role: 'user', content: 'Please add historical flour.', createdAt: at },
      {
        id: 'guest-assistant', role: 'assistant', content: 'I suggested the pantry change.', createdAt: at,
        proposals: [
          { id: 'historical-applied', toolName: 'pantry_add', arguments: '{"names":["Historical Flour"]}', status: 'applied' },
          { id: 'still-pending', toolName: 'pantry_add', arguments: '{"names":["Pending Oats"]}', status: 'pending' }
        ]
      }
    ],
    settings: { ...DEFAULT_STATE.settings, allergies: ['Peanuts'], city: 'Oslo' },
    mealContext: { willingToShop: true, portions: 4, cooks: ['high', 'medium'] }
  });
}

test('guest personal adoption remaps stable chat identities per personal space and preserves proposal status', () => {
  const guest = guestState();
  const first = remapGuestPersonalStateForWorkspace(guest, 'personal-adoption-1', personalA);
  const retry = remapGuestPersonalStateForWorkspace(guest, 'personal-adoption-1', personalA);
  const other = remapGuestPersonalStateForWorkspace(guest, 'personal-adoption-1', personalB);

  assert.equal(first.activeConversationId, retry.activeConversationId);
  assert.notEqual(first.activeConversationId, other.activeConversationId);
  assert.deepEqual(first.chatMessages.map((message) => message.id), retry.chatMessages.map((message) => message.id));
  assert.notEqual(first.chatMessages[0].id, other.chatMessages[0].id);
  const adoptedProposals = first.chatMessages[1].proposals;
  assert.deepEqual(adoptedProposals.map((proposal) => proposal.status), ['applied', 'pending']);

  const adopted = { ...DEFAULT_STATE, ...first };
  const operations = buildPersonalMutationOperations(DEFAULT_STATE, adopted, {
    preferences: new Map(), allergies: new Map(), conversations: new Map()
  });
  const proposalCreates = operations.filter((operation) => operation.type === 'personal.chat.proposal.create');
  assert.deepEqual(proposalCreates.map((operation) => operation.proposal.status), ['applied', 'pending']);
  assert.equal(operations.some((operation) => operation.type === 'personal.chat.proposal.setStatus'), false);
  assert.equal(operations.some((operation) => operation.type.startsWith('pantry.') || operation.type === 'recipe.save'), false);
  assert.equal(operations.some((operation) => operation.type === 'personal.preference.set' && operation.field === 'city' && operation.value === 'Oslo'), true);
  assert.equal(operations.some((operation) => operation.type === 'personal.allergy.set' && operation.name === 'peanuts' && operation.enabled), true);
});

test('personal profile rows preserve service timestamps and honor deleted preference projections', () => {
  const columns = AppSchema.props.personal_profile_fields.options.columns.map((column) => column.options.name);
  assert.ok(columns.includes('created_at'));
  assert.ok(columns.includes('deleted_at'));

  const profile = encodePersonalRows(DEFAULT_STATE, personalA).personal_profile_fields[0];
  assert.equal(profile.created_at, undefined);
  assert.equal(profile.updated_at, undefined);
  assert.equal(profile.deleted_at, undefined);
  assert.equal(profile.version, undefined);
  assert.equal(profile.updated_by, undefined);

  const decoded = decodePersonalRows({
    personal_profile_fields: [{
      id: 'profile-city',
      entity_id: 'city',
      space_id: personalA,
      field_key: 'city',
      value: JSON.stringify('stale city'),
      deleted_at: at
    }]
  }, DEFAULT_STATE, null);
  assert.equal(decoded.settings.city, DEFAULT_STATE.settings.city);
});
