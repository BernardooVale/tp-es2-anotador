#!/usr/bin/env python3
"""Gera o manual HTML da sessão de adjudicação da sonda de qualidade.

Monta, a partir dos dados do repo privado (anotações da rodada 1, amostra de
50 pares e auditoria LLM), um documento autocontido em português com:
contexto, a regra dos dois eixos (CODEBOOK v2), o protocolo da sessão e a
pauta de pares disputados (incertos de Gustavo + desacordos decididos), cada
um com código before/after e a observação da auditoria em bloco recolhível.

A flag `ast_pattern_match` NÃO é exposta (mesmo invariante do harness cego).

Uso:
    python3 tools/gerar_manual_adjudicacao.py --repo-dir ../tp-es2-dataset
"""
import argparse
import html
import json
import os
import re

# A blindagem do harness vale aqui também: qualquer menção ao valor da flag
# do proxy nas observações da auditoria é censurada antes de renderizar.
_RE_FLAG = re.compile(r"ast(?:_pattern)?_?match\s*=\s*(?:True|False)", re.IGNORECASE)


def _censurar_flag(texto: str) -> str:
    return _RE_FLAG.sub("[flag do proxy — oculta]", texto)

SMELL_NOME = {
    "R1": "Long Method → Extract Method",
    "R2": "Long Parameter List → Parameter Object",
    "R3": "Magic Numbers → Named Constant",
    "R4": "Deep Nesting → Guard Clauses",
    "R5": "Dead Code → Remove",
}
SMELL_COR = {"R1": "#7c3aed", "R2": "#0369a1", "R3": "#b45309",
             "R4": "#be123c", "R5": "#15803d"}
VERED_COR = {"genuina": "#15803d", "lixo": "#b91c1c", "incerto": "#b45309"}

CSS = """
:root { --ink:#1c1917; --muted:#57534e; --line:#e7e5e4; --bg:#fafaf9; }
* { box-sizing: border-box; }
body { font: 16px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif;
       color: var(--ink); background: var(--bg); margin: 0; }
main { max-width: 920px; margin: 0 auto; padding: 24px 20px 80px; }
h1 { font-size: 1.7rem; line-height: 1.25; margin: .2em 0; }
h2 { font-size: 1.25rem; margin: 2.2em 0 .6em; border-bottom: 2px solid var(--line); padding-bottom: .25em; }
h3 { font-size: 1.05rem; margin: 1.4em 0 .4em; }
p, li { max-width: 75ch; }
.sub { color: var(--muted); }
.badge { display:inline-block; padding:1px 9px; border-radius:999px;
         font-size:.78rem; font-weight:600; color:#fff; vertical-align:middle; }
.kv { color: var(--muted); font-size:.85rem; }
table { border-collapse: collapse; width: 100%; margin: .6em 0; font-size:.92rem; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: #f5f5f4; }
.card { background:#fff; border:1px solid var(--line); border-left:5px solid #999;
        border-radius:8px; padding:14px 18px; margin:18px 0; }
.card h3 { margin-top: 0; }
details { margin:.5em 0; border:1px solid var(--line); border-radius:6px; background:#fcfcfb; }
details summary { cursor:pointer; padding:7px 12px; font-weight:600; font-size:.92rem; }
details[open] summary { border-bottom:1px solid var(--line); }
details .inner { padding: 10px 14px; }
pre { background:#1c1917; color:#e7e5e4; padding:12px; border-radius:6px;
      overflow-x:auto; font-size:.8rem; line-height:1.45; }
.just { background:#f5f5f4; border-radius:6px; padding:8px 12px; margin:.3em 0;
        font-size:.92rem; white-space:pre-wrap; }
.aviso { background:#fef3c7; border:1px solid #f59e0b; border-radius:6px; padding:10px 14px; }
.regra { background:#ecfdf5; border:1px solid #10b981; border-radius:6px; padding:10px 14px; }
.checklist label { display:block; padding:2px 0; }
.fill { border-bottom:1px dashed #a8a29e; min-height:1.4em; }
.decisao { background:#f0f9ff; border:1px solid #7dd3fc; border-radius:6px;
           padding:8px 12px; margin-top:.6em; font-size:.92rem; }
.decisao label { margin-right: 14px; }
#progresso { position:sticky; top:0; z-index:5; background:#1c1917; color:#fff;
             padding:8px 20px; font-size:.9rem; }
.toc { columns: 2; font-size:.9rem; }
@media print { #progresso { display:none } body { background:#fff } }
"""

JS = """
function atualizaProgresso(){
  var t = document.querySelectorAll('.done-par').length;
  var d = document.querySelectorAll('.done-par:checked').length;
  document.getElementById('progresso').textContent =
    'Progresso da sessão: ' + d + ' / ' + t + ' pares decididos';
}
document.addEventListener('change', function(e){
  if (e.target.classList.contains('done-par')) atualizaProgresso();
});
window.addEventListener('DOMContentLoaded', atualizaProgresso);
"""


def carregar(repo_dir):
    def j(*p):
        with open(os.path.join(repo_dir, *p), encoding="utf-8") as f:
            return json.load(f)
    gus = j("qualidade", "qualidade_gustavo.json")["anotacoes"]
    fel = j("qualidade", "qualidade_felipe.json")["anotacoes"]
    amostra = {p["id"]: p for p in j("positive_quality_sample.json")}
    aud = {}
    auditoria = j("qualidade", "auditoria_llm_2026-06-09.json")
    for bloco in auditoria["auditorias"]:
        for par in bloco["pairs"]:
            aud[par["id"]] = par
    return gus, fel, amostra, aud


def pauta(gus, fel):
    """Pares a adjudicar: incertos de Gustavo + desacordos decididos."""
    itens = []
    for pid in sorted(gus):
        g, f = gus[pid]["veredito"], fel[pid]["veredito"]
        if g == "incerto":
            itens.append((pid, "incerto"))
        elif g != f:
            itens.append((pid, "desacordo"))
    return itens


def bloco_anotador(nome, anot):
    v = anot.get("veredito", "?")
    crit = anot.get("criterio")
    just = anot.get("justificativa", "").strip() or "(sem justificativa)"
    extra = f' · critério: <code>{html.escape(crit)}</code>' if crit else ""
    return (f'<p style="margin:.5em 0 0"><strong>{nome}:</strong> '
            f'<span class="badge" style="background:{VERED_COR.get(v, "#555")}">{v}</span>{extra}</p>'
            f'<div class="just">{html.escape(just)}</div>')


def card(pid, tipo, gus, fel, amostra, aud):
    par = amostra[pid]
    smell = par["smell"]
    cor = SMELL_COR[smell]
    tipo_txt = ("DESACORDO (decidido G≠F)" if tipo == "desacordo"
                else "INCERTO de Gustavo")
    a = aud.get(pid)
    h = [f'<div class="card" id="{pid}" style="border-left-color:{cor}">']
    h.append(
        f'<h3><span class="badge" style="background:{cor}">{smell}</span> '
        f'{pid} <span class="badge" style="background:#44403c">{tipo_txt}</span></h3>')
    h.append(
        f'<p class="kv">{html.escape(par["repo"])} · <code>{html.escape(par["file"])}</code> · '
        f'função <code>{html.escape(par["function_name"])}</code> · commit '
        f'<code>{html.escape(par["commit_hash"][:10])}</code> · origem {html.escape(par["source"])}</p>')

    h.append('<h4 style="margin:.8em 0 .2em">Rodada 1</h4>')
    h.append(bloco_anotador("Gustavo", gus[pid]))
    h.append(bloco_anotador("Filipe", fel[pid]))

    h.append('<details><summary>Código — BEFORE / AFTER</summary><div class="inner">')
    h.append(f'<p class="kv">BEFORE</p><pre>{html.escape(par["before"])}</pre>')
    h.append(f'<p class="kv">AFTER</p><pre>{html.escape(par["after"])}</pre>')
    h.append('</div></details>')

    if a:
        causas = ", ".join(a["root_causes"])
        h.append('<details><summary>⚖️ 3ª opinião (auditoria LLM) — '
                 'abrir SÓ depois das posições individuais</summary><div class="inner">')
        h.append(
            f'<p>Veredito do auditor: <span class="badge" '
            f'style="background:{VERED_COR.get(a["my_verdict"], "#555")}">{a["my_verdict"]}</span>'
            f' · quem acertou: <strong>{a["who_is_right"]}</strong>'
            f' · salvage: <code>{a["salvage"]}</code></p>')
        h.append(f'<p class="kv">Causas: {html.escape(causas)}</p>')
        h.append(f'<div class="just">{html.escape(_censurar_flag(a["key_observation"]))}</div>')
        h.append('</div></details>')

    h.append(f'''<div class="decisao checklist">
      <strong>Eixo A:</strong>
      <label><input type="checkbox"> A1 assinatura/contrato</label>
      <label><input type="checkbox"> A2 símbolos indefinidos</label>
      <label><input type="checkbox"> A3 curto-circuito</label>
      <label><input type="checkbox"> A4 early-return × tail</label>
      <label><input type="checkbox"> A5 exceções/avisos</label>
      <label><input type="checkbox"> A6 falsas mudanças (não rejeitar)</label><br>
      <strong>Consenso:</strong>
      <label><input type="radio" name="v_{pid}"> genuina</label>
      <label><input type="radio" name="v_{pid}"> lixo</label>
      <label><input type="radio" name="v_{pid}"> incerto</label>
      &nbsp;·&nbsp; <label><input type="checkbox" class="done-par"> par concluído</label>
      <div class="fill" contenteditable="true" title="justificativa do consenso (rascunho — o oficial vai no JSON)"></div>
    </div>''')
    h.append('</div>')
    return "\n".join(h)


def gerar(repo_dir, saida):
    gus, fel, amostra, aud = carregar(repo_dir)
    itens = pauta(gus, fel)
    por_smell = {}
    for pid, tipo in itens:
        por_smell.setdefault(amostra[pid]["smell"], []).append((pid, tipo))

    n_inc = sum(1 for _, t in itens if t == "incerto")
    n_des = len(itens) - n_inc

    corpo = []
    corpo.append(f"""
<h1>Manual da Sessão de Adjudicação — Sonda de Qualidade</h1>
<p class="sub">Gustavo + Filipe · {len(itens)} pares ({n_inc} incertos + {n_des} desacordos) ·
~5 min/par ≈ 2h · gerado de <code>qualidade_*.json</code> + auditoria LLM de 2026-06-09</p>

<h2>1. Por que esta sessão (contexto em 2 minutos)</h2>
<p>Na rodada 1 anotamos os mesmos 50 pares às cegas: <strong>Gustavo</strong> 17 genuína /
20 lixo / 13 incerto; <strong>Filipe</strong> 35 genuína / 15 lixo / 0 incerto;
<strong>κ=0,28</strong> (meta ≥0,61). O diagnóstico não é "alguém anotou mal": nós respondemos
<em>perguntas diferentes</em> — Filipe julgou <em>"é uma refatoração real?"</em> e Gustavo
<em>"serve como exemplo de treino?"</em>. Entre os 37 pares que ambos decidiram, concordamos em
73%, e 9 dos 10 desacordos vão na mesma direção. Isso se conserta com uma régua única
(o CODEBOOK v2, resumido abaixo) e esta sessão de negociação.</p>
<p>Uma re-auditoria automatizada par a par (lendo o código antes das nossas justificativas)
também encontrou um ponto cego <em>comum</em>: nenhum de nós verifica comportamento
sistematicamente — ex.: r1_000001 tem um bug real no after (o upstream do sympy corrigiu depois)
e r3_000009 foi aprovado por nós dois com assinatura mudada e atributo inexistente.
Por isso o Eixo A abaixo é um checklist <em>mecânico</em>, a ser rodado em voz alta.</p>
<div class="aviso"><strong>O que esta sessão NÃO é:</strong> não estamos re-medindo κ (a medição
independente da rodada 1 já está registrada; o κ pós-codebook virá de pares NOVOS anotados
independentemente em julho). Estamos produzindo os <strong>rótulos-consenso (gold)</strong>
destes {len(itens)} pares e testando o codebook em casos reais.</div>

<h2>2. A régua: pergunta única + dois eixos</h2>
<div class="regra"><strong>Pergunta única:</strong> "este par é um exemplar de treino de alta
qualidade para o smell rotulado?" — <strong>genuina = Eixo A ∧ Eixo B</strong>. Falhou A ou B →
<strong>lixo</strong> (com critério). <strong>incerto</strong> SOMENTE quando o snippet não
permite decidir (símbolo/efeito fora do recorte) — "resolveu só em parte" NÃO é incerto, é lixo
(<code>after_nao_resolve</code>).</div>

<h3>Eixo A — comportamento preservado? (eliminatório, checklist mecânico)</h3>
<table>
<tr><th>#</th><th>Checar</th><th>Anti-exemplo da rodada 1</th></tr>
<tr><td>A1</td><td>Assinatura/contrato: aridade, defaults, tipo e valores de retorno (laziness
conta: lista→generator muda)</td><td>r2_000005 (11-tupla→2-tupla); r3_000009 (int→Enum)</td></tr>
<tr><td>A2</td><td>Símbolos indefinidos: o after usa nome não definido no snippet nem visível no
before? → no mínimo incerto</td><td>r3_000009 (<code>cs._arg2scope</code>); r4_000009</td></tr>
<tr><td>A3</td><td>Curto-circuito: chamadas com efeito colateral combinadas com
<code>or</code>/<code>and</code></td><td>r1_000002</td></tr>
<tr><td>A4</td><td>Early-return × tail: ramo extraído com return deixa de passar por
pós-processamento comum do original?</td><td>r1_000001 (bug confirmado vs upstream)</td></tr>
<tr><td>A5</td><td>Exceções/avisos: mesmos tipos, condições e mensagens; warn→raise é
mudança</td><td>r4_000002</td></tr>
<tr><td>A6</td><td><strong>Falsas mudanças — NÃO rejeitar:</strong> elif→if com todos os ramos
terminando; pass→return vazio em generator; remoção de else após ramo que
termina</td><td>r4_000005, r4_000010 (erros de percepção da rodada 1)</td></tr>
</table>

<h3>Eixo B — smell materialmente resolvido, no escopo? (eliminatório)</h3>
<table>
<tr><th>Smell</th><th>Limiar de resolução</th><th>Armadilhas</th></tr>
<tr><td><strong>R1</strong></td><td>principal vira orquestração de passos nomeados num só nível;
≥3 seções comentadas ou &gt;40 linhas heterogêneas restantes = mitigação</td><td>NÃO exigir
decomposição de sequência coesa de algoritmo (over-extraction também é falha); eliminar
duplicação ≥2× é resolução material mesmo se a função continua longa</td></tr>
<tr><td><strong>R2</strong></td><td>assinatura final ≤5 com objeto coeso nomeado pelo domínio
(13→10 é mitigação)</td><td><code>**kwargs</code>/dict cru OCULTA o smell; desempacotamento em
massa no topo invalida; definição do objeto deve estar visível</td></tr>
<tr><td><strong>R3</strong></td><td>zero literais opacos restantes E constantes acopladas do
mesmo conceito nomeadas juntas</td><td>literais estruturais (índice, step, 0/0.0, i+1) e
idiomáticos NÃO contam como resíduo; diff válido = só +definições e trocas 1-para-1</td></tr>
<tr><td><strong>R4</strong></td><td>profundidade máxima cai ≥1 nível com happy path no nível
mais raso; before com profundidade ≥3</td><td>remover else após return sozinho NÃO resolve;
técnica-alvo é guard clause/continue — Extract Method não conta; elif-ladder de despacho não é
deep nesting</td></tr>
<tr><td><strong>R5</strong></td><td>fecho transitivo do código morto removido; diff =
exclusivamente remoções</td><td><strong>teste de intenção:</strong> valor que obviamente deveria
ser retornado/propagado = BUG, não smell (lixo/outro, "bugfix disfarçado"); dead store com RHS
efeitoso: remover só o binding, manter a chamada</td></tr>
</table>

<h2>3. Protocolo (por par, ~5 min)</h2>
<ol>
<li><strong>Checklist A juntos, em voz alta</strong> (A1–A6 sobre o código). Falhou A →
<code>lixo / muda_comportamento</code>, fim — não debater B.</li>
<li><strong>Posições individuais ANTES de discutir</strong>: cada um declara veredito + motivo em
1 frase (evita ancoragem).</li>
<li><strong>Discutir B</strong> com os limiares da tabela.</li>
<li><strong>Só então abrir a 3ª opinião</strong> (bloco ⚖️ do par) como insumo de desempate — a
decisão é nossa, não do auditor. <em>Obs.: a auditoria às vezes menciona o proxy; tratar como
contexto — a decisão se ancora no código.</em></li>
<li><strong>Registrar veredito + justificativa escrita</strong> (obrigatória, inclusive
genuina).</li>
<li><strong>Persistiu o desacordo?</strong> → <code>lixo</code> (conservador para gold) com o
dissenso registrado na justificativa.</li>
<li><strong>A régua não decidiu limpo?</strong> → emendar o <code>CODEBOOK.md</code> na hora,
anotando qual par forçou a emenda.</li>
</ol>

<h2>4. Pauta ({len(itens)} pares)</h2>
""")

    corpo.append('<p class="toc">' + " · ".join(
        f'<a href="#{pid}">{pid}</a>' for pid, _ in itens) + '</p>')

    for smell in ["R1", "R2", "R3", "R4", "R5"]:
        if smell not in por_smell:
            continue
        corpo.append(f'<h3><span class="badge" style="background:{SMELL_COR[smell]}">{smell}</span> '
                     f'{html.escape(SMELL_NOME[smell])} — {len(por_smell[smell])} par(es)</h3>')
        for pid, tipo in por_smell[smell]:
            corpo.append(card(pid, tipo, gus, fel, amostra, aud))

    corpo.append("""
<h2>5. Saída da sessão</h2>
<ol>
<li>Gravar <code>tp-es2-dataset/qualidade/qualidade_consenso.json</code> no mesmo schema das
anotações individuais (<code>"pesquisador": "consenso"</code>), com os vereditos negociados e a
justificativa de TODOS os pares adjudicados (os checkboxes/rascunhos desta página não persistem —
o JSON é o registro oficial).</li>
<li>Re-rodar o scorer: <code>python3 tp-es2-anotador/tools/score_qualidade.py --repo-dir
tp-es2-dataset</code> e registrar κ pré (0,28) e a precisão por smell do consenso.</li>
<li>Commitar emendas feitas ao <code>CODEBOOK.md</code> citando os pares que as motivaram.</li>
<li>Os pares consenso-genuína viram os few-shots dos templates de geração (Trilha 2).</li>
</ol>
<p class="sub">Referências: CODEBOOK completo em <code>tp-es2-anotador/CODEBOOK.md</code> ·
auditoria par a par em <code>tp-es2-dataset/qualidade/AUDITORIA_LLM.md</code>.</p>
""")

    doc = ("<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'>"
           "<meta name='viewport' content='width=device-width, initial-scale=1'>"
           "<title>Manual da Sessão de Adjudicação — Sonda de Qualidade</title>"
           f"<style>{CSS}</style></head><body>"
           "<div id='progresso'></div><main>"
           + "\n".join(corpo) +
           f"</main><script>{JS}</script></body></html>")

    with open(saida, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"ok: {saida} ({os.path.getsize(saida)/1024:.0f} KB, {len(itens)} pares na pauta)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-dir", required=True, help="caminho do tp-es2-dataset")
    ap.add_argument("--saida", default=None,
                    help="HTML de saída (default: <repo-dir>/qualidade/MANUAL_ADJUDICACAO.html)")
    args = ap.parse_args()
    saida = args.saida or os.path.join(args.repo_dir, "qualidade", "MANUAL_ADJUDICACAO.html")
    gerar(args.repo_dir, saida)
