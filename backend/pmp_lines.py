"""
PMP Lines v2 — API layer pra UI redesenhada.

Substitui `pmp_deals.py` na camada de leitura. Modela em volta de LINE ITEM
(unidade real do negócio), enriquecida com:
  • Insertion Order (cliente real, via IO name)
  • Hypr Command checklist (PI, owners, agência, CPM/CPCV) via line.code
  • Delivery diária agregada
  • Cálculos derivados (health, pacing, projeção, % a receber, etc.)

Fonte: tabela materializada `prod_assets.pmp_lines_enriched`, recomputada
após cada sync (ver `xandr_curate.refresh_enriched_table()`).

Mutations:
  • save_line_overrides(line_id, fields) — campos manuais (status, notes, PI override)
  • link_command_to_line(line_id, short_token) — escreve no Xandr via PUT
    + atualiza local
  • suggest_command_links(line_id) — fuzzy match com checklists pra UI
    de auto-vinculação
"""

import logging
import os
import re
import unicodedata
from typing import List, Optional, Dict
from google.cloud import bigquery


logger = logging.getLogger(__name__)


PROJECT_ID = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET    = "prod_assets"

TABLE_LINES_ENRICHED = "pmp_lines_enriched"
TABLE_LINE_ITEMS     = "pmp_line_items"
TABLE_DELIVERY       = "pmp_line_delivery_daily"
TABLE_CHECKLISTS     = "checklists_mirror"
TABLE_GROUPS         = "pmp_line_groups"

# Campos que se propagam automaticamente pros demais membros do grupo
# (PI compartilhado → faz sentido todos terem mesmo status/arquivamento/PI).
# Notes/campaign/agency overrides ficam per-line.
GROUP_PROPAGATE_FIELDS = {"status", "is_archived", "client_pi_amount_override"}

VALID_STATUSES = {"Pendente", "Andamento", "Revisão", "Finalizado", "Pausado", "Cancelado"}

bq = bigquery.Client()


def _full(t: str) -> str:
    return f"`{PROJECT_ID}.{DATASET}.{t}`"


# ─── Leitura ──────────────────────────────────────────────────────────────────
def list_lines(include_archived: bool = False, only_active: bool = True) -> List[dict]:
    """Lista lines enriquecidas com filtros básicos."""
    conditions = []
    if not include_archived:
        conditions.append("NOT is_archived")
    if only_active:
        conditions.append("state = 'active'")
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    sql = f"""
        SELECT *
        FROM {_full(TABLE_LINES_ENRICHED)}
        {where}
        ORDER BY
          customer NULLS LAST,
          campaign_name NULLS LAST
    """
    out = []
    for r in bq.query(sql).result():
        d = dict(r)
        # Datetime → ISO
        for k, v in list(d.items()):
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
            elif isinstance(v, list):
                d[k] = list(v)
        out.append(d)
    return out


def get_line(line_id: int) -> Optional[dict]:
    """Detalhe da line + timeseries diária."""
    sql_master = f"SELECT * FROM {_full(TABLE_LINES_ENRICHED)} WHERE line_id = @lid"
    rows = list(bq.query(sql_master, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("lid", "INT64", line_id)]
    )).result())
    if not rows:
        return None
    line = dict(rows[0])
    for k, v in list(line.items()):
        if hasattr(v, "isoformat"):
            line[k] = v.isoformat()
        elif isinstance(v, list):
            line[k] = list(v)

    sql_days = f"""
        SELECT day, imps, viewable_imps, clicks,
               curator_net_media_cost, curator_tech_fees,
               curator_total_cost, curator_revenue, curator_margin
        FROM {_full(TABLE_DELIVERY)}
        WHERE line_id = @lid
        ORDER BY day
    """
    daily = []
    for r in bq.query(sql_days, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("lid", "INT64", line_id)]
    )).result():
        daily.append({
            "day":   r["day"].isoformat(),
            "imps":  int(r["imps"] or 0),
            "viewable_imps": int(r["viewable_imps"] or 0),
            "clicks": int(r["clicks"] or 0),
            "curator_net_media_cost": float(r["curator_net_media_cost"] or 0),
            "curator_tech_fees":      float(r["curator_tech_fees"]      or 0),
            "curator_total_cost":     float(r["curator_total_cost"]     or 0),
            "curator_revenue":        float(r["curator_revenue"]        or 0),
            "curator_margin":         float(r["curator_margin"]         or 0),
        })
    line["daily"] = daily
    return line


# ─── Mutations ────────────────────────────────────────────────────────────────
def save_line_overrides(line_id: int, fields: dict, updated_by: str) -> dict:
    """Atualiza campos manuais na pmp_line_items (não na tabela enriched).

    Após salvar, refresca a row enriched correspondente — em vez de
    reconstruir toda a tabela, usamos um UPDATE direcionado.
    """
    if "status" in fields and fields["status"] not in VALID_STATUSES:
        raise ValueError(f"status inválido: {fields['status']}")

    allowed = {"status", "notes", "is_archived",
                "client_pi_amount_override", "campaign_name_override",
                "agency_override"}
    clean = {k: v for k, v in fields.items() if k in allowed}
    if not clean:
        raise ValueError("nada pra salvar")

    type_map = {
        "status":                     "STRING",
        "notes":                      "STRING",
        "is_archived":                "BOOL",
        "client_pi_amount_override":  "NUMERIC",
        "campaign_name_override":     "STRING",
        "agency_override":            "STRING",
    }
    # Descobre alvos do UPDATE: se a line está num grupo E os campos
    # editados se propagam (status/is_archived/PI), aplica em TODOS os
    # membros do grupo. Senão, só na própria.
    propagate = bool(GROUP_PROPAGATE_FIELDS.intersection(clean.keys()))
    target_ids = _group_member_ids(line_id) if propagate else None
    if not target_ids:
        target_ids = [int(line_id)]

    set_clauses = ", ".join(f"{k} = @{k}" for k in clean.keys())
    params = [
        bigquery.ArrayQueryParameter("line_ids", "INT64", target_ids),
        bigquery.ScalarQueryParameter("updated_by", "STRING", updated_by),
    ] + [bigquery.ScalarQueryParameter(k, type_map[k], v) for k, v in clean.items()]

    sql = f"""
        UPDATE {_full(TABLE_LINE_ITEMS)}
        SET {set_clauses},
            updated_by = @updated_by,
            updated_at = CURRENT_TIMESTAMP()
        WHERE line_id IN UNNEST(@line_ids)
    """
    bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()

    # Otimização: campos "diretos" (status/notes/is_archived) viram UPDATE
    # pontual na enriched table (subsegundos). Overrides que afetam
    # COALESCE com checklist (PI/campanha/agência) ainda exigem rebuild
    # da tabela inteira pra recomputar os campos derivados.
    direct_only = set(clean.keys()).issubset({"status", "notes", "is_archived"})
    if direct_only:
        _update_enriched_rows_direct(target_ids, clean)
    else:
        refresh_enriched_table()
    return get_line(line_id)


def _group_member_ids(line_id: int) -> Optional[List[int]]:
    """Retorna line_ids do mesmo grupo de `line_id` (incluindo a própria),
    ou None se a line não está agrupada."""
    sql = f"""
        SELECT line_id
        FROM {_full(TABLE_GROUPS)}
        WHERE group_id = (
          SELECT group_id FROM {_full(TABLE_GROUPS)} WHERE line_id = @lid
        )
    """
    rows = bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("lid", "INT64", int(line_id))]
    )).result()
    ids = [int(r["line_id"]) for r in rows]
    return ids if ids else None


def _update_enriched_rows_direct(line_ids: List[int], clean: dict) -> None:
    """UPDATE direcionado em campos não-derivados da `pmp_lines_enriched`,
    aplicado em N line_ids de uma vez (membros do grupo).

    Use SÓ pra status/notes/is_archived (que não dependem de COALESCE com
    checklist). Pra qualquer override que afete campos computados, chame
    `refresh_enriched_table()`.
    """
    type_map = {"status": "STRING", "notes": "STRING", "is_archived": "BOOL"}
    set_parts = []
    for k in clean.keys():
        if k == "status":
            set_parts.append("status = COALESCE(@status, 'Pendente')")
        elif k == "is_archived":
            set_parts.append("is_archived = COALESCE(@is_archived, FALSE)")
        else:
            set_parts.append(f"{k} = @{k}")
    set_clauses = ", ".join(set_parts)

    params = [bigquery.ArrayQueryParameter("line_ids", "INT64", [int(x) for x in line_ids])]
    params += [bigquery.ScalarQueryParameter(k, type_map[k], v) for k, v in clean.items()]

    sql = f"""
        UPDATE {_full(TABLE_LINES_ENRICHED)}
        SET {set_clauses}
        WHERE line_id IN UNNEST(@line_ids)
    """
    bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()




def refresh_enriched_table() -> dict:
    """Roda o SQL completo de pmp_lines_enriched.sql (recriação da tabela).

    Chamado após sync de IOs/Lines/delivery e após qualquer mutation.
    Custo: <2s pra ~250 linhas.
    """
    sql_path = os.path.join(os.path.dirname(__file__), "sql", "pmp_lines_enriched.sql")
    with open(sql_path, "r") as f:
        sql = f.read()
    bq.query(sql).result()
    return {"refreshed": True}


# ─── Vinculação com Hypr Command ──────────────────────────────────────────────
def _normalize(s: str) -> str:
    """Normalização leve pra fuzzy match: lowercase, sem acento, alfanum apenas."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()
    return re.sub(r"\s+", " ", s)


def suggest_command_links(line_id: int, limit: int = 5) -> List[dict]:
    """Sugere checklists do Command que provavelmente são essa line.

    Heurística: pega checklists com deal_dv360=TRUE, calcula similaridade
    com base no nome da line (overlap de tokens normalizados).

    Retorna top N ordenado por score, com preview do PI/CP/CS pra UI mostrar.
    """
    sql = f"""
        SELECT line_id, line_name, customer FROM {_full(TABLE_LINES_ENRICHED)}
        WHERE line_id = @lid
    """
    rows = list(bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("lid", "INT64", line_id)]
    )).result())
    if not rows:
        return []
    line_name = rows[0]["line_name"] or ""
    line_customer = rows[0]["customer"] or ""
    target_tokens = set(_normalize(line_name).split())
    target_tokens |= set(_normalize(line_customer).split())

    sql_ck = f"""
        SELECT short_token, client, campaign_name, agency,
               cp_name, cs_name, investment, deal_dv360, start_date, end_date
        FROM {_full(TABLE_CHECKLISTS)}
        WHERE deal_dv360 = TRUE
          AND short_token IS NOT NULL
    """
    candidates = []
    for r in bq.query(sql_ck).result():
        ck_tokens = set()
        ck_tokens |= set(_normalize(r.get("client") or "").split())
        ck_tokens |= set(_normalize(r.get("campaign_name") or "").split())
        if not ck_tokens or not target_tokens:
            continue
        overlap = len(target_tokens & ck_tokens)
        if overlap == 0:
            continue
        score = overlap / max(len(ck_tokens), 1)
        candidates.append({
            "short_token":    r["short_token"],
            "client":         r.get("client"),
            "campaign_name":  r.get("campaign_name"),
            "agency":         r.get("agency"),
            "cp_name":        r.get("cp_name"),
            "cs_name":        r.get("cs_name"),
            "investment":     float(r["investment"]) if r["investment"] is not None else None,
            "start_date":     r["start_date"].isoformat() if r.get("start_date") else None,
            "end_date":       r["end_date"].isoformat() if r.get("end_date") else None,
            "score":          score,
        })
    candidates.sort(key=lambda x: (-x["score"], x["short_token"]))
    return candidates[:limit]


def is_token_in_use(short_token: str, exclude_line_id: int = 0) -> Optional[int]:
    """Retorna line_id que já está usando esse short_token, ou None."""
    if not short_token:
        return None
    sql = f"""
        SELECT line_id FROM {_full(TABLE_LINE_ITEMS)}
        WHERE UPPER(line_code) = UPPER(@t) AND line_id != @exclude
        LIMIT 1
    """
    rows = list(bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("t", "STRING", short_token),
            bigquery.ScalarQueryParameter("exclude", "INT64", int(exclude_line_id)),
        ]
    )).result())
    return rows[0]["line_id"] if rows else None


def set_line_code_local(line_id: int, code: Optional[str], updated_by: str) -> None:
    """Atualiza line_code/short_token localmente (após confirmação do PUT no
    Xandr feito por `xandr_curate.set_line_code()`)."""
    sql = f"""
        UPDATE {_full(TABLE_LINE_ITEMS)}
        SET line_code = @code, short_token = @code,
            updated_by = @by, updated_at = CURRENT_TIMESTAMP()
        WHERE line_id = @lid
    """
    bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("lid",  "INT64",  int(line_id)),
        bigquery.ScalarQueryParameter("code", "STRING", code),
        bigquery.ScalarQueryParameter("by",   "STRING", updated_by),
    ])).result()
    refresh_enriched_table()
