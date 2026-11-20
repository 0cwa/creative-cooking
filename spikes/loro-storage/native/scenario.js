const assert = (condition, message) => { if (!condition) throw new Error(message); };
const ab = bytes => bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
const snapshot = doc => doc.export({mode:'snapshot'});
const update = doc => doc.export({mode:'updates'});

const title = doc => doc.toJSON().recipe?.title;
const query = (db, sql, params=[]) => db.executeSync(sql,params).rows;
const count = (db, table, id) => query(db, `SELECT id FROM ${table} WHERE id=?`, [id]).length;
const documentBytes = db => query(db, 'SELECT bytes FROM documents WHERE id=?',['document'])[0]?.bytes;

const exec = (db, sql, params=[]) => db.executeSync(sql, params);
function transaction(db, body) {
  exec(db, 'BEGIN IMMEDIATE');
  try { body(); exec(db, 'COMMIT'); } catch (e) { exec(db, 'ROLLBACK'); throw e; }
}
function commit(db, doc, effect, object, fail) {
  transaction(db, () => {
    exec(db, 'INSERT OR REPLACE INTO documents VALUES (?,?)', ['document', snapshot(doc)]); if (fail==='document') throw Error('injected document');
    exec(db, 'INSERT INTO effects VALUES (?)', [effect]); if (fail==='effect') throw Error('injected effect');
    exec(db, 'INSERT INTO objects VALUES (?,?)', [object, update(doc)]); if (fail==='object') throw Error('injected object');
    exec(db, 'INSERT INTO outbox VALUES (?,?)', [object, 'pending']); if (fail==='outbox') throw Error('injected outbox');
  });
}
export function run(LoroDoc, openDb) {
  const restore = bytes => { const doc = new LoroDoc(); if (bytes) doc.import_(ab(bytes)); return doc; };
  let db = openDb();
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, bytes BLOB NOT NULL)',
    'CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY)',
    'CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, bytes BLOB NOT NULL)',
    'CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, state TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, bytes BLOB NOT NULL, cursor TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS applied (id TEXT PRIMARY KEY)',
    'CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL)',
  ]) exec(db,sql);
  const previous = count(db,'metadata','completed') > 0;
  if (previous) {
    const doc = restore(documentBytes(db));
    assert(title(doc)==='saved', 'relaunch document');
    assert(doc.toJSON().remote?.item==='imported','relaunch import');
    for (const [table,id] of [['effects','effect-1'],['objects','object-1'],['outbox','object-1'],['inbox','incoming'],['applied','incoming'],['effects','remote-effect']]) assert(count(db,table,id)===1,'relaunch '+table);
    assert(count(db,'effects','failed-outbox')===0,'relaunch failed effect absent');
    db.close(); return 'PASS RESTORED after relaunch: saved document, effect, immutable object, pending outbox, staged and applied import; failed edit absent';
  }
  let doc = new LoroDoc(); doc.getMap('recipe').set('title','saved'); commit(db,doc,'effect-1','object-1');
  for (const boundary of ['document','effect','object','outbox']) {
    doc.getMap('recipe').set('title','unsaved-'+boundary);
    let failed=false; try { commit(db,doc,'failed-'+boundary,'failed-'+boundary,boundary); } catch { failed=true; }
    assert(failed,'injection '+boundary); db.close(); db=openDb(); doc=restore(documentBytes(db));
    assert(title(doc)==='saved','reopen reset '+boundary); assert(!count(db,'effects','failed-'+boundary),'effect rollback '+boundary); assert(!count(db,'objects','failed-'+boundary),'object rollback '+boundary); assert(!count(db,'outbox','failed-'+boundary),'outbox rollback '+boundary);
  }
  let duplicate=false; try { commit(db,doc,'effect-1','object-retry'); } catch { duplicate=true; }
  assert(duplicate && !count(db,'objects','object-retry') && count(db,'outbox','object-1')===1,'duplicate effect and retry');
  const remote = new LoroDoc(); remote.getMap('remote').set('item','imported'); const remoteUpdate=update(remote);
  transaction(db,()=>exec(db,'INSERT INTO inbox VALUES (?,?,?)',['incoming',remoteUpdate,'cursor-1']));
  assert(count(db,'inbox','incoming')===1 && !count(db,'applied','incoming'),'stage distinct from applied');
  doc.import_(ab(remoteUpdate));
  let importFailed=false; try { transaction(db,()=>{ exec(db,'UPDATE documents SET bytes=? WHERE id=?',[snapshot(doc),'document']); exec(db,'INSERT INTO effects VALUES (?)',['remote-effect']); exec(db,'INSERT INTO applied VALUES (?)',['incoming']); throw Error('injected import'); }); } catch { importFailed=true; }
  assert(importFailed && !count(db,'applied','incoming') && !count(db,'effects','remote-effect'),'import rollback');
  db.close(); db=openDb(); doc=restore(documentBytes(db)); assert(!doc.toJSON().remote,'failed import reset');
  const staged=query(db,'SELECT bytes,cursor FROM inbox WHERE id=?',['incoming'])[0]; assert(staged.cursor==='cursor-1','cursor persisted'); doc.import_(ab(staged.bytes));
  transaction(db,()=>{ exec(db,'UPDATE documents SET bytes=? WHERE id=?',[snapshot(doc),'document']); exec(db,'INSERT INTO effects VALUES (?)',['remote-effect']); exec(db,'INSERT INTO applied VALUES (?)',['incoming']); exec(db,'INSERT INTO metadata VALUES (?,?)',['completed','yes']); });
  db.close(); db=openDb(); doc=restore(documentBytes(db)); assert(title(doc)==='saved' && doc.toJSON().remote.item==='imported','close reopen imported'); db.close();
  return 'PASS FIRST: commit; four rollback boundaries; duplicate; staged import and rollback; close/reopen. Relaunch to verify durable state.';
}
