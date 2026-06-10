# CODEBOOK — vereditos de qualidade de pares de refatoração (v2, 2026-06-09)

Regra de decisão unificada para anotação e adjudicação dos pares before→after. Substitui o critério implícito da rodada 1 da sonda (κ=0,28), cujo desacordo foi diagnosticado como **divergência de pergunta**: Felipe respondeu "é uma refatoração real?" e Gustavo respondeu "serve para treino?". Este codebook fixa a pergunta única: **"este par é um exemplar de treino de alta qualidade para o smell rotulado?"**

Material derivado das justificativas humanas da sonda + re-auditoria LLM par a par (`tp-es2-dataset/qualidade/AUDITORIA_LLM.md`, seções "Material de rubrica").

## A regra dos dois eixos (ambos eliminatórios)

**`genuina` = A ∧ B.** Falhou A ou B → `lixo` (com critério). `incerto` SOMENTE quando o snippet não permite decidir (símbolos/efeitos fora do recorte) — não para "resolveu só em parte" (isso é B falso → `lixo`).

### Eixo A — Comportamento preservado? (eliminatório)

Checklist mecânico — responda TODOS antes do veredito:

1. **Assinatura/contrato**: aridade, tipos, defaults, tipo do retorno (inclusive laziness: lista→generator conta) e valores retornados são os mesmos? *(anti-exemplos: r2_000005 11-tupla→2-tupla; r3_000009 int→Enum)*
2. **Símbolos indefinidos**: o after referencia algum nome que não está definido no snippet nem visível no before? → no mínimo `incerto`. *(r3_000009 `cs._arg2scope`; r4_000009 `_check_valid_mode_shapes`)*
3. **Curto-circuito**: chamadas com efeito colateral foram combinadas com `or`/`and`? A segunda deixa de executar. *(r1_000002)*
4. **Early-return vs tail**: ao extrair/retornar cedo um ramo, algum código posterior do original (pós-processamento comum) deixou de se aplicar àquele ramo? *(r1_000001 — confirmado bug; o upstream corrigiu depois)*
5. **Exceções e avisos**: mesmas exceções, mesmos tipos, mesmas condições, mesmas mensagens; `warn`→`raise` é mudança de comportamento. *(r4_000002)*
6. **Equivalências que NÃO são mudança** (não rejeitar por engano): `elif`→`if` quando todos os ramos terminam em return/raise; `pass`→`return` vazio dentro de generator; remoção de else após ramo que termina. *(erros de percepção da rodada 1: r4_000005, r4_000010)*

### Eixo B — Smell materialmente resolvido, no escopo? (eliminatório)

1. **O before tem o smell rotulado de verdade** (não um vizinho: elif-ladder de despacho não é deep nesting; comprimento por aridade/docstring não é long method; dead store que é sintoma de bug não é dead code — ver R5).
2. **Resolução material, não mitigação marginal**: limiar por smell abaixo. "Mitigou" → `lixo` (criterio `after_nao_resolve`), mas o before continua aproveitável para regeneração.
3. **Diff restrito ao escopo do smell**: proibido renomear em massa, modernizar anotações, corrigir bugs, mudar API/algoritmo no mesmo diff. Mudança cosmética só se trivial e pontual.
4. **Autocontenção**: definição de constantes/objetos/helpers novos visível no after.

## Limiares por smell

**R1 (Long Method→Extract Method).** Smell presente = responsabilidades distintas identificáveis (seções comentadas, duplicação ≥2×, aninhamento ≥3, fases preparar/processar/finalizar). Resolvido = principal lê como orquestração de passos nomeados num único nível de abstração; se restam ≥3 seções comentadas ou >40 linhas heterogêneas, é mitigação. NÃO exigir decomposição de sequência intrinsecamente coesa de algoritmo (over-extraction também é falha — r1_000004 e r1_000010 são genuínos). Extração que elimina duplicação ≥2× é resolução material mesmo se a função continua longa pelo algoritmo em si (r1_000010).

**R2 (Long Param List→Parameter Object).** Resolvido = assinatura final ≤5 parâmetros com objeto coeso nomeado pelo domínio (13→10 é mitigação). `**kwargs`/dict cru OCULTA o smell, não resolve (r2_000007). Desempacotamento em massa do objeto no topo do corpo invalida (bundle-sacola, r2_000002). Definição do objeto (dataclass/NamedTuple) deve estar visível.

**R3 (Magic Numbers→Named Constant).** Classificar literais: mágico (nomear) / estrutural — índice, step, acumulador 0/0.0, i+1 (NUNCA nomear; não contar como smell residual — erro da rodada 1 em r3_000010) / idiomático-autoexplicativo (`date(y,m,1)`, largura de format — não nomear). Resolvido = zero literais opacos restantes E constantes acopladas do mesmo conceito nomeadas juntas (nomear o pivô 90 e deixar 1900/2000 é incoerente — r3_000008). Diff válido = só +definições e substituições 1-para-1. Definição da constante DEVE aparecer no after.

**R4 (Deep Nesting→Guard Clauses).** Smell presente = profundidade ≥3 no caminho principal. Resolvido = profundidade máxima cai ≥1 nível com happy path no nível mais raso; remover else/elif após return sozinho NÃO resolve (r4_000001, r4_000005). Técnica-alvo: inversão de condição, early return/raise, continue — Extract Method/Class não conta para R4. Verificação: bijeção dos caminhos (condição→efeitos→saída) entre before e after.

**R5 (Dead Code→Remove).** Antes de tudo, **teste de intenção**: se o valor morto obviamente deveria ser retornado/propagado (função computa e descarta sem return; nome atribuído ≠ nome usado), é BUG, não smell — par `lixo` (criterio `outro`, anotar "bugfix disfarçado"); after que "conserta" adicionando return muda comportamento (r5_6/7/8 — 30% da amostra da sonda). Dead store com RHS efeitoso: remover só o binding, manter a chamada (r5_9, r5_10). Resolvido = fecho transitivo removido (a remoção pode matar outras atribuições — r5_1 deixou resíduos); diff = exclusivamente remoções.

## Protocolo de adjudicação da sonda (rodada 2)

1. Pauta: os **13 `incerto` de Gustavo** + os **10 desacordos decididos** (G≠F): r1_000006/7/10, r2_000002/6, r3_000010, r4_000004/5/9, r5_000003.
2. Para cada par: aplicar o checklist A (mecânico, juntos), depois B com os limiares acima. A re-auditoria LLM (`AUDITORIA_LLM.md`) serve como terceira opinião informativa — a decisão é humana.
3. **Justificativa obrigatória em TODO veredito, inclusive `genuina`** (na rodada 1 os positivos sem justificativa ficaram inauditáveis).
4. Registrar consenso em `tp-es2-dataset/qualidade/qualidade_consenso.json` (mesmo schema, `pesquisador: "consenso"`), re-rodar `tools/score_qualidade.py` e reportar κ pré (0,28) e pós-negociação.

## Vereditos e critérios (inalterados do harness)

`genuina` · `lixo` (criterio: `before_sem_smell` | `after_nao_resolve` | `muda_comportamento` | `outro`) · `incerto` (só por inverificabilidade) · `snippet_completo: sim|nao`.
