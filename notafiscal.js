/* Leitura de nota fiscal a partir de foto, PDF ou XML, feita no próprio aparelho.
   Tipos reconhecidos, cada um com o seu leiaute:
   - NF-e (DANFE, peças e produtos): chave de 44 dígitos, modelo 55. Fornecedor = emitente ("RECEBEMOS DE ...").
   - NFC-e (cupom, ex.: posto): chave de 44 dígitos, modelo 65, QR code.
   - CF-e SAT (cupom de SP/CE): chave de 44 dígitos, modelo 59.
   - NFS-e padrão nacional (DANFSe, serviços): chave de 50 dígitos. Fornecedor = quadro PRESTADOR.
   - NFS-e de prefeitura (sem chave): só campos com rótulo claro.
   A chave (com dígito verificador) é a fonte mais confiável: dela saem o número, o CNPJ do fornecedor
   e o mês da emissão. Os demais campos são lidos pelo rótulo, no quadro certo, e conferidos com a chave.
   Na dúvida o campo fica vazio: melhor em branco do que errado.
   - XML: lê os campos direto do arquivo.
   - PDF com texto: pdf.js (texto com posição na página).
   - Foto ou PDF escaneado: QR code / código de barras (leitor do celular ou zxing) e OCR (Tesseract).
     A imagem não sai do aparelho.
   As bibliotecas ficam em vendor/nf; o sw.js guarda numa cache própria para funcionar sem sinal. */
(() => {
  const BASE = new URL('vendor/nf/', document.baseURI).href;
  const TESS = BASE + 'tesseract-7.0.0/', PDFJS = BASE + 'pdfjs-6.4.299/', ZX = BASE + 'zxing-3.1.6/';
  const VERSAO = 'nf-1';
  const UFS = new Set([11, 12, 13, 14, 15, 16, 17, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 35, 41, 42, 43, 50, 51, 52, 53]);
  const MODELOS = { 55: 'NF-e', 65: 'NFC-e', 59: 'CF-e' };

  class SemRede extends Error { constructor(m) { super(m || 'Sem internet para carregar o leitor de notas'); this.code = 'sem-rede'; } }

  /* ---------- chave de acesso ---------- */
  const digitos = s => String(s || '').replace(/\D+/g, '');
  const anoOk = aa => aa >= 6 && aa <= new Date().getFullYear() % 100 + 1;
  function dvOk(c) {
    let s = 0, p = 2;
    for (let i = c.length - 2; i >= 0; i--) { s += +c[i] * p; p = p === 9 ? 2 : p + 1; }
    const r = s % 11;
    return (r < 2 ? 0 : 11 - r) === +c[c.length - 1];
  }
  // NF-e, NFC-e e CF-e: UF(2) AAMM(4) CNPJ(14) modelo(2) série(3) número(9) tipo(1) código(8) DV(1)
  function chave44(c) {
    if (!/^\d{44}$/.test(c) || !dvOk(c)) return false;
    const mm = +c.slice(4, 6);
    return UFS.has(+c.slice(0, 2)) && mm >= 1 && mm <= 12 && anoOk(+c.slice(2, 4)) && !!MODELOS[c.slice(20, 22)];
  }
  // NFS-e nacional: município(7) ambiente(1) tipo de inscrição(1) CNPJ/CPF(14) número(13) AAMM(4) código(9) DV(1)
  function chave50(c) {
    if (!/^\d{50}$/.test(c) || !dvOk(c)) return false;
    const mm = +c.slice(38, 40);
    return UFS.has(+c.slice(0, 2)) && /[12]/.test(c[8]) && /[1-3]/.test(c[7]) && mm >= 1 && mm <= 12 && anoOk(+c.slice(36, 38)) && +c.slice(23, 36) > 0;
  }
  const chaveValida = c => chave44(c) || chave50(c);
  function info(c) {
    c = digitos(c);
    if (chave50(c)) {
      const doc = c[8] === '2' ? c.slice(9, 23) : '';
      return { tipo: 'NFS-e', cnpj: doc, numero: String(+c.slice(23, 36)), serie: '', ano: '20' + c.slice(36, 38), mes: c.slice(38, 40), modelo: 'nfse' };
    }
    if (!/^\d{44}$/.test(c)) return null;
    const modelo = c.slice(20, 22), sat = modelo === '59';
    return { tipo: MODELOS[modelo] || 'NF-e', cnpj: c.slice(6, 20), modelo, ano: '20' + c.slice(2, 4), mes: c.slice(4, 6),
      serie: sat ? '' : String(+c.slice(22, 25)), numero: String(+(sat ? c.slice(31, 37) : c.slice(25, 34))) };
  }
  const formatarChave = c => digitos(c).replace(/(\d{4})(?=\d)/g, '$1 ');
  // procura chaves válidas numa sequência de dígitos (pode ter números grudados antes/depois)
  function chavesEm(d, out) {
    for (let i = 0; i + 50 <= d.length; i++) { const c = d.slice(i, i + 50); if (chave50(c)) { out.c50 ||= c; d = d.slice(0, i) + ' ' + d.slice(i + 50); break; } }
    for (const parte of d.split(' ')) for (let i = 0; i + 44 <= parte.length; i++) { const c = parte.slice(i, i + 44); if (chave44(c)) { out.c44 ||= c; break; } }
    return out;
  }
  function chavesNoTexto(txt, ocr) {
    const out = {}, toks = String(txt || '').split(/\s+/), runs = [];
    let cur = '';
    for (let t of toks) {
      if (ocr && t.length <= 6 && /\d/.test(t) && (t.match(/\d/g) || []).length / t.length >= 0.5) t = t.replace(/[OoQD]/g, '0').replace(/[Il|i!]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8').replace(/[Zz]/g, '2').replace(/G/g, '6');
      const so = t.replace(/[.\-]/g, '');
      if (/^\d+$/.test(so)) cur += so; else { if (cur) runs.push(cur); cur = ''; }
    }
    if (cur) runs.push(cur);
    for (const r of runs) if (r.length >= 44) chavesEm(r, out);
    for (const m of String(txt || '').matchAll(/\d{44,}/g)) chavesEm(m[0], out);
    return out;
  }

  /* ---------- QR code / código de barras ---------- */
  function doCodigo(txt) {
    const s = String(txt || '').trim(), r = {};
    // CF-e SAT: chave|AAAAMMDDhhmmss|valor|...
    let m = s.match(/^(\d{44})\|(\d{8})\d{6}\|([\d.]+)\|/);
    if (m && chave44(m[1])) return { chave: m[1], data: `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`, valor: +m[3] };
    // NFC-e versão 1: ?chNFe=...&dhEmi=<hex>&vNF=...
    m = s.match(/chNFe=(\d{44})/i);
    if (m && chave44(m[1])) {
      r.chave = m[1];
      const dh = s.match(/dhEmi=([0-9a-f]+)/i);
      if (dh) { const t = dh[1].replace(/../g, h => String.fromCharCode(parseInt(h, 16))); if (/^\d{4}-\d\d-\d\d/.test(t)) r.data = t.slice(0, 10); }
      const v = s.match(/vNF=([\d.]+)/i); if (v) r.valor = +v[1];
      return r;
    }
    // NFC-e versões 2 e 3: ?p=chave|versão|ambiente[|dia|valor|...] (dia e valor só na emissão em contingência)
    m = s.match(/[?&]p=([^&\s]+)/i);
    if (m) {
      const p = decodeURIComponent(m[1]).split('|');
      if (chave44(p[0])) {
        r.chave = p[0];
        if (p.length >= 6 && /^\d{1,2}$/.test(p[3]) && +p[3] >= 1 && +p[3] <= 31 && /^\d+(\.\d{1,2})?$/.test(p[4])) {
          const i = info(p[0]); r.data = `${i.ano}-${i.mes}-${String(+p[3]).padStart(2, '0')}`; r.valor = +p[4];
        }
        return r;
      }
    }
    // NF-e (código de barras do DANFE) e NFS-e nacional (QR com ?chave=): a chave sozinha
    const k = chavesEm(digitos(s), {});
    return k.c50 ? { chave: k.c50 } : k.c44 ? { chave: k.c44 } : {};
  }

  /* ---------- carregar bibliotecas ---------- */
  const scripts = {};
  const script = src => scripts[src] || (scripts[src] = new Promise((ok, erro) => {
    const s = document.createElement('script'); s.src = src; s.async = true;
    s.onload = ok; s.onerror = () => { delete scripts[src]; s.remove(); erro(new SemRede()); };
    document.head.append(s);
  }));
  let tessP = null, tessFim = null;
  const tesseract = () => {
    clearTimeout(tessFim);
    return tessP || (tessP = (async () => {
      await script(TESS + 'tesseract.min.js');
      try {
        return await self.Tesseract.createWorker('por', 1, { workerPath: TESS + 'worker.min.js', corePath: TESS, langPath: TESS + 'lang', workerBlobURL: false, gzip: true });
      } catch (e) { throw navigator.onLine ? e : new SemRede(); }
    })().catch(e => { tessP = null; throw e; }));
  };
  // libera a memória do OCR depois de um tempo sem uso
  const soltarTess = () => { clearTimeout(tessFim); tessFim = setTimeout(async () => { const p = tessP; tessP = null; try { (await p)?.terminate(); } catch {} }, 90000); };
  let pdfP = null;
  const pdfjs = () => pdfP || (pdfP = import(PDFJS + 'pdf.min.js').then(m => { m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; return m; })
    .catch(() => { pdfP = null; throw new SemRede(); }));
  let zxP = null;
  const zxing = () => zxP || (zxP = script(ZX + 'zxing-reader.js').then(() => {
    self.ZXingWASM.prepareZXingModule({ overrides: { locateFile: (p, pre) => p.endsWith('.wasm') ? ZX + p : pre + p } });
    return self.ZXingWASM;
  }).catch(e => { zxP = null; throw e; }));

  /* ---------- texto com posição ----------
     Pedaços de texto {s, x, y, w, h} (y de cima para baixo) viram "frases": palavras vizinhas na mesma linha.
     Nos quadros do DANFE e do DANFSe o rótulo fica em cima e o valor logo abaixo, dentro da mesma célula. */
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  function frases(itens) {
    const its = itens.map(i => ({ ...i, s: String(i.s || '').replace(/\s+/g, ' ').replace(/^[|\[\](){}]+|[|\[\](){}]+$/g, '').trim() })).filter(i => i.s).sort((a, b) => a.y - b.y || a.x - b.x);
    // OCR: cada linha do Tesseract (g) é uma linha; PDF: junta pela altura
    const linhas = [], porG = {};
    for (const it of its) {
      const l = it.g != null ? porG[it.g] : linhas.find(l => Math.abs(l.y - it.y) <= Math.min(l.h, it.h) * 0.5);
      if (l) l.its.push(it); else { const n = { y: it.y, h: it.h, its: [it] }; linhas.push(n); if (it.g != null) porG[it.g] = n; }
    }
    const P = [];
    for (const l of linhas) {
      l.its.sort((a, b) => a.x - b.x);
      let f = null;
      for (const it of l.its) {
        if (f && it.x - (f.x + f.w) <= Math.max(f.h, it.h) * (it.conf != null ? 1.6 : 1.0)) { f.s += ' ' + it.s; f.w = Math.max(f.w, it.x + it.w - f.x); f.h = Math.max(f.h, it.h); f.confs.push(it.conf ?? 100); }
        else { f = { s: it.s, x: it.x, y: it.g != null ? it.y : l.y, w: it.w, h: it.h, linha: l, confs: [it.conf ?? 100] }; P.push(f); }
      }
    }
    for (const f of P) { f.n = norm(f.s).replace(/^[^a-z0-9]+|[^a-z0-9%]+$/g, ''); f.conf = f.confs.reduce((a, b) => a + b, 0) / f.confs.length; }
    return P;
  }
  const textoDe = P => {
    const ls = [...new Set(P.map(f => f.linha))].sort((a, b) => a.y - b.y);
    return ls.map(l => P.filter(f => f.linha === l).sort((a, b) => a.x - b.x).map(f => f.s).join('   ')).join('\n');
  };
  // valor logo abaixo do rótulo, na mesma célula (até o próximo rótulo à direita).
  // "valor" (expressão ou função) descarta o que não serve, como riscos do quadro lidos pelo OCR.
  function abaixo(P, re, { valor = null, de = -Infinity, ate = Infinity } = {}) {
    const serve = !valor ? t => !!t : typeof valor === 'function' ? valor : t => valor.test(t);
    for (const L of P) {
      if (L.y < de || L.y > ate || !re.test(L.n)) continue;
      const prox = P.filter(q => q !== L && Math.abs(q.y - L.y) <= L.h * 0.6 && q.x > L.x + L.h).sort((a, b) => a.x - b.x)[0];
      const x0 = L.x - L.h * 1.2, x1 = prox ? prox.x - L.h * 0.3 : Infinity;
      const cand = P.filter(v => v !== L && v.y > L.y + L.h * 0.4 && v.y - L.y <= Math.max(L.h, v.h) * 3.2 && v.x >= x0 && v.x < x1).sort((a, b) => a.y - b.y);
      while (cand.length) {
        const y = cand[0].y, linha = cand.filter(c => c.y - y <= c.h * 0.5);
        const txt = linha.sort((a, b) => a.x - b.x).map(c => c.s).join(' ').trim();
        if (serve(txt)) return txt;
        for (const c of linha) cand.splice(cand.indexOf(c), 1);
      }
    }
    return '';
  }
  // faixa vertical de um quadro: do título até o título do próximo quadro
  function quadro(P, reIni, reFim) {
    const ini = P.find(f => reIni.test(f.n)); if (!ini) return null;
    const fim = P.filter(f => f.y > ini.y + ini.h && reFim.test(f.n)).sort((a, b) => a.y - b.y)[0];
    return { de: ini.y - ini.h, ate: fim ? fim.y - fim.h * 0.3 : Infinity };
  }

  /* ---------- campos ---------- */
  const moeda = s => +String(s).replace(/\./g, '').replace(',', '.');
  const MONEY = /(?<![\d,])(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})(?![\d,])/;
  const valorDe = s => { const m = String(s || '').match(MONEY); return m ? moeda(m[1]) : null; };
  function cnpjOk(c) {
    if (!/^\d{14}$/.test(c) || /^(\d)\1+$/.test(c)) return false;
    const calc = n => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += +c[i] * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
    return calc(12) === +c[12] && calc(13) === +c[13];
  }
  const RE_CNPJ = /(?<!\d)(\d{2})\s?\.?\s?(\d{3})\s?\.?\s?(\d{3})\s?\/?\s?(\d{4})\s?-?\s?(\d{2})(?!\d)/g;
  const cnpjsDe = s => [...String(s || '').matchAll(RE_CNPJ)].map(m => ({ c: m.slice(1).join(''), i: m.index })).filter(x => cnpjOk(x.c));
  function datas(txt) {
    const out = [], hoje = new Date(); hoje.setDate(hoje.getDate() + 1);
    for (const m of String(txt || '').matchAll(/(?<!\d)(\d{2})\s?[\/.\-]\s?(\d{2})\s?[\/.\-]\s?(\d{4})(?!\d)/g)) {
      const [d, mo, a] = [+m[1], +m[2], +m[3]];
      if (d < 1 || d > 31 || mo < 1 || mo > 12 || a < 2006) continue;
      const dt = new Date(a, mo - 1, d); if (dt.getMonth() !== mo - 1 || dt > hoje) continue;
      out.push({ iso: `${a}-${m[2]}-${m[1]}`, i: m.index });
    }
    return out;
  }
  const dataDe = s => datas(s)[0]?.iso || null;
  // rótulos dos quadros não são nome de empresa
  const ROTULO = /estadual|inscri|subst|tribut|operac|natureza|protocolo|chave|acesso|consulta|danfe|danfse|auxiliar|endere|bairro|municipio|emissao|destinat|remetente|recebiment|assinatura|\bfone\b|telefone|\bcep\b|valor|folha|\bserie\b|entrada|saida|prestador|tomador|adquirente|intermedi|fornecedor|emitente|nome empresarial|razao social|competencia|situacao|finalidade|regime|simples nacional|indicador|e-?mail|codigo|aliquota|retenc|discrimina|descricao|servico prestado/;
  function limpaNome(s) {
    s = String(s || '').replace(/\s+/g, ' ').replace(/^[\s\-–:.,|]+|[\s\-–:.,|]+$/g, '').trim();
    if (s.length < 3 || s.length > 100 || !/[A-Za-zÀ-ú]{3}/.test(s) || /@|www\.|https?:/i.test(s)) return '';
    const a = norm(s);
    if (/^(danfe|documento auxiliar|nota fiscal|nf-?e|nfs-?e|cnpj|cpf|consumidor|ie\b|inscri)/.test(a) || ROTULO.test(a)) return '';
    const letras = (s.match(/[A-Za-zÀ-ú]/g) || []).length;
    if (letras / s.replace(/\s/g, '').length < 0.75 || (s.match(/[A-Za-zÀ-ú]{2,}/g) || []).length < 2) return '';
    return s;
  }
  // mesmo nome de empresa? (ignora acentos, pontuação e LTDA/ME/EPP/EIRELI/S.A.)
  const nomeBase = s => norm(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(ltda|me|epp|eireli|s ?a|cia|mei)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const mesmoNome = (a, b) => { a = nomeBase(a); b = nomeBase(b); return !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 12 && (a.startsWith(b) || b.startsWith(a)))); };

  /* ---------- tipo de nota ---------- */
  function tipoDoc(texto, k) {
    const t = norm(texto);
    const nfse = /danfse|nfs-?e|nota fiscal (de )?servico|prestador (de servicos|\/ fornecedor)|tomador/.test(t);
    if (k.c50 && (nfse || !k.c44)) return 'NFS-e';
    if (k.c44) return info(k.c44).tipo;
    if (nfse) return 'NFS-e';
    if (/\bdanfe\b|documento auxiliar da nota fiscal eletronica/.test(t)) return 'NF-e';
    if (/nfc-?e|consumidor eletronica/.test(t)) return 'NFC-e';
    return '';
  }

  /* NF-e (DANFE de peças, ferramentas, produtos) */
  function lerNFe(P, texto, r) {
    const corrido = texto.replace(/\s+/g, ' ');
    // canhoto: "RECEBEMOS DE <emitente> OS PRODUTOS ..."
    let m = corrido.match(/recebemos\s+de\s+(.{3,120}?)\s+(?:os\s+produtos|o\s+produto|os\s+servi|as\s+mercadorias)/i)
      || (r.ocr && texto.match(/(?:^|\n)\s*\S{6,12}\s+de\s+([^\n]{3,120}?)\s+(?:os\s+produtos|o\s+produto|os\s+servi)/i));
    if (m) r.fornecedor = limpaNome(m[1]);
    // comprador: quadro destinatário (e "DESTINATÁRIO: nome" do canhoto)
    const q = quadro(P, /^destinatario\s*\/?\s*remetente/, /^(fatura|calculo do imposto|transportador)/);
    if (q) {
      r.comprador = abaixo(P, /^nome\s*\/?\s*razao social$/, { ...q, valor: limpaNome });
      r.cnpjComprador = digitos(abaixo(P, /^cnpj\s*\/?\s*cpf$/, q));
      r.data = dataDe(abaixo(P, /^(data )?(de|da) emissao$/, { ...q, valor: /\d{2}\/\d{2}\/\d{4}/ }));
    }
    // CNPJ do emitente: quadro de cima (antes do destinatário), nunca o do canhoto
    const ce = cnpjsDe(abaixo(P, /^cnpj(\s*\/?\s*cpf)?$/, { ate: q ? q.de : Infinity, valor: t => cnpjsDe(t).length > 0 }))[0]; if (ce) r.cnpj = ce.c;
    if ((m = corrido.match(/destinatario\s*:\s*(.{3,80}?)\s+(?:cnpj|cpf|valor)/i))) r.comprador ||= m[1].trim();
    if (!r.data) r.data = dataDe(abaixo(P, /^(data )?(de|da) emissao$/, { valor: /\d{2}\/\d{2}\/\d{4}/ }));
    r.valor = valorDe(abaixo(P, /^(valor )?total da (nota|nf-?e)$/, { valor: MONEY }));
    if (!r.valor && (m = corrido.match(/destinatario\s*:.{3,120}?valor\s*(?:total)?\s*:?\s*(?:r\$)?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i))) r.valor = moeda(m[1]);
  }

  /* NFS-e (serviços). Padrão nacional (DANFSe): quadros PRESTADOR / FORNECEDOR e TOMADOR / ADQUIRENTE. */
  function lerNFSe(P, texto, r) {
    const FIM = /^(tomador|intermediario|destinatario|servico prestado|discrimina|descricao do servico|tributac|valor total|informacoes)/;
    const prest = quadro(P, /^prestador\s*\/\s*fornecedor$/, FIM) || quadro(P, /^(dados do )?prestador( de servicos?| do servico)?$/, FIM)
      || quadro(P, /^prestador\b/, FIM) || quadro(P, /^emitente\b(?! da nfs)/, FIM);
    const NOME = /^(nome\s*\/\s*nome( empresarial)?|nome empresarial|razao social|nome\s*\/\s*razao social|razao social\s*\/\s*nome|nome)$/;
    if (prest) {
      r.fornecedor = limpaNome(abaixo(P, NOME, { ...prest, valor: limpaNome }));
      const c = cnpjsDe(abaixo(P, /^cnpj/, { ...prest, valor: t => cnpjsDe(t).length > 0 }))[0]; if (c) r.cnpj = c.c;
    }
    const tom = quadro(P, /^tomador( \/ adquirente| de servicos?| do servico)?$/, /^(intermediario|destinatario|servico prestado|discrimina|descricao|tributac|valor)/)
      || quadro(P, /^tomador\b/, /^(intermediario|servico|discrimina|descricao|tributac|valor)/);
    if (tom) { r.comprador = abaixo(P, NOME, { ...tom, valor: limpaNome }); r.cnpjComprador = digitos(abaixo(P, /^cnpj/, { ...tom, valor: t => cnpjsDe(t).length > 0 })); }
    r.data = dataDe(abaixo(P, /^data e hora da emissao( da( nfs-?e)?)?$/, { valor: /\d{2}\/\d{2}\/\d{4}/ }))
      || dataDe(abaixo(P, /^data (e hora )?(de|da) emissao( da nota| da nfs-?e)?$/, { valor: /\d{2}\/\d{2}\/\d{4}/ }));
    const num = abaixo(P, /^(numero|n[o°º.]?) da (nfs-?e|nota)( fiscal)?$/, { valor: /^\d[\d.]*$/ });
    if (num) r.numero = String(+digitos(num));
    r.valor = valorDe(abaixo(P, /^valor liquido( da( nfs-?e| nota)?)?$/, { valor: MONEY }))
      || valorDe(abaixo(P, /^valor da operacao( \/ servico)?$/, { valor: MONEY }))
      || valorDe(abaixo(P, /^valor (total )?(dos? )?servicos?$/, { valor: MONEY }))
      || valorDe(abaixo(P, /^valor liquido\b/, { valor: MONEY }));
  }

  /* NFC-e, CF-e e o que não tem quadros: texto corrido (lista de cima para baixo) */
  function lerCupom(texto, r) {
    const plano = String(texto || '').replace(/\r/g, ''), low = norm(plano);
    const linhas = plano.split('\n').map(l => l.trim()).filter(Boolean);
    const ch = info(r.chave);
    // data de emissão: a que vem depois de "emissão"; senão a do mês da chave
    const ds = datas(plano);
    if (ds.length) {
      const mes = ch ? `${ch.ano}-${ch.mes}` : '', ok = d => !mes || d.iso.startsWith(mes);
      let pick = null;
      for (const m of low.matchAll(/emiss[a-z]*/g)) { pick = ds.find(d => d.i > m.index && d.i - m.index < 160 && ok(d)); if (pick) break; }
      pick = pick || (mes ? ds.find(ok) : null);
      if (pick) r.data = pick.iso;
    }
    // valor: "Valor a pagar", "Valor total R$" na mesma linha
    for (const re of [/valor\s+a\s+pagar/, /total\s+a\s+pagar/, /valor\s+total\s*:?\s*r\$/, /valor\s+total\s+da\s+nota/, /valor\s+pago/]) {
      const l = linhas.find(l => re.test(norm(l)));
      const v = l && valorDe(l.slice(norm(l).search(re)));
      if (v) { r.valor = v; break; }
    }
    // fornecedor: a linha antes do primeiro CNPJ (no cupom o emitente vem no alto)
    const cs = r.tipo === 'NFC-e' || r.tipo === 'CF-e' ? cnpjsDe(plano) : [];
    if (cs.length) {
      r.cnpj ||= cs[0].c;
      const ant = plano.slice(0, cs[0].i).split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = ant.length - 1, n = 0; i >= 0 && n < 3; i--, n++) {
        const x = limpaNome(ant[i].replace(/cnpj.*$/i, ''));
        if (x && !/\d{3}/.test(x) && x === x.toUpperCase()) { r.fornecedor = x; break; }
      }
    }
  }

  function analisar(P, opt = {}) {
    const texto = textoDe(P), k = chavesNoTexto(texto + '\n' + (opt.bruto || ''), opt.ocr);
    if (opt.chave) { if (opt.chave.length === 50) k.c50 = opt.chave; else k.c44 = opt.chave; }
    const tipo = tipoDoc(texto, k);
    const r = { tipo, ocr: !!opt.ocr };
    r.chave = tipo === 'NFS-e' ? k.c50 : k.c44 || (!tipo ? k.c50 : undefined);
    if (tipo === 'NFS-e') lerNFSe(P, texto, r);
    else if (tipo === 'NF-e') { lerNFe(P, texto, r); if (!r.data || !r.valor) { const c = {}; c.chave = r.chave; lerCupom(texto, c); r.data ||= c.data; r.valor ||= c.valor; } }
    else lerCupom(texto, r);
    // OCR: o nome lido é só um palpite (o nome pelo CNPJ, com internet, vale mais) e precisa de boa leitura
    if (opt.ocr && r.fornecedor) {
      const nome = r.fornecedor, ps = P.filter(f => f.s.length >= 3 && (nome.includes(f.s) || f.s.includes(nome)));
      const conf = ps.length ? Math.min(...ps.map(f => f.conf)) : 0;
      if (conf >= 75) r.fornecedorPalpite = nome;
      r.fornecedor = undefined;
    }
    return r;
  }

  /* ---------- imagem ---------- */
  function desenhar(src, max) {
    const w = src.width, h = src.height, k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  async function lerCodigos(src) {
    const textos = [];
    const achou = () => textos.some(t => doCodigo(t).chave);
    if ('BarcodeDetector' in self) {
      try {
        const fmts = await self.BarcodeDetector.getSupportedFormats();
        const want = ['qr_code', 'code_128'].filter(f => fmts.includes(f));
        if (want.length) for (const r of await new self.BarcodeDetector({ formats: want }).detect(src)) textos.push(r.rawValue);
      } catch {}
    }
    let semRede = false;
    if (!achou()) {
      try {
        const Z = await zxing();
        const c = desenhar(src, 3200);
        const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        for (const r of await Z.readBarcodes(img, { formats: ['QRCode', 'Code128'], tryHarder: true, maxNumberOfSymbols: 4 })) textos.push(r.text);
      } catch (e) { if (e?.code === 'sem-rede' || !navigator.onLine) semRede = true; }
    }
    return { textos, semRede };
  }
  // tons de cinza e contraste: ajuda o OCR em foto de cupom térmico
  function prepararOcr(src) {
    const c = desenhar(src, 2200), ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data, hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = y; hist[y]++; }
    const tot = d.length / 4; let a = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { a += hist[i]; if (a > tot * 0.01) { lo = i; break; } }
    a = 0; for (let i = 255; i >= 0; i--) { a += hist[i]; if (a > tot * 0.01) { hi = i; break; } }
    const k = hi > lo ? 255 / (hi - lo) : 1;
    for (let i = 0; i < d.length; i += 4) { const y = Math.max(0, Math.min(255, (d[i] - lo) * k)); d[i] = d[i + 1] = d[i + 2] = y; }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  async function doImagem(src, prog) {
    prog?.('codigo');
    const cod = await lerCodigos(src);
    let base = {};
    for (const t of cod.textos) { const x = doCodigo(t); if (x.chave) { base = x; break; } }
    prog?.('ocr');
    let P = null, texto = '', pendente = false;
    try {
      const w = await tesseract();
      const { data } = await w.recognize(prepararOcr(src), {}, { text: true, blocks: true });
      soltarTess();
      texto = data.text || '';
      const linhas = [];
      for (const b of data.blocks || []) for (const pa of b.paragraphs || []) for (const l of pa.lines || []) {
        const ws = (l.words || []).filter(w => w.text?.trim() && w.bbox); if (ws.length) linhas.push(ws);
      }
      // foto torta: endireita as posições pela inclinação típica das linhas
      const incl = [];
      for (const ws of linhas) if (ws.length >= 2) {
        const a = ws[0].bbox, b = ws[ws.length - 1].bbox, dx = (b.x0 + b.x1 - a.x0 - a.x1) / 2;
        if (dx > 80) incl.push((b.y1 - a.y1) / dx);
      }
      incl.sort((a, b) => a - b);
      const t = incl.length >= 3 ? Math.atan(incl[incl.length >> 1]) : 0, cos = Math.cos(t), sin = Math.sin(t);
      const its = [];
      linhas.forEach((ws, g) => { for (const wd of ws) {
        const bb = wd.bbox, w = bb.x1 - bb.x0, h = Math.max(4, bb.y1 - bb.y0), cx = (bb.x0 + bb.x1) / 2, cy = bb.y1;
        its.push({ s: wd.text, x: cx * cos + cy * sin - w / 2, y: -cx * sin + cy * cos, w, h, conf: wd.confidence ?? 0, g });
      } });
      P = frases(its);
    } catch (e) {
      if (e?.code === 'sem-rede' || !navigator.onLine) pendente = true; else console.warn('OCR', e);
    }
    if (cod.semRede && !base.chave) pendente = true;
    const r = P ? analisar(P, { ocr: true, chave: base.chave, bruto: texto }) : { tipo: base.chave ? info(base.chave).tipo : '', chave: base.chave };
    if (base.data) r.data = base.data;
    if (base.valor) r.valor = base.valor;
    if (self.NotaFiscal?.debug) { r.texto = texto; r.frases = P && P.map(f => [Math.round(f.x), Math.round(f.y), Math.round(f.w), Math.round(f.h), f.s].join(' ')); }
    if (pendente) r.pendente = true;
    return r;
  }

  /* ---------- PDF ---------- */
  async function doPdf(buf, prog) {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true, stopAtErrors: false, wasmUrl: PDFJS + 'wasm/' }).promise;
    const pg = await doc.getPage(1), H = pg.getViewport({ scale: 1 }).height, tc = await pg.getTextContent();
    const its = tc.items.filter(i => i.str && i.str.trim()).map(i => {
      const h = Math.abs(i.transform[3]) || Math.abs(i.transform[0]) || 8;
      return { s: i.str, x: i.transform[4], y: H - i.transform[5], w: i.width, h };
    });
    if (its.map(i => i.s).join('').replace(/\s+/g, '').length >= 60) {
      const r = analisar(frases(its));
      if (r.chave || r.data || r.fornecedor) return { fonte: 'pdf', ...r };
    }
    // PDF escaneado (só imagem): lê como foto a primeira página
    const vp0 = pg.getViewport({ scale: 1 }), esc = Math.min(4, 2400 / Math.max(vp0.width, vp0.height));
    const vp = pg.getViewport({ scale: esc }), c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
    return { ...(await doImagem(c, prog)), fonte: 'pdf' };
  }

  /* ---------- XML ---------- */
  function doXml(txt) {
    const d = new DOMParser().parseFromString(txt, 'application/xml');
    if (d.getElementsByTagName('parsererror').length) return {};
    const tag = (n, root = d) => root.getElementsByTagName(n)[0];
    const val = (n, root = d) => (tag(n, root)?.textContent || '').trim();
    const dataIso = dt => /^\d{4}-\d\d-\d\d/.test(dt) ? dt.slice(0, 10) : /^\d{8}$/.test(dt) ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}` : undefined;
    const r = { fonte: 'xml' };
    const raiz = tag('infNFe') || tag('infCFe');
    if (raiz) {
      const c = digitos(raiz.getAttribute('Id')) || digitos(val('chNFe'));
      if (chave44(c)) r.chave = c;
      const ide = tag('ide', raiz), emit = tag('emit', raiz), dest = tag('dest', raiz);
      if (ide) { r.numero = String(+(val('nNF', ide) || val('nCFe', ide)) || '') || undefined; r.data = dataIso(val('dhEmi', ide) || val('dEmi', ide)); }
      if (emit) { r.fornecedor = val('xNome', emit) || val('xFant', emit) || undefined; r.cnpj = val('CNPJ', emit) || undefined; }
      if (dest) { r.comprador = val('xNome', dest); r.cnpjComprador = val('CNPJ', dest); }
      const v = +(val('vNF') || val('vCFe')); if (v > 0) r.valor = v;
      r.tipo = r.chave ? info(r.chave).tipo : tag('infCFe') ? 'CF-e' : 'NF-e';
      return r;
    }
    // NFS-e padrão nacional (infNFSe, prestador em emit) e municipais mais comuns (ABRASF)
    r.tipo = 'NFS-e';
    const inf = tag('infNFSe'), c = digitos(inf?.getAttribute('Id'));
    if (chave50(c)) r.chave = c;
    const emit = tag('emit') || tag('prest') || tag('PrestadorServico') || tag('Prestador');
    if (emit) {
      r.fornecedor = val('xNome', emit) || val('RazaoSocial', emit) || undefined;
      r.cnpj = digitos(val('CNPJ', emit) || val('Cnpj', emit)) || undefined;
    }
    const tom = tag('toma') || tag('TomadorServico') || tag('Tomador');
    if (tom) { r.comprador = val('xNome', tom) || val('RazaoSocial', tom); r.cnpjComprador = digitos(val('CNPJ', tom) || val('Cnpj', tom)); }
    r.numero = String(+(val('nNFSe') || val('Numero')) || '') || undefined;
    r.data = dataIso(val('dhEmi') || val('DataEmissao') || val('dhProc'));
    const v = +(val('vLiq') || val('ValorLiquidoNfse') || val('vServ') || val('ValorServicos')); if (v > 0) r.valor = v;
    return r;
  }

  /* ---------- conferência final: na dúvida, deixa em branco ---------- */
  function conferir(r, opt) {
    const meuCnpj = digitos(opt.meuCnpj), compradores = [r.comprador, ...(opt.meusNomes || [])].filter(Boolean);
    const cnpjsComprador = [meuCnpj, digitos(r.cnpjComprador)].filter(Boolean);
    const ch = info(r.chave);
    if (ch && chaveValida(r.chave)) {
      r.tipo = ch.tipo; r.numero = ch.numero; r.serie = ch.serie || undefined; r.modelo = ch.modelo;
      if (ch.cnpj) r.cnpj = ch.cnpj;
      // a data tem de ser do mês/ano que está na chave
      if (r.data && r.data.slice(0, 7) !== `${ch.ano}-${ch.mes}`) r.data = undefined;
    } else r.chave = undefined;
    if (r.cnpj && (!cnpjOk(r.cnpj) || cnpjsComprador.includes(r.cnpj))) r.cnpj = undefined;
    if (r.numero && !/^\d{1,13}$/.test(r.numero)) r.numero = undefined;
    if (r.data && !datas(r.data.split('-').reverse().join('/')).length) r.data = undefined;
    if (!(r.valor > 0 && r.valor < 1e7)) r.valor = undefined;
    // fornecedor nunca é quem comprou (o destinatário/tomador, ou a própria empresa)
    if (r.fornecedor) { r.fornecedor = r.fonte === 'xml' ? String(r.fornecedor).trim() : limpaNome(r.fornecedor); if (!r.fornecedor || compradores.some(n => mesmoNome(n, r.fornecedor))) r.fornecedor = undefined; }
    if (r.fornecedorPalpite && compradores.some(n => mesmoNome(n, r.fornecedorPalpite))) r.fornecedorPalpite = undefined;
    delete r.comprador; delete r.cnpjComprador; delete r.ocr;
    return r;
  }

  /* ---------- entrada principal ---------- */
  async function ler(arquivo, opt = {}) {
    const prog = typeof opt === 'function' ? opt : opt.prog;
    if (typeof opt === 'function') opt = {};
    const nome = (arquivo.name || '').toLowerCase(), tipo = arquivo.type || '';
    const cab = new Uint8Array(await arquivo.slice(0, 64).arrayBuffer());
    const ini = String.fromCharCode(...cab).replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
    let r;
    if (/xml/.test(tipo) || nome.endsWith('.xml') || ini.startsWith('<')) r = doXml(await arquivo.text());
    else if (tipo === 'application/pdf' || nome.endsWith('.pdf') || ini.startsWith('%PDF')) r = await doPdf(await arquivo.arrayBuffer(), prog);
    else {
      let bmp;
      try { bmp = await createImageBitmap(arquivo); } catch { throw Object.assign(new Error('Não deu para abrir a imagem'), { code: 'imagem' }); }
      try { r = { fonte: 'foto', ...(await doImagem(bmp, prog)) }; } finally { bmp.close?.(); }
    }
    return conferir(r, opt);
  }

  /* nome da empresa pelo CNPJ (internet). Guarda no aparelho. */
  const LSK = 'cs-cnpj-nomes';
  async function nomeCnpj(cnpj) {
    if (!cnpjOk(cnpj)) return '';
    let cache = {}; try { cache = JSON.parse(localStorage.getItem(LSK)) || {}; } catch {}
    if (cache[cnpj]) return cache[cnpj];
    if (!navigator.onLine) return '';
    const tenta = async (url, pega) => {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), 8000);
      try { const r = await fetch(url, { signal: ac.signal }); if (!r.ok) return ''; return pega(await r.json()) || ''; } catch { return ''; } finally { clearTimeout(t); }
    };
    const nome = await tenta(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, j => j.razao_social)
      || await tenta(`https://publica.cnpj.ws/cnpj/${cnpj}`, j => j.razao_social);
    if (nome) { cache[cnpj] = nome.trim(); try { localStorage.setItem(LSK, JSON.stringify(cache)); } catch {} }
    return nome.trim();
  }

  /* baixa o leitor com internet para funcionar depois sem sinal (uma vez por versão) */
  let preparando = false;
  async function preparar() {
    if (preparando || !navigator.onLine || navigator.connection?.saveData) return;
    try { if (localStorage.getItem('cs-nf-pronto') === VERSAO) return; } catch {}
    preparando = true;
    try {
      await Promise.all([PDFJS + 'pdf.min.js', PDFJS + 'pdf.worker.min.js', ZX + 'zxing-reader.js', ZX + 'zxing_reader.wasm', TESS + 'tesseract.min.js', TESS + 'worker.min.js'].map(u => fetch(u).then(r => { if (!r.ok) throw new Error(u); return r.arrayBuffer(); })));
      await tesseract(); soltarTess(); // baixa o núcleo certo para este aparelho e o português
      try { localStorage.setItem('cs-nf-pronto', VERSAO); } catch {}
    } catch {} finally { preparando = false; }
  }

  window.NotaFiscal = { ler, nomeCnpj, preparar, info, formatarChave, chaveValida, cnpjOk, digitos, mesmoNome, _doCodigo: doCodigo, _doXml: doXml, _frases: frases, _analisar: analisar };
})();
