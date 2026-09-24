# Análise de Variação — Orçado × Realizado (FP&A)

Painel interno de FP&A, **em um único arquivo**: `dashboard.html`.

## Uso

1. Abra o `dashboard.html` direto no navegador (duplo clique; funciona via `file://`, sem servidor).
2. Arraste o CSV exportado do **Plano** para a tela, ou clique para escolher o arquivo.
3. Confira o **Resumo da carga** (link na barra lateral): linhas ignoradas, avisos e totais por mês,
   para bater com o Plano antes de analisar.

- **100% offline.** Não usa bibliotecas, CDN nem fontes externas. Uma Content-Security-Policy no
  próprio arquivo bloqueia qualquer conexão de rede, então nenhum dado sai do navegador.
- **Trocar base** (barra lateral) volta à tela de carga e mantém a tela atual.
- Atalhos: `Ctrl+K` busca, `?` lista de atalhos, `G` guia de análise, `P` imprimir/PDF.

## Estrutura

| Caminho | O que é |
|---|---|
| `dashboard.html` | O painel (único arquivo distribuído ao time). |
| `tests/regressao.js` | Suíte de regressão (Node + Playwright/Chromium). |
| `tests/gerar_csv.py` | Gera bases sintéticas no formato do Plano (nenhum dado real). |
| `tests/oraculo_python.py` | Roda a lógica original em Python como oráculo. |
| `tests/referencia/` | Painel original, gerador Python original e snapshot aprovado. |

O gerador Python (`tests/referencia/gerar_dashboard.py`) **não é mais usado para gerar o painel**.
Ele serve só de referência: a suíte confere que o JavaScript chega ao mesmo payload, linha a linha
e ao centavo.

## Testes

Requisitos: Python 3, Node 18+ e Playwright com Chromium
(`npm i -D playwright && npx playwright install chromium`).

```
node tests/regressao.js            # todos os testes
node tests/regressao.js A4 C3      # só os que começam com esses ids
node tests/regressao.js T06 --diff # lista o que mudou em relação ao snapshot aprovado
```

O que a suíte garante:

- **T01**: o payload é idêntico ao do painel original e ao do gerador Python.
- **T02**: as métricas de todas as telas, em 24 estados (modo × período × corte × mês), são
  idênticas às do original, exceto as diferenças intencionais listadas no próprio teste, cada uma
  ligada ao item da revisão que a justifica.
- **T05**: o texto visível de todas as telas é idêntico ao original (no estado padrão).
- **T06**: hash de cada métrica e de cada tela contra o **snapshot aprovado**. Qualquer
  refatoração tem de reproduzir o mesmo resultado.
- Um teste por correção (A1…A15, B1, B3, C0…C12, D2, F1), para que uma mudança posterior não
  desfaça uma anterior.

Quando uma mudança **intencional** altera números ou telas:

1. rode `node tests/regressao.js T06 --diff` e confira que só mudou o esperado;
2. rode `node tests/regressao.js T06 --aprovar`;
3. faça o commit do `tests/referencia/snapshot_aprovado.json` junto com a mudança, explicando o porquê.

## Parâmetros de análise

Os limiares das heurísticas (mês parcial, "sem lastro", sistêmico, tendência, anomalia, pares de
contas trocadas, base velha) ficam no objeto `CFG`, no início do script do app, em
`dashboard.html`. As regras de negócio (família "A", unificações, fusão de contas, recorrentes,
Backoffice 6–9, vigiadas, natureza pelo prefixo) ficam nas constantes do carregador e **não foram
alteradas**.

## Regras confirmadas

- **Mês fechado:** o mês precisa ter realizado **e** o CSV precisa ter sido exportado depois de
  **7 dias corridos** após o fim do mês (o fechamento vai até o 2º dia útil, com ajustes na
  primeira semana). Exemplo: agosto fecha a partir de 08/09, 00:00. A referência é a data do
  arquivo exportado (a data da importação só entra se o arquivo não informar data). O Resumo
  da carga mostra, para cada mês em aberto, o motivo e o prazo de ajustes.
- **Pendências:** só a família 3 (receita e dedução) fica fora. A 4.2 e a 4.3 contam como
  pendência e aparecem em "Custos e despesas".
- **Segmentos:** unidades 6xxx–9xxx são Backoffice pela regra do código. O `SEGMAP` não tem
  (nem precisa ter) entradas para elas.

## Dúvidas de regra em aberto

1. As unidades vigiadas continuam aparecendo em "Orçamento sem lastro" e em
   "Lastro sem orçamento". Clicar numa delas agora leva a Exceções.
2. A confiança "lançava todo mês" tolera um mês sem lançamento.
