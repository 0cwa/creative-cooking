import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseBackupEnvelope } from '../../src/storage/backupFormat.ts';
import { DEFAULT_STATE } from '../../src/domain/defaults.ts';

// Proposed allowlisted v2 projection. NOT a replacement for production v1 backup code.
// Every nested object is constructed field-by-field; unrecognized input never spreads.
export const SCHEMA_VERSION = 2;
export const SECRET_MARKERS = [
  'SYNTHETIC_PROVIDER_API_KEY_NEVER_REPLICATE_XYZZY',
  'SYNTHETIC_OAUTH_REFRESH_TOKEN_NEVER_REPLICATE',
  'SYNTHETIC_DEVICE_SIGNING_KEY_NEVER_REPLICATE',
  'SYNTHETIC_HOUSEHOLD_PRIVATE_KEY_NEVER_REPLICATE',
  'SYNTHETIC_UNKNOWN_FIELD_SECRET_NEVER_REPLICATE'
];
export const SHA = (value) => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
export const fingerprint = (value) => SHA(JSON.stringify(canonical(value)));
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function expectKeys(input, allowed, path) {
  assert.ok(record(input), path + ': expected object');
  for (const k of Object.keys(input)) assert.ok(allowed.includes(k), path + ': unknown field ' + k);
}
function text(value, path, optional = false) {
  if (optional && value === undefined) return undefined;
  assert.equal(typeof value, 'string', path + ': expected text');
  assert.ok(value.length <= 200000, path + ': oversize text');
  return value;
}
function scalar(value, path) {
  assert.ok(Number.isSafeInteger(value) && value > 0, path + ': expected positive integer');
  return value;
}
function timestamp(value) { return typeof value === 'string' ? value : ''; }
function rejectSecrets(value) {
  // Useful synthetic-negative test, not a proof that arbitrary free text contains no secret.
  const raw = JSON.stringify(value);
  for (const marker of SECRET_MARKERS) {
    assert.ok(!raw.includes(marker), 'credential sentinel reached an allowed replicated value');
  }
  assert.ok(!/sk-or-v1-[0-9a-f]{64}/i.test(raw), 'provider key-shaped credential reached document');
  assert.ok(!/-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----/.test(raw), 'private signing key reached document');
}
export function namespace(kind, id) {
  assert.ok(kind === 'personal' || kind === 'household', 'unknown namespace kind');
  assert.match(id, /^[a-zA-Z0-9_-]{1,64}$/, 'namespace ID must be opaque and path safe');
  return { kind, id };
}
export function docId(space) {
  return 'cc:v2:' + space.kind + ':' + SHA(space.id).slice(0, 24) + ':cooking';
}
function baseDocument(space) {
  return {
    schemaVersion: SCHEMA_VERSION, documentId: docId(space), namespace: { ...space },
    pantry: {}, recipes: {}, conversations: {},
    activeConversationId: null, migrationReceipts: {}
  };
}
// IDs never incorporate names: duplicate pantry names remain distinct.
const stableId = (kind, old) => kind + '_' + SHA(kind + '\0' + old).slice(0, 24);
function entriesWithStableIds(rows, kind, dropped) {
  const unique = new Map();
  const missingCounters = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!record(row)) { dropped.push(kind + '[' + i + ']:not-an-object'); continue; }
    const rawId = typeof row.id === 'string' && row.id ? row.id : null;
    const digest = fingerprint(row);
    const key = rawId === null ? 'anonymous:' + digest : 'legacy:' + rawId;
    const matches = unique.get(key) ?? [];
    if (matches.some((v) => v.digest === digest) && rawId !== null) {
      dropped.push(kind + ':duplicate-exact-id-and-content:' + SHA(rawId).slice(0, 12));
      continue;
    }
    const index = missingCounters.get(key) ?? 0;
    missingCounters.set(key, index + 1);
    matches.push({ row, key, digest, index, position:i });
    unique.set(key, matches);
  }
  const output = [];
  for (const matches of unique.values()) {
    const sorted = [...matches].sort((a, b) => a.digest.localeCompare(b.digest) || a.index - b.index);
    if (sorted.length > 1) dropped.push(kind + ':colliding-legacy-identifier:' + SHA(sorted[0].key).slice(0, 12));
    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];
      const suffix = i ? ':collision:' + entry.digest + ':' + entry.index : '';
      output.push({ ...entry, id: stableId(kind, entry.key + suffix) });
    }
  }
  // Identity assignment is digest-stable, but presentation order follows v1 arrays.
  return output.sort((a, b) => a.position - b.position);
}
function ingredientRows(items, recipeId, dropped) {
  assert.ok(Array.isArray(items), 'recipe ingredient collection must be an array');
  return items.map((x, i) => {
    assert.ok(record(x), 'ingredient must be object');
    // v1 has no ingredient identity; index only used ONCE during initial migration.
    // Later v1 imports with changed positions must be quarantined, not guessed.
    for (const key of Object.keys(x)) if (!['name','amount','needsShopping'].includes(key)) dropped.push('recipes.ingredients.' + key);
    const id = stableId('ingredient', recipeId + ':' + i);
    const result = { id, name: text(x.name, 'ingredient.name'), deleted: false };
    if (x.amount !== undefined) result.amount = text(x.amount, 'ingredient.amount');
    if (x.needsShopping !== undefined) dropped.push('recipes.ingredients.needsShopping:personal-overlay-only');
    return result;
  });
}
function chatMessageRows(rows, conversationId, dropped) {
  const byId = {};
  const order = [];
  for (const item of entriesWithStableIds(rows, 'message', dropped)) {
    const x = item.row;
    if (x.role !== 'assistant' && x.role !== 'user') throw Error('unsupported chat role');
    for (const key of Object.keys(x)) if (!['id','role','content','createdAt','proposals'].includes(key)) dropped.push('chat.messages.' + key);
    if (x.proposals !== undefined) dropped.push('chat.messages.proposals:private-action-payload');
    // v1 message IDs can repeat in DIFFERENT conversations. Give each message a
    // conversation-scoped stable ID to prevent shared CRDT root-container aliasing.
    const id=stableId('message',conversationId + '\0' + item.id);
    byId[id] = { id, role:x.role, content:text(x.content, 'message.content'),
      createdAt:timestamp(x.createdAt), deleted:false };
    order.push(id);
  }
  return { byId, order };
}
function auditUnknown(state, paths) {
  for (const key of Object.keys(state)) {
    if (!['pantry','recipes','chatMessages','chatHistory','activeConversationId','mealContext','settings'].includes(key))
      paths.push('state.' + key + ':not-replicated');
  }
  if (record(state.settings)) for (const key of Object.keys(state.settings)) paths.push('state.settings.' + key + ':device-or-personal-overlay-only');
  if (record(state.mealContext)) for (const key of Object.keys(state.mealContext)) paths.push('state.mealContext.' + key + ':personal-overlay-only');
}
export function importV1(raw, space, selection = null) {
  const ns = namespace(space.kind, space.id);
  const envelope = JSON.parse(raw);
  if (!record(envelope) || envelope.format !== 'creative-cooking-backup' ||
      envelope.version !== 1 || !record(envelope.state)) throw Error('unsupported v1 backup');
  const state = parseBackupEnvelope(raw, DEFAULT_STATE); // read-only production parser semantics
  const droppedPaths = [];
  auditUnknown(envelope.state, droppedPaths);
  // Hash only the *allowlisted* projection later, never entire credentials/settings
  // or unrelated personal data in an explicitly shared household receipt.
  const doc = baseDocument(ns);
  const household = ns.kind === 'household';
  if (household && (!selection || selection.confirmed !== true ||
      !Array.isArray(selection.pantryIds) || !Array.isArray(selection.recipeIds))) {
    throw Error('household sharing requires explicit confirmed ID selection');
  }
  const pantryIds = new Set(selection?.pantryIds ?? []);
  const recipeIds = new Set(selection?.recipeIds ?? []);
  for (const {row, id} of entriesWithStableIds(state.pantry, 'pantry', droppedPaths)) {
    if (household && !pantryIds.has(row.id)) continue;
    for (const key of Object.keys(row)) if (!['id','name','preference','createdAt','updatedAt'].includes(key))
      droppedPaths.push('pantry.' + key + ':not-replicated');
    if (![1,2,3,4,5].includes(row.preference)) throw Error('unsupported pantry preference');
    doc.pantry[id] = { id, name:text(row.name,'pantry.name'), preference:row.preference,
      createdAt:timestamp(row.createdAt), updatedAt:timestamp(row.updatedAt), deleted:false };
  }
  for (const {row, id} of entriesWithStableIds(state.recipes, 'recipe', droppedPaths)) {
    if (household && !recipeIds.has(row.id)) continue;
    for (const key of Object.keys(row)) if (!['id','title','description','portions','ingredients','steps','notes','createdAt','updatedAt'].includes(key))
      droppedPaths.push('recipes.' + key + ':not-replicated');
    const ingredients = ingredientRows(row.ingredients, id, droppedPaths);
    assert.ok(Array.isArray(row.steps), 'recipe steps must be array');
    const steps = row.steps.map((step,i) => ({
      id:stableId('step',id + ':' + i), text:text(step,'step.text'), deleted:false
    }));
    const recipe = {
      id, title:text(row.title,'recipe.title'), portions:scalar(row.portions,'recipe.portions'),
      createdAt:timestamp(row.createdAt), updatedAt:timestamp(row.updatedAt), deleted:false,
      ingredientsById:Object.fromEntries(ingredients.map(x => [x.id,x])),
      ingredientOrder:ingredients.map(x => x.id),
      stepsById:Object.fromEntries(steps.map(x => [x.id,x])),
      stepOrder:steps.map(x => x.id)
    };
    if (row.description !== undefined) recipe.description = text(row.description,'recipe.description');
    if (!household && row.notes !== undefined) {
      assert.ok(Array.isArray(row.notes), 'recipe notes must be an array');
      recipe.notes = row.notes.map(x => text(x,'recipe.notes'));
    } else if (household && row.notes !== undefined) droppedPaths.push('recipes.notes:private-by-default');
    doc.recipes[id] = recipe;
  }
  if (!household) {
    const liveId = typeof state.activeConversationId === 'string' && state.activeConversationId
      ? state.activeConversationId : 'active:' + fingerprint(state.chatMessages.map(m=>m.id)).slice(0, 16);
    const conversations = [
      ...state.chatHistory,
      ...(state.chatMessages.length ? [{
        id: liveId, title:'Active chat', messages:state.chatMessages, createdAt:'', updatedAt:''
      }] : [])
    ];
    for (const {row, id, position} of entriesWithStableIds(conversations, 'conversation', droppedPaths)) {
      const messages = chatMessageRows(row.messages, id, droppedPaths);
      for (const key of Object.keys(row)) if (!['id','title','messages','createdAt','updatedAt'].includes(key))
        droppedPaths.push('conversations.' + key + ':not-replicated');
      doc.conversations[id] = { id, title:text(row.title, 'conversation.title'),
        messagesById:messages.byId, messageOrder:messages.order,
        createdAt:timestamp(row.createdAt), updatedAt:timestamp(row.updatedAt), deleted:false };
      if (state.chatMessages.length && position === conversations.length - 1) doc.activeConversationId = id;
    }
    // An empty active chat remains empty; no artificial conversation inserted.
  } else {
    droppedPaths.push('chat-and-context:not-shared-with-household');
  }
  const contentDigest=fingerprint({ namespace:ns, pantry:doc.pantry, recipes:doc.recipes,
    conversations:doc.conversations, activeConversationId:doc.activeConversationId });
  const receiptId='backup:v1:'+contentDigest;
  doc.migrationReceipts[receiptId] = { id:receiptId, contentDigest, formatVersion:1 };
  validateDocument(doc, ns);
  return { document:doc, diagnostics:{ receiptId, sourceDigest:contentDigest,
    droppedPaths:[...new Set(droppedPaths)].sort(), counts: {
      pantry:Object.keys(doc.pantry).length, recipes:Object.keys(doc.recipes).length,
      conversations:Object.keys(doc.conversations).length
    } } };
}
// For existing v2 document: never overwrite edits from a possibly stale legacy backup.
// Same receipt is a no-op. Changed receipts with overlapping identities are quarantined.
export function applyImport(existing, incoming) {
  validateDocument(existing, existing.namespace);
  validateDocument(incoming, existing.namespace);
  const next = structuredClone(existing);
  const duplicates = [], conflicts = [], additions = [];
  for (const receipt of Object.keys(incoming.migrationReceipts)) {
    if (next.migrationReceipts[receipt]) { duplicates.push(receipt); continue; }
    for (const name of ['pantry','recipes','conversations']) for (const [id,value] of Object.entries(incoming[name])) {
      if (!(id in next[name])) { next[name][id] = structuredClone(value); additions.push(name + ':' + id); }
      else if (fingerprint(next[name][id]) !== fingerprint(value)) conflicts.push(name + ':' + id);
    }
    if (conflicts.length) return { document:existing, duplicates, conflicts, additions:[], status:'quarantined' };
    next.migrationReceipts[receipt] = structuredClone(incoming.migrationReceipts[receipt]);
  }
  if (!next.activeConversationId) next.activeConversationId = incoming.activeConversationId;
  validateDocument(next, next.namespace);
  return { document:next, duplicates, conflicts, additions, status:duplicates.length && !additions.length ? 'duplicate' : 'imported' };
}
const MAP_KEYS = ['id','name','preference','createdAt','updatedAt','deleted'];
export function validateDocument(doc, expectedSpace) {
  expectKeys(doc, ['schemaVersion','documentId','namespace','pantry','recipes','conversations','activeConversationId','migrationReceipts'], 'document');
  assert.equal(doc.schemaVersion, SCHEMA_VERSION, 'unsupported schema version');
  expectKeys(doc.namespace, ['kind','id'], 'namespace');
  const ns=namespace(doc.namespace.kind, doc.namespace.id);
  assert.deepEqual(ns, expectedSpace, 'wrong-space replay refused');
  assert.equal(doc.documentId, docId(ns), 'document ID mismatch');
  for (const coll of ['pantry','recipes','conversations','migrationReceipts']) assert.ok(record(doc[coll]),coll+' must be map');
  for (const [id,p] of Object.entries(doc.pantry)) {
    expectKeys(p,MAP_KEYS,'pantry'); assert.equal(p.id,id);
    text(p.name,'pantry.name'); assert.ok([1,2,3,4,5].includes(p.preference));
    assert.equal(typeof p.deleted,'boolean');
  }
  for (const [id,r] of Object.entries(doc.recipes)) {
    expectKeys(r,['id','title','description','portions','createdAt','updatedAt','deleted','ingredientsById','ingredientOrder','stepsById','stepOrder','notes'],'recipe');
    assert.equal(r.id,id); text(r.title,'recipe.title'); scalar(r.portions,'recipe.portions');
    if(r.description!==undefined) text(r.description,'recipe.description');
    if(r.notes!==undefined) {
      assert.equal(ns.kind,'personal','household cannot contain private notes');
      assert.ok(Array.isArray(r.notes));r.notes.forEach(x=>text(x,'notes'));
    }
    assert.equal(typeof r.deleted,'boolean');
    assert.ok(record(r.ingredientsById));assert.ok(Array.isArray(r.ingredientOrder));
    assert.ok(record(r.stepsById));assert.ok(Array.isArray(r.stepOrder));
    for (const [key,v] of Object.entries(r.ingredientsById)) {
      expectKeys(v,['id','name','amount','deleted'],'ingredient');assert.equal(v.id,key);
      text(v.name,'ingredient.name');if(v.amount!==undefined)text(v.amount,'ingredient.amount');
      assert.equal(typeof v.deleted,'boolean');
    }
    for (const [key,v] of Object.entries(r.stepsById)) {
      expectKeys(v,['id','text','deleted'],'step');assert.equal(v.id,key);
      text(v.text,'step.text');assert.equal(typeof v.deleted,'boolean');
    }
    for (const [key,arr,map] of [['ingredientOrder',r.ingredientOrder,r.ingredientsById],['stepOrder',r.stepOrder,r.stepsById]]) {
      assert.equal(arr.length,new Set(arr).size,key+': duplicate stable ID');
      arr.forEach(x=>assert.ok(typeof x==='string' && x in map,key+': missing entity ID'));
    }
  }
  if(ns.kind==='household') {
    assert.deepEqual(doc.conversations,{},'private chats in household');
    assert.equal(doc.activeConversationId,null,'private active chat in household');
  }
  for (const [id,c] of Object.entries(doc.conversations)) {
    expectKeys(c,['id','title','messagesById','messageOrder','createdAt','updatedAt','deleted'],'conversation');
    assert.equal(id,c.id);text(c.title,'conversation.title');assert.equal(typeof c.deleted,'boolean');
    assert.ok(record(c.messagesById));assert.ok(Array.isArray(c.messageOrder));
    assert.equal(c.messageOrder.length,new Set(c.messageOrder).size,'duplicate message IDs');
    for(const [mid,msg] of Object.entries(c.messagesById)){
      expectKeys(msg,['id','role','content','createdAt','deleted'],'message');
      assert.equal(mid,msg.id);assert.ok(['user','assistant'].includes(msg.role));text(msg.content,'chat content');
      assert.equal(typeof msg.deleted,'boolean');
    }
    c.messageOrder.forEach(mid=>assert.ok(mid in c.messagesById,'orphan message reference'));
  }
  assert.ok(doc.activeConversationId === null || (ns.kind==='personal' && doc.activeConversationId in doc.conversations));
  for(const [id,receipt] of Object.entries(doc.migrationReceipts)) {
    expectKeys(receipt,['id','contentDigest','formatVersion'],'receipt');assert.equal(receipt.id,id);
    assert.equal(receipt.formatVersion,1);assert.match(receipt.contentDigest,/^[0-9a-f]{64}$/);
  }
  rejectSecrets(doc);
  return true;
}
export function projectView(doc) {
  validateDocument(doc,doc.namespace);
  const ordered=(byId,order)=>order.filter(id=>!byId[id].deleted).map(id=>byId[id]);
  const visibleConversations=Object.values(doc.conversations).filter(c=>!c.deleted);
  const messages=(c)=>ordered(c.messagesById,c.messageOrder).map(m=>({id:m.id,role:m.role,content:m.content,createdAt:m.createdAt}));
  const active=visibleConversations.find(c=>c.id===doc.activeConversationId);
  return {
    pantry:Object.values(doc.pantry).filter(p=>!p.deleted).map(({id,name,preference,createdAt,updatedAt})=>({id,name,preference,createdAt,updatedAt})),
    recipes:Object.values(doc.recipes).filter(r=>!r.deleted).map(r=>({
      id:r.id,title:r.title,...(r.description===undefined?{}:{description:r.description}),portions:r.portions,
      ingredients:ordered(r.ingredientsById,r.ingredientOrder).map(x=>({
        name:x.name,...(x.amount===undefined?{}:{amount:x.amount})
      })),
      steps:ordered(r.stepsById,r.stepOrder).map(x=>x.text),
      ...(r.notes?{notes:r.notes}:{}),createdAt:r.createdAt,updatedAt:r.updatedAt
    })),
    chatMessages:active?messages(active):[],
    chatHistory:visibleConversations.filter(c=>c.id!==doc.activeConversationId).map(c=>({
      id:c.id,title:c.title,createdAt:c.createdAt,updatedAt:c.updatedAt,
      messages:messages(c)
    })),
    activeConversationId:doc.activeConversationId
  };
}
