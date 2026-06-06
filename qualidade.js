/* Sonda de qualidade dos pares — TP Engenharia de Software II.
   App estatico. Anota uma amostra de 50 pares (10 por smell) before->after para
   medir a PRECISAO DA CLASSE POSITIVA (que fracao dos pares "REAL" do Gemma sao
   refatoracoes genuinas, com comportamento preservado) e CALIBRAR o proxy AST.

   Cego a flag: o campo ast_pattern_match e REMOVIDO de cada par no carregamento
   (nao entra na memoria nem no DOM). So o scorer (score_qualidade.py) le a flag,
   direto do arquivo original. Se a flag vazar para o anotador, a calibracao vira
   circular e a sonda perde o sentido.

   Le/grava no repositorio PRIVADO tp-es2-dataset via API + token pessoal, igual
   ao anotador de smells. Estado de sync, merge de conflito e cache local
   espelham app.js de proposito (duplicacao aceita: nao refatorar o app em uso). */
'use strict';

/* ===== configuracao ===== */
const REPO = 'Gronoxx/tp-es2-dataset';
const API = 'https://api.github.com';
const ARQ_AMOSTRA = 'positive_quality_sample.json';   // no repo privado (raiz)
const ARQ_DEMO = 'positive_quality_sample.example.json'; // local, neste repo
const PESQUISADORES = ['Gustavo', 'Felipe'];           // ambos anotam TODOS os pares (-> kappa)
const VERSAO = 'q1';

const VEREDITOS = [
  { v: 'genuina', k: '1', cls: 'v-real', rot: 'Genuína',
    desc: 'before tem o smell · after resolve · comportamento preservado' },
  { v: 'lixo', k: '2', cls: 'v-aparente', rot: 'Lixo',
    desc: 'falha em algum critério — não é alvo de treino' },
  { v: 'incerto', k: '3', cls: 'v-incerto', rot: 'Incerto',
    desc: 'não dá pra decidir só pelo diff / precisa discussão' },
];
// criterio que falhou (so quando veredito = lixo)
const CRITERIOS = [
  { v: 'before_sem_smell', rot: 'O before não tinha o smell' },
  { v: 'after_nao_resolve', rot: 'O after não resolve/reduz o smell' },
  { v: 'muda_comportamento', rot: 'Muda comportamento (lógica, função +/-, referência quebrada)' },
  { v: 'outro', rot: 'Outro — ver justificativa' },
];
const SNIPPET = [
  { v: 'sim', rot: 'Sim, a refatoração inteira está visível' },
  { v: 'nao', rot: 'Não, o snippet cortou (constante/desaninhamento fora da função)' },
];
const SMELLS_SNIPPET = new Set(['R3', 'R4']); // pergunta extra de completude

/* ===== estado ===== */
let nome = null, token = null, demo = false;
let PARES = null, meus = [], anot = {}, idx = 0;
let shaAnot = null;
let sincronizando = false, precisaSync = false, syncTimer = null;
let miniAberto = false;

/* ===== helpers ===== */
const $ = (s) => document.querySelector(s);
const agora = () => new Date().toISOString();
const kTok = (n) => `anotador.tok.${n}`;            // mesmo token do anotador de smells
const kCache = (n) => `qualidade.${VERSAO}.${n}`;
const caminhoAnot = (n) => `qualidade/qualidade_${n.toLowerCase()}.json`;

function escapar(s) {
  return String(s).replace(/[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function lerToken(n) { return localStorage.getItem(kTok(n)) || null; }
function lerCache(n) {
  try { return JSON.parse(localStorage.getItem(kCache(n))) || {}; }
  catch (_) { return {}; }
}
function salvarCache() {
  if (demo) return;
  try {
    localStorage.setItem(kCache(nome), JSON.stringify(
      { anotacoes: anot, shaAnot: shaAnot, idx: idx, salvoEm: agora() }));
  } catch (_) { /* quota — GitHub e a fonte da verdade */ }
}

/* ===== normalizacao da amostra (UNICO ponto que conhece os nomes de campo) =====
   Quando o positive_quality_sample.json real chegar da outra maquina, adaptar
   AQUI — e so aqui. Tambem e onde a flag do proxy e removida (cego por delecao). */
function normalizeSample(raw) {
  if (!Array.isArray(raw)) {
    if (raw && Array.isArray(raw.pares)) raw = raw.pares;
    else if (raw && Array.isArray(raw.amostra)) raw = raw.amostra;
    else throw new Error('Amostra inesperada: esperava um array de pares.');
  }
  return raw.map((d, i) => {
    const pick = (...ks) => { for (const k of ks) if (d[k] != null) return d[k]; return undefined; };
    const par = {
      id: String(pick('id', 'pair_id', '_id') != null ? pick('id', 'pair_id', '_id') : `par_${i}`),
      smell: String(pick('smell', 'smell_type', 'smell_code') || '?').toUpperCase(),
      before: String(pick('before', 'before_code', 'antes', 'codigo_antes') || ''),
      after: String(pick('after', 'after_code', 'depois', 'codigo_depois') || ''),
      meta: {
        repo: pick('repo', 'repository'),
        file: pick('file', 'path', 'arquivo'),
        function_name: pick('function_name', 'node_name', 'funcao'),
        commit_hash: pick('commit_hash', 'commit', 'sha'),
        source: pick('source', 'provenance'),
        link: pick('link', 'url'),
      },
    };
    // CEGO POR DELECAO: a flag do proxy nunca entra no objeto anotado.
    // (Permanece no arquivo original — o scorer a le de la para o join.)
    return par;
  });
}

/* ===== modelo de anotacao ===== */
function precisaSnippet(par) { return SMELLS_SNIPPET.has(par.smell); }
function completo(par, a) {
  if (!a || !a.veredito) return false;
  if (a.veredito === 'lixo' && !a.criterio) return false;
  if ((a.veredito === 'lixo' || a.veredito === 'incerto')
      && !(a.justificativa || '').trim()) return false;
  if (precisaSnippet(par) && !a.snippet_completo) return false;
  return true;
}
function estado(par, a) {
  if (completo(par, a)) return 'completo';
  if (a && a.veredito) return 'parcial';
  return 'vazio';
}
function mesclar(a, b) {
  const out = Object.assign({}, a);
  for (const id in b) {
    if (!out[id] || (b[id].ts || '') >= (out[id].ts || '')) out[id] = b[id];
  }
  return out;
}

/* ===== cliente GitHub (espelha app.js) ===== */
async function ghFetch(caminho, opts) {
  opts = opts || {};
  return fetch(API + caminho, {
    method: opts.method || 'GET',
    headers: Object.assign({
      'Authorization': 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'Accept': opts.accept || 'application/vnd.github+json',
    }, opts.headers || {}),
    body: opts.body,
  });
}
async function ghValidar() {
  let r;
  try { r = await ghFetch(`/repos/${REPO}`); }
  catch (_) { throw new Error('Sem conexao com o GitHub. Verifique a internet.'); }
  if (r.status === 401) throw new Error('Token invalido ou expirado.');
  if (r.status === 403) throw new Error('Token sem permissao — precisa do escopo "repo".');
  if (r.status === 404) throw new Error('Sem acesso ao repositorio. Peca ao Gustavo '
    + 'para te adicionar como colaborador de tp-es2-dataset.');
  if (!r.ok) throw new Error('Erro ' + r.status + ' ao acessar o GitHub.');
}
async function ghGetRaw(caminho) {
  const r = await ghFetch(`/repos/${REPO}/contents/${caminho}`,
    { accept: 'application/vnd.github.raw' });
  if (r.status === 404) throw new Error(`A amostra "${caminho}" ainda nao existe `
    + `no repo privado. Recupere/gere positive_quality_sample.json primeiro.`);
  if (!r.ok) throw new Error(`Falha ao baixar ${caminho} (${r.status}).`);
  return r.text();
}
async function ghGetAnot(n) {
  const r = await ghFetch(`/repos/${REPO}/contents/${caminhoAnot(n)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Falha ao ler anotacoes (${r.status}).`);
  const j = await r.json();
  const txt = decodeURIComponent(escape(atob((j.content || '').replace(/\s/g, ''))));
  return { obj: JSON.parse(txt), sha: j.sha };
}
function corpoAnot() {
  return {
    pesquisador: nome, versao: VERSAO, tarefa: 'sonda-qualidade-pares',
    atualizadoEm: agora(), totalPares: meus.length,
    completos: meus.filter((p) => completo(p, anot[p.id])).length,
    idx: idx, anotacoes: anot,
  };
}
async function ghPutAnot() {
  const enviar = async (sha) => {
    const c = corpoAnot();
    const txt = JSON.stringify(c, null, 1);
    const body = {
      message: `qualidade ${nome} (${c.completos}/${c.totalPares})`,
      content: btoa(unescape(encodeURIComponent(txt))), branch: 'main',
    };
    if (sha) body.sha = sha;
    return ghFetch(`/repos/${REPO}/contents/${caminhoAnot(nome)}`,
      { method: 'PUT', body: JSON.stringify(body) });
  };
  let r = await enviar(shaAnot);
  if (r.status === 409 || r.status === 422) {
    const remoto = await ghGetAnot(nome);
    anot = mesclar(anot, (remoto && remoto.obj.anotacoes) || {});
    shaAnot = remoto ? remoto.sha : null;
    salvarCache();
    r = await enviar(shaAnot);
  }
  if (!r.ok) throw new Error('PUT ' + r.status);
  shaAnot = (await r.json()).content.sha;
}

/* ===== sincronizacao ===== */
function statusSync(s) {
  const mapa = {
    ok: ['ok', '● sincronizado'], ativo: ['ativo', '⟳ sincronizando'],
    pendente: ['ativo', '⟳ pendente'], erro: ['erro', '⚠ erro — clique p/ tentar'],
    demo: ['ativo', '◐ demo (sem gravar)'],
  };
  const [cls, txt] = mapa[s] || mapa.ok;
  const el = $('#sync');
  el.className = 'sync ' + cls;
  el.textContent = txt;
}
function agendarSync() {
  if (demo) return;
  precisaSync = true;
  statusSync('pendente');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sincronizar, 3000);
}
async function sincronizar() {
  if (demo || sincronizando || !precisaSync) return;
  sincronizando = true; precisaSync = false;
  statusSync('ativo');
  try {
    await ghPutAnot();
    statusSync(precisaSync ? 'pendente' : 'ok');
  } catch (_) {
    precisaSync = true; statusSync('erro');
  }
  sincronizando = false;
  if (precisaSync) { clearTimeout(syncTimer); syncTimer = setTimeout(sincronizar, 5000); }
}

/* ===== overlay ===== */
function mostrarOverlay(msg) { $('#overlayMsg').textContent = msg; $('#overlay').style.display = 'flex'; }
function esconderOverlay() { $('#overlay').style.display = 'none'; }

/* ===== tela de selecao ===== */
function montarInicio() {
  const cont = $('#cartoes');
  cont.innerHTML = '';
  PESQUISADORES.forEach((n) => {
    const temTok = !!lerToken(n);
    const c = document.createElement('div');
    c.className = 'cartao-pesq';
    c.innerHTML = `
      <div class="nome">${n}</div>
      <div class="det">50 pares · anotação cega</div>
      <div class="blocos">precisão + κ + proxy</div>
      <div class="tok-ok" style="display:${temTok ? 'block' : 'none'}">
        &#10003; token salvo &middot; <a class="tok-trocar">trocar</a></div>`;
    c.onclick = () => escolherNome(n);
    const tr = c.querySelector('.tok-trocar');
    if (tr) tr.onclick = (ev) => { ev.stopPropagation(); mostrarTelaToken(n); };
    cont.appendChild(c);
  });
  // botao discreto de demonstracao (carrega o fixture local, sem token)
  const d = document.createElement('div');
  d.className = 'cartao-pesq';
  d.style.opacity = '.7';
  d.innerHTML = `<div class="nome">Ver demonstração</div>
    <div class="det">amostra de exemplo, sem gravar</div>
    <div class="blocos">testar a interface</div>`;
  d.onclick = () => entrarDemo();
  cont.appendChild(d);
}
function escolherNome(n) {
  const t = lerToken(n);
  if (t) { token = t; entrar(n); } else { mostrarTelaToken(n); }
}
function mostrarTelaToken(n) {
  $('#telaInicio').style.display = 'none';
  $('#app').classList.remove('ativo');
  $('#telaToken').style.display = '';
  $('#tokNome').textContent = n;
  $('#tokNome').dataset.nome = n;
  $('#inpToken').value = lerToken(n) || '';
  $('#erroToken').textContent = '';
  $('#inpToken').focus();
}

/* ===== entrada ===== */
async function entrar(n) {
  nome = n; demo = false;
  token = lerToken(n);
  mostrarOverlay('Conectando ao GitHub…');
  try {
    await ghValidar();
    if (!PARES) {
      mostrarOverlay('Baixando a amostra…');
      PARES = normalizeSample(JSON.parse(await ghGetRaw(ARQ_AMOSTRA)));
    }
    meus = PARES;
    mostrarOverlay('Carregando suas anotacoes…');
    const remoto = await ghGetAnot(n);
    const cache = lerCache(n);
    const remotoAnot = (remoto && remoto.obj.anotacoes) || {};
    if (remoto) {
      anot = mesclar(cache.anotacoes || {}, remotoAnot);
      shaAnot = remoto.sha;
      idx = (remoto.obj.idx != null) ? remoto.obj.idx : 0;
    } else {
      anot = cache.anotacoes || {}; shaAnot = null; idx = cache.idx || 0;
    }
    const haPendencia = JSON.stringify(anot) !== JSON.stringify(remotoAnot);
    salvarCache();
    abrirApp(n);
    posicionar();
    montarMinimapa(); render(); esconderOverlay();
    if (haPendencia) agendarSync(); else statusSync('ok');
  } catch (e) {
    esconderOverlay();
    mostrarTelaToken(n);
    $('#erroToken').textContent = e.message || String(e);
  }
}
async function entrarDemo() {
  demo = true; nome = 'demo'; token = null;
  mostrarOverlay('Carregando amostra de exemplo…');
  try {
    const r = await fetch(ARQ_DEMO);
    if (!r.ok) throw new Error('Nao achei ' + ARQ_DEMO);
    PARES = normalizeSample(await r.json());
    meus = PARES; anot = {}; idx = 0;
    abrirApp('demonstração');
    $('#demoAviso').style.display = '';
    statusSync('demo');
    posicionar(); montarMinimapa(); render(); esconderOverlay();
  } catch (e) {
    esconderOverlay(); $('#telaInicio').style.display = '';
    toast(e.message || String(e));
  }
}
function posicionar() {
  idx = Math.min(Math.max(idx, 0), meus.length - 1);
  if (estado(meus[idx], anot[meus[idx].id]) === 'completo') {
    const v = meus.findIndex((p) => estado(p, anot[p.id]) !== 'completo');
    if (v >= 0) idx = v;
  }
}
function abrirApp(rotuloNome) {
  $('#telaInicio').style.display = 'none';
  $('#telaToken').style.display = 'none';
  $('#app').classList.add('ativo');
  $('#hdNome').textContent = rotuloNome;
  $('#posTotal').textContent = meus.length;
  $('#inpIr').max = meus.length;
  $('#dicaSalvo').textContent = demo
    ? 'modo demonstração — nada é gravado'
    : 'sincronizado no repositorio privado do GitHub';
}

/* ===== render ===== */
function idAtual() { return meus[idx].id; }
function render() {
  const p = meus[idx];
  renderMeta(p);
  renderCodigo('#codigoA', '#gutterA', p.before);
  renderCodigo('#codigoD', '#gutterD', p.after);
  renderPainel(p);
  $('#inpIr').value = idx + 1;
  atualizarProgresso(); renderEstado(); marcarCelAtual();
  $('#btnPrev').disabled = idx === 0;
  $('#btnNext').disabled = idx === meus.length - 1;
}
function renderMeta(p) {
  const m = p.meta || {};
  const alvo = [m.repo, m.file].filter(Boolean).join(' / ');
  const fn = m.function_name ? `&nbsp;::&nbsp;<b>${escapar(m.function_name)}</b>` : '';
  const link = m.link ? `&nbsp;&middot;&nbsp;<a href="${escapar(m.link)}" target="_blank" rel="noopener">ver no GitHub &#8599;</a>` : '';
  $('#meta').innerHTML = `
    <div class="meta-linha1">
      <span class="badge">${escapar(p.smell)}</span>
      ${m.source ? `<span class="chip">fonte: <b>${escapar(m.source)}</b></span>` : ''}
    </div>
    ${alvo ? `<div class="alvo"><b>${escapar(alvo)}</b>${fn}${link}</div>` : ''}`;
}
function renderCodigo(selCode, selGutter, code) {
  code = code || '';
  const linhas = code.split('\n');
  $(selGutter).textContent = linhas.map((_, i) => i + 1).join('\n');
  const cod = $(selCode);
  let html;
  try {
    html = window.hljs ? hljs.highlight(code, { language: 'python' }).value : escapar(code);
  } catch (_) { html = escapar(code); }
  cod.innerHTML = html;
  const wrap = cod.parentElement.parentElement;
  wrap.scrollTop = 0; wrap.scrollLeft = 0;
}
function opcaoHTML(campo, valor, rot, sel, opts) {
  opts = opts || {};
  const cls = (opts.cls || 'generico') + (opts.bloco ? ' linha-c' : '');
  return `<div class="opc ${cls}" data-campo="${campo}" data-valor="${valor}"
    data-sel="${sel ? 1 : 0}">
    ${opts.k ? '<span class="k">' + opts.k + '</span>' : ''}
    <span><b>${rot}</b>${opts.desc ? '<br><span class="desc">' + opts.desc + '</span>' : ''}</span>
  </div>`;
}
function renderPainel(p) {
  const a = anot[p.id] || {};
  const reqJust = a.veredito === 'lixo' || a.veredito === 'incerto';
  const vered = VEREDITOS.map((o) => opcaoHTML('veredito', o.v, o.rot,
    a.veredito === o.v, { k: o.k, cls: o.cls, desc: o.desc, bloco: 1 })).join('');
  const crit = CRITERIOS.map((o) => opcaoHTML('criterio', o.v, o.rot,
    a.criterio === o.v, { bloco: 1 })).join('');
  const snip = SNIPPET.map((o) => opcaoHTML('snippet_completo', o.v, o.rot,
    a.snippet_completo === o.v, { bloco: 1 })).join('');

  $('#painel').innerHTML = `
    <div class="pergunta">Par <b>${escapar(p.smell)}</b>. É uma refatoração
      <b>genuína</b>? (before tem o smell · after resolve · comportamento preservado)</div>
    <div class="secao-rot">veredicto <span class="obrig">*</span>
      <span class="tecla">teclas 1 / 2 / 3</span></div>
    <div class="opcoes">${vered}</div>
    <div class="condicional crit-falho ${a.veredito === 'lixo' ? 'visivel' : ''}">
      <div class="secao-rot">qual critério falhou? <span class="obrig">*</span></div>
      <div class="opcoes">${crit}</div>
    </div>
    ${precisaSnippet(p) ? `
    <div class="secao-rot">o <i>after</i> contém a refatoração inteira?
      <span class="obrig">*</span>
      <span class="tecla">específico de ${escapar(p.smell)}</span></div>
    <div class="opcoes">${snip}</div>` : ''}
    <div class="secao-rot">justificativa
      ${reqJust ? '<span class="obrig">*</span>'
                : '<span class="tecla">opcional p/ genuína</span>'}</div>
    <textarea id="txtJust" placeholder="O que no diff sustenta o veredicto?">${escapar(a.justificativa || '')}</textarea>`;

  const tx = $('#txtJust');
  if (reqJust && !(a.justificativa || '').trim()) tx.classList.add('faltando');
  tx.addEventListener('input', () => {
    setCampo(p.id, 'justificativa', tx.value, true);
    tx.classList.remove('faltando');
  });
}

/* ===== alteracao de campo ===== */
function setCampo(id, campo, valor, semRerender) {
  const a = anot[id] || (anot[id] = {});
  a[campo] = valor;
  if (campo === 'veredito' && valor !== 'lixo') delete a.criterio;
  a.ts = agora();
  salvarCache(); agendarSync();
  if (!semRerender) renderPainel(meus[idx]);
  atualizarProgresso(); renderEstado(); marcarCel(id);
}

/* ===== progresso ===== */
function atualizarProgresso() {
  const feitas = meus.filter((p) => completo(p, anot[p.id])).length;
  const prog = $('#hdProg');
  prog.innerHTML = `<b>${feitas}</b> / ${meus.length}`;
  prog.classList.remove('pulsa'); void prog.offsetWidth; prog.classList.add('pulsa');
  $('#hdBarra').style.width = (100 * feitas / Math.max(1, meus.length)) + '%';
}
function renderEstado() {
  const st = estado(meus[idx], anot[idAtual()]);
  const el = $('#estadoAnot');
  el.className = 'estado-anot ' + st;
  el.textContent = { completo: 'anotado', parcial: 'incompleto', vazio: 'nao anotado' }[st];
}

/* ===== minimapa ===== */
function montarMinimapa() {
  const mm = $('#minimapa');
  mm.innerHTML = '';
  meus.forEach((p, i) => {
    const c = document.createElement('div');
    c.className = 'cel';
    c.title = `#${i + 1} · ${p.smell}`;
    c.onclick = () => ir(i);
    mm.appendChild(c);
  });
  $('#miniCab').onclick = () => {
    miniAberto = !miniAberto;
    mm.classList.toggle('aberto', miniAberto);
    $('#miniResumo').textContent = (miniAberto ? '▾' : '▸') + ' mapa de progresso';
    if (miniAberto) marcarCelAtual();
  };
}
function corCel(par, a) {
  const st = estado(par, a);
  if (st === 'parcial') return 's-parcial';
  if (st !== 'completo') return '';
  return a.veredito === 'genuina' ? 's-real'
       : a.veredito === 'lixo' ? 's-aparente' : 's-incerto';
}
function marcarCel(id) {
  const i = meus.findIndex((p) => p.id === id);
  if (i < 0) return;
  const c = $('#minimapa').children[i];
  if (c) c.className = 'cel ' + corCel(meus[i], anot[id]) + (i === idx ? ' atual' : '');
}
function marcarCelAtual() {
  [...$('#minimapa').children].forEach((c, i) => {
    c.className = 'cel ' + corCel(meus[i], anot[meus[i].id]) + (i === idx ? ' atual' : '');
  });
}

/* ===== navegacao ===== */
function ir(novo) {
  idx = Math.max(0, Math.min(meus.length - 1, novo));
  salvarCache(); render();
  const p = $('#painel');
  p.classList.remove('fade'); void p.offsetWidth; p.classList.add('fade');
}
function proximoVazio() {
  for (let n = 1; n <= meus.length; n++) {
    const j = (idx + n) % meus.length;
    if (estado(meus[j], anot[meus[j].id]) !== 'completo') { ir(j); return; }
  }
  toast('Todos os pares estao anotados.');
}

/* ===== backup local ===== */
function exportar() {
  const blob = new Blob([JSON.stringify(corpoAnot(), null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `qualidade_${(nome || 'demo').toLowerCase()}.json`;
  a.click(); URL.revokeObjectURL(url);
  toast(demo ? 'Backup do demo baixado.' : 'Backup local baixado. Ja esta no GitHub.');
}

/* ===== toast ===== */
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('ver');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('ver'), 3200);
}

/* ===== teclado ===== */
document.addEventListener('keydown', (ev) => {
  if (!$('#app').classList.contains('ativo')) return;
  const noTexto = ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT';
  if (ev.key === 'Escape' && noTexto) { ev.target.blur(); return; }
  if (noTexto) return;
  if (ev.key === '1' || ev.key === '2' || ev.key === '3') {
    setCampo(idAtual(), 'veredito', VEREDITOS[+ev.key - 1].v);
  } else if (ev.key === 'ArrowLeft') { ir(idx - 1); }
  else if (ev.key === 'ArrowRight') { ir(idx + 1); }
  else if (ev.key === 'n' || ev.key === 'N') { proximoVazio(); }
});

/* ===== ligacoes ===== */
function ligar() {
  $('#painel').addEventListener('click', (ev) => {
    const o = ev.target.closest('.opc');
    if (o) setCampo(idAtual(), o.dataset.campo, o.dataset.valor);
  });
  $('#btnPrev').onclick = () => ir(idx - 1);
  $('#btnNext').onclick = () => ir(idx + 1);
  $('#btnProxVazio').onclick = proximoVazio;
  $('#btnExport').onclick = exportar;
  $('#btnTrocar').onclick = () => {
    salvarCache();
    if (precisaSync) sincronizar();
    $('#app').classList.remove('ativo');
    $('#demoAviso').style.display = 'none';
    $('#telaToken').style.display = 'none';
    $('#telaInicio').style.display = '';
    demo = false;
    montarInicio();
  };
  $('#inpIr').addEventListener('change', (ev) => {
    const n = parseInt(ev.target.value, 10);
    if (n >= 1 && n <= meus.length) ir(n - 1);
  });
  $('#sync').onclick = () => {
    if ($('#sync').classList.contains('erro')) { precisaSync = true; sincronizar(); }
  };
  $('#btnEntrar').onclick = () => {
    const n = $('#tokNome').dataset.nome;
    const t = $('#inpToken').value.trim();
    if (!t) { $('#erroToken').textContent = 'Cole um token.'; return; }
    localStorage.setItem(kTok(n), t);
    token = t; entrar(n);
  };
  $('#inpToken').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') $('#btnEntrar').click();
  });
  $('#btnVoltarNome').onclick = () => {
    $('#telaToken').style.display = 'none';
    $('#telaInicio').style.display = '';
    montarInicio();
  };
  window.addEventListener('beforeunload', () => { if (nome && !demo) salvarCache(); });
}

/* ===== arranque ===== */
montarInicio();
ligar();
if (new URLSearchParams(location.search).has('demo')) entrarDemo();
