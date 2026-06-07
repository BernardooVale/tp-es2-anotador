#!/usr/bin/env python3
"""Scorer da sonda de qualidade dos pares (TP ES2).

Junta a amostra original (positive_quality_sample.json — COM a flag
ast_pattern_match) com as anotacoes humanas (qualidade/qualidade_<nome>.json) e
produz os numeros que a sonda existe para dar:

  1. Precisao da classe positiva — que fracao dos pares "REAL" do Gemma sao
     refatoracoes genuinas (por smell e no total). A amostra e balanceada ~5
     true/5 false por smell PARA CALIBRAR O PROXY, entao a taxa crua e ENVIESADA;
     se houver positive_quality_sample.meta.json (taxas-base por smell), o scorer
     REPONDERA os estratos e reporta a precisao POPULACIONAL (o numero certo).
  2. Cohen's kappa entre os dois anotadores.
  3. Correlacao proxy<->humano — o ast_pattern_match preve "genuina"?

Politica do INCERTO (explicita): EXCLUIDO do denominador da precisao; tambem se
reporta a variante conservadora (incerto = nao-genuino). n por smell e ~10 e por
estrato ~5 -> ICs largos: o scorer IMPRIME o IC (normal-approx, aproximado),
nunca so o ponto. So usa stdlib.

Uso:
  python3 score_qualidade.py --repo-dir /caminho/para/tp-es2-dataset
  python3 score_qualidade.py --sample positive_quality_sample.json \
      --meta positive_quality_sample.meta.json \
      --anotacoes qualidade/qualidade_gustavo.json qualidade/qualidade_felipe.json
"""
import argparse
import glob
import json
import math
import os
from collections import defaultdict

Z = 1.96
SMELLS = ['R1', 'R2', 'R3', 'R4', 'R5']
GEN = 'genuina'


def wilson(k, n):
    if n == 0:
        return (float('nan'), float('nan'), float('nan'))
    p = k / n
    den = 1 + Z * Z / n
    centro = (p + Z * Z / (2 * n)) / den
    meia = Z * math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / den
    return (p, max(0.0, centro - meia), min(1.0, centro + meia))


def pct(x):
    return '—' if x != x else f'{100 * x:.0f}%'


def carregar_amostra(caminho):
    raw = json.load(open(caminho, encoding='utf-8'))
    if isinstance(raw, dict):
        raw = raw.get('pares') or raw.get('amostra') or []
    out = {}
    for i, d in enumerate(raw):
        def pick(*ks):
            for k in ks:
                if d.get(k) is not None:
                    return d[k]
            return None
        pid = str(pick('id', 'pair_id', '_id') or f'par_{i}')
        smell = str(pick('smell', 'smell_type', 'smell_code') or '?').upper()
        flag = pick('ast_pattern_match', 'ast_match', 'proxy_match')
        out[pid] = {'smell': smell, 'flag': (None if flag is None else bool(flag))}
    return out


def carregar_meta(caminho):
    """-> {smell: {real, flag_true, flag_false}} ou None."""
    if not caminho or not os.path.exists(caminho):
        return None
    m = json.load(open(caminho, encoding='utf-8'))
    tb = m.get('taxa_base_por_smell') or m.get('base_rates') or {}
    return {s.upper(): v for s, v in tb.items()} or None


def carregar_anot(caminho):
    obj = json.load(open(caminho, encoding='utf-8'))
    nome = obj.get('pesquisador') or os.path.basename(caminho)
    anot = obj.get('anotacoes', obj if isinstance(obj, dict) else {})
    out = {}
    for pid, a in anot.items():
        v = (a or {}).get('veredito')
        if v:
            out[str(pid)] = v
    return nome, out


def cohen_kappa(pares):
    n = len(pares)
    if n == 0:
        return float('nan'), 0
    cats = sorted({x for ab in pares for x in ab})
    po = sum(1 for a, b in pares if a == b) / n
    ma = {c: sum(1 for a, _ in pares if a == c) / n for c in cats}
    mb = {c: sum(1 for _, b in pares if b == c) / n for c in cats}
    pe = sum(ma[c] * mb[c] for c in cats)
    return (1.0 if pe >= 1 else (po - pe) / (1 - pe)), n


def reweight_smell(cells_sf, base):
    """cells_sf: {flag(bool): (k_gen, n_decididos)} para um smell.
       base: {real, flag_true, flag_false}.
       -> (p_pop, ci_meia) reponderando estratos pela taxa-base. nan se sem dados."""
    real = base.get('real') or (base.get('flag_true', 0) + base.get('flag_false', 0))
    if not real:
        return (float('nan'), float('nan'))
    pesos = {True: base.get('flag_true', 0) / real, False: base.get('flag_false', 0) / real}
    # estratos com dados anotados decididos
    disp = {f: cells_sf[f] for f in (True, False) if f in cells_sf and cells_sf[f][1] > 0}
    if not disp:
        return (float('nan'), float('nan'))
    wsum = sum(pesos[f] for f in disp) or 1.0
    p = var = 0.0
    for f, (k, n) in disp.items():
        w = pesos[f] / wsum            # renormaliza se um estrato faltar
        ph, lo, hi = wilson(k, n)      # SE via Wilson — nao colapsa a 0 quando p=0/1
        se = (hi - lo) / 2 / Z
        p += w * ph
        var += (w ** 2) * (se ** 2)
    return (p, Z * math.sqrt(var))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo-dir', default=None)
    ap.add_argument('--sample', default=None)
    ap.add_argument('--meta', default=None)
    ap.add_argument('--anotacoes', nargs='*', default=None)
    args = ap.parse_args()

    if args.repo_dir:
        args.sample = args.sample or os.path.join(args.repo_dir, 'positive_quality_sample.json')
        args.meta = args.meta or os.path.join(args.repo_dir, 'positive_quality_sample.meta.json')
        if args.anotacoes is None:
            args.anotacoes = sorted(glob.glob(os.path.join(args.repo_dir, 'qualidade', 'qualidade_*.json')))
    if not args.sample or not args.anotacoes:
        ap.error('informe --repo-dir OU (--sample e --anotacoes)')

    amostra = carregar_amostra(args.sample)
    meta = carregar_meta(args.meta)
    anotadores = [carregar_anot(c) for c in args.anotacoes]
    print(f'Amostra: {len(amostra)} pares · base-rates: '
          + ('carregadas' if meta else 'AUSENTES (sem reponderacao)')
          + ' · anotadores: ' + ', '.join(f'{n} ({len(a)})' for n, a in anotadores))

    print('\n=== 1. PRECISAO DA CLASSE POSITIVA ===')
    print('  Politica: incerto EXCLUIDO do denominador. "amostra" e enviesada (5/5);')
    print('  "populacao" reponderada pelas taxas-base do meta — esse e o numero a citar.')
    for nome, anot in anotadores:
        print(f'\n  • {nome}')
        # tally por (smell, flag): k_gen, n_decididos, n_incerto
        cells = defaultdict(lambda: [0, 0, 0])
        for pid, v in anot.items():
            if pid not in amostra:
                continue
            s, f = amostra[pid]['smell'], amostra[pid]['flag']
            c = cells[(s, f)]
            if v == 'incerto':
                c[2] += 1
            else:
                c[1] += 1
                if v == GEN:
                    c[0] += 1
        pop_terms = []   # (peso_real, p_pop, var_meia) p/ agregado
        for s in SMELLS:
            kg = sum(cells[(s, f)][0] for f in (True, False, None))
            nd = sum(cells[(s, f)][1] for f in (True, False, None))
            ni = sum(cells[(s, f)][2] for f in (True, False, None))
            if nd + ni == 0:
                continue
            p, lo, hi = wilson(kg, nd)
            linha = f'    {s}: amostra {kg}/{nd}={pct(p)}'
            if meta and s in meta:
                csf = {f: (cells[(s, f)][0], cells[(s, f)][1]) for f in (True, False)}
                pp, meia = reweight_smell(csf, meta[s])
                linha += f'  |  populacao {pct(pp)}'
                if pp == pp:
                    linha += f' (IC~±{100*meia:.0f}pp)'
                    pop_terms.append((meta[s].get('real', 0), pp, meia))
            if ni:
                linha += f'  · incertos:{ni}'
            print(linha)
        # geral reponderado (ponderado por #REAL de cada smell)
        if pop_terms:
            W = sum(w for w, _, _ in pop_terms) or 1.0
            p_overall = sum(w * p for w, p, _ in pop_terms) / W
            var_overall = sum((w / W) ** 2 * (m / Z) ** 2 for w, _, m in pop_terms)
            print(f'    GERAL (populacional, ponderado por #REAL): {pct(p_overall)} '
                  f'(IC~±{100*Z*math.sqrt(var_overall):.0f}pp)')
        # geral cru, p/ comparacao + conservador
        labs = [(pid, v) for pid, v in anot.items() if pid in amostra]
        g = sum(1 for _, v in labs if v == GEN)
        dec = sum(1 for _, v in labs if v != 'incerto')
        if dec:
            print(f'    GERAL (amostra cru, enviesado): {g}/{dec}={pct(g/dec)} '
                  f'· conservador(incerto=lixo): {g}/{len(labs)}={pct(g/len(labs))}')

    print('\n=== 2. CONCORDANCIA ENTRE ANOTADORES (Cohen kappa) ===')
    if len(anotadores) >= 2:
        (na, aa), (nb, ab) = anotadores[0], anotadores[1]
        comuns = [pid for pid in amostra if pid in aa and pid in ab]
        pares3 = [(aa[p], ab[p]) for p in comuns]
        k3, n3 = cohen_kappa(pares3)
        binr = lambda v: 'gen' if v == GEN else 'nao'
        k2, _ = cohen_kappa([(binr(aa[p]), binr(ab[p])) for p in comuns])
        conc = sum(1 for a, b in pares3 if a == b)
        print(f'  {na} × {nb} · {n3} pares em comum · concordancia bruta '
              + (pct(conc / n3) if n3 else '—'))
        print(f'  kappa (genuína/lixo/incerto): {k3:.2f}' if k3 == k3 else '  sem dados')
        print(f'  kappa (genuína vs resto):     {k2:.2f}' if k2 == k2 else '')
        print('  referencia: κ≥0.61 = concordancia substancial (meta do protocolo)')
        if n3 and n3 < 20:
            print(f'  aviso: só {n3} pares em comum — κ instável; indicativo.')
    else:
        print('  precisa de 2 anotadores para kappa.')

    print('\n=== 3. PROXY AST × HUMANO (a flag prevê "genuína"?) ===')
    tem_flag = [p for p in amostra if amostra[p]['flag'] is not None]
    if not tem_flag:
        print('  amostra sem ast_pattern_match — sem calibracao.')
    else:
        def verdade(pid):
            vs = [a[pid] for _, a in anotadores if pid in a]
            if not vs or any(v == 'incerto' for v in vs):
                return None
            return all(v == GEN for v in vs)   # consenso genuína
        cel = defaultdict(int)
        for pid in tem_flag:
            g = verdade(pid)
            if g is not None:
                cel[(amostra[pid]['flag'], g)] += 1
        tt, tf = cel[(True, True)], cel[(True, False)]
        ft, ff = cel[(False, True)], cel[(False, False)]
        nT, nF = tt + tf, ft + ff
        print(f'  base: pares com flag E veredito decidido (consenso) = {nT + nF}')
        print(f'  flag=True : {tt}/{nT} genuínas = {pct(tt/nT) if nT else "—"}  (precisão do proxy)')
        print(f'  flag=False: {ft}/{nF} genuínas = {pct(ft/nF) if nF else "—"}  (o que escaparia)')
        if nT and nF:
            print(f'  lift (T−F): {100*((tt/nT)-(ft/nF)):+.0f}pp — quanto maior, melhor o proxy separa')
        print('  proxy só serve de filtro em lote se precisão(T) alta E (F) baixa. n pequeno: confirme.')

    print('\n(n≈10/smell e ~5/estrato → ICs largos e normal-approx: decidem VAI/NÃO-VAI '
          'e se o proxy presta, não são a precisão final de produção.)')


if __name__ == '__main__':
    main()
