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
  • set_line_tokens(source, line_id, tokens) — define a LISTA de short_tokens
    do Command vinculados à line (principal + extras). O principal vai pro
    campo `code` da line no Xandr via PUT; os extras ficam só no BQ
    (`extra_short_tokens`, campo manual que o sync não toca). O PI da line
    passa a ser a SOMA dos investments dos checklists casados.
  • set_line_code_local(line_id, code) — caminho legado de 1 token (mantém
    os extras, só troca o principal)
  • suggest_command_links(line_id) — fuzzy match com checklists pra UI
    de auto-vinculação
  • lookup_checklists(tokens) — preview de checklists por token (a UI mostra
    cliente/campanha/PI antes de confirmar a vinculação)
"""

import logging
import os
import re
import threading
import unicodedata
from typing import Callable, Iterable, List, Optional, Dict
from google.cloud import bigquery

import bq_client


logger = logging.getLogger(__name__)


PROJECT_ID = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET    = "prod_assets"

TABLE_LINES_ENRICHED = "pmp_lines_enriched"
TABLE_LINE_ITEMS     = "pmp_line_items"
TABLE_DELIVERY       = "pmp_line_delivery_daily"
TABLE_CHECKLISTS     = "checklists_mirror"
TABLE_GROUPS         = "pmp_line_groups"

# Fonte do espelho de checklists: dataset do Sales Center (us-central1).
# `checklists_mirror` é uma cópia US-multi disso, pra a UI/sugestão do PMP
# ler sem JOIN cross-region (ver sync_checklists_mirror).
DATASET_SALES_CENTER = "hypr_sales_center"
TABLE_CHECKLISTS_SRC = "checklists"

# Campos que se propagam automaticamente pros demais membros do grupo
# (PI compartilhado → faz sentido todos terem mesmo status/arquivamento/PI).
# Notes/campaign/agency overrides ficam per-line.
GROUP_PROPAGATE_FIELDS = {"status", "is_archived", "client_pi_amount_override"}

VALID_STATUSES = {"Pendente", "Andamento", "Revisão", "Finalizado", "Pausado", "Cancelado"}

# Formato aceito pra short_token do Command: alfanumérico, 2–40 chars, com
# `-`/`_` no meio (ex: NO2015, I4U4HR, FXR5US). Já normalizado (UPPER/TRIM).
TOKEN_RE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{1,39}$")

# Fonte padrão pra chamadas legadas sem `source`.
DEFAULT_SOURCE = "xandr"

# Client compartilhado: timeout obrigatório em toda query + pool HTTP
# dimensionado pro paralelismo real. Ver bq_client.py.
bq = bq_client.get_client()


def _full(t: str) -> str:
    return f"`{PROJECT_ID}.{DATASET}.{t}`"


# ─── Schema (colunas manuais que nasceram depois da tabela) ──────────────────
_schema_ensured = False
_schema_lock = threading.Lock()


def ensure_schema() -> None:
    """Garante as colunas manuais que o código abaixo e o SQL da enriched
    esperam em `pmp_line_items`. DDL idempotente (ADD COLUMN IF NOT EXISTS),
    roda 1x por instância — é o que faz a migração 003 se auto-aplicar no
    primeiro refresh após o deploy, em vez de depender de alguém rodar o .sql
    na mão (e do PMP inteiro cair até isso acontecer)."""
    global _schema_ensured
    if _schema_ensured:
        return
    with _schema_lock:
        if _schema_ensured:
            return
        try:
            bq.query(
                f"ALTER TABLE {_full(TABLE_LINE_ITEMS)} "
                f"ADD COLUMN IF NOT EXISTS extra_short_tokens ARRAY<STRING>"
            ).result()
            _schema_ensured = True
        except Exception as e:  # noqa: BLE001 — não derruba a operação
            # Se o DDL falhar (permissão), o erro real reaparece na query
            # seguinte com contexto melhor. Não marcamos como garantido pra
            # tentar de novo na próxima chamada.
            logger.warning(f"[pmp] ensure_schema falhou: {e}")


def _jsonable(v):
    """Converte recursivamente o que o client do BQ devolve (date/datetime,
    Row, STRUCT→dict, ARRAY→list) em tipos que o jsonify serializa de forma
    previsível. Os campos de topo já eram tratados; o breakdown de checklists
    (`linked_checklists`, ARRAY<STRUCT>) trouxe datas aninhadas — sem isto o
    Flask serializava DATE aninhado como "Wed, 01 Jan 2026 00:00:00 GMT"."""
    if hasattr(v, "isoformat"):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    # google.cloud.bigquery.Row (STRUCT) expõe .items()
    if hasattr(v, "items") and callable(v.items):
        return {k: _jsonable(x) for k, x in v.items()}
    return v


def _row_to_dict(r) -> dict:
    return {k: _jsonable(v) for k, v in dict(r).items()}


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
    return [_row_to_dict(r) for r in bq.query(sql).result()]


def window_metrics(date_from: str, date_to: str) -> Dict[str, dict]:
    """Agrega o delivery diário por line dentro de [date_from, date_to].

    Usado pelo Histórico pra "janelar" as métricas (tipo filtro de Excel):
    cost/revenue/margem/imps passam a refletir só os dias da janela. PI fica
    de fora — é valor de contrato, somado cheio no frontend.

    Retorna mapa {"<source>:<line_id>": {imps, curator_total_cost,
    curator_revenue, curator_margin, ...}}. Só inclui lines com delivery na
    janela.

    A chave carrega a FONTE porque a unidade real é o par (source, line_id):
    um line_id do Xandr pode colidir numericamente com um dealMetaId da
    PubMatic, e agregar só por line_id somaria entrega de deals diferentes na
    mesma line. O frontend tenta a chave nova e cai pra `str(line_id)` quando
    fala com um backend antigo (ver lineKey/pmpFormat.js).
    """
    sql = f"""
        SELECT
          source,
          line_id,
          SUM(imps)                   AS imps,
          SUM(viewable_imps)          AS viewable_imps,
          SUM(clicks)                 AS clicks,
          SUM(curator_net_media_cost) AS curator_net_media_cost,
          SUM(curator_tech_fees)      AS curator_tech_fees,
          SUM(curator_total_cost)     AS curator_total_cost,
          SUM(curator_revenue)        AS curator_revenue,
          SUM(curator_margin)         AS curator_margin,
          MIN(day)                    AS first_delivery_day,
          MAX(day)                    AS last_delivery_day
        FROM {_full(TABLE_DELIVERY)}
        WHERE day BETWEEN @date_from AND @date_to
        GROUP BY source, line_id
    """
    job = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("date_from", "DATE", date_from),
        bigquery.ScalarQueryParameter("date_to",   "DATE", date_to),
    ])
    out: Dict[str, dict] = {}
    for r in bq.query(sql, job_config=job).result():
        d = dict(r)
        for k, v in list(d.items()):
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
        out[f"{d.get('source') or 'xandr'}:{d['line_id']}"] = d
    return out


def timeseries(date_from: str, date_to: str) -> List[dict]:
    """Série diária de delivery POR LINE dentro de [date_from, date_to].

    Diferente de `window_metrics` (que colapsa a janela inteira num único total
    por line), aqui devolvemos UMA row por (line_id, day). É o que alimenta o
    Analytics: o frontend fatia por dia/mês e aplica os filtros de line
    (cliente, campanha, status, bid) client-side, somando só as rows das lines
    sobreviventes. A partição por `day` da tabela faz o scan ser barato mesmo
    em janelas largas.

    Retorna lista achatada [{source, line_id, day, imps, viewable_imps, clicks,
    curator_total_cost, curator_revenue, curator_margin}], ordenada por dia.
    `source` acompanha cada row porque a unidade é o par (source, line_id) —
    sem ela, um dealMetaId da PubMatic com o mesmo número de uma line do Xandr
    entraria nas duas. O frontend casa por (source, line_id) e só cai pro
    match por line_id quando fala com um backend antigo (sem o campo).
    """
    sql = f"""
        SELECT
          source,
          line_id,
          day,
          imps,
          viewable_imps,
          clicks,
          curator_total_cost,
          curator_revenue,
          curator_margin
        FROM {_full(TABLE_DELIVERY)}
        WHERE day BETWEEN @date_from AND @date_to
        ORDER BY day
    """
    job = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("date_from", "DATE", date_from),
        bigquery.ScalarQueryParameter("date_to",   "DATE", date_to),
    ])
    out: List[dict] = []
    for r in bq.query(sql, job_config=job).result():
        out.append({
            "source":               r["source"] or "xandr",
            "line_id":              int(r["line_id"]),
            "day":                  r["day"].isoformat(),
            "imps":                 int(r["imps"] or 0),
            "viewable_imps":        int(r["viewable_imps"] or 0),
            "clicks":               int(r["clicks"] or 0),
            "curator_total_cost":   float(r["curator_total_cost"] or 0),
            "curator_revenue":      float(r["curator_revenue"]    or 0),
            "curator_margin":       float(r["curator_margin"]     or 0),
        })
    return out


def get_line(line_id: int, source: Optional[str] = None) -> Optional[dict]:
    """Detalhe da line + timeseries diária.

    `source` é opcional por compatibilidade: sem ele, casa só por line_id
    (comportamento antigo). Com ele, casa o PAR (source, line_id) — evita
    devolver um deal PubMatic quando se pediu a line Xandr de mesmo número.
    """
    params = [bigquery.ScalarQueryParameter("lid", "INT64", int(line_id))]
    where = "WHERE line_id = @lid"
    if source:
        where += " AND source = @src"
        params.append(bigquery.ScalarQueryParameter("src", "STRING", source))
    sql_master = f"SELECT * FROM {_full(TABLE_LINES_ENRICHED)} {where} LIMIT 1"
    rows = list(bq.query(sql_master, job_config=bigquery.QueryJobConfig(
        query_parameters=params
    )).result())
    if not rows:
        return None
    line = _row_to_dict(rows[0])
    # Delivery casa pelo par (source, line_id) da line encontrada.
    line_source = line.get("source") or source or DEFAULT_SOURCE

    sql_days = f"""
        SELECT day, imps, viewable_imps, clicks,
               curator_net_media_cost, curator_tech_fees,
               curator_total_cost, curator_revenue, curator_margin
        FROM {_full(TABLE_DELIVERY)}
        WHERE line_id = @lid AND COALESCE(source, 'xandr') = @src
        ORDER BY day
    """
    daily = []
    for r in bq.query(sql_days, job_config=bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("lid", "INT64", int(line_id)),
            bigquery.ScalarQueryParameter("src", "STRING", line_source),
        ]
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




def sync_checklists_mirror() -> dict:
    """Recopia hypr_sales_center.checklists (us-central1) → checklists_mirror (US-multi).

    Cross-region copy gerenciado (mesma semântica do `bq cp -f`). A sugestão de
    vinculação (suggest_command_links) e o JOIN do pmp_lines_enriched leem do
    ESPELHO, não da fonte. Sem este passo no sync diário, checklists novos do
    Command nunca chegam ao espelho e a auto-vinculação fica cega a eles.

    Deve rodar ANTES de refresh_enriched_table() pra o enriched já enxergar os
    checklists novos no mesmo sync.
    """
    src = f"{PROJECT_ID}.{DATASET_SALES_CENTER}.{TABLE_CHECKLISTS_SRC}"
    dst = f"{PROJECT_ID}.{DATASET}.{TABLE_CHECKLISTS}"
    job = bq.copy_table(
        src, dst,
        job_config=bigquery.CopyJobConfig(write_disposition="WRITE_TRUNCATE"),
    )
    job.result()
    dst_tbl = bq.get_table(dst)
    logger.info(f"[pmp] checklists_mirror sincronizado: {dst_tbl.num_rows} linhas")
    return {"mirror_synced": True, "rows": dst_tbl.num_rows}


def refresh_enriched_table() -> dict:
    """Roda o SQL completo de pmp_lines_enriched.sql (recriação da tabela).

    Chamado após sync de IOs/Lines/delivery e após qualquer mutation.
    Custo: <2s pra ~250 linhas.
    """
    # O SQL lê `extra_short_tokens` (migração 003); garante a coluna antes.
    ensure_schema()
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


def normalize_tokens(tokens: Optional[Iterable]) -> List[str]:
    """Normaliza uma lista de short_tokens: UPPER/TRIM, ignora vazios, dedupe
    preservando a ORDEM (o 1º é o principal). Levanta ValueError no primeiro
    token fora do formato — a UI mostra a mensagem como está."""
    out: List[str] = []
    seen = set()
    for raw in (tokens or []):
        if raw is None:
            continue
        t = str(raw).strip().upper()
        if not t:
            continue
        if not TOKEN_RE.match(t):
            raise ValueError(f"short_token inválido: {raw!r}")
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def line_tokens(row: dict) -> List[str]:
    """Lista de tokens de uma row de pmp_line_items/enriched: principal
    (`short_token`) + `extra_short_tokens`, normalizada e sem repetição."""
    base = [row.get("short_token")] + list(row.get("extra_short_tokens") or [])
    try:
        return normalize_tokens(base)
    except ValueError:
        # Dado legado fora do formato não pode derrubar leitura — mantém o
        # que der pra normalizar sem validar formato.
        out, seen = [], set()
        for raw in base:
            t = str(raw or "").strip().upper()
            if t and t not in seen:
                seen.add(t); out.append(t)
        return out


def _fetch_line_tokens(source: str, line_id: int) -> Optional[dict]:
    """{source, line_id, line_code, short_token, extra_short_tokens} da
    pmp_line_items, ou None se a line não existe."""
    ensure_schema()
    sql = f"""
        SELECT source, line_id, line_name, line_code, short_token, extra_short_tokens
        FROM {_full(TABLE_LINE_ITEMS)}
        WHERE line_id = @lid AND COALESCE(source, 'xandr') = @src
        LIMIT 1
    """
    rows = list(bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("lid", "INT64", int(line_id)),
        bigquery.ScalarQueryParameter("src", "STRING", source or DEFAULT_SOURCE),
    ])).result())
    if not rows:
        return None
    d = _row_to_dict(rows[0])
    d["extra_short_tokens"] = list(d.get("extra_short_tokens") or [])
    return d


def find_token_conflicts(tokens: Iterable[str],
                         exclude_source: str = DEFAULT_SOURCE,
                         exclude_line_id: int = 0) -> List[dict]:
    """Outras lines que já carregam algum dos `tokens` (como principal OU
    extra). Devolve [{short_token, source, line_id, line_name}] — vazio se
    ninguém usa. O mesmo token em duas lines duplica PI nos KPIs (a não ser
    que estejam agrupadas), por isso a UI pede confirmação."""
    toks = normalize_tokens(tokens)
    if not toks:
        return []
    ensure_schema()
    sql = f"""
        SELECT li.source, li.line_id, li.line_name, li.short_token, li.extra_short_tokens
        FROM {_full(TABLE_LINE_ITEMS)} li
        WHERE NOT (li.line_id = @lid AND COALESCE(li.source, 'xandr') = @src)
          AND (
            UPPER(TRIM(li.short_token)) IN UNNEST(@tokens)
            OR EXISTS (
              SELECT 1 FROM UNNEST(li.extra_short_tokens) x
              WHERE UPPER(TRIM(x)) IN UNNEST(@tokens)
            )
          )
    """
    rows = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("lid", "INT64", int(exclude_line_id or 0)),
        bigquery.ScalarQueryParameter("src", "STRING", exclude_source or DEFAULT_SOURCE),
        bigquery.ArrayQueryParameter("tokens", "STRING", toks),
    ])).result()
    out: List[dict] = []
    wanted = set(toks)
    for r in rows:
        d = _row_to_dict(r)
        for t in line_tokens(d):
            if t in wanted:
                out.append({
                    "short_token": t,
                    "source":      d.get("source") or DEFAULT_SOURCE,
                    "line_id":     int(d["line_id"]),
                    "line_name":   d.get("line_name"),
                })
    return out


def is_token_in_use(short_token: str, exclude_line_id: int = 0,
                    exclude_source: str = DEFAULT_SOURCE) -> Optional[int]:
    """Retorna line_id que já está usando esse short_token (principal ou
    extra), ou None. Mantido pela API legada; ver find_token_conflicts."""
    if not short_token:
        return None
    try:
        conflicts = find_token_conflicts([short_token], exclude_source, exclude_line_id)
    except ValueError:
        return None
    return conflicts[0]["line_id"] if conflicts else None


def set_line_tokens(source: str, line_id: int, tokens: Iterable[str],
                    updated_by: str,
                    xandr_put: Optional[Callable[[int, Optional[str]], object]] = None) -> dict:
    """Define a LISTA COMPLETA de short_tokens da line. Fonte de verdade da
    vinculação multi-checklist:

      tokens[0]  → principal: `short_token`/`line_code` local e, se a line é
                   Xandr, o campo `code` da line via PUT (`xandr_put`). Só
                   faz o PUT quando o principal MUDOU — trocar/remover extras
                   não toca no Xandr.
      tokens[1:] → `extra_short_tokens` (só BQ; o sync não mexe).
      []         → desvincula tudo (code=NULL no Xandr, colunas NULL/[] aqui).

    Lines de outras fontes (PubMatic) não têm Xandr: só o BQ é atualizado.
    Depois refresca a enriched e devolve a line completa (PI já somado).
    Levanta ValueError pra token inválido ou line inexistente.
    """
    src = source or DEFAULT_SOURCE
    toks = normalize_tokens(tokens)
    cur = _fetch_line_tokens(src, line_id)
    if cur is None:
        raise ValueError(f"Line {src}:{line_id} não encontrada")

    primary = toks[0] if toks else None
    extras  = toks[1:]

    if src == DEFAULT_SOURCE and xandr_put is not None:
        cur_code = (cur.get("line_code") or "").strip().upper() or None
        if cur_code != primary:
            xandr_put(int(line_id), primary)

    sql = f"""
        UPDATE {_full(TABLE_LINE_ITEMS)}
        SET line_code = @code, short_token = @code,
            extra_short_tokens = @extras,
            updated_by = @by, updated_at = CURRENT_TIMESTAMP()
        WHERE line_id = @lid AND COALESCE(source, 'xandr') = @src
    """
    bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("lid",    "INT64",  int(line_id)),
        bigquery.ScalarQueryParameter("src",    "STRING", src),
        bigquery.ScalarQueryParameter("code",   "STRING", primary),
        bigquery.ArrayQueryParameter("extras",  "STRING", extras),
        bigquery.ScalarQueryParameter("by",     "STRING", updated_by),
    ])).result()
    refresh_enriched_table()
    return get_line(int(line_id), src)


def set_line_code_local(line_id: int, code: Optional[str], updated_by: str,
                        source: str = DEFAULT_SOURCE) -> None:
    """Caminho legado (1 token): troca só o PRINCIPAL local (após o PUT no
    Xandr feito pelo chamador), preservando os extras — e tirando o novo
    principal da lista de extras se ele já estava lá, pra não contar 2x."""
    ensure_schema()
    code_norm = (code or "").strip().upper() or None
    sql = f"""
        UPDATE {_full(TABLE_LINE_ITEMS)}
        SET line_code = @code, short_token = @code,
            extra_short_tokens = ARRAY(
              SELECT t FROM UNNEST(extra_short_tokens) t
              WHERE @code IS NULL OR UPPER(TRIM(t)) != @code
            ),
            updated_by = @by, updated_at = CURRENT_TIMESTAMP()
        WHERE line_id = @lid AND COALESCE(source, 'xandr') = @src
    """
    bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("lid",  "INT64",  int(line_id)),
        bigquery.ScalarQueryParameter("src",  "STRING", source or DEFAULT_SOURCE),
        bigquery.ScalarQueryParameter("code", "STRING", code_norm),
        bigquery.ScalarQueryParameter("by",   "STRING", updated_by),
    ])).result()
    refresh_enriched_table()


def lookup_checklists(tokens: Iterable[str]) -> List[dict]:
    """Preview dos checklists do Command pra uma lista de tokens — a UI usa
    pra mostrar cliente/campanha/PI ANTES de o operador confirmar o vínculo
    (e pra avisar "token não existe" em vez de vincular um typo).

    Devolve uma entrada POR TOKEN pedido, na ordem, com `found`=False quando
    o espelho não tem o token."""
    toks = normalize_tokens(tokens)
    if not toks:
        return []
    sql = f"""
        SELECT short_token, client, campaign_name, agency,
               cp_name, cs_name, investment, deal_dv360, start_date, end_date
        FROM {_full(TABLE_CHECKLISTS)}
        WHERE UPPER(TRIM(short_token)) IN UNNEST(@tokens)
    """
    found: Dict[str, dict] = {}
    for r in bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("tokens", "STRING", toks),
    ])).result():
        d = _row_to_dict(r)
        key = str(d.get("short_token") or "").strip().upper()
        if key and key not in found:
            found[key] = d
    out: List[dict] = []
    for t in toks:
        d = found.get(t)
        if d is None:
            out.append({"short_token": t, "found": False})
            continue
        inv = d.get("investment")
        out.append({
            "short_token":   t,
            "found":         True,
            "client":        d.get("client"),
            "campaign_name": d.get("campaign_name"),
            "agency":        d.get("agency"),
            "cp_name":       d.get("cp_name"),
            "cs_name":       d.get("cs_name"),
            "investment":    float(inv) if inv is not None else None,
            "deal_dv360":    d.get("deal_dv360"),
            "start_date":    d.get("start_date"),
            "end_date":      d.get("end_date"),
        })
    return out
