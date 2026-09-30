"""
Analytics › Saúde das DSPs — performance e custo por DSP no admin.

Responde "como está cada DSP", no total e quebrado por DSP, formato, com/sem
ABS, campanha, IO e line: impressões, mensuráveis, visíveis, cliques, CTR,
VTR, viewability, custo, eCPM e vCPM, mês a mês ou dia a dia. É a camada de
ANÁLISE; o popover "Saúde das DSPs" do rail (dsp_health) continua sendo o
alarme de volume D-1.

De onde vem
-----------
`bidiq_mart.unified_daily_performance` (o consolidado diário, nome novo da
taxonomia). O `total_cost` dele é o custo que a DSP cobrou, com todas as fees,
em BRL — conferido centavo a centavo mês a mês em 30/09/2026:

  DV360  = Total Media Cost (advertiser currency, BRL em 100% das linhas),
           que já inclui a fee pré-bid da DV, a platform fee e as data fees.
  Yahoo  = Advertiser Spending BRL (currency BRL em 100% das linhas).

NUNCA ler a staging da Yahoo (`staging.yahoo_dsp_daily_performance_metrics`):
ela guarda cada reingestão do dia (29 a 37 por mês). Somada crua, setembro
dá R$ 404k contra R$ 72k reais. O dedup mora no modelo dbt tratado.

Sem ajuste geo (geo_exclusions): aqui a pergunta é o que a DSP entregou e
cobrou, não o que o report do cliente exibe.

Hierarquia
----------
Campanha HYPR = `short_token` (nome e cliente do checklist). IO = o
`campaign_name` do consolidado: no DV360 é o nome do insertion order
(conferido 1:1 contra a dv360_daily_costs), na Yahoo é o Campaign da Yahoo,
na Amazon a campanha da Amazon. Line = `line_item_id` + `line_name`.

Entrega sem `short_token` (line fora da nomenclatura) entra no total por DSP
num balde próprio ("Sem campanha") e sai quando o admin filtra campanha.

ABS (Brand Safety pre-bid) por LINE
-----------------------------------
Campanha mistura line com e sem ABS, então a classificação é por line, em
ordem:

  1. fee     — DV360 com `doubleverify_pre_bid_fee` > 0 na dv360_daily_costs
               em qualquer dia da vida da line. É prova de custo.
  2. cliente — cliente da campanha está na lista de clientes que rodam com
               ABS (ABS_CLIENTS, definida pelo ad ops). Única via pra Yahoo,
               que não traz a fee da DV no dado.
  3. override — admin marcou a campanha no drawer (campaign_abs_overrides).

O nome da line (`ABS` / `NO-ABS`) NÃO classifica; vai no payload (`tag`) pra
tela acusar divergência: desde junho/26, R$ 19,7 mil de fee pré-bid foram
cobrados em lines nomeadas NO-ABS.

Survey
------
Linhas de survey/controle/exposto (mesma regex do report) vêm marcadas
(`sv`), não excluídas: o custo delas é custo real da DSP. A tela decide se
entram na análise (toggle).

Payload compacto
----------------
Um ano dá ~48 mil linhas de série e ~17,5 mil lines, então as linhas vão
como arrays posicionais (ver SERIES_COLS / LINE_COLS) com dimensões
dicionarizadas (datas, tokens, IOs). O front filtra e agrega em memória:
todo recorte (DSP, formato, ABS, campanha, IO, survey) reage sem ida ao
servidor, como na página do DoubleVerify.
"""
import logging
import re
from datetime import date, datetime, timedelta, timezone

logger = logging.getLogger(__name__)

UNIFIED = "`site-hypr.bidiq_mart.unified_daily_performance`"
DV360_COSTS = "`site-hypr.bidiq_enriched.dv360_daily_costs`"
CHECKLIST = "`site-hypr.hyprops_mart.checklist_info`"
ABS_OVERRIDES = "`site-hypr.prod_assets.campaign_abs_overrides`"

# Mesma regra de survey/controle do report (query_totals/query_daily).
SURVEY_LINE_RE = r"SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST"

# Clientes que rodam com ABS (lista do ad ops, 30/09/2026). Cada entrada é
# (rótulo exibido, regex sobre UPPER(client_name) do checklist). As variações
# de grafia reais do checklist estão cobertas: "O Boticario"/"O Boticário",
# "PepsiCo"/"Pepsico", "Mercedes Benz"/"Mercedes-Benz". "Amazon" é o CLIENTE
# Amazon (anunciante), não a DSP Amazon — o match é no client_name, nunca no
# source, e exige o nome inteiro pra não pegar "Amazonas"/"Amazon Prime Video
# de outro anunciante".
ABS_CLIENTS = [
    ("Kenvue",       r"KENVUE"),
    ("Diageo",       r"DIAGEO"),
    ("Mercedes-Benz", r"MERCEDES"),
    ("JLR",          r"\bJLR\b|JAGUAR|LAND ROVER"),
    ("Colgate",      r"COLGATE"),
    ("O Boticário",  r"BOTIC[AÁ]RIO"),
    ("Santander",    r"SANTANDER"),
    ("Mondelez",     r"MONDEL[EÊ]Z"),
    ("PepsiCo",      r"PEPSI"),
    ("Unilever",     r"UNILEVER"),
    ("Amazon",       r"^AMAZON$"),
]
ABS_CLIENT_RE = "|".join(f"(?:{rx})" for _, rx in ABS_CLIENTS)

MAX_RANGE_DAYS = 400
DEFAULT_RANGE_DAYS = 30
MAX_LINE_KEYS = 50

BRT = timezone(timedelta(hours=-3))

# Colunas posicionais. Métricas iguais nos três blocos, na mesma ordem.
METRIC_COLS = ["imp", "meas", "view", "clk", "cost", "vst", "v100", "vcomp", "fee"]
SERIES_COLS = ["d", "s", "m", "abs", "sv", "tk", "io"] + METRIC_COLS
PREV_COLS = ["s", "m", "abs", "sv", "tk", "io"] + METRIC_COLS
LINE_COLS = ["key", "s", "m", "abs", "reason", "sv", "tk", "io", "name", "tag",
             "first", "last"] + METRIC_COLS
LINE_DAILY_COLS = ["key", "d"] + METRIC_COLS

_MEDIA = {"DISPLAY": "DISPLAY", "VIDEO": "VIDEO"}


# ── Janela ─────────────────────────────────────────────────────────────────

def today_brt(now=None):
    return (now or datetime.now(timezone.utc)).astimezone(BRT).date()


def _parse_day(raw, name):
    try:
        return date.fromisoformat(str(raw).strip()[:10])
    except (TypeError, ValueError):
        raise ValueError(f"{name} inválido (use YYYY-MM-DD)")


def resolve_window(from_s=None, to_s=None, now=None):
    """(from, to, prev_from, prev_to), todos `date`, inclusivos.

    Sem datas: últimos DEFAULT_RANGE_DAYS dias fechados (até ontem em BRT —
    o consolidado é D-1). `to` no futuro é puxado pra ontem. O período
    anterior tem o mesmo número de dias, colado antes de `from`.
    """
    yesterday = today_brt(now) - timedelta(days=1)
    d_to = _parse_day(to_s, "to") if to_s else yesterday
    d_to = min(d_to, yesterday)
    d_from = _parse_day(from_s, "from") if from_s else d_to - timedelta(days=DEFAULT_RANGE_DAYS - 1)
    if d_from > d_to:
        raise ValueError("from depois de to")
    span = (d_to - d_from).days + 1
    if span > MAX_RANGE_DAYS:
        raise ValueError(f"período máximo é {MAX_RANGE_DAYS} dias")
    prev_to = d_from - timedelta(days=1)
    prev_from = prev_to - timedelta(days=span - 1)
    return d_from, d_to, prev_from, prev_to


# ── SQL ────────────────────────────────────────────────────────────────────

def _base_ctes():
    """CTEs comuns: linha do consolidado já com survey, formato, ABS da line
    e a fee pré-bid DV do dia. Janela @prev_from..@to (período + anterior).

    `vcomp` (completions visíveis) é calculado POR LINHA CRUA antes de somar,
    igual ao report: video_view_100 × viewable ÷ impressions. Somar primeiro
    e dividir depois dá outro número.
    """
    return f"""
    fee_lines AS (
      -- Line DV360 que pagou fee pré-bid da DV em qualquer dia: é ABS.
      SELECT DISTINCT line_item_id
      FROM {DV360_COSTS}
      WHERE doubleverify_pre_bid_fee_advertiser_currency > 0
    ),
    fee_daily AS (
      SELECT date, line_item_id,
             SUM(doubleverify_pre_bid_fee_advertiser_currency) AS prebid_fee
      FROM {DV360_COSTS}
      WHERE date BETWEEN @prev_from AND @to
      GROUP BY date, line_item_id
    ),
    checklist AS (
      SELECT short_token,
             ANY_VALUE(client_name)   AS client_name,
             ANY_VALUE(campaign_name) AS campaign_name
      FROM {CHECKLIST}
      WHERE short_token IS NOT NULL
      GROUP BY short_token
    ),
    overrides AS (
      SELECT DISTINCT short_token FROM {ABS_OVERRIDES} WHERE has_abs = TRUE
    ),
    raw AS (
      SELECT
        date,
        UPPER(source) AS source,
        CASE UPPER(IFNULL(media_type, ''))
          WHEN 'DISPLAY' THEN 'DISPLAY' WHEN 'VIDEO' THEN 'VIDEO' ELSE 'OUTRO'
        END AS media,
        short_token,
        IFNULL(campaign_name, '') AS io_name,
        COALESCE(line_item_id, line_name, '') AS line_id,
        line_name,
        client_name AS dsp_client,
        (REGEXP_CONTAINS(UPPER(IFNULL(line_name, '')), r'{SURVEY_LINE_RE}')
          OR UPPER(IFNULL(creative_name, '')) LIKE '%SURVEY%') AS is_survey,
        impressions, measurable_impressions, viewable_impressions, clicks,
        total_cost, video_starts, video_view_100_complete,
        IF(impressions > 0 AND UPPER(media_type) = 'VIDEO',
           video_view_100_complete * (viewable_impressions / impressions), 0) AS vcomp
      FROM {UNIFIED}
      WHERE date BETWEEN @prev_from AND @to
    ),
    line_day AS (
      SELECT
        date, source, media, short_token, io_name, line_id, is_survey,
        ANY_VALUE(line_name)  AS line_name,
        ANY_VALUE(dsp_client) AS dsp_client,
        SUM(impressions)             AS imp,
        SUM(measurable_impressions)  AS meas,
        SUM(viewable_impressions)    AS view,
        SUM(clicks)                  AS clk,
        SUM(total_cost)              AS cost,
        SUM(video_starts)            AS vst,
        SUM(video_view_100_complete) AS v100,
        SUM(vcomp)                   AS vcomp
      FROM raw
      GROUP BY date, source, media, short_token, io_name, line_id, is_survey
    ),
    base AS (
      SELECT
        l.*,
        -- A fee é por (dia, line) e a line_day pode ter mais de um balde
        -- (criativo de survey + normal, rename de IO): rateia pela
        -- impressão pra somar exatamente a fee do dia, sem duplicar.
        IF(l.source = 'DV360',
           IFNULL(f.prebid_fee * SAFE_DIVIDE(
             l.imp, SUM(l.imp) OVER (PARTITION BY l.date, l.source, l.line_id)), 0),
           0) AS fee,
        CASE
          WHEN l.source = 'DV360' AND fl.line_item_id IS NOT NULL THEN 'fee'
          WHEN REGEXP_CONTAINS(UPPER(COALESCE(c.client_name, l.dsp_client, '')), r'{ABS_CLIENT_RE}') THEN 'cliente'
          WHEN o.short_token IS NOT NULL THEN 'override'
          ELSE NULL
        END AS abs_reason
      FROM line_day l
      LEFT JOIN fee_lines fl ON l.source = 'DV360' AND fl.line_item_id = l.line_id
      LEFT JOIN fee_daily f  ON l.source = 'DV360' AND f.line_item_id = l.line_id AND f.date = l.date
      LEFT JOIN checklist c  ON c.short_token = l.short_token
      LEFT JOIN overrides o  ON o.short_token = l.short_token
    )
    """


_METRIC_SUMS = """
      SUM(imp) AS imp, SUM(meas) AS meas, SUM(view) AS view, SUM(clk) AS clk,
      SUM(cost) AS cost, SUM(vst) AS vst, SUM(v100) AS v100, SUM(vcomp) AS vcomp,
      SUM(fee) AS fee"""


def build_series_sql():
    """Dia × DSP × formato × ABS × survey × campanha × IO do período E do
    anterior, numa varredura só: o Python separa a janela atual (série) e
    agrega a anterior sem data (variações). Antes eram duas queries sobre a
    mesma base, cada uma varrendo o consolidado inteiro da janela dupla."""
    return f"""
    WITH {_base_ctes()}
    SELECT date, source, media, abs_reason IS NOT NULL AS is_abs, is_survey,
           short_token, io_name,{_METRIC_SUMS}
    FROM base
    WHERE date BETWEEN @prev_from AND @to
    GROUP BY date, source, media, is_abs, is_survey, short_token, io_name
    """


_PREV_DIMS = ("source", "media", "is_abs", "is_survey", "short_token", "io_name")
_SUM_KEYS = ("imp", "meas", "view", "clk", "cost", "vst", "v100", "vcomp", "fee")


def split_series(rows, d_from):
    """Separa as rows diárias em (série do período, anterior agregado sem data)."""
    series, prev = [], {}
    for r in rows:
        day = r["date"]
        if not isinstance(day, date):
            day = date.fromisoformat(str(day)[:10])
        if day >= d_from:
            series.append(r)
            continue
        key = tuple(r.get(k) for k in _PREV_DIMS)
        acc = prev.get(key)
        if acc is None:
            acc = {k: r.get(k) for k in _PREV_DIMS}
            acc.update({k: 0 for k in _SUM_KEYS})
            prev[key] = acc
        for k in _SUM_KEYS:
            acc[k] += r.get(k) or 0
    return series, list(prev.values())


def build_lines_sql():
    return f"""
    WITH {_base_ctes()}
    SELECT source, media, line_id, short_token, io_name, is_survey,
           ANY_VALUE(abs_reason) AS abs_reason,
           ANY_VALUE(line_name)  AS line_name,
           MIN(date) AS first_date, MAX(date) AS last_date,{_METRIC_SUMS}
    FROM base
    WHERE date BETWEEN @from AND @to
    GROUP BY source, media, line_id, short_token, io_name, is_survey
    """


def build_meta_sql():
    """Cliente/campanha do checklist pros tokens da janela."""
    return f"""
    SELECT short_token, ANY_VALUE(client_name) AS client_name,
           ANY_VALUE(campaign_name) AS campaign_name
    FROM {CHECKLIST}
    WHERE short_token IN UNNEST(@tokens)
    GROUP BY short_token
    """


def build_line_daily_sql():
    """Série diária de lines escolhidas (filtro por line na tela)."""
    return f"""
    WITH {_base_ctes()}
    SELECT CONCAT(source, '|', line_id, '|', IF(is_survey, '1', '0')) AS key,
           date,{_METRIC_SUMS}
    FROM base
    WHERE date BETWEEN @from AND @to
      AND CONCAT(source, '|', line_id, '|', IF(is_survey, '1', '0')) IN UNNEST(@keys)
    GROUP BY key, date
    """


# ── Nome da line: ABS / NO-ABS ─────────────────────────────────────────────

_NO_ABS_RE = re.compile(r"NO[-_ ]?ABS")
_ABS_RE = re.compile(r"(^|[-_ ])ABS([-_ ]|$)")


def name_tag(line_name):
    """'NO-ABS' | 'ABS' | None pelo nome da line (só pra divergência)."""
    up = (line_name or "").upper()
    if _NO_ABS_RE.search(up):
        return "NO-ABS"
    if _ABS_RE.search(up):
        return "ABS"
    return None


def line_key(source, line_id, is_survey):
    return f"{source}|{line_id}|{'1' if is_survey else '0'}"


# ── Montagem do payload (pura) ─────────────────────────────────────────────

def _metrics(r):
    return [
        int(r.get("imp") or 0),
        int(r.get("meas") or 0),
        int(r.get("view") or 0),
        int(r.get("clk") or 0),
        round(float(r.get("cost") or 0), 4),
        int(r.get("vst") or 0),
        int(r.get("v100") or 0),
        round(float(r.get("vcomp") or 0), 2),
        round(float(r.get("fee") or 0), 4),
    ]


def _iso(v):
    if v is None:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else str(v)[:10]


def build_payload(series_rows, prev_rows, line_rows, meta_rows, window, generated_at=None):
    """Monta o payload compacto a partir das rows do BQ (dicts).

    `window` = (from, to, prev_from, prev_to). Rows sem impressão nem custo
    são descartadas (ruído de line criada e não veiculada).
    """
    d_from, d_to, prev_from, prev_to = window

    tokens, token_idx = [], {}
    ios, io_idx = [], {}
    dates, date_idx = [], {}
    meta = {r["short_token"]: r for r in meta_rows or []}

    def tk(token):
        key = token or None
        if key not in token_idx:
            token_idx[key] = len(tokens)
            m = meta.get(key) or {}
            tokens.append({
                "t": key,
                "client": m.get("client_name") or ("Sem campanha" if key is None else None),
                "campaign": m.get("campaign_name") or ("Entrega sem short_token" if key is None else None),
            })
        return token_idx[key]

    def io(name):
        name = name or ""
        if name not in io_idx:
            io_idx[name] = len(ios)
            ios.append(name)
        return io_idx[name]

    def dt(v):
        iso = _iso(v)
        if iso not in date_idx:
            date_idx[iso] = len(dates)
            dates.append(iso)
        return date_idx[iso]

    def live(r):
        return (r.get("imp") or 0) > 0 or (r.get("cost") or 0) > 0

    # Datas ordenadas: o índice vira ordem cronológica.
    for r in sorted((r for r in series_rows if live(r)), key=lambda r: _iso(r["date"])):
        dt(r["date"])

    sources = set()
    series = []
    for r in series_rows:
        if not live(r):
            continue
        sources.add(r["source"])
        series.append([
            date_idx[_iso(r["date"])], r["source"], _MEDIA.get(r["media"], "OUTRO"),
            1 if r.get("is_abs") else 0, 1 if r.get("is_survey") else 0,
            tk(r.get("short_token")), io(r.get("io_name")),
        ] + _metrics(r))
    series.sort(key=lambda x: (x[0], x[1]))

    prev = []
    for r in prev_rows:
        if not live(r):
            continue
        sources.add(r["source"])
        prev.append([
            r["source"], _MEDIA.get(r["media"], "OUTRO"),
            1 if r.get("is_abs") else 0, 1 if r.get("is_survey") else 0,
            tk(r.get("short_token")), io(r.get("io_name")),
        ] + _metrics(r))

    lines = []
    for r in line_rows:
        if not live(r):
            continue
        lines.append([
            line_key(r["source"], r.get("line_id") or "", r.get("is_survey")),
            r["source"], _MEDIA.get(r["media"], "OUTRO"),
            1 if r.get("abs_reason") else 0, r.get("abs_reason"),
            1 if r.get("is_survey") else 0,
            tk(r.get("short_token")), io(r.get("io_name")),
            r.get("line_name") or "", name_tag(r.get("line_name")),
            _iso(r.get("first_date")), _iso(r.get("last_date")),
        ] + _metrics(r))
    lines.sort(key=lambda x: -x[len(LINE_COLS) - len(METRIC_COLS)])

    return {
        "from": d_from.isoformat(),
        "to": d_to.isoformat(),
        "prev_from": prev_from.isoformat(),
        "prev_to": prev_to.isoformat(),
        "generated_at": (generated_at or datetime.now(timezone.utc)).isoformat(),
        "abs_clients": [label for label, _ in ABS_CLIENTS],
        "sources": sorted(sources),
        "dates": dates,
        "tokens": tokens,
        "ios": ios,
        "series_cols": SERIES_COLS,
        "prev_cols": PREV_COLS,
        "line_cols": LINE_COLS,
        "series": series,
        "prev": prev,
        "lines": lines,
    }


# ── Leitura ────────────────────────────────────────────────────────────────

def _params(bigquery, window, extra=()):
    d_from, d_to, prev_from, prev_to = window
    return bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("from", "DATE", d_from),
        bigquery.ScalarQueryParameter("to", "DATE", d_to),
        bigquery.ScalarQueryParameter("prev_from", "DATE", prev_from),
        bigquery.ScalarQueryParameter("prev_to", "DATE", prev_to),
        *extra,
    ])


def query_dsp_analytics(bq, bigquery, from_s=None, to_s=None, submit=None, timeout=150, now=None):
    """Lê o consolidado e devolve o payload. `bq` é o client compartilhado;
    `bigquery` o módulo google.cloud.bigquery (injetado pra teste). `submit`
    (opcional) = executor.submit do pool de queries do backend: as três
    leituras (série+anterior e lines) são independentes e rodam em paralelo."""
    window = resolve_window(from_s, to_s, now)
    cfg = _params(bigquery, window)

    def run(sql):
        return [dict(r) for r in bq.query(sql, job_config=cfg, location="US").result()]

    sqls = [build_series_sql(), build_lines_sql()]
    if submit:
        futs = [submit(run, s) for s in sqls]
        daily_rows, line_rows = [f.result(timeout=timeout) for f in futs]
    else:
        daily_rows, line_rows = [run(s) for s in sqls]
    series_rows, prev_rows = split_series(daily_rows, window[0])

    tokens = sorted({r["short_token"] for r in series_rows + prev_rows + line_rows if r.get("short_token")})
    meta_rows = []
    if tokens:
        meta_cfg = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ArrayQueryParameter("tokens", "STRING", tokens),
        ])
        meta_rows = [dict(r) for r in bq.query(build_meta_sql(), job_config=meta_cfg, location="US").result()]

    return build_payload(series_rows, prev_rows, line_rows, meta_rows, window)


def parse_line_keys(raw):
    """"DV360|123|0,YAHOO|9|0" → lista validada (máx. MAX_LINE_KEYS)."""
    keys = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        pieces = part.split("|")
        if len(pieces) != 3 or pieces[2] not in ("0", "1") or not pieces[0]:
            raise ValueError(f"chave de line inválida: {part}")
        keys.append(part)
    if not keys:
        raise ValueError("keys é obrigatório")
    if len(keys) > MAX_LINE_KEYS:
        raise ValueError(f"máximo de {MAX_LINE_KEYS} lines por vez")
    return sorted(set(keys))


def query_line_daily(bq, bigquery, keys, from_s=None, to_s=None, now=None):
    """Série diária das lines pedidas: {dates, cols, rows:[[key, dIdx, ...]]}."""
    window = resolve_window(from_s, to_s, now)
    cfg = _params(bigquery, window, extra=(bigquery.ArrayQueryParameter("keys", "STRING", keys),))
    rows = [dict(r) for r in bq.query(build_line_daily_sql(), job_config=cfg, location="US").result()]
    dates = sorted({_iso(r["date"]) for r in rows})
    idx = {d: i for i, d in enumerate(dates)}
    out = [[r["key"], idx[_iso(r["date"])]] + _metrics(r) for r in rows]
    out.sort(key=lambda x: (x[1], x[0]))
    return {"from": window[0].isoformat(), "to": window[1].isoformat(),
            "dates": dates, "cols": LINE_DAILY_COLS, "rows": out}
