#!/usr/bin/env python3
"""Scorer da sonda de qualidade dos pares (TP ES2).

Junta a amostra original (positive_quality_sample.json — COM a flag
ast_pattern_match) com as anotacoes humanas (qualidade/qualidade_<nome>.json) e
produz os tres numeros que a sonda existe para dar:

  1. Precisao da classe positiva — que fracao dos pares "REAL" do Gemma sao
     refatoracoes genuinas (por smell e no total), com IC95% (Wilson).
  2. Cohen's kappa entre os dois anotadores (concordancia / validade do rotulo).
  3. Correlacao proxy<->humano — o ast_pattern_match preve o que o humano chama
     de genuino? (decide se da pra filtrar os 616 em lote pelo proxy.)

Politica do INCERTO (explicita, porque move o numero): por padrao o 'incerto' e
EXCLUIDO do denominador da precisao; o script tambem reporta a variante
conservadora (incerto contado como nao-genuino) e o numero de incertos. So usa
stdlib. n por smell e ~10 -> ICs largos (~+/-25-28pp): o script IMPRIME o IC,
nunca so o ponto, para nao virar fato citado fora de contexto.

Uso:
  python3 score_qualidade.py --repo-dir /caminho/para/tp-es2-dataset
  python3 score_qualidade.py --sample positive_quality_sample.json \
      --anotacoes qualidade/qualidade_gustavo.json qualidade/qualidade_felipe.json
"""
import argparse
import glob
import json
import math
import os
from collections import defaultdict

Z = 1.96  # IC 95%
SMELLS = ['R1', 'R2', 'R3', 'R4', 'R5']


def wilson(k, n):
    """IC95% de Wilson para proporcao k/n. Retorna (p, lo, hi) em pontos [0,1]."""
    if n == 0:
        return (float('nan'), float('nan'), float('nan'))
    p = k / n
    den = 1 + Z * Z / n
    centro = (p + Z * Z / (2 * n)) / den
    meia = Z * math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / den
    return (p, max(0.0, centro - meia), min(1.0, centro + meia))


def pct(x):
    return '—' if x != x else f'{100 * x:.0f}%'  # x!=x => NaN


def linha_prec(rot, k, n):
    p, lo, hi = wilson(k, n)
    if n == 0:
        return f'  {rot:<14} sem dados'
    meia = (hi - lo) / 2
    return (f'  {rot:<14} {k}/{n} genuínas = {pct(p)}  '
            f'(IC95% {pct(lo)}–{pct(hi)}, ~±{100 * meia:.0f}pp)')


def carregar_amostra(caminho):
    raw = json.load(open(caminho, encoding='utf-8'))
    if isinstance(raw, dict):
        raw = raw.get('pares') or raw.get('amostra') or []
    amostra = {}
    for i, d in enumerate(raw):
        def pick(*ks):
            for k in ks:
                if d.get(k) is not None:
                    return d[k]
            return None
        pid = str(pick('id', 'pair_id', '_id') or f'par_{i}')
        smell = str(pick('smell', 'smell_type', 'smell_code') or '?').upper()
        flag = pick('ast_pattern_match', 'ast_match', 'proxy_match')
        amostra[pid] = {'smell': smell, 'flag': (None if flag is None else bool(flag))}
    return amostra


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
    """pares: lista de (rotulo_a, rotulo_b). Kappa de Cohen multi-classe."""
    n = len(pares)
    if n == 0:
        return float('nan'), 0
    cats = sorted({x for ab in pares for x in ab})
    po = sum(1 for a, b in pares if a == b) / n
    ma = {c: sum(1 for a, _ in pares if a == c) / n for c in cats}
    mb = {c: sum(1 for _, b in pares if b == c) / n for c in cats}
    pe = sum(ma[c] * mb[c] for c in cats)
    if pe >= 1.0:
        return 1.0, n
    return (po - pe) / (1 - pe), n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo-dir', default=None,
                    help='dir do tp-es2-dataset (acha sample + qualidade/*.json)')
    ap.add_argument('--sample', default=None)
    ap.add_argument('--anotacoes', nargs='*', default=None)
    args = ap.parse_args()

    if args.repo_dir:
        args.sample = args.sample or os.path.join(args.repo_dir, 'positive_quality_sample.json')
        if args.anotacoes is None:
            args.anotacoes = sorted(glob.glob(os.path.join(args.repo_dir, 'qualidade', 'qualidade_*.json')))
    if not args.sample or not args.anotacoes:
        ap.error('informe --repo-dir OU (--sample e --anotacoes)')

    amostra = carregar_amostra(args.sample)
    anotadores = [carregar_anot(c) for c in args.anotacoes]
    print(f'Amostra: {len(amostra)} pares · anotadores: '
          + ', '.join(f'{n} ({len(a)} anotados)' for n, a in anotadores))
    ausentes = sorted(amostra and {k for _, a in anotadores for k in a if k not in amostra})
    if ausentes:
        print(f'  aviso: {len(ausentes)} id(s) anotado(s) fora da amostra (ignorados): {ausentes[:5]}…')

    GEN = 'genuina'
    print('\n=== 1. PRECISAO DA CLASSE POSITIVA (por anotador) ===')
    print('  Politica: incerto EXCLUIDO do denominador (variante conservadora entre parenteses).')
    for nome, anot in anotadores:
        print(f'\n  • {nome}')
        # geral
        labs = [(pid, v) for pid, v in anot.items() if pid in amostra]
        gen = sum(1 for _, v in labs if v == GEN)
        inc = sum(1 for _, v in labs if v == 'incerto')
        dec = sum(1 for _, v in labs if v != 'incerto')  # decididos (genuina/lixo)
        print('   ' + linha_prec('GERAL', gen, dec) + f'  · incertos: {inc}')
        if dec:
            pc, lo, hi = wilson(gen, len(labs))  # conservador: incerto no denominador
            print(f'                 conservador (incerto=lixo): {gen}/{len(labs)} = {pct(pc)}')
        # por smell
        for s in SMELLS:
            ls = [(pid, v) for pid, v in labs if amostra[pid]['smell'] == s]
            g = sum(1 for _, v in ls if v == GEN)
            d = sum(1 for _, v in ls if v != 'incerto')
            if ls:
                print('   ' + linha_prec(s, g, d))

    print('\n=== 2. CONCORDANCIA ENTRE ANOTADORES (Cohen kappa) ===')
    if len(anotadores) >= 2:
        (na, aa), (nb, ab) = anotadores[0], anotadores[1]
        comuns = [pid for pid in amostra if pid in aa and pid in ab]
        # 3 classes
        pares3 = [(aa[p], ab[p]) for p in comuns]
        k3, n3 = cohen_kappa(pares3)
        # binario: genuina vs resto
        binr = lambda v: 'gen' if v == GEN else 'nao'
        k2, n2 = cohen_kappa([(binr(aa[p]), binr(ab[p])) for p in comuns])
        conc = sum(1 for a, b in pares3 if a == b)
        print(f'  {na} × {nb} · {n3} pares em comum · concordancia bruta {pct(conc / n3) if n3 else "—"}')
        print(f'  kappa (genuína/lixo/incerto): {k3:.2f}' if k3 == k3 else '  kappa: sem dados')
        print(f'  kappa (genuína vs resto):     {k2:.2f}' if k2 == k2 else '')
        print('  referencia: κ≥0.61 = concordancia substancial (meta do protocolo)')
        if n3 < 20:
            print(f'  aviso: só {n3} pares em comum — κ instável; trate como indicativo.')
    else:
        print('  precisa de 2 anotadores para kappa.')

    print('\n=== 3. PROXY AST × HUMANO (a flag prevê "genuína"?) ===')
    tem_flag = [p for p in amostra if amostra[p]['flag'] is not None]
    if not tem_flag:
        print('  a amostra não traz ast_pattern_match — sem como calibrar o proxy.')
    else:
        # verdade = consenso (ambos genuína) quando 2 anotaram; senao o unico veredito
        def verdade(pid):
            vs = [a[pid] for _, a in anotadores if pid in a]
            if not vs:
                return None
            if any(v == 'incerto' for v in vs):
                return None
            return all(v == GEN for v in vs)  # True=genuína (consenso), False=algum lixo
        cel = defaultdict(int)  # (flag, genuina) -> n
        for pid in tem_flag:
            g = verdade(pid)
            if g is None:
                continue
            cel[(amostra[pid]['flag'], g)] += 1
        tt, tf = cel[(True, True)], cel[(True, False)]   # flag=T
        ft, ff = cel[(False, True)], cel[(False, False)]  # flag=F
        nT, nF = tt + tf, ft + ff
        print(f'  base: pares com flag E veredito humano decidido (consenso) = {nT + nF}')
        print(f'  flag=match=True : {tt}/{nT} genuínas = {pct(tt / nT) if nT else "—"}  (precisão do proxy)')
        print(f'  flag=match=False: {ft}/{nF} genuínas = {pct(ft / nF) if nF else "—"}  (o que escaparia)')
        if nT and nF:
            lift = (tt / nT) - (ft / nF)
            print(f'  lift (T menos F): {100 * lift:+.0f}pp — quanto maior, mais o proxy separa genuína de lixo')
        print('  leitura: proxy só serve de filtro em lote se precisão(T) for alta E (F) baixa.')
        print('  cuidado: n pequeno aqui também — confirme antes de filtrar os 616 por ele.')

    print('\n(IMPORTANTE: com ~10 pares/smell os ICs são largos; estes números decidem '
          'VAI/NÃO-VAI e se o proxy presta — não são a precisão final por smell.)')


if __name__ == '__main__':
    main()
