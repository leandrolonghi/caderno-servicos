/* Nuvem: login e sincronização com o Supabase.
   Oferece ao app a mesma interface que ele usava no Claude (db.collection/doc, assets.upload),
   mantendo um espelho dos dados em memória. Arquivos baixados ou enviados ficam guardados
   neste aparelho (IndexedDB) para abrir sem sinal. */
(() => {
const C = window.CADERNO_CONFIG || {};
const configured = !!(C.supabaseUrl && C.supabaseKey && window.supabase);
const sb = configured ? window.supabase.createClient(C.supabaseUrl, C.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'cs-auth' }
}) : null;
const BUCKET = 'fotos';
const POLL_MS = 20000, OVERLAP_MS = 2 * 60000, PAGE = 1000;

let user = null;
const authFns = [];
const LU = { get() { try { return JSON.parse(localStorage.getItem('cs-user') || 'null'); } catch { return null; } }, set(v) { try { v ? localStorage.setItem('cs-user', JSON.stringify(v)) : localStorage.removeItem('cs-user'); } catch {} } };
user = LU.get();

/* arquivos guardados no aparelho */
const cache = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open('caderno-arquivos', 1); r.onupgradeneeded = () => r.result.createObjectStore('c'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction('c', mode); const r = fn(t.objectStore('c')); t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error); }); };
  return { put: (k, v) => tx('readwrite', s => s.put(v, k)), get: k => tx('readonly', s => s.get(k)) };
})();

/* espelho dos documentos */
const mirror = {};
const listeners = [];
let ready = false, lastMax = null, pulling = null;
const snapCol = col => ({ docs: Object.entries(mirror[col] || {}).map(([id, d]) => ({ id, data: () => d })) });
const snapDoc = (col, id) => { const d = mirror[col]?.[id]; return { exists: !!d, data: () => d }; };
function emit(cols) {
  if (!ready) return;
  for (const l of listeners) if (cols.has(l.col)) l.fn(l.id ? snapDoc(l.col, l.id) : snapCol(l.col));
}
function applyRow(r, changed) {
  const m = mirror[r.col] = mirror[r.col] || {};
  const before = JSON.stringify(m[r.id] ?? null);
  if (r.deleted) delete m[r.id]; else m[r.id] = r.data;
  if (JSON.stringify(m[r.id] ?? null) !== before) changed.add(r.col);
  if (!lastMax || r.updated_at > lastMax) lastMax = r.updated_at;
}
async function pull() {
  if (!sb || !user || pulling) return pulling;
  pulling = (async () => {
    const full = !ready, changed = new Set();
    const since = lastMax ? new Date(new Date(lastMax).getTime() - OVERLAP_MS).toISOString() : null;
    for (let from = 0; ; from += PAGE) {
      let q = sb.from('docs').select('col,id,data,deleted,updated_at').order('updated_at').order('col').order('id').range(from, from + PAGE - 1);
      q = since ? q.gte('updated_at', since) : q.eq('deleted', false);
      const { data, error } = await q;
      if (error) throw error;
      data.forEach(r => applyRow(r, changed));
      if (data.length < PAGE) break;
    }
    if (full) { ready = true; emit(new Set(listeners.map(l => l.col))); }
    else emit(changed);
  })().finally(() => { pulling = null; });
  return pulling;
}
const tryPull = () => { if (!document.hidden && navigator.onLine !== false) pull().catch(() => {}); };
setInterval(tryPull, POLL_MS);
window.addEventListener('online', tryPull);
document.addEventListener('visibilitychange', tryPull);

const fail = error => { throw { code: error.code || 'erro', message: error.message || String(error) }; };
async function write(col, id, op, data) {
  if (!sb || !user) throw { code: 'sem_login', message: 'Entre na sua conta para enviar' };
  let res;
  if (op === 'update') res = await sb.rpc('doc_merge', { p_col: col, p_id: id, p_data: data });
  else res = await sb.from('docs').upsert({ owner: user.id, col, id, data: op === 'delete' ? {} : data, deleted: op === 'delete' }, { onConflict: 'owner,col,id' });
  if (res.error) fail(res.error);
  const m = mirror[col] = mirror[col] || {};
  if (op === 'delete') delete m[id];
  else if (op === 'update') m[id] = { ...(m[id] || {}), ...data, id };
  else m[id] = data;
}

const db = {
  collection: col => ({
    onSnapshot(fn) { const l = { col, fn }; listeners.push(l); if (ready) fn(snapCol(col)); else tryPull(); return () => listeners.splice(listeners.indexOf(l), 1); }
  }),
  doc(path) {
    const [col, id] = path.split('/');
    return {
      onSnapshot(fn) { const l = { col, id, fn }; listeners.push(l); if (ready) fn(snapDoc(col, id)); else tryPull(); return () => listeners.splice(listeners.indexOf(l), 1); },
      set: d => write(col, id, 'set', d),
      update: d => write(col, id, 'update', d),
      delete: () => write(col, id, 'delete')
    };
  }
};

const assets = {
  async upload(blob) {
    if (!sb || !user) throw { code: 'sem_login', message: 'Entre na sua conta para enviar' };
    const id = 'sb-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
    const { error } = await sb.storage.from(BUCKET).upload(`${user.id}/${id}`, blob, { contentType: blob.type || 'application/octet-stream', upsert: true });
    if (error) fail(error);
    try { await cache.put(id, blob); } catch {}
    return { id };
  }
};

const urls = {};
async function blobUrl(id) {
  if (!id) return null;
  if (urls[id]) return urls[id];
  let b = null;
  try { b = await cache.get(id); } catch {}
  if (!b && sb && user) {
    const { data, error } = await sb.storage.from(BUCKET).download(`${user.id}/${id}`);
    if (!error && data) { b = data; try { await cache.put(id, data); } catch {} }
  }
  return b ? (urls[id] = URL.createObjectURL(b)) : null;
}

/* conta */
function setUser(u) {
  const was = user?.id;
  user = u ? { id: u.id, email: u.email } : null; LU.set(user);
  if (user?.id !== was) { ready = false; lastMax = null; for (const k of Object.keys(mirror)) delete mirror[k]; authFns.forEach(f => f(user)); }
}
if (sb) {
  sb.auth.getSession().then(({ data }) => { if (data?.session?.user) setUser(data.session.user); else if (navigator.onLine !== false && !data?.session) setUser(null); }).catch(() => {});
  sb.auth.onAuthStateChange((ev, session) => { if (session?.user) setUser(session.user); else if (ev === 'SIGNED_OUT') setUser(null); });
}
const msg = e => {
  const m = String(e?.message || e || '');
  if (/invalid login/i.test(m)) return 'E-mail ou senha incorretos';
  if (/already registered/i.test(m)) return 'Esse e-mail já tem conta. Use Entrar.';
  if (/email not confirmed/i.test(m)) return 'Confirme o e-mail pelo link que chegou na sua caixa de entrada';
  if (/password/i.test(m)) return 'A senha precisa ter pelo menos 6 caracteres';
  if (/fetch|network/i.test(m)) return 'Sem conexão. Tente de novo quando tiver sinal.';
  return m;
};

window.Nuvem = {
  configured,
  get user() { return user; },
  db: () => (sb && user ? db : null),
  assets,
  blobUrl,
  pull: () => pull(),
  onAuth: fn => authFns.push(fn),
  async signIn(email, password) { const { data, error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw msg(error); setUser(data.user); },
  async signUp(email, password) { const { data, error } = await sb.auth.signUp({ email, password }); if (error) throw msg(error); if (!data.session) throw 'Conta criada. Abra o link de confirmação que chegou no seu e-mail e depois toque em Entrar.'; setUser(data.user); },
  async signOut() { try { await sb.auth.signOut(); } catch {} setUser(null); }
};
})();
