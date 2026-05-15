# Anotador de smells aparentes

Ferramenta web para o **movimento 3** da `NOTA_DADOS_NEGATIVOS` — revisão
manual do seed de smells aparentes (TP Engenharia de Software II).

As anotações são lidas e gravadas **automaticamente** num repositório privado
do GitHub. Cada pesquisador continua de onde parou em qualquer máquina.

## Arquitetura — dois repositórios

| Repositório | Visibilidade | Conteúdo |
|---|---|---|
| `tp-es2-anotador` | público | só o app (`index.html`, `style.css`, `app.js`) — nenhum dado |
| `tp-es2-dataset` | **privado** | `examples.json` (os 1356 exemplos) + `anotacoes/anotacoes_<nome>.json` |

O app é servido por GitHub Pages (público, mas sem dados). Os dados ficam no
repo privado; o app os acessa com o **token pessoal** de cada revisor. Nada
sensível é exposto.

## Setup inicial (Gustavo, uma vez)

1. O repo privado `tp-es2-dataset` já existe com `examples.json`.
2. Adicionar Bernardo e Felipe como **colaboradores**:
   `tp-es2-dataset` → Settings → Collaborators → Add people.
3. Mandar a URL do app (GitHub Pages do `tp-es2-anotador`) para os dois.

## Como cada pesquisador anota

1. Abrir a URL do app, **selecionar seu nome**.
2. Na primeira vez, colar um **token de acesso pessoal** do GitHub
   (instruções na própria tela). O token fica salvo só no navegador.
   Resumo: github.com/settings/tokens/new → escopo `repo` → gerar → copiar.
3. Anotar. Cada exemplo: veredicto (`1`/`2`/`3`), confiança, contexto
   suficiente, justificativa e (se `real`) motivo.
4. O chip no topo mostra o estado da sincronização (● sincronizado).
   Tudo é gravado sozinho no repo privado — não precisa exportar nada.
5. Teclas: `1/2/3` veredicto · `← →` navegar · `N` próximo vazio.

## Esquema de revisão dupla

| Bloco | Revisores | Exemplos |
|---|---|---|
| 1 | Gustavo + Bernardo | 455 |
| 2 | Gustavo + Felipe | 452 |
| 3 | Bernardo + Felipe | 449 |

Cada pessoa anota 2 blocos (~900). Cada exemplo recebe 2 anotações
independentes → permite medir Cohen's kappa.

## Fechar a revisão

Quando todos terminarem, clonar o repo privado e mesclar:

```
git clone https://github.com/Gronoxx/tp-es2-dataset
cp tp-es2-dataset/anotacoes/anotacoes_*.json dados_negativos/anotacoes/
python3 dados_negativos/mesclar_anotacoes.py
```

→ gera `seed_revisado.jsonl`, o kappa por par e a lista de conflitos.

## Desenvolvimento

`examples.json` é gerado por `../gerar_anotador.py` e versionado no repo
privado. Para atualizar o app, editar os arquivos aqui e dar push no
`tp-es2-anotador`.
