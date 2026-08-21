"""
Ledger de execuções do sync PMP (Xandr Curate + PubMatic).

Por que existe
──────────────
Até 21/08/2026 o painel "Sync das fontes" do /admin/pmp inferia "última
execução" do `MAX(synced_at)` das LINHAS DE ENTREGA (`pmp_line_delivery_daily`,
via `pmp_lines_enriched`). Isso mede o DADO, não o JOB — e os dois divergem
sempre que a fonte não tem entrega nova:

  • O conector pula, de propósito, os dias zerados que a API devolve (senão o
    último dia zerado viraria `last_delivery_day` e o deal apareceria "no ar"
    sem ter entregue nada). Deal encerrado ⇒ nenhuma row tocada ⇒ `synced_at`
    congela ⇒ o painel acusa "sync atrasada" com o cron 100% saudável.
  • Simétrico e pior: quando o sync REALMENTE falha (auth, rede, 5xx da API),
    nada muda na tabela de entrega — o painel mostra exatamente o mesmo
    "congelado" de antes. Foi o que escondeu por 3 dias o 401 da PubMatic
    (19–21/08), período em que um deal novo (PM-ZZCX-5733, ~R$32k de spend)
    ficou fora do hub sem ninguém perceber.

O ledger registra a TENTATIVA: toda execução do sync (sucesso ou falha) grava
uma row aqui, com erro e credencial usada. O painel passa a ler daqui, então
"o cron rodou" e "o deal entregou" viram duas afirmações independentes — que
é o que elas sempre foram.

Contrato
────────
  record(source=..., started_at=..., status=..., ...) → grava 1 row (best-effort:
      falha de escrita do ledger NUNCA derruba o sync que ele observa).
  latest_by_source() → 1 dict por fonte com a última execução + a última
      execução BEM-SUCEDIDA (last_ok_at), pro painel diferenciar
      "falhou agora" de "nunca rodou".

Tabela `prod_assets.pmp_sync_runs` — particionada por DATE(started_at) e
clusterizada por source. Criada on-demand por `ensure_table()` (idempotente).
"""

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from google.cloud import bigquery

import bq_client

logger = logging.getLogger(__name__)

PROJECT_ID = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET    = "prod_assets"
TABLE      = "pmp_sync_runs"

_FQ = f"{PROJECT_ID}.{DATASET}.{TABLE}"

bq = bq_client.get_client()

SCHEMA = [
    bigquery.SchemaField("run_id",         "STRING"),
    bigquery.SchemaField("source",         "STRING"),
    bigquery.SchemaField("started_at",     "TIMESTAMP"),
    bigquery.SchemaField("finished_at",    "TIMESTAMP"),
    # 'ok' | 'error'. Sem 'running': o sync é síncrono e curto; uma row só é
    # gravada no fim, então "sem row" == "não rodou".
    bigquery.SchemaField("status",         "STRING"),
    bigquery.SchemaField("rows_processed", "INT64"),
    bigquery.SchemaField("deals_touched",  "INT64"),
    bigquery.SchemaField("window",         "STRING"),
    # 'scheduler' | email do admin que clicou "Sincronizar agora".
    bigquery.SchemaField("actor",          "STRING"),
    # Qual conjunto de credenciais autenticou (ver credential chain do
    # pubmatic_curate). Vazio nas fontes sem chain.
    bigquery.SchemaField("credential",     "STRING"),
    bigquery.SchemaField("error",          "STRING"),
    bigquery.SchemaField("duration_sec",   "FLOAT64"),
]

# Cache do painel: a query é barata (tabela minúscula, particionada), mas o
# pmp_lines_list é chamado a cada mount da página.
_cache: dict = {}
_CACHE_TTL_S = 60


def ensure_table() -> None:
    """Cria a tabela se não existir. Idempotente e barato (get_table cacheado
    pelo próprio BQ client; erro de permissão sobe pro caller)."""
    try:
        bq.get_table(_FQ)
        return
    except Exception:
        pass
    table = bigquery.Table(_FQ, schema=SCHEMA)
    table.time_partitioning = bigquery.TimePartitioning(
        type_=bigquery.TimePartitioningType.DAY, field="started_at"
    )
    table.clustering_fields = ["source"]
    bq.create_table(table, exists_ok=True)
    logger.info("[pmp_sync_runs] tabela %s criada", _FQ)


def record(source: str,
           started_at: datetime,
           status: str,
           rows_processed: Optional[int] = None,
           deals_touched: Optional[int] = None,
           window: Optional[str] = None,
           actor: Optional[str] = None,
           credential: Optional[str] = None,
           error: Optional[str] = None) -> None:
    """Grava uma execução. Best-effort: exceção aqui é logada, nunca propagada
    (o ledger observa o sync, não pode derrubá-lo)."""
    try:
        ensure_table()
        finished = datetime.now(timezone.utc)
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        row = {
            "run_id":         uuid.uuid4().hex,
            "source":         source,
            "started_at":     started_at.isoformat(),
            "finished_at":    finished.isoformat(),
            "status":         status,
            "rows_processed": int(rows_processed) if rows_processed is not None else None,
            "deals_touched":  int(deals_touched) if deals_touched is not None else None,
            "window":         window,
            "actor":          actor,
            "credential":     credential,
            # Erro pode ser um dump enorme de HTML/JSON da API; 1000 chars
            # bastam pro diagnóstico e mantêm a row legível na UI.
            "error":          (str(error)[:1000] if error else None),
            "duration_sec":   round((finished - started_at).total_seconds(), 2),
        }
        errors = bq.insert_rows_json(_FQ, [row])
        if errors:
            logger.warning("[pmp_sync_runs] insert errors: %s", errors[:2])
        else:
            _cache.clear()
    except Exception as e:
        logger.warning("[pmp_sync_runs] falhou gravando run de %s: %s", source, e)


def latest_by_source(days: int = 90) -> List[dict]:
    """Última execução (e última bem-sucedida) por fonte, dentro de `days`.

    Retorna [{source, last_run_at, last_run_status, last_error, last_ok_at,
              rows_processed, deals_touched, actor, credential, duration_sec}].
    Falha de leitura devolve [] — o painel degrada pro modo antigo em vez de
    quebrar a página inteira.
    """
    key = f"latest:{days}"
    hit = _cache.get(key)
    now = datetime.now(timezone.utc).timestamp()
    if hit and now - hit[0] < _CACHE_TTL_S:
        return hit[1]

    sql = f"""
        WITH runs AS (
          SELECT *
          FROM `{_FQ}`
          WHERE started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
        ),
        last_run AS (
          SELECT * EXCEPT(rn) FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY source ORDER BY started_at DESC) AS rn
            FROM runs
          ) WHERE rn = 1
        ),
        last_ok AS (
          SELECT source, MAX(started_at) AS last_ok_at
          FROM runs WHERE status = 'ok' GROUP BY source
        )
        SELECT
          r.source,
          r.started_at   AS last_run_at,
          r.status       AS last_run_status,
          r.error        AS last_error,
          r.rows_processed,
          r.deals_touched,
          r.actor,
          r.credential,
          r.duration_sec,
          o.last_ok_at
        FROM last_run r
        LEFT JOIN last_ok o USING (source)
    """
    try:
        job = bq.query(sql, job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("days", "INT64", days)]
        ))
        out = []
        for r in job.result():
            d = dict(r)
            for k in ("last_run_at", "last_ok_at"):
                if d.get(k) is not None:
                    d[k] = d[k].isoformat()
            out.append(d)
        _cache[key] = (now, out)
        return out
    except Exception as e:
        logger.warning("[pmp_sync_runs] falhou lendo runs: %s", e)
        return []
