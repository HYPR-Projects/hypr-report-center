# Pedido upstream: dia faltando na base de Region do DV360 (12/09/2026)

**Onde aplicar:** conta DV360 (agendamento de report na UI) e repo do Dagster (`HYPR-Projects/hyprster`), NÃO o report-hub.
**Tabela afetada:** `site-hypr.prod_assets.dv360_daily_regions_performance_metrics`.
**Status:** aberto, aguardando backfill.
**Descoberto:** 2026-09-24, na simulação de retirada das entregas fora do BR (Diageo, Paramount, Stellantis, Febraban, Pátria, Latam).

## Sintoma

A base de Region não tem nenhuma linha em **12/09/2026**. A base de performance do
DV360 tem o dia normalmente:

| Data | `dv360_daily_performance_metrics` | `dv360_daily_regions_performance_metrics` |
|---|---|---|
| 11/09 | 14.677.535 imps | 14.694.710 imps |
| **12/09** | **23.099.106 imps** | **nenhuma linha** |
| 13/09 | 29.976.267 imps | 30.011.224 imps |

Nos dias com dado as duas bases batem dentro de 0,2%. Varrendo 2026 inteiro, o único
outro dia faltando é **10/01/2026** (4,3 mi imps).

Impacto hoje: o box "Fora do BR" de setembro subconta o mês, e o ajuste
excepcional de entrega fora do BR precisa estimar esse dia (13% do volume do
Rock in Rio `FITP2U`, 6% da Stellantis `YHGR17`, 5% da Pátria `WM2KUB`).

## Causa-raiz

Os exports nativos DV360 → BigQuery (agendados na UI da DV360) têm janelas
diferentes:

| Export | Janela | Exemplo de tabela em `hypr_dv360` |
|---|---|---|
| performance | últimos 7 dias | `..._20260917_20260923_20260924_075109` |
| costs, device, unique users | últimos 7 dias | `..._20260917_20260923_...` |
| **regions** | **só D-1** | `..._20260923_20260923_20260924_080917` |

Com janela de 7 dias, um run que falha é coberto pelos 6 seguintes. Com janela
de 1 dia, **o dia some para sempre**: o run de 13/09 (que traria o dia 12) não
aterrissou, e nenhum run posterior volta nesse dia. As tabelas de
`hypr_dv360` são apagadas às 22h (`delete_dv360_staging_tables_job`), então
não sobra nada pra reprocessar.

O dbt não tem culpa aqui: `dv360_raw_daily_regions_performance_metrics` escolhe
o `max(src_id)` por data e `dv360_daily_regions_performance_metrics` é
incremental por `ingested_at`. Se um arquivo do dia 12 aterrissar, os dois
modelos incorporam sem mudança.

## Pedido

### 1. Backfill de 12/09 (e 10/01, se ainda der)

Na DV360, rodar uma vez o report de Regions com intervalo **12/09/2026 a
12/09/2026**, mesmo destino BigQuery (`site-hypr.hypr_dv360`) e mesmo prefixo
de tabela (`dv360_daily_regions_performance_metrics_`). Depois disparar o build
dos modelos `dv360_raw_daily_regions_performance_metrics` e
`dv360_daily_regions_performance_metrics` **antes das 22h**, senão o
`delete_dv360_staging_tables_job` apaga a tabela antes do dbt ler.

Alternativa sem UI: o módulo `hypr_library/reports/dv360_reports` (Bid Manager
API com a service account) pode criar a query com as mesmas dimensões, baixar o
CSV e gravar em `hypr_dv360` com o nome no padrão acima.

Conferência depois do backfill:

```sql
SELECT date, SUM(impressions) imps
FROM `site-hypr.prod_assets.dv360_daily_regions_performance_metrics`
WHERE date BETWEEN '2026-09-11' AND '2026-09-13'
GROUP BY 1 ORDER BY 1;
-- 12/09 deve dar ~23,1 mi, perto do total da dv360_daily_performance_metrics
```

### 2. Fix estrutural: janela de 7 dias no report de Regions

Trocar o intervalo do agendamento de Regions na UI da DV360 de "Ontem" para
"Últimos 7 dias", igual ao de performance. O dbt já trata a sobreposição: o
`max(src_id)` por data pega o arquivo mais novo porque o sufixo começa pela
data inicial da janela. Custo: arquivo diário ~7× maior (hoje ~700 mil linhas
por dia), o que vale a pena pela autocura.

Ponto de atenção: o agendamento pertence ao usuário que o criou na UI. O report
de audiência morreu assim quando a conta saiu (ver docstring de
`hypr_library/reports/dv360_reports`). Vale migrar Regions para a Bid Manager
API junto com esse ajuste.

### 3. Alerta de buraco

Hoje nada avisou que o dia 12 faltou. Sugestão: teste dbt (ou sensor) que
compara as datas da `dv360_daily_regions_performance_metrics` com as da
`dv360_daily_performance_metrics` nos últimos 14 dias e falha se faltar alguma.
