// Direct IndexedDB fixture. Bytes are opaque; no authentication or encryption is claimed.
const names = ['documents', 'effects', 'objects', 'outbox', 'inbox', 'cursors', 'applied'];
export async function openStorage(name) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => names.forEach(n => request.result.createObjectStore(n));
  const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const read = (store, key) => new Promise((resolve, reject) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const transact = (stores, body) => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error || Error('aborted')); tx.onerror = () => {};
    try { body(tx); } catch (e) { tx.abort(); }
  });
  return {
    close: () => db.close(), read,
    async commitLocal({document, commands, outbound}, failAt = '') {
      try {
        await transact(['documents', 'effects', 'objects', 'outbox'], tx => {
          const effects = tx.objectStore('effects');
          // This fixture accepts one semantic effect per local commit.
          if (commands.length !== 1 || outbound.length !== 1) throw Error('fixture shape');
          const command = commands[0], entry = outbound[0];
          const get = effects.get(command.effectId);
          get.onsuccess = () => {
            if (get.result) { tx.abort(); return; }
            tx.objectStore('documents').put(document.bytes, document.documentId);
            if (failAt === 'document') { tx.abort(); return; }
            effects.add(command, command.effectId);
            if (failAt === 'effect') { tx.abort(); return; }
            tx.objectStore('objects').add(entry.object.bytes, entry.object.id);
            if (failAt === 'object') { tx.abort(); return; }
            tx.objectStore('outbox').add(entry, entry.object.id);
            if (failAt === 'outbox') tx.abort();
          };
        });
        return {ok: true, value: {state:'saved'}};
      } catch { return {ok:false, error:{code:'IO', recovery:'reload-durable-state'}}; }
    },
    async stageInbox(item) { await transact(['inbox','cursors'], tx => { tx.objectStore('inbox').put(item, item.object.id); tx.objectStore('cursors').put(item.cursor,item.source); }); },
    async commitImport(id, document, effectIds, fail = false) { await transact(['inbox','documents','effects','applied'], tx => { const r = tx.objectStore('inbox').get(id); r.onsuccess = () => { if (!r.result) { tx.abort(); return; } tx.objectStore('documents').put(document.bytes,document.documentId); for (const effect of effectIds) tx.objectStore('effects').put({effectId:effect},effect); tx.objectStore('applied').put(true,id); if (fail) tx.abort(); }; }); }
  };
}
