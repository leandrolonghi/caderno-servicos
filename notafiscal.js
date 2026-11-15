/* Leitura de nota fiscal (NF-e, NFC-e e CF-e SAT) a partir de foto, PDF ou XML, feita no próprio aparelho.
   - XML: lê os campos direto do arquivo.
   - PDF com texto: extrai o texto com o pdf.js.
   - Foto ou PDF escaneado: lê o QR code / código de barras da chave de acesso (leitor do celular ou zxing)
     e o texto por OCR (Tesseract). A imagem não sai do aparelho.
   A chave de acesso (44 dígitos, com dígito verificador) traz o CNPJ do emitente, o ano/mês e o número da nota.
   As bibliotecas ficam em vendor/nf; o sw.js guarda numa cache própria para funcionar sem sinal. */
(() => {
  const BASE = new URL('vendor/nf/', document.baseURI).href;
  const TESS = BASE + 'tesseract-7.0.0/', PDFJS = BASE + 'pdfjs-6.4.299/', ZX = BASE + 'zxing-3.1.6/';
  const VERSAO = 'nf-1';
  const UFS = new Set([11, 12, 13, 14, 15, 16, 17, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 35, 41, 42, 43, 50, 51, 52, 53]);
  const MODELOS = new Set(['55', '65', '59']);

  class SemRede extends Error { constructor(m) { super(m || 'Sem internet para carregar o leitor de notas'); this.code = 'sem-rede'; } }

  /* ---------- chave de acesso ---------- */
  const digitos = s => String(s || '').replace(/\D+/g, '');
  function dvOk(c) {
    if (!/^\d{44}$/.test(c)) return false;
    let s = 0, p = 2;
    for (let i = 42; i >= 0; i--) { s += +c[i] * p; p = p === 9 ? 2 : p + 1; }
    const r = s % 11;
    return (r < 2 ? 0 : 11 - r) === +c[43];
  }
  function chaveValida(c) {
    if (!dvOk(c)) return false;
    const uf = +c.slice(0, 2), aa = +c.slice(2, 4), mm = +c.slice(4, 6), ano = new Date().getFullYear() % 100;
    return UFS.has(uf) && mm >= 1 && mm <= 12 && aa >= 6 && aa <= ano + 1 && MODELOS.has(c.slice(20, 22));
  }
  function info(c) {
    if (!/^\d{44}$/.test(c || '')) return null;
    const modelo = c.slice(20, 22), sat = modelo === '59';
    const doc = c.slice(6, 20);
    return { uf: c.slice(0, 2), ano: '20' + c.slice(2, 4), mes: c.slice(4, 6), cnpj: doc, modelo,
      serie: sat ? '' : String(+c.slice(22, 25)), numero: String(+(sat ? c.slice(31, 37) : c.slice(25, 34))) };
  }
  const formatarChave = c => digitos(c).replace(/(\d{4})(?=\d)/g, '$1 ');
  // procura uma chave válida dentro de uma sequência de dígitos (pode ter números grudados antes/depois)
  function chaveEmDigitos(d) {
    for (let i = 0; i + 44 <= d.length; i++) { const c = d.slice(i, i + 44); if (chaveValida(c)) return c; }
    return '';
  }
  function chaveNoTexto(txt, ocr) {
    // junta as sequências de grupos de dígitos ("4325 1112 3456 ...")
    const toks = String(txt || '').split(/\s+/);
    const runs = []; let cur = '';
    for (let t of toks) {
      if (ocr && t.length <= 6 && /\d/.test(t) && (t.match(/\d/g) || []).length / t.length >= 0.5) t = t.replace(/[OoQD]/g, '0').replace(/[Il|i!]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8').replace(/[Zz]/g, '2').replace(/G/g, '6');
      const so = t.replace(/[.\-]/g, '');
      if (/^\d+$/.test(so)) cur += so; else { if (cur) runs.push(cur); cur = ''; }
    }
    if (cur) runs.push(cur);
    for (const r of runs) if (r.length >= 44) { const c = chaveEmDigitos(r); if (c) return c; }
    // texto corrido (ex.: "NFe4325...")
    for (const m of String(txt || '').matchAll(/\d{44,}/g)) { const c = chaveEmDigitos(m[0]); if (c) return c; }
    return '';
  }

  /* ---------- QR code / código de barras ---------- */
  function doCodigo(txt) {
    const s = String(txt || '').trim(), r = {};
    // CF-e SAT: chave|AAAAMMDDhhmmss|valor|...
    let m = s.match(/^(\d{44})\|(\d{8})\d{6}\|([\d.]+)\|/);
    if (m && chaveValida(m[1])) return { chave: m[1], data: `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`, valor: +m[3] };
    // NFC-e versão 1: ?chNFe=...&dhEmi=<hex>&vNF=...
    m = s.match(/chNFe=(\d{44})/i);
    if (m && chaveValida(m[1])) {
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
      if (chaveValida(p[0])) {
        r.chave = p[0];
        if (p.length >= 6 && /^\d{1,2}$/.test(p[3]) && +p[3] >= 1 && +p[3] <= 31 && /^\d+(\.\d{1,2})?$/.test(p[4])) {
          const i = info(p[0]); r.data = `${i.ano}-${i.mes}-${String(+p[3]).padStart(2, '0')}`; r.valor = +p[4];
        }
        return r;
      }
    }
    const c = chaveEmDigitos(digitos(s));
    return c ? { chave: c } : {};
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
    const r = { fonte: 'foto' };
    prog?.('codigo');
    const cod = await lerCodigos(src);
    for (const t of cod.textos) { const x = doCodigo(t); if (x.chave) { Object.assign(r, x); break; } }
    prog?.('ocr');
    let texto = '';
    try {
      const w = await tesseract();
      texto = (await w.recognize(prepararOcr(src))).data.text || '';
      soltarTess();
    } catch (e) {
      if (e?.code === 'sem-rede' || !navigator.onLine) r.pendente = true; else console.warn('OCR', e);
    }
    if (cod.semRede && !r.chave) r.pendente = true;
    if (self.NotaFiscal?.debug) r.texto = texto;
    if (texto) {
      const t = doTexto(texto, { ocr: true, chave: r.chave });
      for (const k of ['chave', 'data', 'valor']) if (r[k] == null && t[k] != null) r[k] = t[k];
      if (t.fornecedor) r.fornecedorPalpite = t.fornecedor;
      if (t.cnpj) r.cnpjTexto = t.cnpj;
      if (t.numero) r.numeroTexto = t.numero;
    }
    return r;
  }

  /* ---------- texto (PDF ou OCR) ---------- */
  const semAc = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const moeda = s => +String(s).replace(/\./g, '').replace(',', '.');
  function cnpjOk(c) {
    if (!/^\d{14}$/.test(c) || /^(\d)\1+$/.test(c)) return false;
    const calc = n => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += +c[i] * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
    return calc(12) === +c[12] && calc(13) === +c[13];
  }
  function datas(txt) {
    const out = [], hoje = new Date(); hoje.setDate(hoje.getDate() + 1);
    for (const m of txt.matchAll(/(?<!\d)(\d{2})\s?[\/.\-]\s?(\d{2})\s?[\/.\-]\s?(\d{4})(?!\d)/g)) {
      const [d, mo, a] = [+m[1], +m[2], +m[3]];
      if (d < 1 || d > 31 || mo < 1 || mo > 12 || a < 2006) continue;
      const dt = new Date(a, mo - 1, d); if (dt.getMonth() !== mo - 1 || dt > hoje) continue;
      out.push({ iso: `${a}-${m[2]}-${m[1]}`, i: m.index });
    }
    return out;
  }
  function limpaNome(s) {
    s = String(s || '').replace(/\s+/g, ' ').replace(/^[\s\-–:.,|]+|[\s\-–:.,|]+$/g, '').trim();
    if (s.length < 3 || s.length > 90 || !/[A-Za-zÀ-ú]{3}/.test(s)) return '';
    const a = semAc(s).toLowerCase();
    if (/^(danfe|documento auxiliar|nota fiscal|nf-?e|cnpj|cpf|consumidor|ie\b|inscri)/.test(a)) return '';
    // rótulos de quadros do DANFE e do cupom não são nome de empresa
    if (/estadual|inscri|subst|tribut|operac|natureza|protocolo|chave|acesso|consulta|danfe|auxiliar|endere|bairro|municipio|emissao|destinat|remetente|recebiment|assinatura|\bfone\b|\bcep\b|valor|folha|\bserie\b|entrada|saida/.test(a)) return '';
    const letras = (s.match(/[A-Za-zÀ-ú]/g) || []).length;
    if (letras / s.replace(/\s/g, '').length < 0.75 || (s.match(/[A-Za-zÀ-ú]{3,}/g) || []).length < 2) return '';
    return s;
  }
  function doTexto(txt, opt = {}) {
    const r = {}, plano = String(txt || '').replace(/\r/g, ''), low = semAc(plano).toLowerCase();
    const linhas = plano.split('\n').map(l => l.trim()).filter(Boolean);
    r.chave = opt.chave || chaveNoTexto(plano, opt.ocr) || undefined;
    const ch = info(r.chave);
    // data de emissão: a que vem depois de "emissão"; senão a do mês da chave; senão a primeira
    const ds = datas(plano);
    if (ds.length) {
      const mes = ch ? `${ch.ano}-${ch.mes}` : '';
      const ok = d => !mes || d.iso.startsWith(mes);
      const em = [...low.matchAll(/emiss[a-z]*/g)].map(m => m.index);
      let pick = null;
      for (const e of em) { pick = ds.find(d => d.i > e && d.i - e < 160 && ok(d)); if (pick) break; }
      pick = pick || ds.find(ok) || (!mes ? ds[0] : null);
      if (pick) r.data = pick.iso;
    }
    // valor total
    const MON = /(?<![\d,])(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})(?![\d,])/g;
    const achaValor = () => {
      for (const re of [/valor\s+a\s+pagar/, /valor\s+total\s+da\s+nota/, /total\s+a\s+pagar/, /valor\s+total\s*:?\s*r\$/, /valor\s+total\s+da\s+nf/, /valor\s+pago/, /valor\s+total(?!\s+dos?\s+(?:produtos|servicos|tributos|impostos|icms|ipi|frete|seguro))/]) {
        for (let i = 0; i < linhas.length; i++) {
          const l = semAc(linhas[i]).toLowerCase(), m = re.exec(l);
          if (!m) continue;
          const resto = linhas[i].slice(m.index + m[0].length), v1 = [...resto.matchAll(MON)];
          if (v1.length) return moeda(v1[0][1]);
          // rótulo numa linha e valores na de baixo (quadro do DANFE): pega o valor na mesma coluna
          const prox = linhas[i + 1] ? [...linhas[i + 1].matchAll(MON)] : [];
          if (prox.length) {
            const rot = l.split(/\s{2,}|\|/).filter(Boolean), pos = rot.findIndex(x => re.test(x));
            return moeda((prox[pos >= 0 && rot.length === prox.length ? pos : prox.length - 1])[1]);
          }
        }
      }
      return null;
    };
    const v = opt.valor ?? achaValor(); if (v > 0) r.valor = v;
    // CNPJ do emitente
    const cnpjs = [...plano.matchAll(/(?<!\d)(\d{2})\s?\.?\s?(\d{3})\s?\.?\s?(\d{3})\s?\/?\s?(\d{4})\s?-?\s?(\d{2})(?!\d)/g)].map(m => ({ c: m.slice(1).join(''), i: m.index })).filter(x => cnpjOk(x.c));
    if (cnpjs.length) r.cnpj = cnpjs[0].c;
    // fornecedor: canhoto do DANFE ("RECEBEMOS DE ... OS PRODUTOS"), "Emitente:" ou a linha antes do primeiro CNPJ (cupom)
    const corrido = plano.replace(/\s+/g, ' ');
    let m = corrido.match(/recebemos\s+de\s+(.{3,120}?)\s+(?:os\s+produtos|o\s+produto|os\s+servi)/i)
      || (opt.ocr && plano.match(/(?:^|\n)\s*\S{6,12}\s+de\s+([^\n]{3,120}?)\s+(?:os\s+produtos|o\s+produto|os\s+servi)/i));
    let nome = m ? limpaNome(m[1]) : '';
    if (!nome && (m = corrido.match(/(?:raz[aã]o\s+social|emitente|nome\s+empresarial)\s*[:\-]\s*([^:]{3,90}?)(?=\s+(?:cnpj|cpf|endere|inscri|ie\b|nome fantasia|rua|av\.|avenida|\d{2}\.\d{3}))/i))) nome = limpaNome(m[1]);
    if (!nome && cnpjs.length) {
      const pos = plano.slice(0, cnpjs[0].i).split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = pos.length - 1, n = 0; i >= 0 && n < 3; i--, n++) {
        const l = pos[i].replace(/cnpj.*$/i, '').trim(), x = limpaNome(l);
        if (x && !/\d{3}/.test(x) && x === x.toUpperCase()) { nome = x; break; }
      }
    }
    if (nome) r.fornecedor = nome;
    // número da nota (só usado quando não há chave)
    m = semAc(plano).match(/(?:n[uú]mero\s*(?:da\s*(?:nota|nfs-?e|nf-?e))?|nf-?e\s*n[ºo°.]?|\bn[ºo°]\.?)\s*[:.]?\s*(\d{1,3}(?:\.\d{3})+|\d{1,9})(?![\d\/])/i);
    if (m) r.numero = String(+m[1].replace(/\./g, ''));
    return r;
  }

  /* ---------- PDF ---------- */
  async function doPdf(buf, prog) {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true, stopAtErrors: false, wasmUrl: PDFJS + 'wasm/' }).promise;
    let texto = '';
    for (let p = 1; p <= Math.min(2, doc.numPages); p++) {
      const pg = await doc.getPage(p), tc = await pg.getTextContent();
      // monta as linhas pela posição (de cima para baixo, da esquerda para a direita)
      const its = tc.items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5], h: Math.abs(i.transform[3]) || 8, w: i.width }));
      its.sort((a, b) => b.y - a.y || a.x - b.x);
      const ls = [];
      for (const it of its) {
        const l = ls[ls.length - 1];
        if (l && Math.abs(l.y - it.y) <= Math.max(2, Math.min(l.h, it.h) * 0.4)) l.its.push(it); else ls.push({ y: it.y, h: it.h, its: [it] });
      }
      texto += ls.map(l => l.its.sort((a, b) => a.x - b.x).reduce((s, it, i, a) => s + (i && it.x - (a[i - 1].x + a[i - 1].w) > it.h * 1.2 ? '   ' : i ? ' ' : '') + it.s, '')).join('\n') + '\n';
    }
    if (texto.replace(/\s+/g, '').length >= 60) {
      const r = { fonte: 'pdf', ...doTexto(texto) };
      if (r.chave || r.data) return r;
    }
    // PDF escaneado (só imagem): lê como foto a primeira página
    const pg = await doc.getPage(1), vp0 = pg.getViewport({ scale: 1 }), esc = Math.min(4, 2400 / Math.max(vp0.width, vp0.height));
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
    const r = { fonte: 'xml' };
    const inf = tag('infNFe'), cfe = tag('infCFe');
    const raiz = inf || cfe;
    if (raiz) {
      const c = digitos(raiz.getAttribute('Id')) || digitos(val('chNFe'));
      if (/^\d{44}$/.test(c)) r.chave = c;
      const ide = tag('ide', raiz), emit = tag('emit', raiz);
      if (ide) {
        r.numero = String(+(val('nNF', ide) || val('nCFe', ide)) || '') || undefined;
        const dt = val('dhEmi', ide) || val('dEmi', ide);
        if (/^\d{4}-\d\d-\d\d/.test(dt)) r.data = dt.slice(0, 10); else if (/^\d{8}$/.test(dt)) r.data = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
      }
      if (emit) { r.fornecedor = val('xNome', emit) || val('xFant', emit) || undefined; r.cnpj = val('CNPJ', emit) || undefined; }
      const v = +(val('vNF') || val('vCFe')); if (v > 0) r.valor = v;
      return r;
    }
    // NFS-e (padrão nacional e municipais mais comuns): campos genéricos
    const emit = tag('emit') || tag('PrestadorServico') || tag('Prestador') || tag('prest');
    if (emit) { r.fornecedor = val('xNome', emit) || val('RazaoSocial', emit) || undefined; r.cnpj = digitos(val('CNPJ', emit) || val('Cnpj', emit)) || undefined; }
    r.numero = String(+(val('nNFSe') || val('Numero')) || '') || undefined;
    const dt = val('dhEmi') || val('DataEmissao') || val('dhProc');
    if (/^\d{4}-\d\d-\d\d/.test(dt)) r.data = dt.slice(0, 10);
    const v = +(val('vLiq') || val('ValorServicos') || val('vServ')); if (v > 0) r.valor = v;
    return r;
  }

  /* ---------- entrada principal ---------- */
  async function ler(arquivo, prog) {
    const nome = (arquivo.name || '').toLowerCase(), tipo = arquivo.type || '';
    const cab = new Uint8Array(await arquivo.slice(0, 64).arrayBuffer());
    const ini = String.fromCharCode(...cab).replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
    let r;
    if (/xml/.test(tipo) || nome.endsWith('.xml') || ini.startsWith('<')) r = doXml(await arquivo.text());
    else if (tipo === 'application/pdf' || nome.endsWith('.pdf') || ini.startsWith('%PDF')) r = await doPdf(await arquivo.arrayBuffer(), prog);
    else {
      let bmp;
      try { bmp = await createImageBitmap(arquivo); } catch { throw Object.assign(new Error('Não deu para abrir a imagem'), { code: 'imagem' }); }
      try { r = await doImagem(bmp, prog); } finally { bmp.close?.(); }
    }
    // a chave manda: CNPJ e número saem dela
    const ch = info(r.chave);
    if (ch) { r.cnpj = ch.cnpj; r.numero = ch.numero; r.serie = ch.serie; r.modelo = ch.modelo; }
    else { r.chave = undefined; if (!r.numero && r.numeroTexto) r.numero = r.numeroTexto; if (!r.cnpj && r.cnpjTexto) r.cnpj = r.cnpjTexto; }
    if (r.cnpj && !cnpjOk(r.cnpj)) r.cnpj = undefined;
    return r;
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

  window.NotaFiscal = { ler, nomeCnpj, preparar, info, formatarChave, chaveValida, cnpjOk, digitos, _doTexto: doTexto, _doCodigo: doCodigo, _doXml: doXml };
})();
