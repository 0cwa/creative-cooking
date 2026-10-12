import * as A from '@automerge/automerge';
import { LoroDoc } from 'loro-crdt';

export const VERSIONS = { automerge: '3.5.0', loro: '1.16.4' };
const ACTORS = {
  seed: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  phone: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  laptop: 'cccccccccccccccccccccccccccccccc',
  tablet: 'dddddddddddddddddddddddddddddddd'
};
const PEERS = { seed: '900', phone: '101', laptop: '202', tablet: '303' };
const inspect = bytes => bytes?.byteLength ?? 0;
const sum = changes => changes.reduce((n, change) => n + change.byteLength, 0);

export function backend(engine) {
  if (!['automerge', 'loro'].includes(engine)) throw new Error('Unknown engine: ' + engine);
  const isA = engine === 'automerge';
  const init = actor => {
    if (isA) return A.init({ actor: ACTORS[actor] });
    const doc = new LoroDoc();
    doc.setPeerId(PEERS[actor]);
    return doc;
  };
  const clone = (doc, actor) => {
    if (isA) return A.clone(doc, { actor: ACTORS[actor] });
    const copy = doc.fork();
    copy.setPeerId(PEERS[actor]);
    return copy;
  };
  const save = doc => isA ? A.save(doc) : doc.export({ mode: 'snapshot' });
  const load = (bytes, actor) => {
    if (isA) return A.load(bytes, { actor: ACTORS[actor] });
    const doc = init(actor);
    doc.import(bytes);
    return doc;
  };
  function populate(doc, f) {
    if (isA) {
      return A.change(doc, { message: 'canonical seed', time: 1700000000 }, d => {
        d.pantryOrder = f.pantryOrder;
        d.pantryById = f.pantryById;
        d.recipeOrder = f.recipeOrder;
        d.recipesById = f.recipesById;
        d.conversationOrder = f.conversationOrder;
        d.conversationsById = f.conversationsById;
        // Both engines use character-aware CRDT method text rather than replacing an entire scalar.
        for (const rid of f.recipeOrder) {
          const r = f.recipesById[rid];
          for (const sid of r.stepOrder) {
            A.updateText(d, ['recipesById', rid, 'stepsById', sid, 'text'], r.stepsById[sid].text);
          }
        }
      });
    }
    const setMap = (name, values) => {
      const m = doc.getMap(name);
      for (const [key, value] of Object.entries(values)) m.set(key, value);
    };
    const setOrder = (name, ids) => {
      const l = doc.getMovableList(name);
      for (const id of ids) l.push(id);
    };
    setOrder('pantry-order', f.pantryOrder);
    for (const id of f.pantryOrder) setMap('pantry:' + id, f.pantryById[id]);
    setOrder('recipe-order', f.recipeOrder);
    for (const rid of f.recipeOrder) {
      const r = f.recipesById[rid];
      const { ingredientsById, ingredientOrder, stepsById, stepOrder, ...scalars } = r;
      setMap('recipe:' + rid, scalars);
      setOrder('recipe:' + rid + ':ingredients', ingredientOrder);
      for (const iid of ingredientOrder) setMap('ingredient:' + iid, ingredientsById[iid]);
      setOrder('recipe:' + rid + ':steps', stepOrder);
      for (const sid of stepOrder) {
        setMap('step:' + sid, { id: sid });
        doc.getText('step:' + sid + ':text').insert(0, stepsById[sid].text);
      }
    }
    setOrder('conversation-order', f.conversationOrder);
    for (const cid of f.conversationOrder) {
      const c = f.conversationsById[cid];
      setMap('conversation:' + cid, { id: cid, title: c.title });
      setOrder('conversation:' + cid + ':messages', c.messageOrder);
      for (const mid of c.messageOrder) setMap('message:' + mid, c.messagesById[mid]);
    }
    doc.commit({ message: 'canonical seed' });
    return doc;
  }
  function project(doc) {
    if (isA) return JSON.parse(JSON.stringify(doc));
    const getMap = name => doc.getMap(name).toJSON();
    const getOrder = name => doc.getMovableList(name).toArray();
    const p = { pantryOrder: getOrder('pantry-order'), pantryById: {},
      recipeOrder: getOrder('recipe-order'), recipesById: {},
      conversationOrder: getOrder('conversation-order'), conversationsById: {} };
    for (const id of p.pantryOrder) p.pantryById[id] = getMap('pantry:' + id);
    for (const rid of p.recipeOrder) {
      const r = getMap('recipe:' + rid);
      r.ingredientOrder = getOrder('recipe:' + rid + ':ingredients');
      r.ingredientsById = {};
      for (const iid of r.ingredientOrder) r.ingredientsById[iid] = getMap('ingredient:' + iid);
      r.stepOrder = getOrder('recipe:' + rid + ':steps');
      r.stepsById = {};
      for (const sid of r.stepOrder) r.stepsById[sid] = {
        ...getMap('step:' + sid), text: doc.getText('step:' + sid + ':text').toString()
      };
      p.recipesById[rid] = r;
    }
    for (const cid of p.conversationOrder) {
      const c = getMap('conversation:' + cid);
      c.messageOrder = getOrder('conversation:' + cid + ':messages');
      c.messagesById = {};
      for (const mid of c.messageOrder) c.messagesById[mid] = getMap('message:' + mid);
      p.conversationsById[cid] = c;
    }
    return p;
  }
  function edit(doc, ops, actor) {
    if (isA) return A.change(doc, { message: 'device:' + actor + '; ' + ops.length + ' operations', time: 1700000100 }, d => {
      for (const op of ops) {
        if (op.type === 'pantry') d.pantryById[op.id][op.field] = op.value;
        else if (op.type === 'recipe') d.recipesById[op.id][op.field] = op.value;
        else if (op.type === 'step') A.updateText(d, ['recipesById', op.id.slice(0, 11), 'stepsById', op.id, 'text'], op.value);
        else throw new Error('Unknown edit ' + op.type);
      }
    });
    for (const op of ops) {
      if (op.type === 'pantry' || op.type === 'recipe') doc.getMap(op.type + ':' + op.id).set(op.field, op.value);
      else if (op.type === 'step') {
        const text = doc.getText('step:' + op.id + ':text');
        text.delete(0, text.toString().length);
        text.insert(0, op.value);
      } else throw new Error('Unknown edit ' + op.type);
    }
    doc.commit({ message: 'device:' + actor + '; ' + ops.length + ' operations' });
    return doc;
  }
  function read(doc) {
    let chars = 0;
    for (let i = 0; i < 100; i++) {
      const rid = 'recipe-' + String(i).padStart(4, '0');
      const pid = 'pantry-' + String(i).padStart(4, '0');
      const cid = 'conversation-' + String(i % 100).padStart(3, '0');
      const r = isA ? doc.recipesById[rid] : doc.getMap('recipe:' + rid);
      const p = isA ? doc.pantryById[pid] : doc.getMap('pantry:' + pid);
      const c = isA ? doc.conversationsById[cid] : doc.getMap('conversation:' + cid);
      const value = isA ? [r.title, p.name, c.title] : [r.get('title'), p.get('name'), c.get('title')];
      for (const str of value) chars += str.length;
    }
    return chars;
  }
  function syncPair(docA, docB, prior = null, duplicate = false) {
    if (!isA) {
      const vb = docB.oplogVersion();
      const va = docA.oplogVersion();
      const ab = docA.export({ mode: 'update', from: vb });
      const ba = docB.export({ mode: 'update', from: va });
      docB.import(ab);
      docA.import(ba);
      if (duplicate) { docB.import(ab); docA.import(ba); }
      return { a: docA, b: docB, session: null,
        wire: { kind: 'version-vector update exchange', aToB: inspect(ab), bToA: inspect(ba), rounds: 1, messages: 2 } };
    }
    let a = docA, b = docB;
    let sa = prior?.a ?? A.initSyncState(), sb = prior?.b ?? A.initSyncState();
    let aToB = 0, bToA = 0, messages = 0;
    let lastA = null, lastB = null, rounds = 0;
    for (let round = 0; round < 100; round++) {
      rounds++;
      let ma, mb;
      // Generate *both* peers' outbound messages against the same pre-round
      // state, then deliver them. This is the symmetric exchange used by the
      // official Automerge sync test helper; don't let B observe A's message
      // before creating its corresponding round message (unfair serialization).
      [sa, ma] = A.generateSyncMessage(a, sa);
      [sb, mb] = A.generateSyncMessage(b, sb);
      if (ma) {
        aToB += inspect(ma); messages++;
        [b, sb] = A.receiveSyncMessage(b, sb, ma);
        lastA = ma;
      }
      if (mb) {
        bToA += inspect(mb); messages++;
        [a, sa] = A.receiveSyncMessage(a, sa, mb);
        lastB = mb;
      }
      if (!ma && !mb) {
        if (duplicate) {
          if (lastA) [b, sb] = A.receiveSyncMessage(b, sb, lastA);
          if (lastB) [a, sa] = A.receiveSyncMessage(a, sa, lastB);
        }
        return { a, b, session: { a: sa, b: sb },
          wire: { kind: 'Automerge SyncState protocol', aToB, bToA, rounds, messages } };
      }
    }
    throw new Error('Automerge sync exceeded 100 rounds');
  }
  // Version-vector update exchange and Automerge getChanges/applyChanges are not the SyncState protocol.
  function exchange(base, docA, docB, duplicate = false) {
    if (isA) {
      const ab = A.getChanges(base, docA), ba = A.getChanges(base, docB);
      let a = A.applyChanges(docA, ba)[0], b = A.applyChanges(docB, ab)[0];
      if (duplicate) { a = A.applyChanges(a, ba)[0]; b = A.applyChanges(b, ab)[0]; }
      return { a, b, wire: { kind: 'Automerge getChanges/applyChanges', aToB: sum(ab), bToA: sum(ba),
        rounds: 1, messages: ab.length + ba.length } };
    }
    return syncPair(docA, docB, null, duplicate);
  }
  function bootstrap(seeded, fresh) {
    if (isA) return syncPair(seeded, fresh);
    const snapshot = save(seeded);
    fresh.import(snapshot);
    return { a: seeded, b: fresh, session: null,
      wire: { kind: 'Loro full snapshot bootstrap', aToB: snapshot.byteLength, bToA: 0,
        rounds: 1, messages: 1 } };
  }
  function docMerge(docA, docB) {
    if (isA) return A.merge(A.clone(docA), A.clone(docB));
    const copy = clone(docA, 'tablet');
    copy.import(docB.export({ mode: 'update', from: copy.oplogVersion() }));
    return copy;
  }
  const dispose = doc => {
    if (isA) A.free(doc);
    else if (typeof doc?.free === 'function') doc.free();
  };
  return { engine, init, populate, clone, save, load, project, edit, read, syncPair, exchange, bootstrap, docMerge, dispose };
}
