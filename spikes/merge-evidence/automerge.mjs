import * as A from '@automerge/automerge';

export const ENGINE = 'automerge';
export const VERSION = '3.5.0';
const ACTORS = {
  seed: '00000000000000000000000000000000',
  iphone: '11111111111111111111111111111111',
  macbook: '22222222222222222222222222222222',
  ipad: '33333333333333333333333333333333'
};
const AUTHORS = Object.fromEntries(['iphone', 'macbook', 'ipad']
  .map((name) => [name, Buffer.from('fixture-device:' + name).toString('hex')]));
const TIMES = { iphone: 1700000100, macbook: 1700000200, ipad: 1700000300 };

export function base() {
  let doc = A.init({ actor: ACTORS.seed });
  doc = A.change(doc, { message: 'seed stable-ID cooking fixture', time: 1700000000 }, (d) => {
    d.recipes = {
      'recipe-1': {
        id: 'recipe-1', title: 'Tomato toast', description: 'Simple supper',
        portions: 2, deleted: false,
        ingredients: { 'ingredient-1': { id: 'ingredient-1', name: 'tomatoes', amount: '2' } },
        stepOrder: ['step-1', 'step-2'],
        steps: {
          'step-1': { id: 'step-1', text: 'Heat oil, then add tomatoes.', note: '' },
          'step-2': { id: 'step-2', text: 'Serve on toast.', note: '' }
        }
      }
    };
    d.pantry = {};
    d.conversations = {};
  });
  return doc;
}
export function fork(doc, device) {
  return A.clone(doc, { author: AUTHORS[device] });
}
export function write(doc, device, operation, value) {
  return A.change(doc, {
    message: JSON.stringify({ fixtureDevice: device, operation }), time: TIMES[device]
  }, (d) => {
    const recipe = d.recipes['recipe-1'];
    switch (operation) {
      case 'title': case 'portions': case 'description': case 'deleted':
        recipe[operation] = value; break;
      case 'ingredientAmount': recipe.ingredients['ingredient-1'].amount = value; break;
      case 'ingredientName': recipe.ingredients['ingredient-1'].name = value; break;
      case 'stepEdit': recipe.steps['step-1'].note = value; break;
      case 'reorder': {
        recipe.stepOrder.splice(1, 1);
        recipe.stepOrder.unshift('step-2');
        break;
      }
      case 'textPrefix':
        A.updateText(d, ['recipes', 'recipe-1', 'steps', 'step-1', 'text'],
          'Gently Heat oil, then add tomatoes.'); break;
      case 'textSuffix':
        A.updateText(d, ['recipes', 'recipe-1', 'steps', 'step-1', 'text'],
          'Heat oil, then add tomatoes. Simmer for 10 minutes.'); break;
      case 'carrotsPhone':
        d.pantry['carrot-phone'] = { id: 'carrot-phone', name: 'Carrots', preference: 5 }; break;
      case 'carrotsMac':
        d.pantry['carrot-mac'] = { id: 'carrot-mac', name: ' carrots ', preference: 2 }; break;
      default: throw new Error('Unknown Automerge operation ' + operation);
    }
  });
}
export function merge(a, b) { return A.merge(A.clone(a), A.clone(b)); }
export function save(doc) { return A.save(doc); }
export function load(bytes) { return A.load(bytes); }
export function heads(doc) { return A.getHeads(doc).sort(); }
export function read(doc, key) {
  const r = doc.recipes['recipe-1'];
  switch (key) {
    case 'ingredientAmount': return r.ingredients['ingredient-1'].amount;
    case 'ingredientName': return r.ingredients['ingredient-1'].name;
    case 'stepOrder': return [...r.stepOrder];
    case 'stepEdit': return r.steps['step-1'].note;
    case 'stepText': return r.steps['step-1'].text;
    case 'pantry': return Object.values(doc.pantry).map((x) => ({ ...x })).sort((a, b) => a.id.localeCompare(b.id));
    default: return r[key];
  }
}
export function metadata(doc) {
  return A.getChangesMetaSince(doc, []).map((m) => ({
    hash: m.hash, actor: m.actor, deps: [...m.deps], seq: m.seq,
    message: m.message, time: m.time,
    author: A.getAuthorForActor(doc, m.actor) ?? null
  }));
}
export function scalar(doc, key) {
  const conflicts = A.getConflicts(doc.recipes['recipe-1'], key) ?? {};
  const all = metadata(doc);
  const alternatives = Object.entries(conflicts).map(([operationId, value]) => {
    const actor = operationId.split('@')[1] ?? null;
    // Actor alone is not a unique change identifier. Do not guess if ambiguous.
    const matching = all.filter((item) => item.actor === actor);
    const match = matching.length === 1 ? matching[0] : null;
    return {
      value, operationId, changeId: match?.hash ?? null,
      authorId: actor ? (A.getAuthorForActor(doc, actor) ?? actor) : null,
      dependencies: match?.deps ?? null
    };
  });
  return {
    alternatives, concurrent: alternatives.length > 1,
    frontier: heads(doc), completeness: alternatives.every((a) => a.changeId) ? 'complete' : 'partial',
    missingCapabilities: alternatives.every((a) => a.changeId) ? [] : ['unambiguous-operation-to-change-join']
  };
}
export function causalResolution(doc, event, key) {
  const after = A.getChangesMetaSince(doc, event.frontier ?? []);
  const proven = after.find((m) =>
    (event.frontier ?? []).every((parent) => m.deps.includes(parent)) &&
    read(doc, key) === 5);
  return proven ? {
    changeId: proven.hash, value: read(doc, key), causalProof: true,
    evidence: 'Automerge new change directly depends on every prior conflict head'
  } : null;
}
export function transportProbe(seed) {
  let author = fork(seed, 'iphone');
  author = write(author, 'iphone', 'description', 'first causal edit');
  author = write(author, 'iphone', 'title', 'second causal edit');
  const changes = A.getChanges(seed, author);
  if (changes.length !== 2) throw new Error('Expected two real incremental changes');
  let receiver = A.clone(seed, { actor: ACTORS.ipad });
  [receiver] = A.applyChanges(receiver, [changes[1]]);
  const missing = A.getMissingDeps(receiver);
  [receiver] = A.applyChanges(receiver, [changes[0]]);
  [receiver] = A.applyChanges(receiver, [changes[1], changes[0]]);
  const restarted = load(save(receiver));
  return {
    outOfOrderBuffered: missing.length > 0,
    duplicateIdempotent: read(restarted, 'title') === 'second causal edit',
    restoredValue: read(restarted, 'description'),
    bytes: changes.map((x) => x.byteLength)
  };
}
