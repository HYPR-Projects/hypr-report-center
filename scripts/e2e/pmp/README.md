# E2E do PMP Deals — filtros e Analytics

Roteiro de navegador que exercita **todos os filtros** do `/admin/pmp` contra um
backend de mentira, e confere os números na tela contra o total calculado do
fixture. Nasceu do bug em que a aba **Analytics** ignorava os filtros da página
(filtrar `Fonte · PubMatic` mudava a lista e os KPIs do topo, e os gráficos
seguiam somando Xandr + PubMatic).

## Rodar

```bash
npm i --no-save playwright-core     # não é dependência do app
node scripts/e2e/pmp/run.mjs        # analytics + tabs
node scripts/e2e/pmp/run.mjs tabs   # só um roteiro
```

O `run.mjs` sobe o stub (porta 8788), o Vite apontado pra ele
(`VITE_API_URL`), roda os roteiros e derruba tudo. Prints e `results.json` vão
pra `/tmp/e2e-pmp` (ou `$OUT_DIR`).

O `browser.mjs` procura o Chromium sozinho em `$PLAYWRIGHT_BROWSERS_PATH`; se
o binário estiver em outro lugar, aponte com
`CHROMIUM_PATH=/caminho/chrome node scripts/e2e/pmp/run.mjs`.

## O que tem aqui

| arquivo | papel |
| --- | --- |
| `fixtures.mjs` | 6 lines (2 fontes, 4 clientes, 2 bids, 2 status) + série diária de 30 dias. Lifetime de cada line = soma exata da própria série, e as datas são relativas a hoje. |
| `stub-server.mjs` | Responde `pmp_lines_list`, `pmp_lines_timeseries` e `pmp_lines_window`; qualquer outro `action` volta vazio. |
| `analytics.mjs` | A aba Analytics: filtros da página (busca, Cliente, Status, Bid, Fonte), filtros da aba (Período, Cliente, Campanha, Status, Bid), Diário/Mensal, composição dos dois níveis, poda de seleção órfã e coerência entre a faixa de KPIs do topo e os cards. |
| `tabs.mjs` | Lista, No ar, Carteira e Histórico — inclusive os recortes de data exclusivos do Histórico. |

A sessão admin é falsa (`localStorage.hypr.session` com um JWT que só o stub
precisa aceitar), então nada disso toca produção.

## Regras que os roteiros travam

- Todo filtro da página recorta **todas** as views, Analytics incluída.
- `PubMatic + Xandr = total` — nenhuma row de entrega contada duas vezes.
- Faixa "Faturamento" do topo e cards do Analytics falam do MESMO conjunto.
- Seleção da aba que some do recorte da página é **suspensa** (não zera a aba) e
  volta a valer quando a opção reaparece.
- Na Lista, filtrar por `Finalizado` dá vazio **por partição** (essas lines
  moram no Histórico) — o mesmo filtro acha as duas no Histórico.

A lógica pura por trás disso tem teste de unidade em
`src/v2/admin/lib/pmpFilters.test.js` e `pmpAnalyticsData.test.js` (`npm test`).
