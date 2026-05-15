/* Anotador de smells aparentes — TP Engenharia de Software II.
   App estatico. As anotacoes sao lidas/gravadas num repositorio PRIVADO do
   GitHub (tp-es2-dataset) via API, com o token pessoal de cada revisor —
   sincronizacao automatica, continua de qualquer maquina. */
'use strict';

/* ===== configuracao ===== */
const REPO = 'Gronoxx/tp-es2-dataset';         // repo privado de dados
const API = 'https://api.github.com';
const PESQUISADORES = { Gustavo: [1, 2], Bernardo: [1, 3], Felipe: [2, 3] };
const VERSAO = 'v3';

const VEREDITOS = [
  { v: 'aparente', k: '1', cls: 'v-aparente', rot: 'Aparente',
    desc: 'parece o smell, mas e codigo legitimo — nao refatorar' },
  { v: 'real', k: '2', cls: 'v-real', rot: 'Real',
    desc: 'e mesmo o smell — deveria ser refatorado' },
  { v: 'incerto', k: '3', cls: 'v-incerto', rot: 'Incerto',
    desc: 'nao consigo decidir / precisa discussao no trio' },
];
const CONFIANCAS = [{ v: 'alta', rot: 'Alta' }, { v: 'media', rot: 'Media' },
                    { v: 'baixa', rot: 'Baixa' }];
const CONTEXTOS = [{ v: 'sim', rot: 'Sim, suficiente' },
                   { v: 'nao', rot: 'Nao, faltou contexto' }];
const MOTIVOS = [
  { v: 'pressa', rot: 'Pressa / nao prioritario' },
  { v: 'legado', rot: 'Codigo legado ou de terceiros' },
  { v: 'threshold', rot: 'Discordancia de threshold do detector' },
  { v: 'outro', rot: 'Outro — ver justificativa' },
];

/* ===== estado ===== */
let nome = null, token = null;
let EXEMPLOS = null, meus = [], anot = {}, idx = 0;
let shaAnot = null;                  // sha do arquivo de anotacoes no repo
let sincronizando = false, precisaSync = false, syncTimer = null;
let miniAberto = false;

/* ===== helpers ===== */
const $ = (s) => document.querySelector(s);
const agora = () => new Date().toISOString();
const kTok = (n) => `anotador.tok.${n}`;
const kCache = (n) => `anotador.${VERSAO}.${n}`;
const caminhoAnot = (n) => `anotacoes/anotacoes_${n.toLowerCase()}.json`;

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
  try {
    localStorage.setItem(kCache(nome), JSON.stringify(
      { anotacoes: anot, shaAnot: shaAnot, idx: idx, salvoEm: agora() }));
  } catch (_) { /* quota — ignora, o GitHub e a fonte da verdade */ }
}

/* ===== modelo de anotacao ===== */
function completo(a) {
  if (!a || !a.veredito || !a.confianca || !a.contexto) return false;
  if ((a.veredito === 'real' || a.veredito === 'incerto')
      && !(a.justificativa || '').trim()) return false;
  if (a.veredito === 'real' && !a.motivo) return false;
  return true;
}
function estado(a) {
  if (completo(a)) return 'completo';
  if (a && a.veredito) return 'parcial';
  return 'vazio';
}
function mesclar(a, b) {            // uniao por id, mantem o ts mais recente
  const out = Object.assign({}, a);
  for (const id in b) {
    if (!out[id] || (b[id].ts || '') >= (out[id].ts || '')) out[id] = b[id];
  }
  return out;
}

/* ===== cliente GitHub ===== */
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
  if (!r.ok) throw new Error(`Falha ao baixar ${caminho} (${r.status}).`);
  return r.text();
}
async function ghGetAnot(n) {                       // -> {obj, sha} | null
  const r = await ghFetch(`/repos/${REPO}/contents/${caminhoAnot(n)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Falha ao ler anotacoes (${r.status}).`);
  const j = await r.json();
  const txt = decodeURIComponent(escape(atob((j.content || '').replace(/\s/g, ''))));
  return { obj: JSON.parse(txt), sha: j.sha };
}
function corpoAnot() {
  return {
    pesquisador: nome, versao: VERSAO, atualizadoEm: agora(),
    totalExemplos: meus.length,
    completos: meus.filter((e) => completo(anot[e.id])).length,
    idx: idx, anotacoes: anot,
  };
}
async function ghPutAnot() {
  const enviar = async (sha) => {
    const c = corpoAnot();
    const txt = JSON.stringify(c, null, 1);
    const body = {
      message: `anotacoes ${nome} (${c.completos}/${c.totalExemplos})`,
      content: btoa(unescape(encodeURIComponent(txt))), branch: 'main',
    };
    if (sha) body.sha = sha;
    return ghFetch(`/repos/${REPO}/contents/${caminhoAnot(nome)}`,
      { method: 'PUT', body: JSON.stringify(body) });
  };
  let r = await enviar(shaAnot);
  if (r.status === 409 || r.status === 422) {        // conflito: outra maquina
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
    ok: ['ok', '● sincronizado'],
    ativo: ['ativo', '⟳ sincronizando'],
    pendente: ['ativo', '⟳ pendente'],
    erro: ['erro', '⚠ erro — clique p/ tentar'],
  };
  const [cls, txt] = mapa[s] || mapa.ok;
  const el = $('#sync');
  el.className = 'sync ' + cls;
  el.textContent = txt;
}
function agendarSync() {
  precisaSync = true;
  statusSync('pendente');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sincronizar, 3000);
}
async function sincronizar() {
  if (sincronizando || !precisaSync) return;
  sincronizando = true; precisaSync = false;
  statusSync('ativo');
  try {
    await ghPutAnot();
    statusSync(precisaSync ? 'pendente' : 'ok');
  } catch (_) {
    precisaSync = true;
    statusSync('erro');
  }
  sincronizando = false;
  if (precisaSync) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sincronizar, 5000);
  }
}

/* ===== overlay ===== */
function mostrarOverlay(msg) {
  $('#overlayMsg').textContent = msg;
  $('#overlay').style.display = 'flex';
}
function esconderOverlay() { $('#overlay').style.display = 'none'; }

/* ===== tela de selecao de nome ===== */
function montarInicio() {
  const cont = $('#cartoes');
  cont.innerHTML = '';
  Object.entries(PESQUISADORES).forEach(([n, blocos]) => {
    const temTok = !!lerToken(n);
    const c = document.createElement('div');
    c.className = 'cartao-pesq';
    c.innerHTML = `
      <div class="nome">${n}</div>
      <div class="det">~900 exemplos a anotar</div>
      <div class="blocos">blocos ${blocos.join(' + ')}</div>
      <div class="tok-ok" style="display:${temTok ? 'block' : 'none'}">
        &#10003; token salvo &middot; <a class="tok-trocar">trocar</a></div>`;
    c.onclick = () => escolherNome(n);
    const tr = c.querySelector('.tok-trocar');
    if (tr) tr.onclick = (ev) => { ev.stopPropagation(); mostrarTelaToken(n); };
    cont.appendChild(c);
  });
}
function escolherNome(n) {
  const t = lerToken(n);
  if (t) { token = t; entrar(n); }
  else { mostrarTelaToken(n); }
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

/* ===== entrada na sessao ===== */
async function entrar(n) {
  nome = n;
  token = lerToken(n);
  mostrarOverlay('Conectando ao GitHub…');
  try {
    await ghValidar();
    if (!EXEMPLOS) {
      mostrarOverlay('Baixando exemplos (~6 MB)…');
      EXEMPLOS = JSON.parse(await ghGetRaw('examples.json'));
    }
    meus = EXEMPLOS.filter((e) => PESQUISADORES[n].includes(e.bloco));

    mostrarOverlay('Carregando suas anotacoes…');
    const remoto = await ghGetAnot(n);
    const cache = lerCache(n);
    const remotoAnot = (remoto && remoto.obj.anotacoes) || {};
    if (remoto) {
      anot = mesclar(cache.anotacoes || {}, remotoAnot);
      shaAnot = remoto.sha;
      idx = (remoto.obj.idx != null) ? remoto.obj.idx : 0;
    } else {
      anot = cache.anotacoes || {};
      shaAnot = null;
      idx = cache.idx || 0;
    }
    const haPendencia = JSON.stringify(anot) !== JSON.stringify(remotoAnot);
    salvarCache();

    abrirApp(n);
    idx = Math.min(Math.max(idx, 0), meus.length - 1);
    if (estado(anot[meus[idx].id]) === 'completo') {
      const v = meus.findIndex((e) => estado(anot[e.id]) !== 'completo');
      if (v >= 0) idx = v;
    }
    montarMinimapa();
    render();
    esconderOverlay();
    if (haPendencia) agendarSync(); else statusSync('ok');
  } catch (e) {
    esconderOverlay();
    mostrarTelaToken(n);
    $('#erroToken').textContent = e.message || String(e);
  }
}
function abrirApp(n) {
  $('#telaInicio').style.display = 'none';
  $('#telaToken').style.display = 'none';
  $('#app').classList.add('ativo');
  $('#hdNome').textContent = n;
  $('#hdBloco').textContent = 'blocos ' + PESQUISADORES[n].join(' + ');
  $('#posTotal').textContent = meus.length;
  $('#inpIr').max = meus.length;
  $('#dicaSalvo').textContent = 'sincronizado no repositorio privado do GitHub';
}

/* ===== render principal ===== */
function render() {
  const e = meus[idx];
  renderMeta(e);
  renderCodigo(e);
  renderPainel(e);
  $('#inpIr').value = idx + 1;
  atualizarProgresso();
  renderEstado();
  marcarCelAtual();
  $('#btnPrev').disabled = idx === 0;
  $('#btnNext').disabled = idx === meus.length - 1;
}

function renderMeta(e) {
  const m = e.metrics || {};
  const chips = [];
  if (m.n_lines != null) chips.push(`<span class="chip">linhas <b>${m.n_lines}</b></span>`);
  if (m.n_statements != null) chips.push(`<span class="chip">stmts <b>${m.n_statements}</b></span>`);
  if (m.max_nesting != null) chips.push(`<span class="chip">nest <b>${m.max_nesting}</b></span>`);
  if (m.n_params != null) chips.push(`<span class="chip">params <b>${m.n_params}</b></span>`);

  let sinal;
  if (e.suppression) {
    sinal = `<span class="rot">sinal &middot; supressao do desenvolvedor</span>
      Um desenvolvedor suprimiu explicitamente o aviso do linter:
      <code>${escapar(e.suppression)}</code>`;
  } else if (e.magic_values && e.magic_values.length) {
    sinal = `<span class="rot">sinal &middot; literal de protocolo</span>
      O codigo compara contra <code>${escapar(e.magic_values.join(', '))}</code>
      (categoria: ${escapar((e.magic_categories || []).join(', '))}).
      Um detector marcaria como magic number.`;
  } else {
    sinal = `<span class="rot">sinal</span> exemplo sinalizado por detector.`;
  }

  let avisoEscopo = '';
  if (e.label_scope === 'argument') {
    avisoEscopo = `<div class="aviso-escopo">&#9888; julgamento sobre o ARGUMENTO
      suprimido, nao a funcao inteira</div>`;
  } else if (e.label_scope === 'line') {
    avisoEscopo = `<div class="aviso-escopo">&#9888; julgamento sobre a LINHA
      suprimida, nao a funcao inteira</div>`;
  }

  const proxyBadge = e.proxy === 'fraco'
    ? `<span class="badge proxy-fraco">proxy fraco</span>` : '';
  const origem = e.proxy_origin === 'curator' ? 'curador' : 'desenvolvedor';

  $('#meta').innerHTML = `
    <div class="meta-linha1">
      <span class="badge">${escapar(e.smell)}</span>
      <span class="badge escopo">${escapar(e.label_scope || '?')}</span>
      ${proxyBadge}
      <span class="chip">origem do rotulo: <b>${origem}</b></span>
      ${chips.join('')}
    </div>
    <div class="alvo"><b>${escapar(e.repo)}</b> / ${escapar(e.path)}
      ${e.node_name ? '&nbsp;::&nbsp;<b>' + escapar(e.node_name) + '</b>' : ''}
      &nbsp;&middot;&nbsp;<a href="${escapar(e.link)}" target="_blank" rel="noopener">ver no GitHub &#8599;</a>
    </div>
    <div class="sinal">${sinal}</div>
    ${avisoEscopo}`;
}

function renderCodigo(e) {
  const code = e.code || '';
  const linhas = code.split('\n');
  const inicio = e.node_lineno || 1;
  $('#gutter').textContent = linhas.map((_, i) => inicio + i).join('\n');
  const cod = $('#codigo');
  let html;
  try {
    html = window.hljs ? hljs.highlight(code, { language: 'python' }).value
                        : escapar(code);
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

function renderPainel(e) {
  const a = anot[e.id] || {};
  const reqJust = a.veredito === 'real' || a.veredito === 'incerto';
  const vered = VEREDITOS.map((o) => opcaoHTML('veredito', o.v, o.rot,
    a.veredito === o.v, { k: o.k, cls: o.cls, desc: o.desc, bloco: 1 })).join('');
  const conf = CONFIANCAS.map((o) => opcaoHTML('confianca', o.v, o.rot,
    a.confianca === o.v, {})).join('');
  const ctx = CONTEXTOS.map((o) => opcaoHTML('contexto', o.v, o.rot,
    a.contexto === o.v, { bloco: 1 })).join('');
  const mot = MOTIVOS.map((o) => opcaoHTML('motivo', o.v, o.rot,
    a.motivo === o.v, { bloco: 1 })).join('');

  $('#painel').innerHTML = `
    <div class="pergunta">Sinalizado como <b>${escapar(e.smell)}</b>.
      E um smell real ou aparente?</div>
    <div class="secao-rot">veredicto <span class="obrig">*</span>
      <span class="tecla">teclas 1 / 2 / 3</span></div>
    <div class="opcoes">${vered}</div>
    <div class="secao-rot">confianca no veredicto <span class="obrig">*</span></div>
    <div class="opcoes linha">${conf}</div>
    <div class="secao-rot">o contexto visivel foi suficiente? <span class="obrig">*</span></div>
    <div class="opcoes">${ctx}</div>
    <div class="secao-rot">justificativa
      ${reqJust ? '<span class="obrig">*</span>'
                : '<span class="tecla">opcional p/ aparente</span>'}</div>
    <textarea id="txtJust" placeholder="Por que? O que no codigo (ou no contexto) sustenta o veredicto?">${escapar(a.justificativa || '')}</textarea>
    <div class="condicional ${a.veredito === 'real' ? 'visivel' : ''}">
      <div class="secao-rot">se e smell real, por que estava sinalizado/suprimido?
        <span class="obrig">*</span></div>
      <div class="opcoes">${mot}</div>
    </div>`;

  const tx = $('#txtJust');
  if (reqJust && !(a.justificativa || '').trim()) tx.classList.add('faltando');
  tx.addEventListener('input', () => {
    setCampo(e.id, 'justificativa', tx.value, true);
    tx.classList.remove('faltando');
  });
}

/* ===== alteracao de campo ===== */
function setCampo(id, campo, valor, semRerender) {
  const a = anot[id] || (anot[id] = {});
  a[campo] = valor;
  a.ts = agora();
  salvarCache();
  agendarSync();
  if (!semRerender) renderPainel(meus[idx]);
  atualizarProgresso();
  renderEstado();
  marcarCel(id);
}

/* ===== progresso ===== */
function atualizarProgresso() {
  const feitas = meus.filter((e) => completo(anot[e.id])).length;
  const prog = $('#hdProg');
  prog.innerHTML = `<b>${feitas}</b> / ${meus.length}`;
  prog.classList.remove('pulsa'); void prog.offsetWidth; prog.classList.add('pulsa');
  $('#hdBarra').style.width = (100 * feitas / meus.length) + '%';
}
function renderEstado() {
  const st = estado(anot[idAtual()]);
  const el = $('#estadoAnot');
  el.className = 'estado-anot ' + st;
  el.textContent = { completo: 'anotado', parcial: 'incompleto', vazio: 'nao anotado' }[st];
}

/* ===== minimapa ===== */
function montarMinimapa() {
  const mm = $('#minimapa');
  mm.innerHTML = '';
  meus.forEach((e, i) => {
    const c = document.createElement('div');
    c.className = 'cel';
    c.title = `#${i + 1} · ${e.smell}`;
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
function corCel(a) {
  const st = estado(a);
  if (st === 'parcial') return 's-parcial';
  if (st !== 'completo') return '';
  return 's-' + a.veredito;
}
function marcarCel(id) {
  const i = meus.findIndex((e) => e.id === id);
  if (i < 0) return;
  const c = $('#minimapa').children[i];
  if (c) c.className = 'cel ' + corCel(anot[id]) + (i === idx ? ' atual' : '');
}
function marcarCelAtual() {
  [...$('#minimapa').children].forEach((c, i) => {
    c.className = 'cel ' + corCel(anot[meus[i].id]) + (i === idx ? ' atual' : '');
  });
}

/* ===== navegacao ===== */
function idAtual() { return meus[idx].id; }
function ir(novo) {
  idx = Math.max(0, Math.min(meus.length - 1, novo));
  salvarCache();
  render();
  const p = $('#painel');
  p.classList.remove('fade'); void p.offsetWidth; p.classList.add('fade');
}
function proximoVazio() {
  for (let n = 1; n <= meus.length; n++) {
    const j = (idx + n) % meus.length;
    if (estado(anot[meus[j].id]) !== 'completo') { ir(j); return; }
  }
  toast('Todos os exemplos estao anotados.');
}

/* ===== backup local ===== */
function exportar() {
  const blob = new Blob([JSON.stringify(corpoAnot(), null, 1)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `anotacoes_${nome.toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup local baixado. As anotacoes ja estao no GitHub.');
}

/* ===== toast ===== */
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('ver');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('ver'), 3200);
}

/* ===== teclado ===== */
document.addEventListener('keydown', (ev) => {
  if (!nome || !$('#app').classList.contains('ativo')) return;
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
    $('#telaToken').style.display = 'none';
    $('#telaInicio').style.display = '';
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
    token = t;
    entrar(n);
  };
  $('#inpToken').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') $('#btnEntrar').click();
  });
  $('#btnVoltarNome').onclick = () => {
    $('#telaToken').style.display = 'none';
    $('#telaInicio').style.display = '';
    montarInicio();
  };
  window.addEventListener('beforeunload', () => {
    if (nome) salvarCache();
  });
}

/* ===== arranque ===== */
montarInicio();
ligar();
