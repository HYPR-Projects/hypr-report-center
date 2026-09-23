"""
Entrega fora do Brasil (DV360) — box das big metrics do menu admin.

Substitui a planilha manual HYPR_OUT-OF-COUNTRY_<MÊS>, que era montada
baixando o report de Country do DV360 e pivotando na mão.

De onde vem
-----------
`prod_assets.dv360_daily_regions_performance_metrics` — performance DV360
por data × IO × line × criativo × país/região/DMA/cidade, atualizada todo
dia pelo export do DV360 (dbt no Dagster). A coluna de país é
`country_code` (ISO-2, "BR").

O vínculo com a campanha é por `line_item_id` contra a
`unified_daily_performance_metrics`, que tem `short_token` nativo — o mesmo
mapeamento que o ABS automático já usa com a `dv360_daily_costs`. O nome
da line na tabela de regiões vem "normalizado" pelo dbt (sem prefixo
HYPR_), então não dá pra confiar no `ID-<token>_` dele.

Só DV360 por enquanto. StackAdapt, Amazon e Yahoo não têm tabela de região
no BQ; quando tiverem, entram como mais um UNION na CTE `geo`.

A regra de negócio: país previsto no nome da line
-------------------------------------------------
Tudo deveria entregar no Brasil, EXCETO campanha que é de outro país — a
Elux roda Chile, Peru e Colômbia. Um país fora do BR é "previsto" pra uma
line quando:

  1. aparece no nome da line, no nome da campanha/IO da DSP ou no nome da
     campanha no checklist (a Elux Chile se chama "AON CH ELUX": o CH está
     só no nome da campanha, não na line); ou
  2. o admin liberou o país na campanha, no drawer
     (`campaign_country_overrides`) — pra quando o nome não diz.

Então cada impressão cai num de quatro baldes:

  BR          entregou no Brasil
  EXPECTED    fora do BR, num país previsto (regra acima)
  UNEXPECTED  fora do BR, num país que NÃO é previsto
  UNKNOWN     o DV360 não resolveu o país

A taxa do box é UNEXPECTED / total. EXPECTED e UNKNOWN aparecem separados
no hover — nem somam no numerador, nem somem do denominador.

Conta nome de país por extenso (PT/ES/EN) e as abreviações que a operação
usa de fato ("CH" = Chile, visto na AON CH ELUX). Sigla ISO em geral NÃO:
"PE" é Pernambuco, "CO" é Centro-Oeste, "AR" aparece por outros motivos, e
um falso "previsto" esconde exatamente a entrega que o box existe pra
mostrar. "CH" é o ISO da Suíça, mas a regra só libera CL com ele — a HYPR
não roda na Suíça, então o pior caso é não acusar entrega no Chile de uma
campanha com "CH" solto no nome. Ressalva: "PERU" também é a ave — campanha
de Natal com PERU no nome libera entrega no Peru. Raro e pequeno; o drawer
não tem como "desliberar", então se virar problema a exceção entra aqui.

O alerta
--------
O box fica vermelho quando o dia mais recente com dado foge do normal:

  - global: a taxa do dia saltou vs o dia anterior (≥ GLOBAL_JUMP_PP pontos
    e ≥ GLOBAL_JUMP_RATIO×), ou está bem acima da média dos 7 dias
    anteriores (≥ GLOBAL_BASELINE_PP pontos e ≥ GLOBAL_BASELINE_RATIO×);
  - por campanha: a taxa da campanha no dia saltou ≥ CAMPAIGN_JUMP_PP pontos
    vs o dia anterior, com volume mínimo pra 3 impressões em 10 não virar
    30% de alarme.

Os dois cortes (pontos E razão) são de propósito: só pontos dispara em taxa
alta estável que oscila; só razão dispara em 0,1% → 0,3%.
"""

import logging
import re
import threading
import unicodedata
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from google.cloud import bigquery

SP_TZ = ZoneInfo("America/Sao_Paulo")
logger = logging.getLogger(__name__)

REGIONS_TABLE = "`site-hypr.prod_assets.dv360_daily_regions_performance_metrics`"
UNIFIED_TABLE = "`site-hypr.prod_assets.unified_daily_performance_metrics`"
CHECKLIST_TABLE = "`site-hypr.prod_assets.checklist_info`"
OVERRIDES_TABLE = "`site-hypr.prod_assets.campaign_country_overrides`"

# Teto de bytes por query. A tabela de regiões tem ~127 GB; com poda por
# `date` o recorte de um mês fica em poucos GB. Se a tabela não estiver
# particionada por data a query estoura aqui e falha com erro explícito, em
# vez de varrer tudo em silêncio a cada cache miss.
MAX_BYTES_BILLED = str(60 * 1024 ** 3)

# Dias antes do dia de referência que entram na conta do alerta (1 pra o
# comparativo dia a dia + 7 pra média de base).
ALERT_LOOKBACK_DAYS = 10

GLOBAL_JUMP_PP = 2.0
GLOBAL_JUMP_RATIO = 1.5
GLOBAL_BASELINE_PP = 3.0
GLOBAL_BASELINE_RATIO = 2.0
GLOBAL_MIN_DAY_IMPS = 100_000

CAMPAIGN_JUMP_PP = 10.0
CAMPAIGN_MIN_DAY_IMPS = 5_000
CAMPAIGN_MIN_DAY_UNEXPECTED = 1_000

# Guarda de qualidade do dado. O modo de falha perigoso aqui é o SILENCIOSO:
# se `country_code` vier num formato que a régua não reconhece, tudo cai em
# UNKNOWN e o box mostra 0% fora, verde; se o join line_item_id → token
# quebrar (tipo de coluna, formato do id), o ranking e o alerta por campanha
# somem sem erro nenhum. Acima destes cortes o payload leva `data_warnings`
# e o front avisa em vez de exibir o número como se estivesse tudo certo.
# Alguma fatia sem token é normal (line fora da convenção ID-<token>_);
# metade do volume não é.
DQ_MAX_UNKNOWN_SHARE = 0.10
DQ_MAX_UNTRACKED_SHARE = 0.50

# Ranking do hover: campanha precisa de volume no mês pra entrar, senão uma
# line de teste com 40 impressões lidera a tabela com 50%.
RANKING_MIN_IMPS = 10_000
RANKING_LIMIT = 15

# Nome por extenso (sem acento, maiúsculo) → ISO-2. Espaço no alias casa
# com qualquer separador de nome de line ("COSTA_RICA", "COSTA-RICA").
COUNTRY_ALIASES = {
    "AR": ["ARGENTINA"],
    "BO": ["BOLIVIA"],
    "CA": ["CANADA"],
    "CL": ["CHILE", "CH"],
    "CO": ["COLOMBIA"],
    "CR": ["COSTA RICA"],
    "DO": ["REPUBLICA DOMINICANA", "DOMINICAN REPUBLIC"],
    "EC": ["EQUADOR", "ECUADOR"],
    "ES": ["ESPANHA", "ESPANA", "SPAIN"],
    "GT": ["GUATEMALA"],
    "HN": ["HONDURAS"],
    "MX": ["MEXICO"],
    "NI": ["NICARAGUA"],
    "PA": ["PANAMA"],
    "PE": ["PERU"],
    "PR": ["PORTO RICO", "PUERTO RICO"],
    "PT": ["PORTUGAL"],
    "PY": ["PARAGUAI", "PARAGUAY"],
    "SV": ["EL SALVADOR"],
    "US": ["EUA", "USA", "ESTADOS UNIDOS", "UNITED STATES"],
    "UY": ["URUGUAI", "URUGUAY"],
    "VE": ["VENEZUELA"],
}


def _alias_pattern(alias):
    body = alias.replace(" ", "[^A-Z0-9]*")
    return f"(^|[^A-Z0-9]){body}([^A-Z0-9]|$)"


def normalize_text(text):
    """Maiúsculo e sem acento — mesma normalização que o SQL aplica."""
    if not text:
        return ""
    decomposed = unicodedata.normalize("NFD", str(text).upper())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def expected_countries(line_name):
    """Países (ISO-2) liberados pelo nome da line. BR não entra: é sempre
    liberado e tratado à parte."""
    norm = normalize_text(line_name)
    return {
        code
        for code, aliases in COUNTRY_ALIASES.items()
        if any(re.search(_alias_pattern(a), norm) for a in aliases)
    }


def _expected_sql(country_col, text_col):
    """Espelho SQL de `expected_countries`: TRUE quando o país da linha
    aparece por extenso no texto (já normalizado) da line."""
    clauses = []
    for code, aliases in COUNTRY_ALIASES.items():
        alts = "|".join(a.replace(" ", "[^A-Z0-9]*") for a in aliases)
        clauses.append(
            f"({country_col} = '{code}' AND REGEXP_CONTAINS({text_col}, "
            f"r'(^|[^A-Z0-9])({alts})([^A-Z0-9]|$)'))"
        )
    return "(" + "\n          OR ".join(clauses) + ")"


def build_sql(with_overrides=True):
    """`with_overrides=False` é o degrau de segurança: sem a tabela de override
    (não deu pra criar), o box segue com a regra por nome em vez de sumir."""
    expected = _expected_sql("country", "name_text")
    overrides_cte = (
        f"SELECT short_token, countries FROM {OVERRIDES_TABLE}" if with_overrides
        else "SELECT CAST(NULL AS STRING) AS short_token, CAST(NULL AS ARRAY<STRING>) AS countries LIMIT 0"
    )
    return f"""
    WITH line_map AS (
      -- line_item_id → short_token. Sem filtro de source: ids de DSPs
      -- diferentes não colidem (mesmo racional do ABS automático).
      SELECT
        CAST(line_item_id AS STRING) AS line_item_id,
        ANY_VALUE(short_token) AS short_token,
        STRING_AGG(DISTINCT line_name, ' || ' LIMIT 5) AS line_names,
        -- Nome da campanha/IO na DSP: a Elux Chile tem o país só aqui.
        STRING_AGG(DISTINCT campaign_name, ' || ' LIMIT 3) AS dsp_campaign_names
      FROM {UNIFIED_TABLE}
      WHERE date BETWEEN @d_from AND @d_to
        AND line_item_id IS NOT NULL
        AND short_token IS NOT NULL
      GROUP BY 1
    ),
    checklist_names AS (
      SELECT short_token, ANY_VALUE(campaign_name) AS checklist_campaign
      FROM {CHECKLIST_TABLE}
      WHERE short_token IS NOT NULL
      GROUP BY 1
    ),
    overrides AS (
      {overrides_cte}
    ),
    geo AS (
      SELECT
        CAST(line_item_id AS STRING) AS line_item_id,
        date,
        UPPER(TRIM(CAST(country_code AS STRING))) AS cc,
        ANY_VALUE(line_name) AS geo_line_name,
        SUM(impressions) AS imps
      FROM {REGIONS_TABLE}
      WHERE date BETWEEN @d_from AND @d_to
      GROUP BY 1, 2, 3
    ),
    classified AS (
      SELECT
        g.date,
        m.short_token,
        g.imps,
        CASE
          WHEN g.cc IN ('BR', 'BRA', 'BRAZIL', 'BRASIL') THEN 'BR'
          WHEN g.cc IS NULL OR NOT REGEXP_CONTAINS(g.cc, r'^[A-Z]{{2}}$') THEN 'UNKNOWN'
          ELSE g.cc
        END AS country,
        REGEXP_REPLACE(
          NORMALIZE(UPPER(CONCAT(
            IFNULL(m.line_names, ''), ' || ',
            IFNULL(g.geo_line_name, ''), ' || ',
            IFNULL(m.dsp_campaign_names, ''), ' || ',
            IFNULL(c.checklist_campaign, '')
          )), NFD),
          r'\\p{{M}}', ''
        ) AS name_text,
        IFNULL(o.countries, []) AS allowed
      FROM geo g
      LEFT JOIN line_map m USING (line_item_id)
      LEFT JOIN checklist_names c ON c.short_token = m.short_token
      LEFT JOIN overrides o ON o.short_token = m.short_token
    )
    SELECT
      date,
      short_token,
      country,
      CASE
        WHEN country IN ('BR', 'UNKNOWN') THEN country
        WHEN country IN UNNEST(allowed) THEN 'EXPECTED'
        WHEN {expected} THEN 'EXPECTED'
        ELSE 'UNEXPECTED'
      END AS bucket,
      SUM(imps) AS imps
    FROM classified
    GROUP BY 1, 2, 3, 4
    """


# ── Override manual: países liberados por campanha ──────────────────────────
# Tabela criada sob demanda (CREATE IF NOT EXISTS) antes da primeira leitura
# da instância: a query principal a referencia, e tabela ausente derrubaria o
# box inteiro. Um registro por short_token; lista vazia = sem override (a
# linha é apagada).

_overrides_ready = False
_overrides_lock = threading.Lock()


def ensure_overrides_table(bq):
    global _overrides_ready
    if _overrides_ready:
        return
    with _overrides_lock:
        if _overrides_ready:
            return
        bq.query(f"""
            CREATE TABLE IF NOT EXISTS {OVERRIDES_TABLE} (
              short_token STRING NOT NULL,
              countries   ARRAY<STRING>,
              updated_at  TIMESTAMP,
              updated_by  STRING
            )
        """, location="US").result()
        _overrides_ready = True


def normalize_countries(raw):
    """Lista de ISO-2 limpa: maiúscula, sem BR, sem repetição, ordenada."""
    if not isinstance(raw, (list, tuple)):
        raise ValueError("countries deve ser uma lista")
    out = set()
    for c in raw:
        code = str(c or "").strip().upper()
        if not re.fullmatch(r"[A-Z]{2}", code):
            raise ValueError(f"país inválido: {c!r} (use código ISO de 2 letras)")
        if code != "BR":
            out.add(code)
    if len(out) > 30:
        raise ValueError("no máximo 30 países")
    return sorted(out)


def get_country_override(bq, short_token):
    ensure_overrides_table(bq)
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", short_token),
    ])
    rows = list(bq.query(f"""
        SELECT countries, updated_by, updated_at
        FROM {OVERRIDES_TABLE}
        WHERE short_token = @token
        LIMIT 1
    """, job_config=cfg, location="US").result())
    if not rows:
        return None
    r = rows[0]
    return {
        "countries": list(r["countries"] or []),
        "updated_by": r["updated_by"],
        "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
    }


def save_country_override(bq, short_token, countries, updated_by=None):
    """UPSERT (ou DELETE, com lista vazia). Devolve a lista gravada."""
    countries = normalize_countries(countries)
    ensure_overrides_table(bq)
    if not countries:
        cfg = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
        ])
        bq.query(f"DELETE FROM {OVERRIDES_TABLE} WHERE short_token = @token",
                 job_config=cfg, location="US").result()
        return []
    cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", short_token),
        bigquery.ArrayQueryParameter("countries", "STRING", countries),
        bigquery.ScalarQueryParameter("updated_by", "STRING", updated_by),
    ])
    bq.query(f"""
        MERGE {OVERRIDES_TABLE} T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
          UPDATE SET countries = @countries, updated_at = CURRENT_TIMESTAMP(), updated_by = @updated_by
        WHEN NOT MATCHED THEN
          INSERT (short_token, countries, updated_at, updated_by)
          VALUES (@token, @countries, CURRENT_TIMESTAMP(), @updated_by)
    """, job_config=cfg, location="US").result()
    return countries


def month_window(month_key, today):
    """(month_start, month_end, is_current) de 'YYYY-MM'; None = mês de `today`."""
    if month_key:
        if not re.fullmatch(r"\d{4}-\d{2}", month_key):
            raise ValueError("month deve ser YYYY-MM")
        y, m = int(month_key[:4]), int(month_key[5:])
        if not 1 <= m <= 12:
            raise ValueError("month deve ser YYYY-MM")
        start = date(y, m, 1)
    else:
        start = today.replace(day=1)
    nxt = date(start.year + (start.month == 12), start.month % 12 + 1, 1)
    end = nxt - timedelta(days=1)
    is_current = start <= today <= end
    return start, end, is_current


def _rate(part, total):
    return round(part / total * 100, 2) if total else None


def _empty_buckets():
    return {"total": 0, "br": 0, "expected": 0, "unexpected": 0, "unknown": 0}


def _add(acc, bucket, imps):
    acc["total"] += imps
    acc[bucket.lower()] += imps


def build_payload(rows, month_start, month_end, is_current, meta_by_token=None):
    """Agrega as linhas (date, short_token, country, bucket, imps) no payload
    do box. Pura — sem I/O — pra régua ser testável."""
    meta_by_token = meta_by_token or {}

    month = _empty_buckets()
    daily = {}                 # date -> buckets (todas as datas da janela)
    by_token = {}              # token -> buckets do mês
    token_daily = {}           # (token, date) -> buckets
    unexpected_countries = {}  # country -> imps no mês
    expected_countries_imps = {}
    token_unexpected_c = {}    # token -> {country: imps}
    token_expected_c = {}
    untracked = 0

    for r in rows:
        d = r["date"]
        if isinstance(d, datetime):
            d = d.date()
        token = r.get("short_token")
        bucket = r["bucket"]
        country = r["country"]
        imps = int(r["imps"] or 0)
        if imps <= 0:
            continue

        _add(daily.setdefault(d, _empty_buckets()), bucket, imps)
        if token:
            _add(token_daily.setdefault((token, d), _empty_buckets()), bucket, imps)

        if not (month_start <= d <= month_end):
            continue
        _add(month, bucket, imps)
        if bucket == "UNEXPECTED":
            unexpected_countries[country] = unexpected_countries.get(country, 0) + imps
        elif bucket == "EXPECTED":
            expected_countries_imps[country] = expected_countries_imps.get(country, 0) + imps
        if not token:
            untracked += imps
            continue
        _add(by_token.setdefault(token, _empty_buckets()), bucket, imps)
        if bucket == "UNEXPECTED":
            tc = token_unexpected_c.setdefault(token, {})
            tc[country] = tc.get(country, 0) + imps
        elif bucket == "EXPECTED":
            tc = token_expected_c.setdefault(token, {})
            tc[country] = tc.get(country, 0) + imps

    # Dia de referência = último dia com entrega na janela. Não é "ontem" de
    # calendário: se o export do DV360 atrasou, comparar ontem (vazio) com
    # anteontem acusaria queda, não o que interessa aqui.
    data_days = sorted(d for d, b in daily.items() if b["total"] > 0)
    ref_day = data_days[-1] if data_days else None
    prev_day = data_days[-2] if len(data_days) >= 2 else None
    base_days = data_days[-8:-1] if len(data_days) >= 2 else []

    def day_rate(d):
        b = daily.get(d)
        return _rate(b["unexpected"], b["total"]) if b else None

    ref_rate = day_rate(ref_day) if ref_day else None
    prev_rate = day_rate(prev_day) if prev_day else None
    base_tot = sum(daily[d]["total"] for d in base_days)
    base_unx = sum(daily[d]["unexpected"] for d in base_days)
    base_rate = _rate(base_unx, base_tot)

    reasons = []
    ref_total = daily[ref_day]["total"] if ref_day else 0
    if is_current and ref_rate is not None and ref_total >= GLOBAL_MIN_DAY_IMPS:
        if prev_rate is not None and (
            ref_rate - prev_rate >= GLOBAL_JUMP_PP
            and ref_rate >= prev_rate * GLOBAL_JUMP_RATIO
        ):
            reasons.append({
                "kind": "global_jump",
                "rate": ref_rate, "previous_rate": prev_rate,
                "date": ref_day.isoformat(), "previous_date": prev_day.isoformat(),
            })
        if base_rate is not None and (
            ref_rate - base_rate >= GLOBAL_BASELINE_PP
            and ref_rate >= base_rate * GLOBAL_BASELINE_RATIO
        ):
            reasons.append({
                "kind": "global_baseline",
                "rate": ref_rate, "baseline_rate": base_rate,
                "date": ref_day.isoformat(), "baseline_days": len(base_days),
            })

    spiking = set()
    if is_current and ref_day:
        for (token, d), b in token_daily.items():
            if d != ref_day:
                continue
            if b["total"] < CAMPAIGN_MIN_DAY_IMPS or b["unexpected"] < CAMPAIGN_MIN_DAY_UNEXPECTED:
                continue
            rate_d = _rate(b["unexpected"], b["total"])
            prev_b = token_daily.get((token, prev_day)) if prev_day else None
            rate_p = _rate(prev_b["unexpected"], prev_b["total"]) if prev_b else 0.0
            if rate_d - (rate_p or 0.0) >= CAMPAIGN_JUMP_PP:
                spiking.add(token)
                meta = meta_by_token.get(token, {})
                reasons.append({
                    "kind": "campaign_jump",
                    "short_token": token,
                    "client_name": meta.get("client_name"),
                    "campaign_name": meta.get("campaign_name"),
                    "rate": rate_d, "previous_rate": rate_p,
                    "unexpected_impressions": b["unexpected"],
                    "date": ref_day.isoformat(),
                })

    def _top(counter, n=3):
        return [
            {"country": c, "impressions": v}
            for c, v in sorted(counter.items(), key=lambda kv: -kv[1])[:n]
        ]

    campaigns = []
    for token, b in by_token.items():
        if b["unexpected"] <= 0 and token not in spiking:
            continue
        if b["total"] < RANKING_MIN_IMPS and token not in spiking:
            continue
        ref_b = token_daily.get((token, ref_day)) if ref_day else None
        meta = meta_by_token.get(token, {})
        campaigns.append({
            "short_token": token,
            "client_name": meta.get("client_name"),
            "campaign_name": meta.get("campaign_name"),
            "impressions": b["total"],
            "unexpected_impressions": b["unexpected"],
            "expected_impressions": b["expected"],
            "unknown_impressions": b["unknown"],
            "rate": _rate(b["unexpected"], b["total"]),
            "day_rate": _rate(ref_b["unexpected"], ref_b["total"]) if ref_b else None,
            "top_countries": _top(token_unexpected_c.get(token, {})),
            "expected_countries": sorted(token_expected_c.get(token, {})),
            "alert": token in spiking,
        })
    campaigns.sort(key=lambda c: (not c["alert"], -(c["rate"] or 0), -c["unexpected_impressions"]))

    data_warnings = []
    if month["total"]:
        unknown_share = month["unknown"] / month["total"]
        untracked_share = untracked / month["total"]
        if unknown_share > DQ_MAX_UNKNOWN_SHARE:
            data_warnings.append({"kind": "unknown_country", "share": round(unknown_share * 100, 1)})
        if untracked_share > DQ_MAX_UNTRACKED_SHARE:
            data_warnings.append({"kind": "untracked_lines", "share": round(untracked_share * 100, 1)})

    return {
        "source": "DV360",
        "month": month_start.strftime("%Y-%m"),
        "is_current_month": is_current,
        "impressions": month["total"],
        "br_impressions": month["br"],
        "unexpected_impressions": month["unexpected"],
        "expected_impressions": month["expected"],
        "unknown_impressions": month["unknown"],
        "untracked_impressions": untracked,
        "rate": _rate(month["unexpected"], month["total"]),
        "expected_rate": _rate(month["expected"], month["total"]),
        "unknown_rate": _rate(month["unknown"], month["total"]),
        "top_countries": _top(unexpected_countries, 5),
        "expected_countries": _top(expected_countries_imps, 5),
        "reference_date": ref_day.isoformat() if ref_day else None,
        "day_rate": ref_rate,
        "previous_date": prev_day.isoformat() if prev_day else None,
        "previous_day_rate": prev_rate,
        "baseline_rate": base_rate,
        "daily": [
            {"date": d.isoformat(), "impressions": daily[d]["total"],
             "unexpected_impressions": daily[d]["unexpected"],
             "rate": day_rate(d)}
            for d in data_days[-14:]
        ],
        "data_warnings": data_warnings,
        "alert": bool(reasons),
        "alert_reasons": reasons,
        "campaigns": campaigns[:RANKING_LIMIT],
        "campaigns_with_unexpected": sum(1 for b in by_token.values() if b["unexpected"] > 0),
    }


def _job_config(params):
    return bigquery.QueryJobConfig(
        query_parameters=params,
        maximum_bytes_billed=MAX_BYTES_BILLED,
    )


def _campaign_meta(bq, tokens):
    if not tokens:
        return {}
    sql = f"""
        SELECT short_token,
               ANY_VALUE(client_name)   AS client_name,
               ANY_VALUE(campaign_name) AS campaign_name
        FROM {CHECKLIST_TABLE}
        WHERE short_token IN UNNEST(@tokens)
        GROUP BY 1
    """
    cfg = _job_config([bigquery.ArrayQueryParameter("tokens", "STRING", sorted(tokens))])
    rows = bq.query(sql, job_config=cfg, location="US").result()
    return {r["short_token"]: {"client_name": r["client_name"], "campaign_name": r["campaign_name"]} for r in rows}


def query_out_of_country(bq, month_key=None, now=None):
    """Lê a tabela de regiões e devolve o payload do box. `bq` é o client
    compartilhado do backend (bq_client.get_client())."""
    today = (now or datetime.now(SP_TZ)).date()
    month_start, month_end, is_current = month_window(month_key, today)
    d_to = min(month_end, today)
    d_from = min(month_start, d_to - timedelta(days=ALERT_LOOKBACK_DAYS))

    cfg = _job_config([
        bigquery.ScalarQueryParameter("d_from", "DATE", d_from),
        bigquery.ScalarQueryParameter("d_to", "DATE", d_to),
    ])
    try:
        ensure_overrides_table(bq)
        with_overrides = True
    except Exception as e:  # noqa: BLE001 — permissão/DDL não pode derrubar o box
        logger.warning(f"[out_of_country] tabela de override indisponível, seguindo só com a regra por nome: {e}")
        with_overrides = False
    rows = [dict(r) for r in bq.query(build_sql(with_overrides), job_config=cfg, location="US").result()]

    tokens = {r["short_token"] for r in rows if r.get("short_token")}
    meta = _campaign_meta(bq, tokens)
    payload = build_payload(rows, month_start, month_end, is_current, meta)
    payload["server_now"] = datetime.now(SP_TZ).isoformat()
    return payload
