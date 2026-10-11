import { createHash } from 'node:crypto';

export const SEED = 20261012;
export const FIXTURE_SPEC = Object.freeze({
  pantryItems: 200, recipes: 500, ingredientsPerRecipe: 5, stepsPerRecipe: 4,
  conversations: 100, messagesPerConversation: 20, seed: SEED,
  logicalTimestamp: '2026-01-01T00:00:00.000Z'
});
const pad = (n, w) => String(n).padStart(w, '0');
const fixed = (text, size) => text.padEnd(size, ' ').slice(0, size);
const rand = (() => { let x = SEED >>> 0; return () => ((x = (1664525 * x + 1013904223) >>> 0) % 10000); })();
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const checksum = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function fixture() {
  const f = { pantryOrder: [], pantryById: {}, recipeOrder: [], recipesById: {},
    conversationOrder: [], conversationsById: {} };
  const at = FIXTURE_SPEC.logicalTimestamp;
  for (let i = 0; i < 200; i++) {
    const id = 'pantry-' + pad(i, 4);
    f.pantryOrder.push(id);
    f.pantryById[id] = { id, name: fixed('Ingredient ' + pad(i, 4) + ' (' + pad(rand(), 4) + ')', 32),
      preference: (i % 5) + 1, createdAt: at, updatedAt: at };
  }
  for (let i = 0; i < 500; i++) {
    const id = 'recipe-' + pad(i, 4);
    f.recipeOrder.push(id);
    const r = { id, title: fixed('Creative recipe ' + pad(i, 4), 48),
      description: fixed('A comforting dinner with vegetables ' + pad(rand(), 4), 80),
      portions: 2 + (i % 5), createdAt: at, updatedAt: at, deleted: false,
      ingredientOrder: [], ingredientsById: {}, stepOrder: [], stepsById: {} };
    for (let j = 0; j < 5; j++) {
      const iid = id + '-ingredient-' + pad(j, 2);
      r.ingredientOrder.push(iid);
      r.ingredientsById[iid] = { id: iid, name: fixed('Ingredient ' + pad((i + j) % 200, 4), 32),
        amount: fixed(String(j + 1) + ' tbsp', 12) };
    }
    for (let j = 0; j < 4; j++) {
      const sid = id + '-step-' + pad(j, 2);
      r.stepOrder.push(sid);
      r.stepsById[sid] = { id: sid, text: fixed('Cook stage ' + pad(j, 2) + ' for ' + id + ' until aromatic.', 72) };
    }
    f.recipesById[id] = r;
  }
  for (let i = 0; i < 100; i++) {
    const id = 'conversation-' + pad(i, 3);
    f.conversationOrder.push(id);
    const c = { id, title: fixed('Dinner planning ' + pad(i, 3), 40),
      messageOrder: [], messagesById: {} };
    for (let j = 0; j < 20; j++) {
      const mid = id + '-message-' + pad(j, 2);
      c.messageOrder.push(mid);
      c.messagesById[mid] = { id: mid, role: j % 2 ? 'assistant' : 'user',
        content: fixed('Conversation ' + pad(i, 3) + ': dinner suggestion ' + pad(j, 2), 96),
        createdAt: at };
    }
    f.conversationsById[id] = c;
  }
  return f;
}

export const TRACE = Object.freeze({
  single: [{ type: 'recipe', id: 'recipe-0003', field: 'title', value: fixed('Fresh herb supper', 48) }],
  batch: [
    ...Array.from({ length: 5 }, (_, i) => ({ type: 'pantry', id: 'pantry-' + pad(i + 20, 4),
      field: 'preference', value: 5 - (i % 5) })),
    ...Array.from({ length: 3 }, (_, i) => ({ type: 'recipe', id: 'recipe-' + pad(i + 25, 4),
      field: 'description', value: fixed('A quick weeknight dinner ' + pad(i, 2), 80) })),
    { type: 'step', id: 'recipe-0030-step-01', field: 'text',
      value: fixed('Sauté everything gently for a few minutes.', 72) }
  ],
  warmA: [{ type: 'recipe', id: 'recipe-0040', field: 'title', value: fixed('Phone edit', 48) }],
  warmB: [{ type: 'pantry', id: 'pantry-0040', field: 'preference', value: 1 }],
  divergenceA: [
    { type: 'recipe', id: 'recipe-0044', field: 'portions', value: 4 },
    ...Array.from({ length: 20 }, (_, i) => ({ type: 'pantry', id: 'pantry-' + pad(80 + i, 4),
      field: 'preference', value: 5 }))
  ],
  divergenceB: [
    { type: 'recipe', id: 'recipe-0044', field: 'portions', value: 6 },
    ...Array.from({ length: 20 }, (_, i) => ({ type: 'recipe', id: 'recipe-' + pad(80 + i, 4),
      field: 'description', value: fixed('Offline update ' + pad(i, 2), 80) }))
  ],
  reload: [{ type: 'recipe', id: 'recipe-0100', field: 'title', value: fixed('Updated after reload', 48) }]
});
export const historyOps = count => Array.from({ length: count }, (_, i) => ({
  type: 'recipe', id: 'recipe-0101', field: 'description',
  value: fixed('History revision ' + pad(i, 5), 80)
}));
export function expectedAfter(base, ops) {
  const result = structuredClone(base);
  for (const op of ops) {
    if (op.type === 'pantry') result.pantryById[op.id][op.field] = op.value;
    else if (op.type === 'recipe') result.recipesById[op.id][op.field] = op.value;
    else if (op.type === 'step') {
      const recipeId = op.id.slice(0, 'recipe-0000'.length);
      result.recipesById[recipeId].stepsById[op.id][op.field] = op.value;
    } else throw new Error('unknown operation ' + JSON.stringify(op));
  }
  return result;
}
