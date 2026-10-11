import { LoroDoc } from 'loro-crdt';

export const ENGINE = 'loro';
export const VERSION = '1.16.4';
const PEERS = { seed: '900', iphone: '101', macbook: '202', ipad: '303' };

function fresh(device) {
  const doc = new LoroDoc();
  doc.setPeerId(PEERS[device]);
  return doc;
}
export function base() {
  const d = fresh('seed');
  const r = d.getMap('recipe:recipe-1');
  r.set('id', 'recipe-1');
  r.set('title', 'Tomato toast');
  r.set('description', 'Simple supper');
  r.set('portions', 2);
  r.set('deleted', false);
  const ingredient = d.getMap('ingredient:ingredient-1');
  ingredient.set('id', 'ingredient-1');
  ingredient.set('name', 'tomatoes');
  ingredient.set('amount', '2');
  d.getMap('step:step-1').set('note', '');
  d.getText('step:step-1:text').insert(0, 'Heat oil, then add tomatoes.');
  d.getText('step:step-2:text').insert(0, 'Serve on toast.');
  d.getMovableList('recipe:recipe-1:steps').push('step-1');
  d.getMovableList('recipe:recipe-1:steps').push('step-2');
  d.getMap('pantry-registry');
  d.commit({ message: 'device:seed; seed stable-ID cooking fixture' });
  return d;
}
export function fork(doc, device) {
  const copy = doc.fork();
  copy.setPeerId(PEERS[device]);
  return copy;
}
export function write(doc, device, operation, value) {
  const d = doc;
  switch (operation) {
    case 'title': case 'portions': case 'description': case 'deleted':
      d.getMap('recipe:recipe-1').set(operation, value); break;
    case 'ingredientAmount': d.getMap('ingredient:ingredient-1').set('amount', value); break;
    case 'ingredientName': d.getMap('ingredient:ingredient-1').set('name', value); break;
    case 'stepEdit': d.getMap('step:step-1').set('note', value); break;
    case 'reorder': d.getMovableList('recipe:recipe-1:steps').move(1, 0); break;
    case 'textPrefix': d.getText('step:step-1:text').insert(0, 'Gently '); break;
    case 'textSuffix': d.getText('step:step-1:text').push(' Simmer for 10 minutes.'); break;
    case 'carrotsPhone': {
      d.getMap('pantry-registry').set('carrot-phone', true);
      const p = d.getMap('pantry:carrot-phone');
      p.set('id', 'carrot-phone'); p.set('name', 'Carrots'); p.set('preference', 5);
      break;
    }
    case 'carrotsMac': {
      d.getMap('pantry-registry').set('carrot-mac', true);
      const p = d.getMap('pantry:carrot-mac');
      p.set('id', 'carrot-mac'); p.set('name', ' carrots '); p.set('preference', 2);
      break;
    }
    default: throw new Error('Unknown Loro operation ' + operation);
  }
  d.commit({ message: 'device:' + device + '; ' + operation });
  return d;
}
export function merge(a, b) {
  const copy = a.fork();
  copy.import(b.export({ mode: 'update', from: copy.oplogVersion() }));
  return copy;
}
export function save(doc) { return doc.export({ mode: 'snapshot' }); }
export function load(bytes) {
  const d = new LoroDoc();
  d.import(bytes);
  return d;
}
export function heads(doc) {
  return doc.frontiers().map((f) => String(f.counter) + '@' + String(f.peer)).sort();
}
export function read(d, key) {
  const r = d.getMap('recipe:recipe-1');
  switch (key) {
    case 'ingredientAmount': return d.getMap('ingredient:ingredient-1').get('amount');
    case 'ingredientName': return d.getMap('ingredient:ingredient-1').get('name');
    case 'stepOrder': return d.getMovableList('recipe:recipe-1:steps').toArray();
    case 'stepEdit': return d.getMap('step:step-1').get('note');
    case 'stepText': return d.getText('step:step-1:text').toString();
    case 'pantry': return Object.keys(d.getMap('pantry-registry').toJSON()).sort().map(
      (id) => d.getMap('pantry:' + id).toJSON()
    );
    default: return r.get(key);
  }
}
function normalize(value) {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}
/** The publicly exposed low-level serde RemoteOp shape is an API maintenance dependency. */
function mapWrite(op) {
  const root = op?.container?.Root ?? op?.container?.root;
  const name = typeof op?.container === 'string'
    ? (op.container.startsWith('cid:root-') && op.container.endsWith(':Map')
      ? op.container.slice(9, -4) : null)
    : root?.name ?? null;
  const raw = op?.content?.Map ?? op?.content?.map;
  const fallback = op?.content?.type === 'insert' ? op.content : null;
  const entry = raw ?? fallback;
  if (!name || !entry || entry.key == null || entry.value == null) return null;
  return { name, key: entry.key, value: normalize(entry.value), counter: Number(op.counter) };
}
/**
 * Incremental operation extraction. getAllChanges enumerates metadata on each call
 * (O(history)); getOpsInChange runs ONLY for newly seen changes, not on UI render.
 * Serialize this index alongside the review ledger, never as authoritative edits.
 */
export class IncrementalIndex {
  constructor(snapshot = null) {
    this.seen = new Set(snapshot?.seen ?? []);
    this.items = [...(snapshot?.items ?? [])];
    this.opsDecoded = 0;
    this.changeHeadersVisited = 0;
    this.cachedFrontier = snapshot?.cachedFrontier ?? null;
  }
  ensure(doc) {
    const now = JSON.stringify(heads(doc));
    if (now !== this.cachedFrontier) this.update(doc);
  }
  update(doc) {
    let added = 0;
    for (const [peerKey, changes] of doc.getAllChanges()) {
      const peer = String(peerKey);
      for (const change of changes) {
        this.changeHeadersVisited++;
        const id = String(change.counter) + '@' + peer;
        if (this.seen.has(id)) continue;
        const ops = doc.getOpsInChange({ peer, counter: change.counter });
        this.opsDecoded += ops.length;
        for (const op of ops) {
          const write = mapWrite(op);
          if (!write) continue;
          this.items.push({
            map: write.name, key: write.key, value: write.value,
            authorId: peer, peer, counter: write.counter, changeId: id,
            operationId: String(write.counter) + '@' + peer,
            message: change.message ?? change.msg ?? null
          });
          added++;
        }
        this.seen.add(id);
      }
    }
    this.cachedFrontier = JSON.stringify(heads(doc));
    return { newWrites: added, decodedOps: this.opsDecoded, changeHeadersVisited: this.changeHeadersVisited };
  }
  writes(map, key) { return this.items.filter((item) => item.map === map && item.key === key); }
  serialize() { return { seen: [...this.seen].sort(), items: this.items, cachedFrontier: this.cachedFrontier }; }
}
export function compare(doc, a, b) {
  return doc.cmpFrontiers(
    [{ peer: a.peer, counter: a.counter }],
    [{ peer: b.peer, counter: b.counter }]
  );
}
export function latest(doc, index, map, key) {
  index.ensure(doc);
  const writes = index.writes(map, key);
  return writes.filter((a) => !writes.some((b) => b !== a && compare(doc, a, b) === -1));
}
export function scalar(doc, key, index = new IncrementalIndex()) {
  const candidates = latest(doc, index, 'recipe:recipe-1', key);
  const distinctValues = new Set(candidates.map((x) => JSON.stringify(x.value)));
  const concurrent = candidates.some((a, i) =>
    candidates.slice(i + 1).some((b) => compare(doc, a, b) === undefined));
  const alternatives = candidates.map((x) => ({
    value: x.value, operationId: x.operationId, changeId: x.changeId,
    authorId: x.authorId, dependencies: null
  }));
  return {
    alternatives, concurrent: concurrent && distinctValues.size > 1,
    frontier: heads(doc),
    completeness: 'partial',
    missingCapabilities: ['per-operation-dependency-list-not-exposed-by-index']
  };
}
export function causalResolution(doc, event, key, index) {
  const current = latest(doc, index, 'recipe:recipe-1', key);
  if (current.length !== 1 || current[0].value !== 5) return null;
  const newWrite = current[0];
  const oldIds = new Set(event.alternatives.map((a) => a.operationId));
  const previous = index.writes('recipe:recipe-1', key).filter((x) => oldIds.has(x.operationId));
  if (previous.length !== oldIds.size) return null; // do not close from missing, compacted evidence
  if (!previous.every((old) => compare(doc, old, newWrite) === -1)) return null;
  return {
    changeId: newWrite.changeId, value: 5, causalProof: true,
    evidence: 'Loro cmpFrontiers proves each conflicting operation precedes the new write'
  };
}
export function transportProbe(seed) {
  const source = fork(seed, 'iphone');
  write(source, 'iphone', 'description', 'first causal edit');
  const firstUpdate = source.export({ mode: 'update' });
  const version = source.oplogVersion();
  write(source, 'iphone', 'title', 'second causal edit');
  const secondUpdate = source.export({ mode: 'update', from: version });
  const target = new LoroDoc();
  const pending = target.import(secondUpdate);
  const pendingProof = read(target, 'title') === undefined;
  target.import(firstUpdate);
  target.import(secondUpdate);
  const once = JSON.stringify(target.toJSON());
  target.import(firstUpdate);
  target.import(secondUpdate);
  const restarted = load(save(target));
  return {
    outOfOrderBuffered: pendingProof,
    duplicateIdempotent: JSON.stringify(target.toJSON()) === once,
    restoredValue: read(restarted, 'description'), pending: pending.pending
      ? Object.fromEntries(pending.pending) : null,
    bytes: [firstUpdate.byteLength, secondUpdate.byteLength]
  };
}
