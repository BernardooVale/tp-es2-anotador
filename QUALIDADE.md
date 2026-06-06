# Sonda de qualidade dos pares (`qualidade.html`)

Segunda ferramenta deste repo, **separada** do anotador de smells aparentes
(`index.html`/`app.js`, que continua intacto). Aqui se anota uma amostra pequena
de **pares before→after** de refatoração, para responder a pergunta que está
aberta desde o começo: **que fração dos pares que o Gemma chamou de REAL são
refatorações genuínas?** (precisão da classe positiva) — e, de brinde, **calibrar
o proxy automático `ast_pattern_match`**.

É a etapa que destrava (ou redireciona) o projeto: garbage in, garbage out. ~50
pares (10 por smell), anotados por **Gustavo + Felipe** às cegas → precisão +
Cohen's κ + correlação proxy↔humano.

## Fluxo

1. A amostra `positive_quality_sample.json` é gerada **na máquina que tem os dados
   rotulados** (os veredictos do Gemma + a flag `ast_pattern_match`) e fica no repo
   **privado** `tp-es2-dataset` (raiz), como o `examples.json`.
2. Gustavo e Felipe abrem `qualidade.html` (GitHub Pages), escolhem o nome, colam o
   token pessoal (escopo `repo`) — o mesmo do anotador de smells.
3. Anotam os 50 pares. As anotações sincronizam sozinhas em
   `tp-es2-dataset/qualidade/qualidade_<nome>.json`.
4. Ao fim, roda-se `tools/score_qualidade.py` (ver abaixo).

Teclas: `1` genuína · `2` lixo · `3` incerto · `← →` navegar · `N` próximo vazio.

**Quer só ver a interface?** Abra `qualidade.html?demo` — carrega
`positive_quality_sample.example.json` (3 pares fabricados), sem token e sem gravar.

## Cego à flag — invariante científico (não cosmético)

O `ast_pattern_match` é **removido de cada par no carregamento**
(`normalizeSample` em `qualidade.js`) — não entra na memória do app nem no DOM. Se
o anotador enxergar a flag, ele ancora nela e a calibração proxy↔humano vira
**circular**, anulando a sonda. A flag permanece só no arquivo original, lido
exclusivamente pelo scorer para o join.

## Schema de `positive_quality_sample.json` (o contrato)

Um array de pares. `before`, `after` e `smell` são obrigatórios; o resto é meta de
exibição. `ast_pattern_match` é obrigatório para a calibração do proxy.

```json
[
  {
    "id": "r2_000123",            // único; usado no join com as anotações
    "smell": "R2",               // R1..R5
    "before": "def ...",         // código antes (string)
    "after": "def ...",          // código depois (string)
    "ast_pattern_match": true,   // proxy AST (bool) — o harness REMOVE; só o scorer lê
    "repo": "org/projeto",       // meta opcional
    "file": "pkg/mod.py",        // meta opcional
    "function_name": "foo",      // meta opcional
    "commit_hash": "abc1234",    // meta opcional
    "source": "rule_id_mined"    // meta opcional
  }
]
```

O `normalizeSample` aceita nomes alternativos comuns (`before_code`/`after_code`,
`smell_type`, etc.). Se o arquivo real vier com outro formato, **adapte só essa
função** — é o único ponto que conhece os nomes de campo.

> A geração da amostra (amostrar 10/smell dos pares REAL, manter a flag) acontece
> na máquina que tem os dados rotulados — não foi escrita aqui de propósito, para
> não codar contra um schema não observado. Basta produzir um arquivo neste
> formato (o `positive_quality_sample.example.json` serve de gabarito).

## Rodar o scorer

```bash
# com o tp-es2-dataset clonado e a amostra + qualidade/*.json presentes:
python3 tools/score_qualidade.py --repo-dir /caminho/para/tp-es2-dataset
```

Saída: precisão da classe positiva (geral + por smell, com **IC95% de Wilson** —
nunca o ponto sozinho, porque n≈10/smell dá ±25–28pp), Cohen's κ entre os dois
anotadores, e a tabela proxy↔humano (a flag prevê "genuína"?). Política do
`incerto`: **excluído** do denominador da precisão por padrão; a variante
conservadora (incerto = lixo) também é impressa.

Só usa a stdlib do Python 3.
