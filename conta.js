/* Conta (entrar, sair) e instalação do app */
(() => {
const $ = s => document.querySelector(s);
const sheet = $('#loginSheet'), form = $('#loginForm'), out = $('#loginMsg');

function renderConta() {
  const u = Nuvem.user;
  $('#ajSum-conta').textContent = u ? u.email : 'Não conectado';
  $('#contaEmail').textContent = u ? u.email : 'Não conectado';
  sheet.hidden = !!u || !Nuvem.configured;
  if (!Nuvem.configured) { $('#dbBanner').hidden = false; $('#dbBanner').textContent = 'App ainda sem conexão com a nuvem. Os registros ficam só neste aparelho.'; }
}
Nuvem.onAuth(renderConta);
renderConta();

async function go(fn) {
  const email = $('#loginEmail').value.trim(), senha = $('#loginSenha').value;
  if (!email || !senha) { out.textContent = 'Preencha e-mail e senha'; return; }
  form.querySelectorAll('button').forEach(b => b.disabled = true); out.textContent = 'Aguarde…';
  try { await fn(email, senha); out.textContent = ''; $('#loginSenha').value = ''; }
  catch (e) { out.textContent = String(e); }
  finally { form.querySelectorAll('button').forEach(b => b.disabled = false); }
}
form.addEventListener('submit', e => { e.preventDefault(); go(Nuvem.signIn); });

async function pendentes() {
  let n = 0;
  try { n += JSON.parse(localStorage.getItem('cs-outbox') || '[]').length; } catch {}
  try {
    n += await new Promise(res => { const r = indexedDB.open('caderno-fotos', 1); r.onupgradeneeded = () => r.result.createObjectStore('f'); r.onsuccess = () => { const t = r.result.transaction('f').objectStore('f').count(); t.onsuccess = () => res(t.result); t.onerror = () => res(0); }; r.onerror = () => res(0); });
  } catch {}
  return n;
}
$('#btnSair').onclick = async () => {
  const p = await pendentes();
  if (p) { alert(`Ainda há ${p} registro(s) guardado(s) só neste aparelho. Espere aparecer "Tudo enviado" antes de sair.`); return; }
  if (!confirm('Sair da conta neste aparelho?')) return;
  await Nuvem.signOut();
  ['cs-cache', 'cs-outbox', 'cs-user'].forEach(k => { try { localStorage.removeItem(k); } catch {} });
  location.reload();
};

/* Versão nova do app: procura de tempos em tempos e, quando chega, recarrega sozinho
   assim que nenhuma tela de edição estiver aberta (para não perder o que está sendo digitado). */
if ('serviceWorker' in navigator) window.addEventListener('load', () => {
  const tinha = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const checar = () => { if (!document.hidden && navigator.onLine !== false) reg.update().catch(() => {}); };
    setInterval(checar, 5 * 60000);
    document.addEventListener('visibilitychange', checar);
  }).catch(() => {});
  let pendente = false;
  const livre = () => ![...document.querySelectorAll('.sheet')].some(s => !s.hidden && s.id !== 'loginSheet')
    && !document.querySelector('dialog[open]') && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  const tentar = () => { if (pendente && livre()) location.reload(); };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!tinha || pendente) return;
    pendente = true; tentar(); setInterval(tentar, 3000);
  });
});
})();
