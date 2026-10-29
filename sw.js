/* Guarda o app no aparelho para abrir sem sinal.
   Abre sempre a cópia guardada e busca a versão nova em segundo plano (vale na próxima abertura). */
const V = 'caderno-1793283471';
const SHELL = ['./', 'index.html', 'config.js', 'nuvem.js', 'conta.js', 'manifest.webmanifest',
  'vendor/supabase.js', 'vendor/591.supabase.js', 'vendor/jspdf.umd.min.js', 'vendor/jspdf.plugin.autotable.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-180.png', 'icons/favicon-64.png', 'selic.json'];
const FCACHE = 'caderno-fontes';
const FONTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== FCACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // O portal do cliente é outra página e sempre busca da internet
  if (url.origin === location.origin && url.pathname.includes('/portal/')) return;
  if (url.origin === location.origin) {
    const key = req.mode === 'navigate' ? 'index.html' : req;
    e.respondWith(caches.open(V).then(async c => {
      const hit = await c.match(key, { ignoreSearch: req.mode === 'navigate' });
      const net = fetch(req.mode === 'navigate' ? 'index.html' : req.url, { cache: 'no-cache' }).then(r => { if (r.ok) c.put(key, r.clone()); return r; });
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net;
    }));
  } else if (FONTS.includes(url.hostname)) {
    e.respondWith(caches.open(FCACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === 'opaque') c.put(req, r.clone());
      return r;
    }));
  }
});
