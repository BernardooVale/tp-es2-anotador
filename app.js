/* Anotador de smells aparentes — TP Engenharia de Software II.
   App estatico, sem backend. Progresso salvo em localStorage; exportacao
   manual em JSON para depois mesclar com mesclar_anotacoes.py. */
'use strict';

/* ---- configuracao: pesquisador -> blocos que ele anota ---- */
const PESQUISADORES = {
  Gustavo:  [1, 2],
  Bernardo: [1, 3],
  Felipe:   [2, 3],
};
const VERSAO = 'v2';

const VEREDITOS = [
  { v: 'aparente', k: '1', cls: 'v-aparente', rot: 'Aparente',
    desc: 'parece o smell, mas e codigo legitimo — nao refatorar' },
  { v: 'real', k: '2', cls: 'v-real', rot: 'Real',
    desc: 'e mesmo o smell — deveria ser refatorado' },
  { v: 'incerto', k: '3', cls: 'v-incerto', rot: 'Incerto',
    desc: 'nao consigo decidir / precisa discussao no trio' },
];
const CONFIANCAS = [
  { v: 'alta', rot: 'Alta' },
  { v: 'media', rot: 'Media' },
  { v: 'baixa', rot: 'Baixa' },
];
const CONTEXTOS = [
  { v: 'sim', rot: 'Sim, suficiente' },
  { v: 'nao', rot: 'Nao, faltou contexto' },
];
const MOTIVOS = [
  { v: 'pressa', rot: 'Pressa / nao prioritario' },
  { v: 'legado', rot: 'Codigo legado ou de terceiros' },
  { v: 'threshold', rot: 'Discordancia de threshold do detector' },
  { v: 'outro', rot: 'Outro — ver justificativa' },
];

/* ---- estado ---- */
let nome = null;
let meus = [];          // exemplos do pesquisador
let anot = {};          // { id: {veredito,confianca,contexto,justificativa,motivo,ts} }
let idx = 0;
let ultimoExport = null;
let miniAberto = false;

/* ---- helpers ---- */
const $ = (s) => document.querySelector(s);
const chave = (n) => `anotador.${VERSAO}.${n}`;
const agora = () => new Date().toISOString();

function escapar(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function carregar(n) {
  try { return JSON.parse(localStorage.getItem(chave(n))) || {}; }
  catch (_) { return {}; }
}
function salvar() {
  localStorage.setItem(chave(nome), JSON.stringify({
    pesquisador: nome, anotacoes: anot, ultimoIdx: idx,
    ultimoExport: ultimoExport, salvoEm: agora(),
  }));
  localStorage.setItem(`anotador.${VERSAO}.ultimoNome`, nome);
}

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

/* ---- tela de selecao ---- */
function montarInicio() {
  const ultimo = localStorage.getItem(`anotador.${VERSAO}.ultimoNome`);
  const cont = $('#cartoes');
  Object.entries(PESQUISADORES).forEach(([n, blocos]) => {
    const dados = carregar(n);
    const feitas = Object.values(dados.anotacoes || {}).filter(completo).length;
    const total = window.EXEMPLOS.filter((e) => blocos.includes(e.bloco)).length;
    const c = document.createElement('div');
    c.className = 'cartao-pesq';
    c.innerHTML = `
      <div class="nome">${n}</div>
      <div class="det">${total} exemplos a anotar</div>
      <div class="blocos">blocos ${blocos.join(' + ')}</div>
      <div class="retomar" style="display:${feitas ? 'block' : 'none'}">
        ${feitas} ja anotados — retomar</div>`;
    c.onclick = () => iniciar(n);
    cont.appendChild(c);
  });
  if (ultimo) {
    const card = [...cont.children].find((c) =>
      c.querySelector('.nome').textContent === ultimo);
    if (card) card.style.borderColor = 'var(--amber)';
  }
}

/* ---- inicio da sessao ---- */
function iniciar(n) {
  nome = n;
  const dados = carregar(n);
  anot = dados.anotacoes || {};
  ultimoExport = dados.ultimoExport || null;
  meus = window.EXEMPLOS.filter((e) => PESQUISADORES[n].includes(e.bloco));
  idx = Math.min(dados.ultimoIdx || 0, meus.length - 1);
  if (!anot[meus[idx].id] || estado(anot[meus[idx].id]) === 'completo') {
    const vazio = meus.findIndex((e) => estado(anot[e.id]) !== 'completo');
    if (vazio >= 0) idx = vazio;
  }
  $('#telaInicio').style.display = 'none';
  $('#app').classList.add('ativo');
  $('#hdNome').textContent = n;
  $('#hdBloco').textContent = 'blocos ' + PESQUISADORES[n].join(' + ');
  $('#posTotal').textContent = meus.length;
  $('#inpIr').max = meus.length;
  montarMinimapa();
  render();
}

/* ---- render principal ---- */
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
    sinal = `<span class="rot">sinal · supressao do desenvolvedor</span>
      Um desenvolvedor suprimiu explicitamente o aviso do linter:
      <code>${escapar(e.suppression)}</code>`;
  } else if (e.magic_values && e.magic_values.length) {
    sinal = `<span class="rot">sinal · literal de protocolo</span>
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
      &nbsp;·&nbsp;<a href="${escapar(e.link)}" target="_blank" rel="noopener">ver no GitHub &#8599;</a>
    </div>
    <div class="sinal">${sinal}</div>
    ${avisoEscopo}`;
}

function renderCodigo(e) {
  const code = e.code || '';
  const linhas = code.split('\n');
  const inicio = e.node_lineno || 1;
  $('#gutter').textContent = linhas
    .map((_, i) => inicio + i).join('\n');
  const cod = $('#codigo');
  let html;
  try {
    html = window.hljs ? hljs.highlight(code, { language: 'python' }).value
                       : escapar(code);
  } catch (_) { html = escapar(code); }
  cod.innerHTML = html;
  cod.parentElement.parentElement.scrollTop = 0;
  cod.parentElement.parentElement.scrollLeft = 0;
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

  const veredHTML = VEREDITOS.map((o) => opcaoHTML('veredito', o.v,
    o.rot, a.veredito === o.v, { k: o.k, cls: o.cls, desc: o.desc, bloco: 1 })).join('');
  const confHTML = CONFIANCAS.map((o) => opcaoHTML('confianca', o.v,
    o.rot, a.confianca === o.v, {})).join('');
  const ctxHTML = CONTEXTOS.map((o) => opcaoHTML('contexto', o.v,
    o.rot, a.contexto === o.v, { bloco: 1 })).join('');
  const motHTML = MOTIVOS.map((o) => opcaoHTML('motivo', o.v,
    o.rot, a.motivo === o.v, { bloco: 1 })).join('');

  $('#painel').innerHTML = `
    <div class="pergunta">Sinalizado como <b>${escapar(e.smell)}</b>.
      E um smell real ou aparente?</div>

    <div class="secao-rot">veredicto <span class="obrig">*</span>
      <span class="tecla">teclas 1 / 2 / 3</span></div>
    <div class="opcoes">${veredHTML}</div>

    <div class="secao-rot">confianca no veredicto <span class="obrig">*</span></div>
    <div class="opcoes linha">${confHTML}</div>

    <div class="secao-rot">o contexto visivel foi suficiente? <span class="obrig">*</span></div>
    <div class="opcoes">${ctxHTML}</div>

    <div class="secao-rot">justificativa
      ${reqJust ? '<span class="obrig">*</span>' : '<span class="tecla">opcional p/ aparente</span>'}</div>
    <textarea id="txtJust" placeholder="Por que? O que no codigo (ou no contexto)
sustenta o veredicto?">${escapar(a.justificativa || '')}</textarea>

    <div class="condicional ${a.veredito === 'real' ? 'visivel' : ''}">
      <div class="secao-rot">se e smell real, por que estava sinalizado/suprimido?
        <span class="obrig">*</span></div>
      <div class="opcoes">${motHTML}</div>
    </div>`;

  const tx = $('#txtJust');
  if (reqJust && !(a.justificativa || '').trim()) tx.classList.add('faltando');
  tx.addEventListener('input', () => {
    setCampo(e.id, 'justificativa', tx.value, true);
    tx.classList.remove('faltando');
  });
}

/* ---- alteracao de campo ---- */
function setCampo(id, campo, valor, semRerender) {
  const a = anot[id] || (anot[id] = {});
  a[campo] = valor;
  a.ts = agora();
  salvar();
  if (campo === 'justificativa' || semRerender) {
    atualizarProgresso();
    renderEstado();
    marcarCel(idAtual());
  } else {
    renderPainel(meus[idx]);
    atualizarProgresso();
    renderEstado();
    marcarCel(idAtual());
  }
}

/* ---- progresso ---- */
function atualizarProgresso() {
  const feitas = meus.filter((e) => completo(anot[e.id])).length;
  const prog = $('#hdProg');
  prog.innerHTML = `<b>${feitas}</b> / ${meus.length}`;
  prog.classList.remove('pulsa'); void prog.offsetWidth; prog.classList.add('pulsa');
  $('#hdBarra').style.width = (100 * feitas / meus.length) + '%';

  const desde = ultimoExport
    ? meus.filter((e) => anot[e.id] && anot[e.id].ts > ultimoExport).length
    : feitas;
  const d = $('#dicaSalvo');
  if (desde > 40) {
    d.innerHTML = `&#9888; ${desde} anotacoes desde o ultimo export — exporte`;
    d.style.color = 'var(--amber)';
  } else {
    d.textContent = 'salvo automaticamente neste navegador';
    d.style.color = 'var(--text-dim)';
  }
}

function renderEstado() {
  const a = anot[idAtual()];
  const st = estado(a);
  const el = $('#estadoAnot');
  el.className = 'estado-anot ' + st;
  el.textContent = { completo: 'anotado', parcial: 'incompleto', vazio: 'nao anotado' }[st];
}

/* ---- minimapa ---- */
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

/* ---- navegacao ---- */
function ir(novo) {
  idx = Math.max(0, Math.min(meus.length - 1, novo));
  salvar();
  render();
  $('#painel').classList.remove('fade'); void $('#painel').offsetWidth;
  $('#painel').classList.add('fade');
}
function idAtual() { return meus[idx].id; }
function proximoVazio() {
  for (let n = 1; n <= meus.length; n++) {
    const j = (idx + n) % meus.length;
    if (estado(anot[meus[j].id]) !== 'completo') { ir(j); return; }
  }
  toast('Todos os exemplos estao anotados.');
}

/* ---- export / import ---- */
function exportar() {
  ultimoExport = agora();
  salvar();
  const blob = new Blob([JSON.stringify({
    pesquisador: nome, versao: VERSAO, geradoEm: ultimoExport,
    totalExemplos: meus.length,
    completos: meus.filter((e) => completo(anot[e.id])).length,
    anotacoes: anot,
  }, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `anotacoes_${nome.toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  atualizarProgresso();
  toast('Arquivo exportado. Envie-o ao Gustavo / comite o no repositorio.');
}
function importar(file) {
  const fr = new FileReader();
  fr.onload = () => {
    let dados;
    try { dados = JSON.parse(fr.result); }
    catch (_) { return toast('Arquivo invalido.'); }
    const n = dados.pesquisador;
    if (!PESQUISADORES[n]) return toast('Pesquisador desconhecido no arquivo.');
    const atual = carregar(n);
    const merge = Object.assign({}, atual.anotacoes || {}, dados.anotacoes || {});
    localStorage.setItem(chave(n), JSON.stringify({
      pesquisador: n, anotacoes: merge,
      ultimoIdx: atual.ultimoIdx || 0,
      ultimoExport: dados.geradoEm || atual.ultimoExport, salvoEm: agora(),
    }));
    toast(`Anotacoes de ${n} importadas.`);
    if (nome === n) iniciar(n);
  };
  fr.readAsText(file);
}

/* ---- toast ---- */
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('ver');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('ver'), 3200);
}

/* ---- teclado ---- */
document.addEventListener('keydown', (ev) => {
  if (!nome) return;
  const noTexto = ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT';
  if (ev.key === 'Escape' && noTexto) { ev.target.blur(); return; }
  if (noTexto) return;
  if (ev.key === '1' || ev.key === '2' || ev.key === '3') {
    setCampo(idAtual(), 'veredito', VEREDITOS[+ev.key - 1].v);
  } else if (ev.key === 'ArrowLeft') { ir(idx - 1); }
  else if (ev.key === 'ArrowRight') { ir(idx + 1); }
  else if (ev.key === 'n' || ev.key === 'N') { proximoVazio(); }
});

/* ---- ligacoes ---- */
function ligar() {
  $('#painel').addEventListener('click', (ev) => {
    const o = ev.target.closest('.opc');
    if (!o) return;
    setCampo(idAtual(), o.dataset.campo, o.dataset.valor);
  });
  $('#btnPrev').onclick = () => ir(idx - 1);
  $('#btnNext').onclick = () => ir(idx + 1);
  $('#btnProxVazio').onclick = proximoVazio;
  $('#btnExport').onclick = exportar;
  $('#btnTrocar').onclick = () => {
    salvar();
    $('#app').classList.remove('ativo');
    $('#telaInicio').style.display = '';
  };
  $('#inpIr').addEventListener('change', (ev) => {
    const n = parseInt(ev.target.value, 10);
    if (n >= 1 && n <= meus.length) ir(n - 1);
  });
  $('#inpImport').addEventListener('change', (ev) => {
    if (ev.target.files[0]) importar(ev.target.files[0]);
  });
  window.addEventListener('beforeunload', () => { if (nome) salvar(); });
}

/* ---- arranque ---- */
if (!window.EXEMPLOS) {
  document.body.innerHTML = '<p style="padding:40px;font-family:monospace">'
    + 'ERRO: examples.js nao carregou. Rode gerar_anotador.py.</p>';
} else {
  montarInicio();
  ligar();
}
