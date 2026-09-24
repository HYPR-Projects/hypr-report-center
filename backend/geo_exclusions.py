"""
Exclusão de entrega fora do Brasil no report (ajuste excepcional, DV360).

Por que existe
--------------
Em setembro/2026 um erro de setup (line sem geo targeting em open exchange)
fez várias campanhas entregarem fora do BR: Diageo Rock in Rio e Selo,
Paramount MobLand, Stellantis Avenger, Febraban, Pátria e Latam. Em algumas,
70% a 99% do display saiu do país. A decisão foi retirar essa entrega do report
do cliente, campanha por campanha, sem mexer na base (o pipeline reconstrói o
campaign_results e o dado voltaria) e sem congelar o report (as ativas
precisam seguir atualizando).

Como funciona
-------------
1. `campaign_geo_exclusions` (config): um registro por short_token que deve
   ser ajustado, com janela opcional de datas. Países liberados = BR + os que
   o admin já liberou no drawer do box "Fora do BR"
   (`campaign_country_overrides`). País não resolvido pelo DV360 fica (não é
   prova de entrega fora).

2. `refresh()` recalcula `campaign_geo_adjustments`: para cada chave
   (token × dia × line × criativo) que o report lê, a FRAÇÃO de cada métrica
   que foi entregue fora, tirada do relatório de Region do DV360
   (`dv360_daily_regions_performance_metrics`). Fração, e não valor absoluto,
   porque unified e campaign_results divergem por arredondamento; a fração
   aplica igual nas duas. Métrica a métrica (viewable, cliques, vídeo)
   porque o CTR fora chega a 5% contra 0,1% no BR: escalar cliques pela fração
   de impressões deixaria clique de bot no report.

   Método por chave (coluna `method`):
     exact        Region tem o mesmo dia × line × criativo
     line_day     tem o dia e a line, mas não o criativo → fração da line no dia
     line_window  o dia não está no Region (export de 12/09/2026 faltou) →
                  fração da line na janela inteira. É ESTIMATIVA; some sozinha
                  quando o dia for reprocessado, porque o refresh roda de novo.
   Line sem nenhum dado no Region (Yahoo, StackAdapt…) não ganha fração: não
   há como saber o país, então não se retira nada.

3. Conciliação antes de publicar: nas chaves `exact`, a soma de impressões do
   Region tem de bater com a da unified dentro de RECON_TOLERANCE. Token que
   não bate NÃO recebe a fração nova: mantém a última que bateu (ou fica sem
   ajuste, se nunca bateu). Assim o report não oscila por causa de um dia de
   dado ruim, e nunca retira volume com base num Region que não fecha com a
   entrega. O resultado fica em `campaign_geo_exclusion_status`.

4. `adjusted_source()` devolve o FROM que as queries do report usam: a tabela
   original com as métricas multiplicadas por (1 − fração), via LEFT JOIN com
   a tabela de frações. O custo DSP (`total_cost`, admin-only) fica intacto:
   foi gasto de verdade e a análise de custo do mês precisa dele cheio. O
   custo da entrega retirada vai pro status (`removed_cost`) e aparece no card
   do menu admin como "fora do BR (oculto)". O custo cliente
   (`effective_total_cost` do campaign_results = entrega × CPM/CPCV negociado)
   é descontado, porque é valor de entrega. Token sem ajuste passa intacto; sem nenhum token
   configurado a tabela original é devolvida crua (custo zero).

O box "Fora do BR" do admin segue lendo o Region cru: é o monitor da operação
e precisa mostrar o que aconteceu, não o que o cliente vê.
"""

import logging
import re
import threading
import time
from datetime import date

from google.api_core.exceptions import NotFound
from google.cloud import bigquery

logger = logging.getLogger(__name__)

PROJECT = "site-hypr"
CONFIG_TABLE = f"`{PROJECT}.prod_assets.campaign_geo_exclusions`"
ADJ_TABLE_ID = "campaign_geo_adjustments"
ADJ_TABLE = f"`{PROJECT}.prod_assets.{ADJ_TABLE_ID}`"
STATUS_TABLE = f"`{PROJECT}.prod_assets.campaign_geo_exclusion_status`"
OVERRIDES_TABLE = f"`{PROJECT}.prod_assets.campaign_country_overrides`"
REGIONS_TABLE = f"`{PROJECT}.prod_assets.dv360_daily_regions_performance_metrics`"
# Cópia compacta do Region (dia × line × criativo × país, sem cidade/DMA),
# particionada por data. A tabela original NÃO é particionada: qualquer leitura
# varre ~19 GB. Refeita quando o Region muda (warmup); o toggle lê só ela.
COMPACT_TABLE_ID = "dv360_region_country_compact"
COMPACT_TABLE = f"`{PROJECT}.prod_assets.{COMPACT_TABLE_ID}`"
COMPACT_LOOKBACK_DAYS = 120
# Janela máxima para trás no refresh: a mesma da cópia compacta (proteção de
# custo). Campanha com entrega mais antiga que isso não é ajustada.
MAX_LOOKBACK_DAYS = COMPACT_LOOKBACK_DAYS
UNIFIED_TABLE = f"`{PROJECT}.prod_assets.unified_daily_performance_metrics`"
CR_TABLE = f"`{PROJECT}.prod_prod_hypr_reporthub.campaign_results`"

# Tabelas cujo last_modified dispara um refresh (ver `needs_refresh`).
SOURCE_TABLES = [
    ("prod_assets", COMPACT_TABLE_ID),
    ("prod_assets", "unified_daily_performance_metrics"),
    ("prod_prod_hypr_reporthub", "campaign_results"),
    ("prod_assets", "campaign_geo_exclusions"),
    ("prod_assets", "campaign_country_overrides"),
]

# Diferença máxima de impressões Region × unified nas chaves exatas. Medido em
# 24/09/2026 nas 8 campanhas de setembro: 0,01% a 0,18%.
RECON_TOLERANCE = 0.005

# Mesmo teto do box "Fora do BR": a tabela de Region tem ~140 GB; com poda por
# data e filtro de line um mês fica em ~17 GB.
MAX_BYTES_BILLED = str(80 * 1024 ** 3)



TOKEN_RE = re.compile(r"^[A-Z0-9]{4,12}$")

# Sobe quando o formato do status/frações muda: o próximo warmup recalcula
# mesmo sem mudança nas fontes (ver `needs_refresh`).
SCRIPT_VERSION = 2

# ── Colunas ajustadas por tabela ────────────────────────────────────────────
# (coluna, fração, é inteiro). A fração é o nome da coluna na tabela de
# ajustes; "cost_cr" é resolvida por mídia (viewable no display, vídeo no
# vídeo) porque o custo cliente do campaign_results é entrega × CPM/CPCV.
_UNIFIED_COLS = [
    ("impressions",             "f_imps",     True),
    ("measurable_impressions",  "f_imps",     True),
    ("viewable_impressions",    "f_viewable", True),
    ("clicks",                  "f_clicks",   True),
    # `total_cost` (custo DSP, admin-only) NÃO é descontado de propósito: o
    # dinheiro foi gasto, e a visão de custo do mês/tech cost tem de mostrar
    # o gasto real. O quanto disso foi fora do BR sai em `removed_cost` no
    # status e aparece no card do menu admin.
    ("conversions",             "f_imps",     False),
    ("video_starts",            "f_video",    True),
    ("video_view_25_complete",  "f_video",    True),
    ("video_view_50_complete",  "f_video",    True),
    ("video_view_75_complete",  "f_video",    True),
    ("video_view_100_complete", "f_video",    True),
]
_CR_COLS = [
    ("impressions",                      "f_imps",     True),
    ("viewable_impressions",             "f_viewable", True),
    ("clicks",                           "f_clicks",   True),
    ("viewable_video_starts",            "f_video",    False),
    ("viewable_video_view_25_complete",  "f_video",    False),
    ("viewable_video_view_50_complete",  "f_video",    False),
    ("viewable_video_view_75_complete",  "f_video",    False),
    ("viewable_video_view_100_complete", "f_video",    False),
    ("effective_total_cost",             "cost_cr",    False),
    ("effective_cost_with_over",         "cost_cr",    False),
]
KINDS = {"unified": _UNIFIED_COLS, "campaign_results": _CR_COLS}


def _frac_expr(frac):
    if frac == "cost_cr":
        return "IF(t.media_type = 'VIDEO', a.f_video, a.f_viewable)"
    return f"a.{frac}"


def adjusted_sql(base_table, kind):
    """FROM ajustado: `base_table` com as métricas × (1 − fração). Pura (sem
    I/O) pra ser testável. `base_table` pode ser um override de recuperação do
    freeze — o ajuste vale igual."""
    cols = KINDS[kind]
    # Fonte com time travel (`x` FOR SYSTEM_TIME AS OF ...) ou subquery não
    # aceita o alias direto: embrulha antes.
    if "FOR SYSTEM_TIME" in base_table.upper() or base_table.lstrip().startswith("("):
        base_table = f"(SELECT * FROM {base_table})"
    replaces = []
    for col, frac, is_int in cols:
        expr = f"t.{col} * (1 - IFNULL({_frac_expr(frac)}, 0))"
        if is_int:
            expr = f"CAST(ROUND({expr}) AS INT64)"
        replaces.append(f"{expr} AS {col}")
    replace_sql = ",\n        ".join(replaces)
    return f"""(
      SELECT t.* REPLACE (
        {replace_sql}
      )
      FROM {base_table} t
      LEFT JOIN {ADJ_TABLE} a
        ON a.short_token = t.short_token
       AND a.date = t.date
       AND a.line_item_id = t.line_item_id
       AND a.creative_id = t.creative_id
    )"""


# ── Tokens ativos (com fração publicada) ────────────────────────────────────
_active_lock = threading.Lock()
_active_cache = {"ts": 0.0, "tokens": None}
ACTIVE_TTL_S = 60


def invalidate_active_cache():
    with _active_lock:
        _active_cache["ts"] = 0.0
        _active_cache["tokens"] = None
    with _summary_lock:
        _summary_cache["ts"] = 0.0
        _summary_cache["data"] = None


def active_tokens(bq):
    """Tokens que têm fração publicada. Cacheado 60s. Falha de leitura (tabela
    ainda não criada, permissão) devolve o último valor conhecido, ou vazio:
    o report nunca cai por causa do ajuste."""
    now = time.time()
    with _active_lock:
        if _active_cache["tokens"] is not None and now - _active_cache["ts"] < ACTIVE_TTL_S:
            return _active_cache["tokens"]
        prev = _active_cache["tokens"]
    try:
        rows = bq.query(f"SELECT DISTINCT short_token FROM {ADJ_TABLE}", location="US").result()
        tokens = frozenset(r["short_token"] for r in rows if r["short_token"])
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[geo_exclusions] leitura dos tokens ativos falhou: {e}")
        tokens = prev if prev is not None else frozenset()
    with _active_lock:
        _active_cache["ts"] = now
        _active_cache["tokens"] = tokens
    return tokens


def adjusted_source(bq, base_table, kind, token=None):
    """FROM a usar numa query de delivery. Com `token`, só embrulha se o token
    tem ajuste (as queries do report são por token e não pagam o JOIN à toa).
    Sem `token` (lista admin, performers), embrulha sempre que existe algum
    token ajustado."""
    tokens = active_tokens(bq)
    if not tokens:
        return base_table
    if token is not None and str(token).upper() not in tokens:
        return base_table
    return adjusted_sql(base_table, kind)


# ── Resumo por token (card do menu admin) ────────────────────────────────────
_summary_lock = threading.Lock()
_summary_cache = {"ts": 0.0, "data": None}


def summary_by_token(bq):
    """{token: {impressions, viewable, cost, status}} dos tokens com ajuste
    publicado — o que foi ocultado do cliente. Cacheado 60s junto com os
    tokens ativos. Falha devolve o último valor ou vazio (o card só não mostra
    a linha)."""
    now = time.time()
    with _summary_lock:
        if _summary_cache["data"] is not None and now - _summary_cache["ts"] < ACTIVE_TTL_S:
            return _summary_cache["data"]
        prev = _summary_cache["data"]
    active = active_tokens(bq)
    if not active:
        data = {}
    else:
        try:
            rows = bq.query(f"SELECT * FROM {STATUS_TABLE}", location="US").result()
            data = {}
            for r in rows:
                r = dict(r)
                tok = r.get("short_token")
                if tok not in active:
                    continue
                data[tok] = {
                    "impressions": round(float(r.get("removed_imps") or 0)),
                    "viewable": round(float(r.get("removed_viewable") or 0)),
                    "cost": round(float(r.get("removed_cost") or 0), 2) if r.get("removed_cost") is not None else None,
                    "status": r.get("status"),
                }
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[geo_exclusions] leitura do resumo falhou: {e}")
            data = prev if prev is not None else {}
    with _summary_lock:
        _summary_cache["ts"] = now
        _summary_cache["data"] = data
    return data


# ── Config ──────────────────────────────────────────────────────────────────
_ready = False
_ready_lock = threading.Lock()


def ensure_tables(bq):
    global _ready
    if _ready:
        return
    with _ready_lock:
        if _ready:
            return
        bq.query(f"""
            CREATE TABLE IF NOT EXISTS {CONFIG_TABLE} (
              short_token STRING NOT NULL,
              date_from   DATE,
              date_to     DATE,
              reason      STRING,
              updated_at  TIMESTAMP,
              updated_by  STRING
            );
            CREATE TABLE IF NOT EXISTS {ADJ_TABLE} (
              short_token  STRING,
              date         DATE,
              line_item_id STRING,
              creative_id  STRING,
              method       STRING,
              f_imps       FLOAT64,
              f_viewable   FLOAT64,
              f_clicks     FLOAT64,
              f_video      FLOAT64,
              f_cost       FLOAT64
            )
            CLUSTER BY short_token;
            CREATE TABLE IF NOT EXISTS {STATUS_TABLE} (
              short_token             STRING,
              refreshed_at            TIMESTAMP,
              status                  STRING,
              recon_diff_pct          FLOAT64,
              unified_imps            INT64,
              removed_imps            FLOAT64,
              removed_viewable        FLOAT64,
              removed_clicks          FLOAT64,
              removed_video_100       FLOAT64,
              removed_cost            FLOAT64,
              unified_cost            FLOAT64,
              exact_imps              INT64,
              estimated_imps          INT64,
              no_geo_imps             INT64,
              last_geo_date           DATE,
              script_version          INT64
            );
        """, location="US").result()
        _ready = True


def normalize_token(raw):
    tok = str(raw or "").strip().upper()
    if not TOKEN_RE.match(tok):
        raise ValueError(f"short_token inválido: {raw!r}")
    return tok


def _parse_date(raw, field):
    if raw in (None, ""):
        return None
    if isinstance(raw, date):
        return raw
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError:
        raise ValueError(f"{field} deve ser YYYY-MM-DD")


def list_exclusions(bq):
    """Config + status do último refresh, por token. Leitura sem DDL (o drawer
    abre mais rápido); tabela ainda inexistente = nenhuma exclusão."""
    try:
        rows = bq.query(f"""
            SELECT e.short_token, e.date_from, e.date_to, e.reason, e.updated_at, e.updated_by,
                   s.* EXCEPT (short_token)
            FROM {CONFIG_TABLE} e
            LEFT JOIN {STATUS_TABLE} s USING (short_token)
            ORDER BY e.short_token
        """, location="US").result()
    except NotFound:
        return []
    out = []
    for r in rows:
        d = dict(r)
        for k in ("date_from", "date_to", "last_geo_date"):
            d[k] = d[k].isoformat() if d.get(k) else None
        for k in ("updated_at", "refreshed_at"):
            d[k] = d[k].isoformat() if d.get(k) else None
        out.append(d)
    return out


def save_exclusion(bq, short_token, date_from=None, date_to=None, reason=None, updated_by=None):
    tok = normalize_token(short_token)
    d_from = _parse_date(date_from, "date_from")
    d_to = _parse_date(date_to, "date_to")
    if d_from and d_to and d_from > d_to:
        raise ValueError("date_from precisa ser ≤ date_to")
    ensure_tables(bq)
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", tok),
        bigquery.ScalarQueryParameter("d_from", "DATE", d_from),
        bigquery.ScalarQueryParameter("d_to", "DATE", d_to),
        bigquery.ScalarQueryParameter("reason", "STRING", (reason or "").strip()[:500] or None),
        bigquery.ScalarQueryParameter("by", "STRING", updated_by),
    ])
    bq.query(f"""
        MERGE {CONFIG_TABLE} T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN UPDATE SET
          date_from = @d_from, date_to = @d_to, reason = @reason,
          updated_at = CURRENT_TIMESTAMP(), updated_by = @by
        WHEN NOT MATCHED THEN
          INSERT (short_token, date_from, date_to, reason, updated_at, updated_by)
          VALUES (@token, @d_from, @d_to, @reason, CURRENT_TIMESTAMP(), @by)
    """, job_config=cfg, location="US").result()
    return {"short_token": tok,
            "date_from": d_from.isoformat() if d_from else None,
            "date_to": d_to.isoformat() if d_to else None}


def delete_exclusion(bq, short_token):
    """Desliga o ajuste do token: apaga config, frações e status de uma vez.
    Não precisa recalcular nada — sem fração, o report volta a ler a entrega
    cheia na próxima leitura."""
    tok = normalize_token(short_token)
    ensure_tables(bq)
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", tok),
    ])
    bq.query(f"""
        DELETE FROM {CONFIG_TABLE} WHERE short_token = @token;
        DELETE FROM {ADJ_TABLE} WHERE short_token = @token;
        DELETE FROM {STATUS_TABLE} WHERE short_token = @token;
    """, job_config=cfg, location="US").result()
    invalidate_active_cache()
    return tok


# ── Refresh ─────────────────────────────────────────────────────────────────

def _out_cond(cc_col="cc"):
    """País fora do BR e fora dos liberados. Código não-ISO (NULL, 'BRA',
    vazio) não conta como fora: não prova entrega fora."""
    return (f"(REGEXP_CONTAINS(IFNULL({cc_col}, ''), r'^[A-Z]{{2}}$') "
            f"AND {cc_col} NOT IN UNNEST(allowed))")


# Ordem explícita das colunas do status: o recálculo parcial faz UNION do
# status novo com o publicado, e `SELECT *` dependeria da ordem física.
_STATUS_COLS = ", ".join([
    "short_token", "refreshed_at", "status", "recon_diff_pct", "unified_imps",
    "removed_imps", "removed_viewable", "removed_clicks", "removed_video_100",
    "removed_cost", "unified_cost", "exact_imps", "estimated_imps", "no_geo_imps",
    "last_geo_date", "script_version",
])


def build_refresh_script(tolerance=RECON_TOLERANCE):
    """Script BQ (multi-statement) que recalcula frações e status. Pura."""
    out = _out_cond()
    frac = lambda o, g: (f"LEAST(1.0, GREATEST(0.0, COALESCE(SAFE_DIVIDE({o}, {g}), "
                         f"SAFE_DIVIDE(o_imps, g_imps), 0)))")
    return f"""
-- @scope vazio = recalcula todos os tokens da config; com tokens = só eles
-- (os demais mantêm fração e status publicados). É o que deixa o toggle do
-- drawer rápido: ligar uma campanha não recalcula as outras.
DECLARE scope ARRAY<STRING> DEFAULT @scope;
DECLARE scoped BOOL DEFAULT IFNULL(ARRAY_LENGTH(scope), 0) > 0;
DECLARE d_from DATE DEFAULT (
  SELECT GREATEST(
    COALESCE(MIN(COALESCE(e.date_from, u.first_date)), CURRENT_DATE()),
    DATE_SUB(CURRENT_DATE(), INTERVAL {MAX_LOOKBACK_DAYS} DAY))
  FROM {CONFIG_TABLE} e
  LEFT JOIN (
    SELECT short_token, MIN(date) AS first_date
    FROM {UNIFIED_TABLE}
    WHERE short_token IN (SELECT short_token FROM {CONFIG_TABLE})
    GROUP BY 1
  ) u USING (short_token)
  WHERE NOT scoped OR e.short_token IN UNNEST(scope)
);

CREATE TEMP TABLE cfg_all AS
SELECT DISTINCT short_token FROM {CONFIG_TABLE};

-- Tokens deste cálculo + países liberados (BR sempre; demais do drawer do
-- box Fora do BR).
CREATE TEMP TABLE cfg AS
SELECT e.short_token, e.date_from, e.date_to,
       ARRAY_CONCAT(['BR'], IFNULL(o.countries, [])) AS allowed
FROM {CONFIG_TABLE} e
LEFT JOIN {OVERRIDES_TABLE} o USING (short_token)
WHERE NOT scoped OR e.short_token IN UNNEST(scope);

-- Chaves que o report lê (as duas bases), já na janela de cada token.
-- u_imps vem só da unified: é a régua da conciliação.
CREATE TEMP TABLE keys AS
SELECT short_token, date, line_item_id, creative_id, SUM(u_imps) AS u_imps
FROM (
  SELECT short_token, date, line_item_id, creative_id, impressions AS u_imps
  FROM {UNIFIED_TABLE}
  WHERE date >= d_from AND short_token IN (SELECT short_token FROM cfg)
  UNION ALL
  SELECT short_token, date, line_item_id, creative_id, 0 AS u_imps
  FROM {CR_TABLE}
  WHERE date >= d_from AND short_token IN (SELECT short_token FROM cfg)
) k
JOIN cfg c USING (short_token)
WHERE line_item_id IS NOT NULL AND creative_id IS NOT NULL
  AND (c.date_from IS NULL OR k.date >= c.date_from)
  AND (c.date_to IS NULL OR k.date <= c.date_to)
GROUP BY 1, 2, 3, 4;

CREATE TEMP TABLE lines AS
SELECT DISTINCT k.short_token, k.line_item_id, c.allowed
FROM keys k JOIN cfg c USING (short_token);

-- Region por token × dia × line × criativo: total e parcela fora.
CREATE TEMP TABLE geo AS
SELECT l.short_token, r.date,
       r.line_item_id,
       r.creative_id,
       SUM(r.impressions) AS g_imps,
       SUM(IF({out}, r.impressions, 0)) AS o_imps,
       SUM(r.viewable_impressions) AS g_vw,
       SUM(IF({out}, r.viewable_impressions, 0)) AS o_vw,
       SUM(r.clicks) AS g_clk,
       SUM(IF({out}, r.clicks, 0)) AS o_clk,
       SUM(r.video_view_100_complete) AS g_vid,
       SUM(IF({out}, r.video_view_100_complete, 0)) AS o_vid,
       SUM(r.total_media_cost_advertiser_currency) AS g_cost,
       SUM(IF({out}, r.total_media_cost_advertiser_currency, 0)) AS o_cost
FROM (
  -- Cópia compacta particionada (ver COMPACT_TABLE): lê só as datas da janela.
  SELECT date, line_item_id, creative_id, cc,
         impressions, viewable_impressions, clicks, video_view_100_complete,
         total_media_cost_advertiser_currency
  FROM {COMPACT_TABLE}
  WHERE date >= d_from
) r
JOIN lines l ON l.line_item_id = r.line_item_id
GROUP BY 1, 2, 3, 4;

CREATE TEMP TABLE geo_line_day AS
SELECT short_token, date, line_item_id,
       SUM(g_imps) g_imps, SUM(o_imps) o_imps, SUM(g_vw) g_vw, SUM(o_vw) o_vw,
       SUM(g_clk) g_clk, SUM(o_clk) o_clk, SUM(g_vid) g_vid, SUM(o_vid) o_vid,
       SUM(g_cost) g_cost, SUM(o_cost) o_cost
FROM geo GROUP BY 1, 2, 3;

CREATE TEMP TABLE geo_line AS
SELECT short_token, line_item_id,
       SUM(g_imps) g_imps, SUM(o_imps) o_imps, SUM(g_vw) g_vw, SUM(o_vw) o_vw,
       SUM(g_clk) g_clk, SUM(o_clk) o_clk, SUM(g_vid) g_vid, SUM(o_vid) o_vid,
       SUM(g_cost) g_cost, SUM(o_cost) o_cost
FROM geo GROUP BY 1, 2;

-- Frações por chave, com o método usado (exact > line_day > line_window).
CREATE TEMP TABLE new_adj AS
WITH picked AS (
  SELECT k.short_token, k.date, k.line_item_id, k.creative_id, k.u_imps,
    CASE WHEN e.g_imps IS NOT NULL THEN 'exact'
         WHEN d.g_imps IS NOT NULL THEN 'line_day'
         WHEN w.g_imps IS NOT NULL THEN 'line_window' END AS method,
    COALESCE(e.g_imps, d.g_imps, w.g_imps) AS g_imps,
    COALESCE(e.o_imps, d.o_imps, w.o_imps) AS o_imps,
    COALESCE(e.g_vw,   d.g_vw,   w.g_vw)   AS g_vw,
    COALESCE(e.o_vw,   d.o_vw,   w.o_vw)   AS o_vw,
    COALESCE(e.g_clk,  d.g_clk,  w.g_clk)  AS g_clk,
    COALESCE(e.o_clk,  d.o_clk,  w.o_clk)  AS o_clk,
    COALESCE(e.g_vid,  d.g_vid,  w.g_vid)  AS g_vid,
    COALESCE(e.o_vid,  d.o_vid,  w.o_vid)  AS o_vid,
    COALESCE(e.g_cost, d.g_cost, w.g_cost) AS g_cost,
    COALESCE(e.o_cost, d.o_cost, w.o_cost) AS o_cost,
    e.g_imps AS exact_g_imps
  FROM keys k
  LEFT JOIN geo e USING (short_token, date, line_item_id, creative_id)
  LEFT JOIN geo_line_day d USING (short_token, date, line_item_id)
  LEFT JOIN geo_line w USING (short_token, line_item_id)
)
SELECT short_token, date, line_item_id, creative_id, method, u_imps, exact_g_imps,
  {frac("o_imps", "g_imps")} AS f_imps,
  {frac("o_vw", "g_vw")}     AS f_viewable,
  {frac("o_clk", "g_clk")}   AS f_clicks,
  {frac("o_vid", "g_vid")}   AS f_video,
  {frac("o_cost", "g_cost")} AS f_cost
FROM picked
WHERE method IS NOT NULL;

-- Conciliação por token nas chaves exatas + números pro admin.
CREATE TEMP TABLE recon AS
SELECT c.short_token,
  SUM(IF(a.method = 'exact' AND a.u_imps > 0, a.u_imps, 0)) AS exact_u_imps,
  SUM(IF(a.method = 'exact' AND a.u_imps > 0, a.exact_g_imps, 0)) AS exact_g_imps
FROM cfg c LEFT JOIN new_adj a USING (short_token)
GROUP BY 1;

CREATE TEMP TABLE new_status AS
WITH u AS (
  SELECT u.short_token, u.line_item_id, u.date, u.creative_id,
         SUM(u.impressions) imps, SUM(u.viewable_impressions) vw,
         SUM(u.clicks) clk, SUM(u.video_view_100_complete) vid,
         SUM(u.total_cost) cost
  FROM {UNIFIED_TABLE} u JOIN cfg c USING (short_token)
  WHERE u.date >= d_from
    AND (c.date_from IS NULL OR u.date >= c.date_from)
    AND (c.date_to IS NULL OR u.date <= c.date_to)
  GROUP BY 1, 2, 3, 4
),
agg AS (
  SELECT u.short_token,
    SUM(u.imps) AS unified_imps,
    SUM(u.imps * IFNULL(a.f_imps, 0)) AS removed_imps,
    SUM(u.vw * IFNULL(a.f_viewable, 0)) AS removed_viewable,
    SUM(u.clk * IFNULL(a.f_clicks, 0)) AS removed_clicks,
    SUM(u.vid * IFNULL(a.f_video, 0)) AS removed_video_100,
    SUM(u.cost * IFNULL(a.f_cost, 0)) AS removed_cost,
    SUM(u.cost) AS unified_cost,
    SUM(IF(a.method = 'exact', u.imps, 0)) AS exact_imps,
    SUM(IF(a.method IN ('line_day', 'line_window'), u.imps, 0)) AS estimated_imps,
    SUM(IF(a.method IS NULL, u.imps, 0)) AS no_geo_imps
  FROM u LEFT JOIN new_adj a USING (short_token, date, line_item_id, creative_id)
  GROUP BY 1
)
SELECT c.short_token,
  CURRENT_TIMESTAMP() AS refreshed_at,
  CASE
    WHEN r.exact_u_imps IS NULL OR r.exact_u_imps = 0 THEN 'no_data'
    WHEN SAFE_DIVIDE(ABS(r.exact_u_imps - r.exact_g_imps), r.exact_u_imps) <= {tolerance} THEN 'ok'
    ELSE 'blocked'
  END AS status,
  ROUND(SAFE_DIVIDE(ABS(r.exact_u_imps - r.exact_g_imps), r.exact_u_imps) * 100, 3) AS recon_diff_pct,
  CAST(g.unified_imps AS INT64) AS unified_imps,
  g.removed_imps, g.removed_viewable, g.removed_clicks, g.removed_video_100,
  ROUND(g.removed_cost, 2) AS removed_cost,
  ROUND(g.unified_cost, 2) AS unified_cost,
  CAST(g.exact_imps AS INT64) AS exact_imps,
  CAST(g.estimated_imps AS INT64) AS estimated_imps,
  CAST(g.no_geo_imps AS INT64) AS no_geo_imps,
  (SELECT MAX(date) FROM geo x WHERE x.short_token = c.short_token) AS last_geo_date,
  {SCRIPT_VERSION} AS script_version
FROM cfg c
LEFT JOIN recon r USING (short_token)
LEFT JOIN agg g USING (short_token);

-- Status: os tokens calculados agora + (no recálculo parcial) o status
-- publicado dos demais tokens da config.
CREATE OR REPLACE TABLE {STATUS_TABLE} AS
SELECT {_STATUS_COLS} FROM new_status
UNION ALL
SELECT {_STATUS_COLS} FROM {STATUS_TABLE}
WHERE scoped
  AND short_token IN (SELECT short_token FROM cfg_all)
  AND short_token NOT IN (SELECT short_token FROM cfg);

-- Publica: token conciliado recebe a fração nova; token que não fechou
-- mantém a última publicada (ou fica sem ajuste); token fora deste cálculo
-- mantém a sua. Token que saiu da config some.
CREATE OR REPLACE TABLE {ADJ_TABLE}
CLUSTER BY short_token AS
SELECT short_token, date, line_item_id, creative_id, method,
       f_imps, f_viewable, f_clicks, f_video, f_cost
FROM new_adj
WHERE short_token IN (SELECT short_token FROM new_status WHERE status = 'ok')
UNION ALL
SELECT short_token, date, line_item_id, creative_id, method,
       f_imps, f_viewable, f_clicks, f_video, f_cost
FROM {ADJ_TABLE}
WHERE short_token IN (SELECT short_token FROM cfg_all)
  AND short_token NOT IN (SELECT short_token FROM new_status WHERE status = 'ok');

SELECT * FROM {STATUS_TABLE} ORDER BY short_token;
"""


_refresh_lock = threading.Lock()


def _status_is_current(bq):
    """O status publicado está no formato desta versão? Recálculo parcial só
    é seguro assim (ele reaproveita as linhas dos outros tokens)."""
    try:
        schema = {f.name for f in bq.get_table(STATUS_TABLE.strip("`")).schema}
        if "script_version" not in schema:
            return False
        rows = list(bq.query(f"SELECT MIN(script_version) AS v FROM {STATUS_TABLE}",
                             location="US").result())
        v = rows[0]["v"] if rows else None
        return v is None or v == SCRIPT_VERSION
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[geo_exclusions] checagem de versão do status falhou: {e}")
        return False


def refresh(bq, scope=None):
    """Recalcula frações e status. `scope` (lista de tokens) limita o cálculo
    a eles; sem scope, ou com status de versão antiga, recalcula todos. Um
    refresh por instância por vez. Devolve o status de todos os tokens."""
    ensure_tables(bq)
    if _last_modified_ms(bq, "prod_assets", COMPACT_TABLE_ID) is None:
        sync_compact(bq, force=True)  # primeira vez: ~20s, depois só no warmup
    scope = sorted({normalize_token(t) for t in (scope or [])})
    if scope and not _status_is_current(bq):
        scope = []
    with _refresh_lock:
        t0 = time.time()
        cfg = bigquery.QueryJobConfig(
            maximum_bytes_billed=MAX_BYTES_BILLED,
            query_parameters=[bigquery.ArrayQueryParameter("scope", "STRING", scope)],
        )
        job = bq.query(build_refresh_script(), job_config=cfg, location="US")
        rows = [dict(r) for r in job.result()]
        invalidate_active_cache()
        for r in rows:
            for k in ("refreshed_at", "last_geo_date"):
                if r.get(k) is not None:
                    r[k] = r[k].isoformat()
        logger.warning(f"[geo_exclusions] refresh {scope or 'total'} em {time.time() - t0:.1f}s: "
                       + ", ".join(f"{r['short_token']}={r['status']}" for r in rows))
        return rows


def _last_modified_ms(bq, dataset, table):
    try:
        return int(bq.get_table(f"{PROJECT}.{dataset}.{table}").modified.timestamp() * 1000)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[geo_exclusions] last_modified de {dataset}.{table} falhou: {e}")
        return None


def needs_refresh(bq):
    """True quando alguma fonte (Region, unified, campaign_results, config,
    países liberados) mudou depois do último refresh. Só metadata."""
    try:
        ensure_tables(bq)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[geo_exclusions] tabelas indisponíveis: {e}")
        return False
    adj = _last_modified_ms(bq, "prod_assets", ADJ_TABLE_ID)
    if adj is None:
        return False
    if not _status_is_current(bq):
        return True
    for ds, tb in SOURCE_TABLES:
        lm = _last_modified_ms(bq, ds, tb)
        if lm is not None and lm > adj:
            return True
    return False


def has_config(bq):
    try:
        ensure_tables(bq)
        rows = list(bq.query(f"SELECT COUNT(*) AS n FROM {CONFIG_TABLE}", location="US").result())
        return bool(rows and rows[0]["n"])
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[geo_exclusions] leitura da config falhou: {e}")
        return False


def build_compact_sql():
    return f"""
        CREATE OR REPLACE TABLE {COMPACT_TABLE}
        PARTITION BY date
        CLUSTER BY line_item_id AS
        SELECT date,
               CAST(line_item_id AS STRING) AS line_item_id,
               CAST(creative_id AS STRING) AS creative_id,
               UPPER(TRIM(CAST(country_code AS STRING))) AS cc,
               SUM(impressions) AS impressions,
               SUM(viewable_impressions) AS viewable_impressions,
               SUM(clicks) AS clicks,
               SUM(video_view_100_complete) AS video_view_100_complete,
               SUM(total_media_cost_advertiser_currency) AS total_media_cost_advertiser_currency
        FROM {REGIONS_TABLE}
        WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL {COMPACT_LOOKBACK_DAYS} DAY)
        GROUP BY 1, 2, 3, 4
    """


_compact_lock = threading.Lock()


def sync_compact(bq, force=False):
    """Refaz a cópia compacta quando o Region mudou depois dela (ou quando
    não existe). Reconstrução inteira, não incremental: pega também dia antigo
    reprocessado (o 12/09 que faltou). Devolve True se reconstruiu."""
    with _compact_lock:
        compact = _last_modified_ms(bq, "prod_assets", COMPACT_TABLE_ID)
        if not force and compact is not None:
            regions = _last_modified_ms(bq, "prod_assets", "dv360_daily_regions_performance_metrics")
            if regions is None or regions <= compact:
                return False
        t0 = time.time()
        cfg = bigquery.QueryJobConfig(maximum_bytes_billed=MAX_BYTES_BILLED)
        bq.query(build_compact_sql(), job_config=cfg, location="US").result()
        logger.warning(f"[geo_exclusions] cópia compacta do Region refeita em {time.time() - t0:.1f}s")
        return True


def refresh_if_stale(bq):
    """Chamado pelo cron de warmup. Não faz nada sem config; com config,
    atualiza a cópia compacta do Region se ele mudou e só recalcula se alguma
    fonte mudou. Devolve o status, ou None se não rodou."""
    if not has_config(bq) and not active_tokens(bq):
        return None
    sync_compact(bq)
    if not needs_refresh(bq):
        return None
    return refresh(bq)
