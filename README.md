# Anotador de smells aparentes

Ferramenta web estática (sem backend) para o **movimento 3** da
`NOTA_DADOS_NEGATIVOS` — revisão manual do seed de smells aparentes.
Cada um dos 3 pesquisadores rotula seus exemplos; o progresso fica salvo no
navegador; ao final cada um exporta um JSON que é mesclado por
`mesclar_anotacoes.py`.

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` `style.css` `app.js` | a aplicação |
| `examples.js` | os 1356 exemplos, gerados por `../gerar_anotador.py` |

`examples.js` é regenerável: `python3 ../gerar_anotador.py`.

## Como hospedar (GitHub Pages)

1. Subir o conteúdo desta pasta para a raiz de um repositório **público**.
2. Settings → Pages → Branch `main` / `/ (root)` → Save.
3. A URL `https://<usuario>.github.io/<repo>/` é o que o trio acessa.

Funciona também localmente: `python3 -m http.server` nesta pasta e abrir
`http://localhost:8000` (abrir o `index.html` direto por `file://` também
funciona — os dados estão embutidos em `examples.js`, não há `fetch`).

## Como anotar (cada pesquisador)

1. Abrir a URL, **selecionar seu nome**. Você recebe seus ~900 exemplos
   (2 blocos). O progresso é salvo automaticamente neste navegador.
2. Para cada exemplo, preencher:
   - **veredicto** (teclas `1`/`2`/`3`): aparente · real · incerto
   - **confiança**: alta · média · baixa
   - **contexto suficiente?**: sim · não — mede a limitação L3 da NOTA
   - **justificativa**: obrigatória para `real`/`incerto`, opcional p/ `aparente`
   - **motivo** (só se `real`): por que estava sinalizado/suprimido
3. Teclas: `1/2/3` veredicto · `← →` navegar · `N` próximo vazio · `Esc` sair do texto.
4. **Exportar** (botão no topo) gera `anotacoes_<nome>.json` — fazer isso
   periodicamente e ao terminar; enviar ao Gustavo / comitar no repositório.
5. Trocou de máquina? "Importar anotações" na tela inicial restaura o progresso.

## Esquema de revisão dupla

Cada exemplo é anotado por 2 pesquisadores (revisão dupla de 100% do seed):

| Bloco | Revisores | Exemplos |
|---|---|---|
| 1 | Gustavo + Bernardo | 455 |
| 2 | Gustavo + Felipe | 452 |
| 3 | Bernardo + Felipe | 449 |

Cada pessoa anota 2 blocos (~900). Permite medir Cohen's kappa entre os
revisores — número que vai para o relatório (NOTA §4, L1/L2).

## Depois

Juntar os 3 `anotacoes_*.json` (na pasta `dados_negativos/anotacoes/` ou ao
lado dos scripts) e rodar `python3 ../mesclar_anotacoes.py` → gera
`seed_revisado.jsonl`, o kappa por par e a lista de conflitos a adjudicar.
