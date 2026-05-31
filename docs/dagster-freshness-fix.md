# Fix: bases unificadas congelam quando uma fonte atrasa

**Onde aplicar:** repo do Dagster (`hypr-platform/hyprster`), NÃO o report-hub.
**Job afetado:** `dbt_assets_freshness_06am_job` (location `hyprster`, deployment `prod`).

## Causa-raiz (quantificada, 14 dias)

O job roda às **06:00 fixo**, mas depende das 4 fontes terem aterrissado no BQ.
Horário real de término de cada fonte:

| Fonte | Normal | Observação |
|---|---|---|
| DV360 (`hypr_dv360.dv360_daily_performance_metrics_*`) | 02:47–04:07 | **mais variável** — em 31/05 atrasou pra 06:38 |
| Amazon (`staging.amazon_daily_performance_metrics`) | 05:02–05:20 | a mais apertada vs 06h |
| StackAdapt (`staging.stackadapt_campaign_daily_metrics`) | 05:01 | estável |
| Xandr (`staging.xandr_daily_performance_metrics`) | 05:01–05:02 | estável |

Quando qualquer fonte passa das 06h, o modelo `*_raw_*` correspondente lê um
wildcard/tabela vazia → falha → o `unified_*` (downstream) é **skipado** e as
bases congelam no último build bom. O re-run manual "resolve" só porque o tempo
passou e a fonte já chegou.

**Produtor (fonte) com horário variável + consumidor (job) com horário fixo +
nenhuma dependência entre eles.** O gatilho precisa esperar **a última das 4**,
não só o DV360.

## Fix 1 — Sensor multi-fonte (mata a raiz)

Dispara o job só quando as 4 landings do dia existem. Substitui o schedule fixo.

```python
from dagster import sensor, RunRequest, SkipReason, DefaultSensorStatus
from datetime import datetime
from zoneinfo import ZoneInfo
from google.cloud import bigquery

TZ = ZoneInfo("America/Sao_Paulo")

# (dataset, prefixo_ou_tabela, coluna_de_data) por fonte. DV360 usa wildcard.
_SOURCES = [
    ("hypr_dv360", "dv360_daily_performance_metrics_*", "Date"),
    ("staging",    "amazon_daily_performance_metrics",  "DATE"),
    ("staging",    "stackadapt_campaign_daily_metrics", "date"),
    ("staging",    "xandr_daily_performance_metrics",   "DAY"),
]

def _source_has_yesterday(bq: bigquery.Client, dataset: str, table: str, col: str, target) -> bool:
    sql = f'SELECT COUNT(*) n FROM `site-hypr.{dataset}.{table}` WHERE {col} = @d'
    job = bq.query(sql, location="US", job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("d", "DATE", target)]))
    return next(iter(job)).n > 0

@sensor(
    job=dbt_assets_freshness_06am_job,          # o job existente
    minimum_interval_seconds=600,                # checa a cada 10 min
    default_status=DefaultSensorStatus.RUNNING,
)
def all_sources_ready_sensor(context):
    today = datetime.now(TZ).date()
    target = today.fromordinal(today.toordinal() - 1)   # ontem (D-1)
    run_key = f"unified-{target.isoformat()}"            # 1x por dia, idempotente

    bq = bigquery.Client(project="site-hypr")
    pending = [t for (d, t, c) in _SOURCES if not _source_has_yesterday(bq, d, t, c, target)]
    if pending:
        return SkipReason(f"Aguardando fontes de {target}: {', '.join(pending)}")

    yield RunRequest(run_key=run_key)   # dispara assim que TODAS chegaram
```

Notas:
- `run_key` amarrado à data → o sensor dispara **uma vez** por dia, quando a
  última fonte chega (seja 04h ou 06h38). Sem race.
- Cobre `audience`/`domains` do DV360 só se você incluí-las em `_SOURCES` — hoje
  elas chegam ~10h e NÃO alimentam o `unified` principal, então deixe de fora.

## Fix 2 — Retry como rede de segurança (agnóstico de fonte)

Mesmo com sensor, vale ter retry: re-tenta a DAG até passar, sem ligar pra
*qual* fonte atrasou (cobre fonte nova que esqueçam de pôr no sensor).

```python
# Dagster+ run retries — tags no job:
dbt_assets_freshness_06am_job = define_asset_job(
    name="dbt_assets_freshness_06am_job",
    selection=...,
    tags={
        "dagster/max_retries": "4",
        "dagster/retry_strategy": "FROM_FAILURE",  # re-roda só o que faltou + downstream
    },
)
```

> Hoje (31/05) um retry ~30 min depois (06:30) já teria pego o DV360 das 06:38
> **sozinho**, sem ninguém acordar.

## Fix 3 — Higiene de alerta (importante)

O job vive em `FAILURE` **todo dia** por falhas crônicas não-bloqueantes:
- `checklist_info` → `staging.checklist_info` não existe.
- `dv360_raw_daily_audience/domains` → tabelas chegam ~10h / inexistentes.

Como vive vermelho, ninguém distingue falha boba de falha séria (foi por isso
que a de 31/05 passou batida). Corrigir/remover esses assets faz o status do job
voltar a significar algo — e o alerta de falha do Dagster volta a ser confiável.

## Escape manual (já implementado no report-hub)

Botão **"Reconstruir agora"** no indicador "Estado das bases" → dispara este job
via `launchRun` (GraphQL Dagster+). Para o raro caso em que o retry não cobrir.
Requer env `DAGSTER_API_TOKEN` no Cloud Run do `report-data` (Secret Manager).
