"""
PMP Deals — análise de entregas dos deals de pagamento HYPR.

Substitui o fluxo manual de baixar o report do Xandr Curate e alimentar a
planilha "HYPR Product Performance" no Google Sheets. A fonte da verdade
passa a ser o admin do report center; o sync com o Xandr Curate é
automatizado (ver `xandr_curate.py` — Fase 3).

Modelo de dados
---------------
Duas tabelas no BigQuery (`prod_assets`):

  • `pmp_deals` — MASTER de deals. Linha por deal_id. Campos manuais
    (PI value, margem, status, owner) + campos derivados do nome do deal
    (customer, agency, campanha, quarter). O admin pode sobrescrever os
    derivados a qualquer momento.

  • `pmp_deals_delivery` — FATO diário de delivery. Partition por `day`,
    cluster por `deal_id`. Cada linha é (deal_id, day) com métricas do
    Xandr Curate API (imps, custo, revenue, margem). Upsert via MERGE.

Cálculos derivados (feitos em Python, não persistidos)
------------------------------------------------------
  • curator_total_cost = curator_net_media_cost + curator_tech_fees
  • curator_margin     = curator_revenue - curator_total_cost
  • effective_margin_pct = curator_margin / curator_revenue
  • ecpm = curator_revenue / imps * 1000
  • pct_a_receber = curator_revenue / client_pi_amount  (% do PI que o
    Xandr Curate já reconheceu como revenue)
  • pct_entregue_cliente = total_dv_spend / client_pi_amount  (% do PI
    que o cliente já consumiu na DSP)

Parsing do nome do deal
-----------------------
Padrão observado: `HYPR_<CLIENT>_<DSP>_<AGENCY>_<CAMPAIGN_TOKENS...>_<MONTH>`.
Exemplos:
  HYPR_NESTLE_DV360_WPP_NUTREN-SENIOR-PROMO_DEAL_FLEX-BID_DISPLAY_MAR-26
  HYPR_AMAZON_DSP_ALMAP_5-DO-5_DEAL_ABR-26
  HYPR_LATAM_DSP_CLIENTE-DIRETO_NUBANK_FIXED-BID_DEAL_MAI-26

A heurística é "best effort" — qualquer campo extraído errado pode ser
sobrescrito manualmente via UI.
"""

import logging
import os
import re
from typing import Dict, List, Optional
from google.cloud import bigquery


logger = logging.getLogger(__name__)


PROJECT_ID = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET    = "prod_assets"

TABLE_DEALS    = "pmp_deals"
TABLE_DELIVERY = "pmp_deals_delivery"

# Status workflow. Mantemos como STRING (não ENUM) pra evolução barata.
# Default novo = "Pendente" (sem PI cadastrado ainda).
VALID_STATUSES = {"Pendente", "Andamento", "Revisão", "Finalizado", "Pausado", "Cancelado"}

# Customers conhecidos — normalização de display name.
# Chave: forma uppercase do token do nome do deal (sem hífens). Valor: display name.
# A normalização do parser TIRA os hífens antes do lookup, então
# "MERCADO-LIVRE" e "MERCADOLIVRE" ambos batem na chave "MERCADOLIVRE".
# Casos não mapeados caem em title-case com hífen→espaço.
CUSTOMER_DISPLAY = {
    "NESTLE":         "Nestlé",
    "TIM":            "TIM",
    "AVON":           "Avon",
    "AMAZON":         "Amazon",
    "PICPAY":         "PicPay",
    "LATAM":          "Latam",
    "JBS":            "JBS",
    "RAIADROGASIL":   "RaiaDrogasil",
    "RDSAUDE":        "RaiaDrogasil",
    "NATURA":         "Natura",
    "BOTICARIO":      "O Boticário",
    "OBOTICARIO":     "O Boticário",
    "AMERICANAS":     "Americanas",
    "DISNEY":         "Disney+",
    "DISNEY+":        "Disney+",
    "SANTANDER":      "Santander",
    "HEINEKEN":       "Heineken",
    "MERCADOLIVRE":   "Mercado Livre",
    "FLASHBENEFICIOS":"Flash Benefícios",
    "RENAULT":        "Renault",
    "SANOFI":         "Sanofi",
    "KENVUE":         "Kenvue",
    "ITAU":           "Itaú",
}

# Tokens que aparecem na posição de "cliente" mas NÃO são clientes —
# indicam ordem invertida no nome do deal (ex: HYPR_DEAL_DV360_ITAU_...).
# Nesses casos o cliente real está mais à frente.
NON_CUSTOMER_TOKENS = {"DEAL", "PMP", "CURATE", "CURATED"}

# Map MES → quarter. Mantemos PT-BR (Xandr puxa do nosso template de naming).
MONTH_TO_QUARTER = {
    "JAN": "Q1", "FEV": "Q1", "MAR": "Q1",
    "ABR": "Q2", "MAI": "Q2", "JUN": "Q2",
    "JUL": "Q3", "AGO": "Q3", "SET": "Q3",
    "OUT": "Q4", "NOV": "Q4", "DEZ": "Q4",
}


bq = bigquery.Client()


def _full(table_name: str) -> str:
    return f"`{PROJECT_ID}.{DATASET}.{table_name}`"


# ─── Setup de schema ──────────────────────────────────────────────────────────
_deals_table_ready    = False
_delivery_table_ready = False


def _ensure_deals_table() -> None:
    """Cria `pmp_deals` se não existe. Idempotente, lazy."""
    global _deals_table_ready
    if _deals_table_ready:
        return
    sql = f"""
        CREATE TABLE IF NOT EXISTS {_full(TABLE_DEALS)} (
            deal_id              STRING NOT NULL,
            curated_deal_name    STRING,
            io_name              STRING,
            customer             STRING,
            campaign_name        STRING,
            agency               STRING,
            flight_quarter       STRING,
            flight_month         STRING,
            client_pi_amount     NUMERIC,
            margin_pct           NUMERIC,
            dv_tech_fee_pct      NUMERIC,
            status               STRING,
            owner_email          STRING,
            notes                STRING,
            is_archived          BOOL,
            created_by           STRING,
            created_at           TIMESTAMP,
            updated_by           STRING,
            updated_at           TIMESTAMP
        )
    """
    bq.query(sql).result()
    _deals_table_ready = True


def _ensure_delivery_table() -> None:
    """Cria `pmp_deals_delivery` particionada por dia e clusterizada por deal."""
    global _delivery_table_ready
    if _delivery_table_ready:
        return
    sql = f"""
        CREATE TABLE IF NOT EXISTS {_full(TABLE_DELIVERY)} (
            deal_id                  STRING NOT NULL,
            day                      DATE   NOT NULL,
            imps                     INT64,
            viewable_imps            INT64,
            clicks                   INT64,
            curator_net_media_cost   NUMERIC,
            curator_tech_fees        NUMERIC,
            curator_total_cost       NUMERIC,
            curator_revenue          NUMERIC,
            curator_margin           NUMERIC,
            synced_at                TIMESTAMP
        )
        PARTITION BY day
        CLUSTER BY deal_id
    """
    bq.query(sql).result()
    _delivery_table_ready = True


def setup_schema() -> dict:
    """Cria ambas as tabelas. Chamado uma vez no setup do backend."""
    results = {}
    try:
        _ensure_deals_table()
        results["pmp_deals"] = "ok"
    except Exception as e:
        results["pmp_deals"] = f"erro: {e}"
    try:
        _ensure_delivery_table()
        results["pmp_deals_delivery"] = "ok"
    except Exception as e:
        results["pmp_deals_delivery"] = f"erro: {e}"
    return results


# ─── Parsing do nome do deal ──────────────────────────────────────────────────
# Mapa de meses PT-BR e EN curto pra mesma chave canônica PT.
_MONTH_ALIASES = {
    "JAN": "JAN", "FEV": "FEV", "FEB": "FEV", "MAR": "MAR",
    "ABR": "ABR", "APR": "ABR", "MAI": "MAI", "MAY": "MAI",
    "JUN": "JUN", "JUL": "JUL", "AGO": "AGO", "AUG": "AGO",
    "SET": "SET", "SEP": "SET", "OUT": "OUT", "OCT": "OUT",
    "NOV": "NOV", "DEZ": "DEZ", "DEC": "DEZ",
}
_MONTH_KEYS = "|".join(sorted(set(_MONTH_ALIASES.keys()), key=len, reverse=True))

# Padrões de mês aceitos como ÚLTIMO token do nome:
#   MES-YY                                 ex: MAR-26
#   MES_YY                                 ex: JAN_25
#   MESYY                                  ex: JAN25, NOV25
#   MES_FYYY / MES-FYYY                    ex: JUL_FY25, JAN-FY26
#   MES-MES-YY  / MES-MES-FY25 (ranges)    ex: FEV-MAR-26, JUN-JUL_FY25
#   MES-MES-MES_FY25                       ex: MAI-JUN-JUL_FY25
# Em todos os casos com range, usamos o ÚLTIMO mês da range.
_MONTH_TAIL_RE = re.compile(
    r"^("
    r"(?:" + _MONTH_KEYS + r")"      # primeiro mês
    r"(?:[-_](?:" + _MONTH_KEYS + r")){0,3}"  # opcional 0..3 outros meses em range
    r")"
    r"(?:[-_]FY)?[-_]?(\d{2,4})$",   # ano (com ou sem FY)
    re.IGNORECASE,
)

_SKIP_TOKENS = {
    "DEAL", "FLEX-BID", "FIXED-BID", "FIXED-PRICE", "DISPLAY", "VIDEO", "CTV",
    "OOH", "AUDIO", "PMP", "DV360", "DSP", "XANDR", "CURATE", "CURATED",
    "INSTITUCIONAL",
}


def _try_parse_month_tail(token: str):
    """Tenta interpretar `token` como sufixo de mês (com range).

    Retorna (last_month_pt, year_yy_int) ou None.
    Ex: 'FEV-MAR-26' → ('MAR', 26)
         'JUL_FY25'  → ('JUL', 25)
         'JAN25'     → ('JAN', 25)
         'Sep-FY24'  → ('SET', 24)
    """
    m = _MONTH_TAIL_RE.match(token)
    if not m:
        return None
    months_part = m.group(1)
    year_raw = m.group(2)
    # Pega o último mês da range
    month_tokens = re.split(r"[-_]", months_part)
    last_month = _MONTH_ALIASES.get(month_tokens[-1].upper())
    if not last_month:
        return None
    year_yy = int(year_raw) % 100
    return last_month, year_yy


def parse_deal_name(curated_deal_name: str) -> dict:
    """Quebra o nome do deal em customer/agency/campaign/flight_month.

    Heurística (best effort — admin pode sobrescrever qualquer campo via UI):
      1. Split por `_`.
      2. Primeiro token "HYPR" (com ou sem hífen — aceita HYPR-XANDR, HYPR-DV360).
      3. Token de cliente: token[1] (caso normal). Quando token[1] está em
         NON_CUSTOMER_TOKENS (DEAL, PMP, CURATE), o cliente é deslocado pra
         token[3] (caso HYPR_DEAL_DV360_ITAU_...).
      4. Agência: primeiro token APÓS o cliente que não seja DSP/SKIP nem mês.
      5. Mês (flight_month): último token batendo `_try_parse_month_tail`.
      6. Campanha: tokens entre a agência e o mês, excluindo SKIP_TOKENS.

    Retorna dict com customer, agency, campaign_name, flight_month,
    flight_quarter, flight_year. Valores podem ser None se o nome não bate.
    """
    out = {
        "customer": None, "agency": None, "campaign_name": None,
        "flight_month": None, "flight_quarter": None, "flight_year": None,
    }
    if not curated_deal_name:
        return out

    tokens = [t.strip() for t in curated_deal_name.split("_") if t.strip()]
    if len(tokens) < 2:
        return out

    # Token 0 pode vir como "HYPR", "HYPR-XANDR", "HYPR-DV360" etc.
    # Aceitamos qualquer um que comece com HYPR-prefix.
    first_upper = tokens[0].upper()
    if not (first_upper == "HYPR" or first_upper.startswith("HYPR-")):
        return out

    # Detecta ordem invertida: token 1 não é cliente (é DEAL/PMP/...) →
    # tenta token 3 como cliente.
    cust_idx = 1
    if tokens[1].upper() in NON_CUSTOMER_TOKENS and len(tokens) > 3:
        cust_idx = 3

    customer_token_raw = tokens[cust_idx]
    # Normaliza: tira hífens pra match em CUSTOMER_DISPLAY, mantém o
    # original como fallback (com hífen→espaço, title case).
    customer_lookup = customer_token_raw.upper().replace("-", "")
    if customer_lookup in CUSTOMER_DISPLAY:
        out["customer"] = CUSTOMER_DISPLAY[customer_lookup]
    elif customer_token_raw.upper() in NON_CUSTOMER_TOKENS:
        # Mesmo após shift, ainda não acharemos cliente — deixa NULL.
        # Provavelmente nome de teste/deal interno; admin arquiva.
        out["customer"] = None
    else:
        out["customer"] = customer_token_raw.replace("-", " ").title()

    # Mês: tenta do ÚLTIMO ao penúltimo token. Casos cobertos:
    #   a) Tudo num token só: "ABR-26", "JUL_FY25" (sem _ no meio), "JUN-JUL25"
    #   b) Mês + ano em DOIS tokens consecutivos: tokens[-2]="JUL", tokens[-1]="FY25"
    #      (caso mais comum no histórico do Xandr). Junta com "_" e tenta de novo.
    #   c) Alguns nomes têm sufixo lixo depois do mês (ex: "_deal", "_v2") —
    #      por isso a varredura é do fim pro começo, dentro de uma janela curta.
    middle_end = len(tokens)
    for i in range(len(tokens) - 1, max(cust_idx, len(tokens) - 4) - 1, -1):
        # Single-token (caso a/c)
        parsed_month = _try_parse_month_tail(tokens[i])
        consumed = 1
        # Two-token (caso b): MES + (FY25|FY26|25|26)
        if not parsed_month and i - 1 > cust_idx:
            combined = f"{tokens[i-1]}_{tokens[i]}"
            parsed_month = _try_parse_month_tail(combined)
            if parsed_month:
                consumed = 2
        if parsed_month:
            last_month, year_yy = parsed_month
            out["flight_month"]   = f"{last_month}-{year_yy:02d}"
            out["flight_quarter"] = f"{MONTH_TO_QUARTER.get(last_month, '?')} - {year_yy:02d}"
            out["flight_year"]    = 2000 + year_yy
            middle_end = i - (consumed - 1)
            break

    # Agência: primeiro token após cliente que não seja SKIP. Em "DEAL/PMP"
    # invertidos, a agência fica em posição diferente — ainda vale a regra
    # geral "primeiro token útil depois do cliente".
    agency_idx = None
    for i in range(cust_idx + 1, middle_end):
        t = tokens[i].upper()
        if t in _SKIP_TOKENS:
            continue
        agency_idx = i
        break
    if agency_idx is not None:
        out["agency"] = tokens[agency_idx].replace("-", " ").title()

    # Campanha: tokens entre agência (+1) e middle_end, sem SKIP.
    camp_start = (agency_idx + 1) if agency_idx is not None else (cust_idx + 1)
    middle = [t for t in tokens[camp_start:middle_end] if t.upper() not in _SKIP_TOKENS]
    if middle:
        camp = " ".join(middle).replace("-", " ")
        out["campaign_name"] = camp.title()

    return out


# ─── Leitura ──────────────────────────────────────────────────────────────────
def list_deals(include_archived: bool = False) -> List[dict]:
    """Lista todos os deals com totais de delivery agregados.

    Faz LEFT JOIN com pmp_deals_delivery e calcula os campos derivados
    (curator_total_cost, margin %, % a receber, % entregue cliente)
    em SQL pra reduzir round-trips. Status, customer, etc. vêm do master.

    Retorna lista ordenada por flight_quarter desc, customer asc.
    """
    _ensure_deals_table()
    _ensure_delivery_table()

    where = "" if include_archived else "WHERE COALESCE(d.is_archived, FALSE) = FALSE"
    sql = f"""
        WITH agg AS (
            SELECT
                deal_id,
                SUM(imps)                   AS imps,
                SUM(viewable_imps)          AS viewable_imps,
                SUM(clicks)                 AS clicks,
                SUM(curator_net_media_cost) AS curator_net_media_cost,
                SUM(curator_tech_fees)      AS curator_tech_fees,
                SUM(curator_total_cost)     AS curator_total_cost,
                SUM(curator_revenue)        AS curator_revenue,
                SUM(curator_margin)         AS curator_margin,
                MAX(day)                    AS last_delivery_day,
                MAX(synced_at)              AS last_synced_at
            FROM {_full(TABLE_DELIVERY)}
            GROUP BY deal_id
        )
        SELECT
            d.deal_id,
            d.curated_deal_name,
            d.io_name,
            d.customer,
            d.campaign_name,
            d.agency,
            d.flight_quarter,
            d.flight_month,
            d.client_pi_amount,
            d.margin_pct,
            d.dv_tech_fee_pct,
            d.status,
            d.owner_email,
            d.notes,
            d.is_archived,
            d.created_by, d.created_at,
            d.updated_by, d.updated_at,
            agg.imps, agg.viewable_imps, agg.clicks,
            agg.curator_net_media_cost, agg.curator_tech_fees,
            agg.curator_total_cost, agg.curator_revenue, agg.curator_margin,
            agg.last_delivery_day, agg.last_synced_at
        FROM {_full(TABLE_DEALS)} d
        LEFT JOIN agg ON agg.deal_id = d.deal_id
        {where}
        ORDER BY d.flight_quarter DESC, d.customer ASC, d.campaign_name ASC
    """
    rows = list(bq.query(sql).result())
    out = []
    for r in rows:
        revenue = float(r["curator_revenue"]) if r["curator_revenue"] is not None else 0.0
        imps    = int(r["imps"]) if r["imps"] is not None else 0
        cost    = float(r["curator_total_cost"]) if r["curator_total_cost"] is not None else 0.0
        margin  = float(r["curator_margin"]) if r["curator_margin"] is not None else 0.0
        pi      = float(r["client_pi_amount"]) if r["client_pi_amount"] is not None else 0.0

        effective_margin_pct = (margin / revenue) if revenue > 0 else None
        ecpm                 = (revenue / imps * 1000.0) if imps > 0 else None
        pct_a_receber        = (revenue / pi) if pi > 0 else None

        out.append({
            "deal_id":             r["deal_id"],
            "curated_deal_name":   r.get("curated_deal_name"),
            "io_name":             r.get("io_name"),
            "customer":            r.get("customer"),
            "campaign_name":       r.get("campaign_name"),
            "agency":              r.get("agency"),
            "flight_quarter":      r.get("flight_quarter"),
            "flight_month":        r.get("flight_month"),
            "client_pi_amount":    float(r["client_pi_amount"]) if r["client_pi_amount"] is not None else None,
            "margin_pct":          float(r["margin_pct"]) if r["margin_pct"] is not None else None,
            "dv_tech_fee_pct":     float(r["dv_tech_fee_pct"]) if r["dv_tech_fee_pct"] is not None else None,
            "status":              r.get("status") or "Pendente",
            "owner_email":         r.get("owner_email"),
            "notes":               r.get("notes"),
            "is_archived":         bool(r.get("is_archived")),
            "created_by":          r.get("created_by"),
            "created_at":          r["created_at"].isoformat() if r.get("created_at") else None,
            "updated_by":          r.get("updated_by"),
            "updated_at":          r["updated_at"].isoformat() if r.get("updated_at") else None,
            # Delivery agregada
            "imps":                imps,
            "viewable_imps":       int(r["viewable_imps"]) if r["viewable_imps"] is not None else 0,
            "clicks":              int(r["clicks"]) if r["clicks"] is not None else 0,
            "curator_net_media_cost": float(r["curator_net_media_cost"]) if r["curator_net_media_cost"] is not None else 0.0,
            "curator_tech_fees":   float(r["curator_tech_fees"]) if r["curator_tech_fees"] is not None else 0.0,
            "curator_total_cost":  cost,
            "curator_revenue":     revenue,
            "curator_margin":      margin,
            "last_delivery_day":   r["last_delivery_day"].isoformat() if r.get("last_delivery_day") else None,
            "last_synced_at":      r["last_synced_at"].isoformat() if r.get("last_synced_at") else None,
            # Derivados
            "effective_margin_pct": effective_margin_pct,
            "ecpm":                 ecpm,
            "pct_a_receber":        pct_a_receber,
        })
    return out


def get_deal(deal_id: str) -> Optional[dict]:
    """Retorna um deal específico com timeseries diária de delivery."""
    _ensure_deals_table()
    _ensure_delivery_table()

    sql_master = f"SELECT * FROM {_full(TABLE_DEALS)} WHERE deal_id = @did"
    master_rows = list(bq.query(sql_master, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("did", "STRING", deal_id)]
    )).result())
    if not master_rows:
        return None
    m = dict(master_rows[0])

    sql_days = f"""
        SELECT day, imps, viewable_imps, clicks,
               curator_net_media_cost, curator_tech_fees,
               curator_total_cost, curator_revenue, curator_margin
        FROM {_full(TABLE_DELIVERY)}
        WHERE deal_id = @did
        ORDER BY day
    """
    day_rows = list(bq.query(sql_days, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("did", "STRING", deal_id)]
    )).result())

    daily = []
    for r in day_rows:
        daily.append({
            "day":   r["day"].isoformat(),
            "imps":  int(r["imps"]) if r["imps"] is not None else 0,
            "viewable_imps": int(r["viewable_imps"]) if r["viewable_imps"] is not None else 0,
            "clicks": int(r["clicks"]) if r["clicks"] is not None else 0,
            "curator_net_media_cost": float(r["curator_net_media_cost"]) if r["curator_net_media_cost"] is not None else 0.0,
            "curator_tech_fees": float(r["curator_tech_fees"]) if r["curator_tech_fees"] is not None else 0.0,
            "curator_total_cost": float(r["curator_total_cost"]) if r["curator_total_cost"] is not None else 0.0,
            "curator_revenue": float(r["curator_revenue"]) if r["curator_revenue"] is not None else 0.0,
            "curator_margin": float(r["curator_margin"]) if r["curator_margin"] is not None else 0.0,
        })

    return {
        "deal_id":           m["deal_id"],
        "curated_deal_name": m.get("curated_deal_name"),
        "io_name":           m.get("io_name"),
        "customer":          m.get("customer"),
        "campaign_name":     m.get("campaign_name"),
        "agency":            m.get("agency"),
        "flight_quarter":    m.get("flight_quarter"),
        "flight_month":      m.get("flight_month"),
        "client_pi_amount":  float(m["client_pi_amount"]) if m.get("client_pi_amount") is not None else None,
        "margin_pct":        float(m["margin_pct"]) if m.get("margin_pct") is not None else None,
        "dv_tech_fee_pct":   float(m["dv_tech_fee_pct"]) if m.get("dv_tech_fee_pct") is not None else None,
        "status":            m.get("status") or "Pendente",
        "owner_email":       m.get("owner_email"),
        "notes":             m.get("notes"),
        "is_archived":       bool(m.get("is_archived")),
        "daily":             daily,
    }


# ─── Escrita ──────────────────────────────────────────────────────────────────
def save_deal(deal_id: str, fields: dict, updated_by: str) -> dict:
    """Upsert de um deal master.

    `fields` aceita qualquer subset de:
      curated_deal_name, io_name, customer, campaign_name, agency,
      flight_quarter, flight_month, client_pi_amount, margin_pct,
      dv_tech_fee_pct, status, owner_email, notes, is_archived

    Campos não presentes ficam inalterados (ou NULL se for INSERT novo).
    Status default = "Pendente". updated_by/updated_at sempre escritos.
    Retorna o registro atualizado.
    """
    _ensure_deals_table()

    if not deal_id:
        raise ValueError("deal_id obrigatório")

    if "status" in fields and fields["status"] not in VALID_STATUSES:
        raise ValueError(f"status inválido: {fields['status']}. Use um de: {sorted(VALID_STATUSES)}")

    allowed = {
        "curated_deal_name", "io_name", "customer", "campaign_name", "agency",
        "flight_quarter", "flight_month", "client_pi_amount", "margin_pct",
        "dv_tech_fee_pct", "status", "owner_email", "notes", "is_archived",
    }
    clean = {k: v for k, v in fields.items() if k in allowed}

    type_map = {
        "curated_deal_name": "STRING", "io_name": "STRING",
        "customer": "STRING", "campaign_name": "STRING", "agency": "STRING",
        "flight_quarter": "STRING", "flight_month": "STRING",
        "client_pi_amount": "NUMERIC", "margin_pct": "NUMERIC",
        "dv_tech_fee_pct": "NUMERIC",
        "status": "STRING", "owner_email": "STRING", "notes": "STRING",
        "is_archived": "BOOL",
    }

    params = [
        bigquery.ScalarQueryParameter("deal_id", "STRING", deal_id),
        bigquery.ScalarQueryParameter("updated_by", "STRING", updated_by),
    ]
    for k, v in clean.items():
        params.append(bigquery.ScalarQueryParameter(k, type_map[k], v))

    # MERGE preservando campos não enviados. Os SET usam COALESCE no UPDATE
    # — quando @field é NULL e o caller QUER nullar, ele não passa
    # o campo (mantém valor antigo). Pra explicitamente nullar, mandar
    # string vazia no front e tratar como NULL aqui antes de chamar.
    update_clauses = ", ".join(f"{k} = @{k}" for k in clean.keys())
    update_clauses = update_clauses + ", " if update_clauses else ""

    insert_cols = ["deal_id"] + list(clean.keys()) + [
        "status", "is_archived", "created_by", "created_at", "updated_by", "updated_at"
    ]
    insert_vals = ["@deal_id"] + [f"@{k}" for k in clean.keys()] + [
        # status default só se não foi enviado
        ("@status" if "status" in clean else "'Pendente'"),
        ("@is_archived" if "is_archived" in clean else "FALSE"),
        "@updated_by", "CURRENT_TIMESTAMP()", "@updated_by", "CURRENT_TIMESTAMP()"
    ]
    # Evitar duplicar status/is_archived nos cols
    # (se já estão em clean, não duplica)
    insert_cols_dedup, insert_vals_dedup, seen = [], [], set()
    for c, v in zip(insert_cols, insert_vals):
        if c in seen:
            continue
        seen.add(c)
        insert_cols_dedup.append(c)
        insert_vals_dedup.append(v)

    sql = f"""
        MERGE {_full(TABLE_DEALS)} T
        USING (SELECT @deal_id AS deal_id) S
        ON T.deal_id = S.deal_id
        WHEN MATCHED THEN UPDATE SET
            {update_clauses}
            updated_by = @updated_by,
            updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT
            ({', '.join(insert_cols_dedup)})
            VALUES ({', '.join(insert_vals_dedup)})
    """
    bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()

    return get_deal(deal_id)


def archive_deal(deal_id: str, updated_by: str) -> None:
    """Soft delete — marca is_archived=TRUE. Mantém histórico de delivery."""
    save_deal(deal_id, {"is_archived": True}, updated_by)


def unarchive_deal(deal_id: str, updated_by: str) -> None:
    save_deal(deal_id, {"is_archived": False}, updated_by)


# ─── Ingestão de delivery (Xandr Curate) ──────────────────────────────────────
def upsert_delivery_rows(rows: List[dict]) -> dict:
    """Upsert em batch de linhas de delivery (uma por (deal_id, day)).

    Cada row deve ter: deal_id, day (date or ISO string), imps,
    viewable_imps, clicks, curator_net_media_cost, curator_tech_fees,
    curator_total_cost, curator_revenue, curator_margin.

    Usado por:
      • Script de migração (XLSX → BQ)
      • Job de sync do Xandr Curate API (Fase 3)

    Implementação: usa staging table temporária (auto-expira em 1h) +
    MERGE. Funciona tanto pra 10 linhas quanto pra 100k — evita a
    complexidade de STRUCT em ArrayQueryParameter (que tem API frágil)
    e mantém custo de storage desprezível.

    Retorna: {"rows_processed": N, "deals_touched": M}
    """
    _ensure_delivery_table()
    if not rows:
        return {"rows_processed": 0, "deals_touched": 0}
    return _upsert_delivery_rows_via_load(rows)


def _upsert_delivery_rows_via_load(rows: List[dict]) -> dict:
    """Faz load → staging table → MERGE.

    Staging table tem auto-expiração de 1h e é deletada no `finally` —
    mesmo que o MERGE falhe ou a Cloud Function morra, o BQ varre a
    tabela depois de 1h. Sem leak de storage.
    """
    import uuid
    staging = f"_pmp_delivery_staging_{uuid.uuid4().hex[:8]}"
    staging_ref = bigquery.TableReference.from_string(
        f"{PROJECT_ID}.{DATASET}.{staging}"
    )
    schema = [
        bigquery.SchemaField("deal_id",                "STRING"),
        bigquery.SchemaField("day",                    "DATE"),
        bigquery.SchemaField("imps",                   "INT64"),
        bigquery.SchemaField("viewable_imps",          "INT64"),
        bigquery.SchemaField("clicks",                 "INT64"),
        bigquery.SchemaField("curator_net_media_cost", "NUMERIC"),
        bigquery.SchemaField("curator_tech_fees",      "NUMERIC"),
        bigquery.SchemaField("curator_total_cost",     "NUMERIC"),
        bigquery.SchemaField("curator_revenue",        "NUMERIC"),
        bigquery.SchemaField("curator_margin",         "NUMERIC"),
    ]
    table = bigquery.Table(staging_ref, schema=schema)
    # Auto-expire em 1h
    import datetime as _dt
    table.expires = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(hours=1)
    bq.create_table(table)
    try:
        norm = [{
            "deal_id":                str(r["deal_id"]),
            "day":                    str(r["day"]),
            "imps":                   int(r.get("imps") or 0),
            "viewable_imps":          int(r.get("viewable_imps") or 0),
            "clicks":                 int(r.get("clicks") or 0),
            "curator_net_media_cost": str(r.get("curator_net_media_cost") or 0),
            "curator_tech_fees":      str(r.get("curator_tech_fees") or 0),
            "curator_total_cost":     str(r.get("curator_total_cost") or 0),
            "curator_revenue":        str(r.get("curator_revenue") or 0),
            "curator_margin":         str(r.get("curator_margin") or 0),
        } for r in rows]
        errors = bq.insert_rows_json(table, norm)
        if errors:
            raise RuntimeError(f"staging insert errors: {errors}")

        sql = f"""
            MERGE {_full(TABLE_DELIVERY)} T
            USING `{PROJECT_ID}.{DATASET}.{staging}` S
            ON T.deal_id = S.deal_id AND T.day = S.day
            WHEN MATCHED THEN UPDATE SET
                imps = S.imps, viewable_imps = S.viewable_imps, clicks = S.clicks,
                curator_net_media_cost = S.curator_net_media_cost,
                curator_tech_fees = S.curator_tech_fees,
                curator_total_cost = S.curator_total_cost,
                curator_revenue = S.curator_revenue,
                curator_margin = S.curator_margin,
                synced_at = CURRENT_TIMESTAMP()
            WHEN NOT MATCHED THEN INSERT (
                deal_id, day, imps, viewable_imps, clicks,
                curator_net_media_cost, curator_tech_fees, curator_total_cost,
                curator_revenue, curator_margin, synced_at
            ) VALUES (
                S.deal_id, S.day, S.imps, S.viewable_imps, S.clicks,
                S.curator_net_media_cost, S.curator_tech_fees, S.curator_total_cost,
                S.curator_revenue, S.curator_margin, CURRENT_TIMESTAMP()
            )
        """
        bq.query(sql).result()
    finally:
        try:
            bq.delete_table(staging_ref, not_found_ok=True)
        except Exception as e:
            logger.warning(f"[pmp_deals] falhou deletando staging {staging}: {e}")

    deals = {str(r["deal_id"]) for r in rows}
    return {"rows_processed": len(rows), "deals_touched": len(deals)}


def ensure_deal_from_xandr(deal_id: str, curated_deal_name: str,
                           io_name: Optional[str] = None,
                           created_by: str = "system") -> bool:
    """Cria um registro master se não existir, fazendo o parsing automático
    do nome do deal. Idempotente — não sobrescreve campos manuais.

    Retorna True se criou, False se já existia.
    """
    _ensure_deals_table()

    sql_check = f"SELECT 1 FROM {_full(TABLE_DEALS)} WHERE deal_id = @did LIMIT 1"
    existing = list(bq.query(sql_check, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("did", "STRING", str(deal_id))]
    )).result())
    if existing:
        return False

    parsed = parse_deal_name(curated_deal_name or "")
    save_deal(str(deal_id), {
        "curated_deal_name": curated_deal_name,
        "io_name":           io_name,
        "customer":          parsed["customer"],
        "campaign_name":     parsed["campaign_name"],
        "agency":            parsed["agency"],
        "flight_quarter":    parsed["flight_quarter"],
        "flight_month":      parsed["flight_month"],
    }, updated_by=created_by)
    return True
