/* Sessão de adjudicação (consenso) — TP Engenharia de Software II.
   App estatico para a rodada 2 da sonda de qualidade: Gustavo + Felipe decidem
   JUNTOS os pares disputados da rodada 1 (incertos de Gustavo + desacordos
   decididos), seguindo o CODEBOOK dos dois eixos.

   Diferencas para qualidade.js:
   - mostra um DIFF lado a lado (alinhado por LCS, só mudanças + contexto);
   - mostra os vereditos/justificativas da rodada 1 dos dois anotadores;
   - mostra a 3a opiniao da auditoria LLM (recolhida; flag do proxy censurada);
   - captura estruturada: veredito + criterio + tags A/B + salvage + texto;
   - grava em qualidade/qualidade_consenso.json (pesquisador "consenso");
   - co-op: alem do autosave, puxa o remoto periodicamente e mescla por ts,
     entao os dois podem ter a pagina aberta ao mesmo tempo.

   Os 27 pares concordantes da rodada 1 sao pre-preenchidos como consenso
   automatico (origem:"auto") — o arquivo final cobre os 50.

   Cego a flag: ast_pattern_match e removido no carregamento (normalizeSample)
   e mencoes ao seu valor na auditoria sao censuradas antes de renderizar. */
'use strict';

/* ===== configuracao ===== */
const REPO = 'Gronoxx/tp-es2-dataset';
const API = 'https://api.github.com';
const ARQ_AMOSTRA = 'positive_quality_sample.json';
const ARQ_DEMO = 'positive_quality_sample.example.json';
const ARQ_G = 'qualidade/qualidade_gustavo.json';
const ARQ_F = 'qualidade/qualidade_felipe.json';
const ARQ_AUD = 'qualidade/auditoria_llm_2026-06-09.json';
const ARQ_CONS = 'qualidade/qualidade_consenso.json';
const PESQUISADORES = ['Gustavo', 'Felipe'];
const VERSAO = 'q1';

const VEREDITOS = [
  { v: 'genuina', k: '1', cls: 'v-real', rot: 'Genuína',
    desc: 'Eixo A ok E Eixo B ok — exemplar de treino' },
  { v: 'lixo', k: '2', cls: 'v-aparente', rot: 'Lixo',
    desc: 'falhou A ou B — marcar critério, tags e salvage' },
  { v: 'incerto', k: '3', cls: 'v-incerto', rot: 'Incerto',
    desc: 'SÓ inverificável pelo snippet (símbolo/efeito fora do recorte)' },
];
const CRITERIOS = [
  { v: 'muda_comportamento', rot: 'Muda comportamento (Eixo A)' },
  { v: 'after_nao_resolve', rot: 'Não resolve / só mitiga (Eixo B)' },
  { v: 'before_sem_smell', rot: 'O before não tinha o smell (Eixo B)' },
  { v: 'outro', rot: 'Outro — fora de escopo, bug disfarçado etc.' },
];
// multipla escolha; o legado `criterio` (singular, rodada 1) e espelhado como
// criterios[0] na escrita e absorvido na leitura
function getCriterios(a) {
  if (Array.isArray(a && a.criterios)) return a.criterios;
  return a && a.criterio ? [a.criterio] : [];
}
const TAGS = [
  { v: 'A1_assinatura', rot: 'A1 assinatura/contrato' },
  { v: 'A2_simbolo_indefinido', rot: 'A2 símbolo indefinido' },
  { v: 'A3_curto_circuito', rot: 'A3 curto-circuito' },
  { v: 'A4_early_return_tail', rot: 'A4 early-return × tail' },
  { v: 'A5_excecoes_avisos', rot: 'A5 exceções/avisos' },
  { v: 'B_resolucao_incompleta', rot: 'B resolução incompleta' },
  { v: 'B_fora_de_escopo', rot: 'B fora de escopo' },
  { v: 'B_nao_autocontido', rot: 'B não autocontido' },
  { v: 'B_bugfix_disfarcado', rot: 'B bugfix disfarçado' },
];
const SALVAGE = [
  { v: 'regenerar_after', rot: 'Before vale — regenerar o after' },
  { v: 'descartar', rot: 'Descartar o par inteiro' },
];
const SNIPPET = [
  { v: 'sim', rot: 'Refatoração inteira visível' },
  { v: 'nao', rot: 'Snippet cortou parte' },
];
const SMELLS_SNIPPET = new Set(['R3', 'R4']);
const CONTEXTO = 3;          // linhas iguais ao redor de cada mudança
const PULL_MS = 30000;       // co-op: puxar o remoto a cada 30 s

/* ===== estado ===== */
let nome = null, token = null, demo = false;
let PARES = {};              // id -> par normalizado
let AGENDA = [];             // [{id, tipo: 'incerto'|'desacordo'}]
let R1 = { Gustavo: {}, Felipe: {} };
let AUD = {};                // id -> bloco da auditoria
let anot = {}, idx = 0, shaAnot = null;
let totalPares = 0;
let sincronizando = false, precisaSync = false, syncTimer = null, pullTimer = null;
let diffExpandido = new Set();   // segmentos de contexto abertos no par atual
let diffCompleto = false;        // mostrar todas as linhas

/* ===== helpers ===== */
const $ = (s) => document.querySelector(s);
const agora = () => new Date().toISOString();
const kTok = (n) => `anotador.tok.${n}`;            // mesmo token das rodadas anteriores
const kCache = `consenso.${VERSAO}`;
function escapar(s) {
  return String(s).replace(/[&<>]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function censurar(s) {
  return String(s).replace(/ast(?:_pattern)?_?match\s*=\s*(?:True|False)/gi,
    '[flag do proxy — oculta]');
}
function lerToken(n) { return localStorage.getItem(kTok(n)) || null; }
function lerCache() {
  try { return JSON.parse(localStorage.getItem(kCache)) || {}; }
  catch (_) { return {}; }
}
function salvarCache() {
  if (demo) return;
  try {
    localStorage.setItem(kCache, JSON.stringify(
      { anotacoes: anot, shaAnot: shaAnot, idx: idx, salvoEm: agora() }));
  } catch (_) { /* quota — GitHub e a fonte da verdade */ }
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('ver');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('ver'), 3500);
}

/* ===== normalizacao da amostra (cego por delecao, igual qualidade.js) ===== */
function normalizeSample(raw) {
  if (!Array.isArray(raw)) {
    if (raw && Array.isArray(raw.pares)) raw = raw.pares;
    else if (raw && Array.isArray(raw.amostra)) raw = raw.amostra;
    else throw new Error('Amostra inesperada: esperava um array de pares.');
  }
  return raw.map((d, i) => {
    const pick = (...ks) => { for (const k of ks) if (d[k] != null) return d[k]; return undefined; };
    return {
      id: String(pick('id', 'pair_id', '_id') != null ? pick('id', 'pair_id', '_id') : `par_${i}`),
      smell: String(pick('smell', 'smell_type', 'smell_code') || '?').toUpperCase(),
      before: String(pick('before', 'before_code', 'antes') || ''),
      after: String(pick('after', 'after_code', 'depois') || ''),
      meta: {
        repo: pick('repo', 'repository'), file: pick('file', 'path'),
        function_name: pick('function_name', 'funcao'),
        commit_hash: pick('commit_hash', 'commit', 'sha'),
        source: pick('source', 'provenance'),
      },
    };
  });
}

/* ===== agenda e pre-preenchimento ===== */
function montarAgenda(g, f) {
  const ag = [];
  for (const id of Object.keys(g).sort()) {
    const vg = (g[id] || {}).veredito, vf = (f[id] || {}).veredito;
    if (!vg) continue;
    if (vg === 'incerto') ag.push({ id, tipo: 'incerto' });
    else if (vf && vf !== 'incerto' && vf !== vg) ag.push({ id, tipo: 'desacordo' });
  }
  return ag;
}
function seedConcordantes(g, f) {
  // pares decididos iguais na rodada 1 viram consenso automatico (revisavel)
  const naAgenda = new Set(AGENDA.map((x) => x.id));
  let n = 0;
  for (const id of Object.keys(g)) {
    if (naAgenda.has(id) || anot[id]) continue;
    const a = g[id] || {}, b = f[id] || {};
    if (!a.veredito || a.veredito !== b.veredito) continue;
    const reg = {
      veredito: a.veredito, origem: 'auto', ts: agora(),
      justificativa: '[consenso automático: rodada 1 concordante] '
        + 'G: ' + (a.justificativa || '—') + ' | F: ' + (b.justificativa || '—'),
    };
    if (a.veredito === 'lixo') {
      const uniao = Array.from(new Set([a.criterio, b.criterio].filter(Boolean)));
      reg.criterios = uniao.length ? uniao : ['outro'];
      reg.criterio = reg.criterios[0];   // espelho legado
      reg.salvage = 'regenerar_after';   // default conservador — revisar se preciso
    }
    if (a.veredito === 'genuina') reg.salvage = 'usar_como_esta';
    if (a.snippet_completo || b.snippet_completo) {
      reg.snippet_completo = a.snippet_completo || b.snippet_completo;
    }
    anot[id] = reg; n++;
  }
  return n;
}

/* ===== modelo ===== */
function precisaSnippet(par) { return SMELLS_SNIPPET.has(par.smell); }
function completo(par, a) {
  if (!a || !a.veredito) return false;
  if (!(a.justificativa || '').trim()) return false;          // obrigatoria SEMPRE
  if (a.veredito === 'lixo' && (!getCriterios(a).length || !a.salvage)) return false;
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

/* ===== cliente GitHub (espelha qualidade.js) ===== */
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
  catch (_) { throw new Error('Sem conexao com o GitHub.'); }
  if (r.status === 401) throw new Error('Token invalido ou expirado.');
  if (r.status === 403) throw new Error('Token sem permissao — precisa do escopo "repo".');
  if (r.status === 404) throw new Error('Sem acesso ao repositorio tp-es2-dataset.');
  if (!r.ok) throw new Error('Erro ' + r.status + ' ao acessar o GitHub.');
}
async function ghGetRaw(caminho) {
  const r = await ghFetch(`/repos/${REPO}/contents/${caminho}`,
    { accept: 'application/vnd.github.raw' });
  if (r.status === 404) throw new Error(`"${caminho}" nao existe no repo privado.`);
  if (!r.ok) throw new Error(`Falha ao baixar ${caminho} (${r.status}).`);
  return r.text();
}
async function ghGetJson(caminho) {
  const r = await ghFetch(`/repos/${REPO}/contents/${caminho}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Falha ao ler ${caminho} (${r.status}).`);
  const j = await r.json();
  const txt = decodeURIComponent(escape(atob((j.content || '').replace(/\s/g, ''))));
  return { obj: JSON.parse(txt), sha: j.sha };
}
function corpoConsenso() {
  const ids = Object.keys(PARES);
  return {
    pesquisador: 'consenso', versao: VERSAO, tarefa: 'adjudicacao-consenso',
    participantes: PESQUISADORES, atualizadoEm: agora(),
    totalPares: totalPares,
    completos: ids.filter((id) => completo(PARES[id], anot[id])).length,
    pauta: AGENDA.map((x) => x.id),
    anotacoes: anot,
  };
}
async function ghPutConsenso() {
  const enviar = async (sha) => {
    const c = corpoConsenso();
    const body = {
      message: `consenso (${c.completos}/${c.totalPares})`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(c, null, 1)))),
      branch: 'main',
    };
    if (sha) body.sha = sha;
    return ghFetch(`/repos/${REPO}/contents/${ARQ_CONS}`,
      { method: 'PUT', body: JSON.stringify(body) });
  };
  let r = await enviar(shaAnot);
  if (r.status === 409 || r.status === 422) {
    const remoto = await ghGetJson(ARQ_CONS);
    anot = mesclar(anot, (remoto && remoto.obj.anotacoes) || {});
    shaAnot = remoto ? remoto.sha : null;
    salvarCache();
    r = await enviar(shaAnot);
  }
  if (!r.ok) throw new Error('PUT ' + r.status);
  shaAnot = (await r.json()).content.sha;
}

/* ===== sincronizacao + co-op ===== */
function statusSync(s) {
  const mapa = {
    ok: ['ok', '● sincronizado'], ativo: ['ativo', '⟳ sincronizando'],
    pendente: ['ativo', '⟳ pendente'], erro: ['erro', '⚠ erro — clique p/ tentar'],
    demo: ['ativo', '◐ demo (sem gravar)'],
  };
  const [cls, txt] = mapa[s] || mapa.ok;
  const el = $('#sync');
  el.className = 'sync ' + cls; el.textContent = txt;
}
function agendarSync() {
  if (demo) return;
  precisaSync = true; statusSync('pendente');
  clearTimeout(syncTimer); syncTimer = setTimeout(sincronizar, 3000);
}
async function sincronizar() {
  if (demo || sincronizando || !precisaSync) return;
  sincronizando = true; precisaSync = false; statusSync('ativo');
  try { await ghPutConsenso(); statusSync(precisaSync ? 'pendente' : 'ok'); }
  catch (_) { precisaSync = true; statusSync('erro'); }
  sincronizando = false;
  if (precisaSync) { clearTimeout(syncTimer); syncTimer = setTimeout(sincronizar, 5000); }
}
async function pullRemoto(manual) {
  // co-op: traz o que o parceiro gravou; merge por ts par a par
  if (demo || sincronizando || precisaSync) return;
  try {
    const remoto = await ghGetJson(ARQ_CONS);
    if (!remoto || remoto.sha === shaAnot) { if (manual) toast('nada novo no remoto'); return; }
    anot = mesclar(anot, remoto.obj.anotacoes || {});
    shaAnot = remoto.sha;
    salvarCache(); render();
    toast('alterações do parceiro mescladas ✓');
  } catch (_) { if (manual) toast('falha ao puxar o remoto'); }
}

/* ===== diff (LCS por linha) ===== */
function diffOps(a, b) {
  const n = a.length, m = b.length;
  const L = [];
  for (let i = 0; i <= n; i++) L.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: 'eq', la: i, lb: j }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { ops.push({ t: 'del', la: i }); i++; }
    else { ops.push({ t: 'ins', lb: j }); j++; }
  }
  while (i < n) ops.push({ t: 'del', la: i++ });
  while (j < m) ops.push({ t: 'ins', lb: j++ });
  return ops;
}
function emparelhar(ops) {
  // del-run + ins-run viram linhas "mod" lado a lado (estilo split view)
  const out = []; let k = 0;
  while (k < ops.length) {
    if (ops[k].t === 'eq') { out.push(ops[k]); k++; continue; }
    const dels = [], ins = [];
    while (k < ops.length && ops[k].t === 'del') { dels.push(ops[k]); k++; }
    while (k < ops.length && ops[k].t === 'ins') { ins.push(ops[k]); k++; }
    const mx = Math.max(dels.length, ins.length);
    for (let x = 0; x < mx; x++) {
      out.push({
        t: 'mod',
        la: x < dels.length ? dels[x].la : null,
        lb: x < ins.length ? ins[x].lb : null,
      });
    }
  }
  return out;
}
function hlLinha(s) {
  if (s == null) return '';
  try {
    return window.hljs ? hljs.highlight(s, { language: 'python' }).value : escapar(s);
  } catch (_) { return escapar(s); }
}
function renderDiff(par) {
  const A = par.before.split('\n'), B = par.after.split('\n');
  const rows = emparelhar(diffOps(A, B));
  const mudou = rows.some((r) => r.t !== 'eq');

  // visibilidade: tudo, ou só mudancas + contexto (com expansores por segmento)
  const vis = new Array(rows.length).fill(diffCompleto || !mudou);
  if (!diffCompleto && mudou) {
    rows.forEach((r, i) => {
      if (r.t !== 'eq') {
        for (let d = -CONTEXTO; d <= CONTEXTO; d++) {
          if (rows[i + d]) vis[i + d] = true;
        }
      }
    });
  }
  const html = [];
  let k = 0, seg = 0;
  while (k < rows.length) {
    if (vis[k]) {
      const r = rows[k];
      const ta = r.la != null ? A[r.la] : null;
      const tb = r.lb != null ? B[r.lb] : null;
      let cls = 'd-eq';
      if (r.t === 'mod') cls = ta == null ? 'd-ins' : (tb == null ? 'd-del' : 'd-mod');
      html.push(`<tr class="${cls}">
        <td class="ln">${r.la != null ? r.la + 1 : ''}</td>
        <td class="cd">${ta != null ? '<code>' + hlLinha(ta) + '</code>' : ''}</td>
        <td class="ln">${r.lb != null ? r.lb + 1 : ''}</td>
        <td class="cd">${tb != null ? '<code>' + hlLinha(tb) + '</code>' : ''}</td></tr>`);
      k++;
    } else {
      let fim = k;
      while (fim < rows.length && !vis[fim]) fim++;
      const sid = seg++;
      if (diffExpandido.has(sid)) {
        for (let x = k; x < fim; x++) vis[x] = true;
        continue;                                  // re-renderiza o trecho aberto
      }
      html.push(`<tr class="d-skip" data-seg="${sid}">
        <td colspan="4">··· ${fim - k} linha(s) igual(is) — clique para mostrar ···</td></tr>`);
      k = fim;
    }
  }
  $('#diffBody').innerHTML = html.join('');
  $('#diffVazio').style.display = mudou ? 'none' : '';
  $('#btnDiffModo').textContent = diffCompleto ? 'ver só o diff' : 'ver código completo';
}

/* ===== render ===== */
function parAtual() { return PARES[AGENDA[idx].id]; }
function render() {
  if (!AGENDA.length) return;
  const item = AGENDA[idx], p = PARES[item.id];
  renderMeta(p, item);
  renderDiff(p);
  renderRodada1(p);
  renderAuditoria(p);
  renderPainel(p);
  $('#inpIr').value = idx + 1;
  atualizarProgresso(); renderEstado(); renderMinimapa();
  $('#btnPrev').disabled = idx === 0;
  $('#btnNext').disabled = idx === AGENDA.length - 1;
}
function renderMeta(p, item) {
  const m = p.meta || {};
  const alvo = [m.repo, m.file].filter(Boolean).join(' / ');
  $('#meta').innerHTML = `
    <div class="meta-linha1">
      <span class="badge">${escapar(p.smell)}</span>
      <span class="chip tipo-${item.tipo}">${item.tipo === 'incerto'
        ? 'INCERTO de Gustavo' : 'DESACORDO G≠F'}</span>
      <span class="chip">${escapar(p.id)}</span>
      ${m.source ? `<span class="chip">fonte: <b>${escapar(m.source)}</b></span>` : ''}
    </div>
    ${alvo ? `<div class="alvo"><b>${escapar(alvo)}</b>${m.function_name
      ? '&nbsp;::&nbsp;<b>' + escapar(m.function_name) + '</b>' : ''}</div>` : ''}`;
}
function chipVer(v) {
  const cls = v === 'genuina' ? 'v-real' : (v === 'lixo' ? 'v-aparente' : 'v-incerto');
  return `<span class="mini-ver ${cls}">${escapar(v || '—')}</span>`;
}
function renderRodada1(p) {
  const blocos = PESQUISADORES.map((n) => {
    const a = R1[n][p.id] || {};
    return `<div class="r1-bloco">
      <div class="r1-cab"><b>${n}</b> ${chipVer(a.veredito)}
        ${a.criterio ? `<span class="chip">${escapar(a.criterio)}</span>` : ''}</div>
      <div class="r1-just">${escapar((a.justificativa || 'sem justificativa').trim())}</div>
    </div>`;
  });
  $('#rodada1').innerHTML = blocos.join('');
}
function renderAuditoria(p) {
  const a = AUD[p.id];
  const det = $('#auditoria');
  if (!a) { det.style.display = 'none'; return; }
  det.style.display = '';
  det.open = false;                                  // fecha ao trocar de par
  $('#audCorpo').innerHTML = `
    <div class="r1-cab">auditor: ${chipVer(a.my_verdict)}
      <span class="chip">acertou: <b>${escapar(a.who_is_right)}</b></span>
      <span class="chip">salvage: <b>${escapar(a.salvage)}</b></span></div>
    <div class="r1-just">causas: ${escapar((a.root_causes || []).join(', '))}</div>
    <div class="r1-just">${escapar(censurar(a.key_observation || ''))}</div>`;
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
  const tags = new Set(a.tags || []);
  const crits = new Set(getCriterios(a));
  const vered = VEREDITOS.map((o) => opcaoHTML('veredito', o.v, o.rot,
    a.veredito === o.v, { k: o.k, cls: o.cls, desc: o.desc, bloco: 1 })).join('');
  const crit = CRITERIOS.map((o) => opcaoHTML('criterio', o.v, o.rot,
    crits.has(o.v), { bloco: 1 })).join('');
  const salv = SALVAGE.map((o) => opcaoHTML('salvage', o.v, o.rot,
    a.salvage === o.v, { bloco: 1 })).join('');
  const snip = SNIPPET.map((o) => opcaoHTML('snippet_completo', o.v, o.rot,
    a.snippet_completo === o.v, { bloco: 1 })).join('');
  const chips = TAGS.map((t) => `<span class="tag ${tags.has(t.v) ? 'on' : ''}"
    data-tag="${t.v}">${t.rot}</span>`).join('');

  const ehLixo = a.veredito === 'lixo';
  $('#painel').innerHTML = `
    <div class="pergunta">Consenso para <b>${escapar(p.id)}</b> — regra:
      <b>genuína = Eixo A ∧ Eixo B</b>
      <a href="GUIA_EIXOS.html" target="_blank" rel="noopener">guia ↗</a></div>
    <div class="secao-rot">veredicto do consenso <span class="obrig">*</span>
      <span class="tecla">teclas 1 / 2 / 3</span></div>
    <div class="opcoes">${vered}</div>
    <div class="condicional ${ehLixo ? 'visivel' : ''}">
      <div class="secao-rot">critérios que falharam <span class="obrig">*</span>
        <span class="tecla">marque 1 ou mais</span></div>
      <div class="opcoes">${crit}</div>
      <div class="secao-rot">salvage do before <span class="obrig">*</span></div>
      <div class="opcoes">${salv}</div>
    </div>
    <div class="secao-rot">tags do que foi observado <span class="tecla">opcional, exportadas no JSON</span></div>
    <div class="tags">${chips}</div>
    ${precisaSnippet(p) ? `
      <div class="secao-rot">snippet completo? <span class="obrig">*</span></div>
      <div class="opcoes">${snip}</div>` : ''}
    <div class="secao-rot">justificativa do consenso <span class="obrig">*</span>
      <button class="btn mini" id="btnRascunho" title="insere as tags marcadas como rascunho">tags → texto</button></div>
    <textarea id="txtJust"
      placeholder="1 frase concreta: qual mecanismo decide o veredito?">${escapar(a.justificativa || '')}</textarea>
    ${a.origem === 'auto' ? '<div class="auto-aviso">pré-preenchido da rodada 1 — edite se a sessão decidir diferente</div>' : ''}`;

  const tx = $('#txtJust');
  if (!(a.justificativa || '').trim() && a.veredito) tx.classList.add('faltando');
  tx.addEventListener('input', () => {
    setCampo(p.id, 'justificativa', tx.value, true);
    tx.classList.remove('faltando');
  });
  $('#btnRascunho').addEventListener('click', () => {
    const sel = (anot[p.id] && anot[p.id].tags) || [];
    if (!sel.length) { toast('marque tags primeiro'); return; }
    const rotulos = TAGS.filter((t) => sel.includes(t.v)).map((t) => t.rot).join('; ');
    tx.value = (rotulos + ': ' + tx.value).trimEnd();
    setCampo(p.id, 'justificativa', tx.value, true);
    tx.focus();
  });
}
function renderEstado() {
  const item = AGENDA[idx], a = anot[item.id];
  const e = estado(PARES[item.id], a);
  const el = $('#estadoAnot');
  el.className = 'estado-anot ' + e;
  el.textContent = e === 'completo' ? '✓ consenso registrado'
    : (e === 'parcial' ? 'incompleto — falta critério/salvage/justificativa' : 'não decidido');
}
function atualizarProgresso() {
  const done = AGENDA.filter((x) => completo(PARES[x.id], anot[x.id])).length;
  $('#hdProg').innerHTML = `<b>${done}</b> / ${AGENDA.length} da pauta`;
  $('#hdBarra').style.width = (AGENDA.length ? (100 * done / AGENDA.length) : 0) + '%';
}
function renderMinimapa() {
  $('#minimapa').innerHTML = AGENDA.map((x, i) => {
    const a = anot[x.id] || {};
    const e = estado(PARES[x.id], a);
    let cor = 'transparent';
    if (a.veredito === 'genuina') cor = '#4ec9a8';
    else if (a.veredito === 'lixo') cor = '#e5575c';
    else if (a.veredito === 'incerto') cor = '#9a8cff';
    return `<i class="cel ${i === idx ? 'atual' : ''} ${e}" data-i="${i}"
      style="background:${cor}" title="${x.id}"></i>`;
  }).join('');
}

/* ===== alteracao de campo ===== */
function setCampo(id, campo, valor, semRerender) {
  const a = anot[id] || (anot[id] = {});
  a[campo] = valor; a.ts = agora();
  delete a.origem;                                   // mexeu → deixa de ser automatico
  if (campo === 'veredito') {
    if (valor === 'genuina') { delete a.criterio; delete a.criterios; a.salvage = 'usar_como_esta'; }
    if (valor === 'incerto') { delete a.criterio; delete a.criterios; delete a.salvage; }
    if (valor === 'lixo' && a.salvage === 'usar_como_esta') delete a.salvage;
  }
  salvarCache(); agendarSync();
  if (!semRerender) render(); else { atualizarProgresso(); renderEstado(); renderMinimapa(); }
}
function toggleCriterio(id, valor) {
  const a = anot[id] || (anot[id] = {});
  const s = new Set(getCriterios(a));
  if (s.has(valor)) s.delete(valor); else s.add(valor);
  a.criterios = Array.from(s);
  a.criterio = a.criterios[0];           // espelho legado (singular)
  if (!a.criterios.length) { delete a.criterios; delete a.criterio; }
  a.ts = agora(); delete a.origem;
  salvarCache(); agendarSync(); render();
}
function toggleTag(id, tag) {
  const a = anot[id] || (anot[id] = {});
  const s = new Set(a.tags || []);
  if (s.has(tag)) s.delete(tag); else s.add(tag);
  a.tags = Array.from(s); a.ts = agora(); delete a.origem;
  salvarCache(); agendarSync(); render();
}

/* ===== carregamento ===== */
async function carregar() {
  mostrarOverlay('Baixando amostra e anotações da rodada 1…');
  const [amostra, gTxt, fTxt] = await Promise.all([
    ghGetRaw(ARQ_AMOSTRA), ghGetRaw(ARQ_G), ghGetRaw(ARQ_F)]);
  normalizeSample(JSON.parse(amostra)).forEach((p) => { PARES[p.id] = p; });
  R1.Gustavo = (JSON.parse(gTxt).anotacoes) || {};
  R1.Felipe = (JSON.parse(fTxt).anotacoes) || {};
  totalPares = Object.keys(PARES).length;

  try {
    const aud = JSON.parse(await ghGetRaw(ARQ_AUD));
    (aud.auditorias || []).forEach((b) => (b.pairs || []).forEach((p) => { AUD[p.id] = p; }));
  } catch (_) { /* auditoria e opcional */ }

  AGENDA = montarAgenda(R1.Gustavo, R1.Felipe);
  if (!AGENDA.length) throw new Error('Pauta vazia — nada a adjudicar.');

  mostrarOverlay('Carregando consenso salvo…');
  const cache = lerCache();
  anot = cache.anotacoes || {};
  const remoto = await ghGetJson(ARQ_CONS);
  if (remoto) { anot = mesclar(anot, remoto.obj.anotacoes || {}); shaAnot = remoto.sha; }
  const auto = seedConcordantes(R1.Gustavo, R1.Felipe);
  if (auto) toast(`${auto} pares concordantes pré-preenchidos`);
  idx = Math.min(cache.idx || 0, AGENDA.length - 1);
  salvarCache();
  clearInterval(pullTimer); pullTimer = setInterval(pullRemoto, PULL_MS);
}
async function carregarDemo() {
  const r = await fetch(ARQ_DEMO);
  if (!r.ok) throw new Error('Fixture de demonstração não encontrado.');
  normalizeSample(await r.json()).forEach((p) => { PARES[p.id] = p; });
  totalPares = Object.keys(PARES).length;
  const ids = Object.keys(PARES).sort();
  ids.forEach((id, i) => {
    R1.Gustavo[id] = i % 2 ? { veredito: 'incerto', justificativa: 'demo: na dúvida' }
      : { veredito: 'lixo', criterio: 'after_nao_resolve', justificativa: 'demo: só mitiga' };
    R1.Felipe[id] = { veredito: 'genuina', justificativa: '' };
  });
  AGENDA = montarAgenda(R1.Gustavo, R1.Felipe);
}

/* ===== fluxo de telas ===== */
function mostrarOverlay(msg) { $('#overlayMsg').textContent = msg; $('#overlay').style.display = 'flex'; }
function esconderOverlay() { $('#overlay').style.display = 'none'; }
function montarInicio() {
  const cont = $('#cartoes');
  cont.innerHTML = '';
  PESQUISADORES.forEach((n) => {
    const temTok = !!lerToken(n);
    const c = document.createElement('div');
    c.className = 'cartao-pesq';
    c.innerHTML = `
      <div class="nome">${n} está no teclado</div>
      <div class="det">sessão conjunta — grava como "consenso"</div>
      <div class="blocos">pauta: incertos + desacordos da rodada 1</div>
      <div class="tok-ok" style="display:${temTok ? 'block' : 'none'}">
        &#10003; token salvo &middot; <a class="tok-trocar">trocar</a></div>`;
    c.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('tok-trocar')) { mostrarTelaToken(n); return; }
      const t = lerToken(n);
      if (t) { token = t; entrar(n); } else { mostrarTelaToken(n); }
    });
    cont.appendChild(c);
  });
}
function mostrarTelaToken(n) {
  nome = n;
  $('#telaInicio').style.display = 'none';
  $('#telaToken').style.display = '';
  $('#tokNome').textContent = n;
  $('#inpToken').value = ''; $('#erroToken').textContent = '';
  $('#inpToken').focus();
}
async function entrar(n) {
  nome = n;
  try {
    mostrarOverlay('Validando acesso…');
    await ghValidar();
    await carregar();
    abrirApp(`${PESQUISADORES.join(' + ')} (${n} no teclado)`);
    render();
    esconderOverlay();
  } catch (e) {
    esconderOverlay();
    $('#telaInicio').style.display = '';
    toast(e.message || String(e));
  }
}
async function entrarDemo() {
  demo = true; nome = 'demo'; token = null;
  try {
    mostrarOverlay('Carregando demonstração…');
    await carregarDemo();
    abrirApp('demonstração'); statusSync('demo');
    $('#demoAviso').style.display = '';
    render(); esconderOverlay();
  } catch (e) { esconderOverlay(); toast(e.message || String(e)); }
}
function abrirApp(rotulo) {
  $('#telaInicio').style.display = 'none';
  $('#telaToken').style.display = 'none';
  $('#app').classList.add('ativo');
  $('#hdNome').textContent = rotulo;
  $('#posTotal').textContent = AGENDA.length;
  $('#inpIr').max = AGENDA.length;
  if (!demo) statusSync('ok');
}

/* ===== exportacao ===== */
function exportar() {
  const blob = new Blob([JSON.stringify(corpoConsenso(), null, 1)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'qualidade_consenso.json';
  a.click(); URL.revokeObjectURL(a.href);
}

/* ===== eventos ===== */
document.addEventListener('click', (ev) => {
  const opc = ev.target.closest('.opc');
  if (opc) {
    const campo = opc.dataset.campo, valor = opc.dataset.valor;
    const id = AGENDA[idx].id;
    if (campo === 'criterio') { toggleCriterio(id, valor); return; }
    const a = anot[id] || {};
    setCampo(id, campo, a[campo] === valor && campo !== 'veredito' ? undefined : valor);
    return;
  }
  const tag = ev.target.closest('.tag');
  if (tag) { toggleTag(AGENDA[idx].id, tag.dataset.tag); return; }
  const skip = ev.target.closest('.d-skip');
  if (skip) { diffExpandido.add(Number(skip.dataset.seg)); renderDiff(parAtual()); return; }
  const cel = ev.target.closest('.cel');
  if (cel) { irPara(Number(cel.dataset.i)); return; }
  if (ev.target.id === 'sync') sincronizar();
});
function irPara(i) {
  idx = Math.min(Math.max(i, 0), AGENDA.length - 1);
  diffExpandido = new Set(); diffCompleto = false;
  salvarCache(); render();
}
document.addEventListener('keydown', (ev) => {
  if (!$('#app').classList.contains('ativo')) return;
  const noTexto = ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT';
  if (noTexto) { if (ev.key === 'Escape') ev.target.blur(); return; }
  const id = AGENDA[idx] && AGENDA[idx].id;
  if (ev.key === 'ArrowLeft') irPara(idx - 1);
  else if (ev.key === 'ArrowRight') irPara(idx + 1);
  else if (ev.key === '1') setCampo(id, 'veredito', 'genuina');
  else if (ev.key === '2') setCampo(id, 'veredito', 'lixo');
  else if (ev.key === '3') setCampo(id, 'veredito', 'incerto');
  else if (ev.key.toLowerCase() === 'n') {
    const v = AGENDA.findIndex((x, i) => i > idx && !completo(PARES[x.id], anot[x.id]));
    irPara(v >= 0 ? v : idx);
  }
});
window.addEventListener('DOMContentLoaded', () => {
  montarInicio();
  $('#btnEntrar').addEventListener('click', () => {
    const t = $('#inpToken').value.trim();
    if (!t) { $('#erroToken').textContent = 'Cole um token.'; return; }
    localStorage.setItem(kTok(nome), t);
    token = t; entrar(nome);
  });
  $('#inpToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnEntrar').click(); });
  $('#btnVoltarNome').addEventListener('click', () => {
    $('#telaToken').style.display = 'none'; $('#telaInicio').style.display = '';
  });
  $('#btnPrev').addEventListener('click', () => irPara(idx - 1));
  $('#btnNext').addEventListener('click', () => irPara(idx + 1));
  $('#btnProxVazio').addEventListener('click', () => {
    const v = AGENDA.findIndex((x) => !completo(PARES[x.id], anot[x.id]));
    if (v >= 0) irPara(v); else toast('pauta completa ✓');
  });
  $('#inpIr').addEventListener('change', () => irPara(Number($('#inpIr').value) - 1));
  $('#btnExport').addEventListener('click', exportar);
  $('#btnPull').addEventListener('click', () => pullRemoto(true));
  $('#btnDiffModo').addEventListener('click', () => {
    diffCompleto = !diffCompleto; renderDiff(parAtual());
  });
  if (new URLSearchParams(location.search).has('demo')) entrarDemo();
});
window.addEventListener('beforeunload', () => { if (precisaSync) sincronizar(); });
