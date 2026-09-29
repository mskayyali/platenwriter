// Tiny IndexedDB key-value store. One record for the machine state ('meta'), one per scrap ('scrap:<id>'),
// so a save only writes what changed. Browsers allow hundreds of MB here, versus ~5 MB in localStorage.
const DB = 'platen', STORE = 'kv';
let dbp = null;
function db() {
  return dbp ||= new Promise((resolve, reject) => {
    let r;
    try { r = indexedDB.open(DB, 1); } catch (e) { dbp = null; reject(e); return; }
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => {
      const d = r.result;
      // a connection the browser closed (or a newer version elsewhere) is dropped, so the next call reopens
      d.onclose = () => { dbp = null; };
      d.onversionchange = () => { d.close(); dbp = null; };
      resolve(d);
    };
    r.onerror = () => { dbp = null; reject(r.error); };
    r.onblocked = () => { dbp = null; reject(new Error('IndexedDB open blocked')); };
  });
}
// a failed attempt on a stale connection is retried once on a fresh one
async function withDb(fn) {
  try { return await fn(await db()); }
  catch (e) { dbp = null; return fn(await db()); }
}
export function readAll() {
  return withDb(d => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readonly'), st = tx.objectStore(STORE), out = new Map();
    const req = st.openCursor();
    req.onsuccess = () => { const c = req.result; if (c) { out.set(c.key, c.value); c.continue(); } else resolve(out); };
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error || new Error('read aborted'));
  }));
}
export function write(puts, deletes = []) {
  return withDb(d => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE);
    for (const [k, v] of puts) st.put(v, k);
    for (const k of deletes) st.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    // quota and commit failures abort the transaction without an error event on the request
    tx.onabort = () => reject(tx.error || new Error('write aborted'));
  }));
}
