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

Terceira afirmação, adicionada em 24/08/2026
────────────────────────────────────────────
"O job rodou" ainda não é "a base está fresca". O sync da PubMatic rodava verde
todo dia às 04h e a base vivia 2 dias atrás, porque a essa hora a fonte ainda
não fechou D-1 e o conector (com razão) pula dia zerado. Ninguém tinha como
ver isso: o ledger só dizia que a execução terminou bem.

Agora a execução também carrega o FRESCOR DA FONTE — `api_last_day` (último dia
em que a API tinha dado real) e `lag_days` (quantos dias atrás de D-1 isso
está). É o que permite o painel alarmar em "rodou com sucesso e o dado está
velho", que é o estado em que este pipeline passa a maior parte do tempo quando
quebra de leve.

`status='skipped'` também é novo: PubMatic sem credencial no ambiente fazia o
`pmp_sync_v2` pular o bloco INTEIRO, sem row nenhuma — silêncio idêntico ao que
o ledger nasceu pra matar, entrando por outra porta.

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
    # 'ok' | 'error' | 'skipped' (não rodou por falta de credencial). Sem
    # 'running': o sync é síncrono e curto; uma row só é gravada no fim, então
    # "sem row" == "nem foi tentado".
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
    # ── Frescor da FONTE (≠ frescor do job) ──────────────────────────────────
    # Último dia em que a API tinha dado real, e a distância disso até D-1.
    # NULL nas fontes que ainda não reportam frescor (o painel degrada).
    bigquery.SchemaField("api_last_day",   "DATE"),
    bigquery.SchemaField("lag_days",       "INT64"),
]

# Colunas adicionadas DEPOIS que a tabela já existia em produção. `ensure_table`
# sai cedo quando a tabela existe, então sem isto o insert das novas colunas
# falharia calado (insert_rows_json rejeita campo desconhecido) — o ledger
# perderia exatamente a informação que ele foi estendido pra carregar.
_ADDED_COLUMNS = [
    ("api_last_day", "DATE"),
    ("lag_days",     "INT64"),
]

# Cache do painel: a query é barata (tabela minúscula, particionada), mas o
# pmp_lines_list é chamado a cada mount da página.
_cache: dict = {}
_CACHE_TTL_S = 60


def ensure_table() -> None:
    """Cria a tabela se não existir e converge o schema. Idempotente e barato
    (erro de permissão sobe pro caller)."""
    try:
        existing = bq.get_table(_FQ)
    except Exception:
        existing = None

    if existing is not None:
        have = {f.name for f in existing.schema}
        adds = [(n, t) for n, t in _ADDED_COLUMNS if n not in have]
        if adds:
            # ADD COLUMN IF NOT EXISTS é barato e não reescreve a tabela.
            # Best-effort: se falhar (permissão), o `record` abaixo cai no
            # modo compatível e grava sem as colunas novas em vez de perder a
            # row inteira — um ledger degradado ainda vale mais que nenhum.
            try:
                bq.query(
                    f"ALTER TABLE `{_FQ}` "
                    + ", ".join(f"ADD COLUMN IF NOT EXISTS {n} {t}" for n, t in adds)
                ).result()
                logger.info("[pmp_sync_runs] colunas adicionadas: %s",
                            [n for n, _ in adds])
            except Exception as e:
                logger.warning("[pmp_sync_runs] falhou adicionando colunas %s: %s",
                               [n for n, _ in adds], e)
        return

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
           error: Optional[str] = None,
           api_last_day: Optional[str] = None,
           lag_days: Optional[int] = None) -> None:
    """Grava uma execução. Best-effort: exceção aqui é logada, nunca propagada
    (o ledger observa o sync, não pode derrubá-lo).

    `status` ∈ {'ok','error','skipped'}. `api_last_day`/`lag_days` são o frescor
    da FONTE (vêm do conector) — só quem sabe medir preenche.
    """
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
            "api_last_day":   api_last_day,
            "lag_days":       int(lag_days) if lag_days is not None else None,
        }
        errors = bq.insert_rows_json(_FQ, [row])
        if errors:
            # Causa provável: as colunas de frescor não existem nesta tabela
            # (ALTER falhou por permissão). Re-tenta sem elas — perder o frescor
            # é ruim, perder a row inteira é o silêncio que o ledger combate.
            legacy = {k: v for k, v in row.items()
                      if k not in ("api_last_day", "lag_days")}
            retry = bq.insert_rows_json(_FQ, [legacy])
            if retry:
                logger.warning("[pmp_sync_runs] insert errors: %s", errors[:2])
            else:
                logger.warning("[pmp_sync_runs] row gravada SEM as colunas de "
                               "frescor (schema antigo?): %s", errors[:1])
                _cache.clear()
        else:
            _cache.clear()
    except Exception as e:
        logger.warning("[pmp_sync_runs] falhou gravando run de %s: %s", source, e)


def last_ok_api_day(source: str, days: int = 7) -> Optional[str]:
    """Até que dia a fonte tinha dado na última execução BEM-SUCEDIDA.

    Serve pra responder "esta run trouxe dia novo?" sem comparar tabela de
    entrega. Com o refresh de hora em hora, a maioria das runs não traz nada
    novo — são sondagens esperando a fonte fechar D-1 — e o trabalho pesado a
    jusante (push do compplan pra planilha) não deve rodar 19 vezes por dia
    pra reescrever o mesmo número.

    Devolve None quando não há run OK com frescor medido; nesse caso o caller
    deve tratar como "não sei" e fazer o trabalho completo, nunca pular.
    """
    try:
        job = bq.query(
            f"""
            SELECT api_last_day
            FROM `{_FQ}`
            WHERE source = @source
              AND status = 'ok'
              AND api_last_day IS NOT NULL
              AND started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
            ORDER BY started_at DESC
            LIMIT 1
            """,
            job_config=bigquery.QueryJobConfig(query_parameters=[
                bigquery.ScalarQueryParameter("source", "STRING", source),
                bigquery.ScalarQueryParameter("days", "INT64", days),
            ]),
        )
        for r in job.result():
            return r["api_last_day"].isoformat() if r["api_last_day"] else None
    except Exception as e:
        # Coluna ausente (ALTER pendente) ou falha de leitura. "Não sei" é a
        # resposta segura: o caller faz o trabalho completo.
        logger.info("[pmp_sync_runs] last_ok_api_day indisponível: %s", e)
    return None


def latest_by_source(days: int = 90) -> List[dict]:
    """Última execução (e última bem-sucedida) por fonte, dentro de `days`.

    Retorna [{source, last_run_at, last_run_status, last_error, last_ok_at,
              rows_processed, deals_touched, actor, credential, duration_sec,
              api_last_day, lag_days}].

    `api_last_day`/`lag_days` vêm do último run BEM-SUCEDIDO, não do último run:
    um run que falhou não mediu frescor nenhum, e herdar NULL dele apagaria do
    painel o atraso que continua lá.
    Falha de leitura devolve [] — o painel degrada pro modo antigo em vez de
    quebrar a página inteira.
    """
    key = f"latest:{days}"
    hit = _cache.get(key)
    now = datetime.now(timezone.utc).timestamp()
    if hit and now - hit[0] < _CACHE_TTL_S:
        return hit[1]

    for with_freshness in (True, False):
        sql = _latest_sql(with_freshness)
        try:
            job = bq.query(sql, job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("days", "INT64", days)]
            ))
            out = []
            for r in job.result():
                d = dict(r)
                for k in ("last_run_at", "last_ok_at", "api_last_day"):
                    if d.get(k) is not None:
                        d[k] = d[k].isoformat()
                out.append(d)
            _cache[key] = (now, out)
            return out
        except Exception as e:
            # 1ª volta: provavelmente a tabela ainda não tem as colunas de
            # frescor (ALTER pendente ou sem permissão). Cai pro SQL legado em
            # vez de devolver [] — o painel perde o atraso, não o ledger todo.
            if with_freshness:
                logger.info("[pmp_sync_runs] SQL com frescor falhou (%s); "
                            "tentando o legado", e)
                continue
            logger.warning("[pmp_sync_runs] falhou lendo runs: %s", e)
            return []
    return []


def _latest_sql(with_freshness: bool) -> str:
    ok_cols = ("source, started_at AS last_ok_at, api_last_day, lag_days"
               if with_freshness else "source, started_at AS last_ok_at")
    ok_select = ("o.last_ok_at,\n          o.api_last_day,\n          o.lag_days"
                 if with_freshness else "o.last_ok_at")
    return f"""
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
          SELECT * EXCEPT(rn) FROM (
            SELECT {ok_cols},
                   ROW_NUMBER() OVER (PARTITION BY source ORDER BY started_at DESC) AS rn
            FROM runs WHERE status = 'ok'
          ) WHERE rn = 1
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
          {ok_select}
        FROM last_run r
        LEFT JOIN last_ok o USING (source)
    """
