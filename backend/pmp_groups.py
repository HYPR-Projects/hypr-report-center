"""
PMP Line Groups — agrupa N lines do Xandr sob o mesmo PI compartilhado.

Caso de uso típico
------------------
Admin cria 2 lines no Xandr pra A/B test (Fixed Bid vs Flex Bid) — ambas
fazem parte do MESMO PI cadastrado no Hypr Command. Sem agrupamento, a UI
mostraria PI duplicado (uma vez por line) e o % entrega seria calculado
isoladamente. Com agrupamento:

  • PI vem do checklist do Command (1×, não N×)
  • Revenue/Margin = soma de TODAS as lines do grupo
  • % Entrega = soma_revenue / PI

Modelo
------
Espelha `merges.py` mas com `line_id` em vez de `short_token` como chave de
membro. Tabela física `pmp_line_groups` no BQ:

    group_id     STRING NOT NULL  -- random URL-safe 8 chars
    line_id      INT64  NOT NULL  -- UNIQUE: uma line só num grupo
    group_name   STRING            -- opcional, default vem do checklist
    short_token  STRING            -- mesmo short_token em todas as lines do grupo
    created_by   STRING
    created_at   TIMESTAMP
    updated_by   STRING
    updated_at   TIMESTAMP
    notes        STRING

Invariantes
-----------
1. UNIQUE(line_id): uma line só num grupo por vez.
2. Todos os rows de um mesmo group_id têm o mesmo short_token (se houver).
3. Grupo mínimo = 2 lines. Após ungroup, se sobrar 1 line o grupo dissolve.

Compatibilidade
---------------
Lines fora de grupo continuam funcionando como antes. Este módulo é puro
aditivo — `pmp_lines_enriched` faz LEFT JOIN com `pmp_line_groups`.
"""

import logging
import os
import secrets
from typing import List, Optional
from google.cloud import bigquery

import bq_client


logger = logging.getLogger(__name__)

PROJECT_ID = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET    = "prod_assets"
TABLE_GROUPS = "pmp_line_groups"
TABLE_LINES  = "pmp_line_items"
TABLE_IOS    = "pmp_insertion_orders"

# Client compartilhado: timeout obrigatório em toda query + pool HTTP
# dimensionado pro paralelismo real. Ver bq_client.py.
bq = bq_client.get_client()


def _full(t: str) -> str:
    return f"`{PROJECT_ID}.{DATASET}.{t}`"


# ─── Erros tipados ──────────────────────────────────────────────────────────
class GroupError(Exception):
    """Base — handler HTTP traduz code em status."""
    code = 400


class LineNotFoundError(GroupError):
    code = 404


class LineAlreadyGroupedError(GroupError):
    code = 409


class ClientMismatchError(GroupError):
    code = 400


class InvalidGroupError(GroupError):
    code = 400


# ─── Helpers ────────────────────────────────────────────────────────────────
def _generate_group_id() -> str:
    return secrets.token_urlsafe(6)  # 8 chars URL-safe


# ─── Modelo de membro (source, line_id) ──────────────────────────────────────
# A unidade de um grupo agora é o PAR (source, line_id). `source` ∈
# {'xandr','pubmatic'}. Membros são dicts {"source","line_id"}; helpers abaixo
# normalizam entradas legadas (int puro → source='xandr').
DEFAULT_SOURCE = "xandr"


def _norm_member(m) -> dict:
    """Normaliza um membro: aceita int (legado → xandr) ou dict {source,line_id}."""
    if isinstance(m, dict):
        return {"source": (m.get("source") or DEFAULT_SOURCE),
                "line_id": int(m["line_id"])}
    return {"source": DEFAULT_SOURCE, "line_id": int(m)}


def _mkey(source: str, line_id: int) -> tuple:
    return (source, int(line_id))


def _fetch_lines_metadata(members: List[dict]) -> dict:
    """Retorna {(source, line_id): {customer, line_name, short_token, group_id}}.

    `members` é lista de dicts {source, line_id}. Casa por (source, line_id)
    pra não confundir line_ids numericamente iguais entre fontes. Customer
    cai pra customer_override quando a fonte não tem IO (PubMatic).
    """
    if not members:
        return {}
    line_ids = sorted({m["line_id"] for m in members})
    sources  = sorted({m["source"]  for m in members})
    sql = f"""
        SELECT
          li.source, li.line_id, li.line_name, li.short_token,
          COALESCE(io.customer, li.customer_override) AS customer,
          g.group_id  AS current_group_id
        FROM {_full(TABLE_LINES)} li
        LEFT JOIN {_full(TABLE_IOS)} io ON io.io_id = li.io_id
        LEFT JOIN {_full(TABLE_GROUPS)} g
          ON g.line_id = li.line_id AND g.source = li.source
        WHERE li.line_id IN UNNEST(@ids) AND li.source IN UNNEST(@sources)
    """
    rows = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ArrayQueryParameter("ids", "INT64", line_ids),
        bigquery.ArrayQueryParameter("sources", "STRING", sources),
    ])).result()
    return {_mkey(r["source"], r["line_id"]): dict(r) for r in rows}


# ─── Reads ──────────────────────────────────────────────────────────────────
def get_group(group_id: str) -> Optional[dict]:
    """Retorna {group_id, group_name, short_token, members: [...]} ou None."""
    sql = f"""
        SELECT g.group_id, g.group_name, g.short_token, g.notes,
               g.source, g.line_id, li.line_name,
               g.created_by, g.created_at
        FROM {_full(TABLE_GROUPS)} g
        JOIN {_full(TABLE_LINES)} li
          ON li.line_id = g.line_id AND li.source = g.source
        WHERE g.group_id = @gid
        ORDER BY g.created_at, g.line_id
    """
    rows = list(bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("gid", "STRING", group_id)]
    )).result())
    if not rows:
        return None
    first = rows[0]
    return {
        "group_id":    first["group_id"],
        "group_name":  first.get("group_name"),
        "short_token": first.get("short_token"),
        "notes":       first.get("notes"),
        "created_by":  first.get("created_by"),
        "created_at":  first["created_at"].isoformat() if first.get("created_at") else None,
        "members": [
            {"source": r["source"], "line_id": r["line_id"], "line_name": r.get("line_name")}
            for r in rows
        ],
    }


def get_group_id_for_line(source: str, line_id: int) -> Optional[str]:
    sql = (f"SELECT group_id FROM {_full(TABLE_GROUPS)} "
           f"WHERE line_id = @lid AND source = @src LIMIT 1")
    rows = list(bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("lid", "INT64", int(line_id)),
        bigquery.ScalarQueryParameter("src", "STRING", source or DEFAULT_SOURCE),
    ])).result())
    return rows[0]["group_id"] if rows else None


def list_groupable_lines(source: str, line_id: int) -> List[dict]:
    """Lista lines do MESMO CLIENTE que podem ser agrupadas com (source, line_id).

    Lê de `pmp_lines_enriched`, que já resolve customer/source/grupo das DUAS
    fontes — então o candidato pode ser Xandr OU PubMatic (agrupamento
    cross-fornecedor). Critério: mesmo customer, não arquivada, exclui a própria.
    """
    src = source or DEFAULT_SOURCE
    sql = f"""
        WITH target AS (
          SELECT customer
          FROM `site-hypr.prod_assets.pmp_lines_enriched`
          WHERE line_id = @lid AND source = @src
        )
        SELECT
          enr.source, enr.line_id, enr.external_deal_id,
          enr.line_name, enr.state, enr.start_date, enr.end_date,
          enr.bid_type, enr.short_token, enr.customer, enr.status,
          enr.delivery_status,
          enr.group_id   AS current_group_id,
          enr.group_name AS current_group_name
        FROM `site-hypr.prod_assets.pmp_lines_enriched` enr
        CROSS JOIN target t
        WHERE enr.customer = t.customer
          AND NOT (enr.line_id = @lid AND enr.source = @src)
          AND COALESCE(enr.is_archived, FALSE) = FALSE
        ORDER BY enr.state DESC, enr.start_date DESC, enr.line_id
    """
    rows = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("lid", "INT64", int(line_id)),
        bigquery.ScalarQueryParameter("src", "STRING", src),
    ])).result()
    out = []
    for r in rows:
        out.append({
            "source":            r.get("source"),
            "line_id":           r["line_id"],
            "external_deal_id":  r.get("external_deal_id"),
            "line_name":         r.get("line_name"),
            "state":             r.get("state"),
            "status":            r.get("status"),
            "delivery_status":   r.get("delivery_status"),
            "start_date":        r["start_date"].isoformat() if r.get("start_date") else None,
            "end_date":          r["end_date"].isoformat()   if r.get("end_date")   else None,
            "bid_type":          r.get("bid_type"),
            "short_token":       r.get("short_token"),
            "customer":          r.get("customer"),
            "current_group_id":  r.get("current_group_id"),
            "current_group_name":r.get("current_group_name"),
        })
    return out


def get_groups_summary() -> List[dict]:
    """Lista todos os grupos com contagem de membros — útil pra UI listar."""
    sql = f"""
        SELECT g.group_id, ANY_VALUE(g.group_name) AS group_name,
               ANY_VALUE(g.short_token) AS short_token,
               COUNT(*) AS member_count,
               MIN(g.created_at) AS created_at,
               ARRAY_AGG(g.line_id ORDER BY g.created_at, g.line_id) AS line_ids
        FROM {_full(TABLE_GROUPS)} g
        GROUP BY g.group_id
        ORDER BY created_at DESC
    """
    out = []
    for r in bq.query(sql).result():
        out.append({
            "group_id":     r["group_id"],
            "group_name":   r.get("group_name"),
            "short_token":  r.get("short_token"),
            "member_count": r["member_count"],
            "line_ids":     list(r["line_ids"]),
            "created_at":   r["created_at"].isoformat() if r.get("created_at") else None,
        })
    return out


# ─── Writes ─────────────────────────────────────────────────────────────────
def group_lines(members: List[dict],
                 short_token: Optional[str],
                 group_name: Optional[str],
                 created_by: str) -> dict:
    """Cria grupo OU anexa lines a grupo existente.

    `members`: lista de {source, line_id} (aceita int legado = xandr). Pode
    misturar fontes — o objetivo é justamente unir entrega Xandr + PubMatic
    sob o mesmo PI.

    Regras (igual ao merge_tokens):
      • Se nenhuma está em grupo → cria grupo novo
      • Se UMA já está em grupo → anexa as outras a esse grupo
      • Se DUAS+ estão em grupos DIFERENTES → erro (desagrupe antes)
      • Todas devem ser do MESMO customer (validação)

    Retorna o grupo completo após o merge.
    """
    if not members or len(members) < 2:
        raise InvalidGroupError("Grupo precisa de pelo menos 2 lines")
    # Normaliza + dedup por (source, line_id)
    norm = {}
    for m in members:
        nm = _norm_member(m)
        norm[_mkey(nm["source"], nm["line_id"])] = nm
    keys = sorted(norm.keys())

    meta = _fetch_lines_metadata(list(norm.values()))
    missing = [k for k in keys if k not in meta]
    if missing:
        raise LineNotFoundError(f"Lines não encontradas: {missing}")

    # Valida cliente único
    customers = {m["customer"] for m in meta.values() if m.get("customer")}
    if len(customers) > 1:
        raise ClientMismatchError(f"Lines de clientes diferentes: {customers}")

    # Detecta grupos existentes nas lines
    existing_groups = {m["current_group_id"] for m in meta.values() if m.get("current_group_id")}
    if len(existing_groups) > 1:
        raise InvalidGroupError(
            f"Lines em grupos diferentes ({existing_groups}). Desagrupe antes."
        )

    # Decide group_id: anexa ao existente OR cria novo
    if existing_groups:
        group_id = existing_groups.pop()
    else:
        group_id = _generate_group_id()

    # Insere membros que ainda não estão no grupo
    to_insert = [k for k in keys if meta[k].get("current_group_id") != group_id]
    if not to_insert:
        return get_group(group_id)

    # Resolve short_token e group_name
    if not short_token:
        tokens = {m.get("short_token") for m in meta.values() if m.get("short_token")}
        if len(tokens) == 1:
            short_token = tokens.pop()
    if not group_name:
        group_name = customers.pop() if customers else None

    sql = f"""
        INSERT INTO {_full(TABLE_GROUPS)}
          (group_id, source, line_id, group_name, short_token, created_by, created_at, updated_by, updated_at)
        VALUES (@gid, @src, @lid, @gname, @token, @by, CURRENT_TIMESTAMP(), @by, CURRENT_TIMESTAMP())
    """
    for (src, lid) in to_insert:
        bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("gid",   "STRING", group_id),
            bigquery.ScalarQueryParameter("src",   "STRING", src),
            bigquery.ScalarQueryParameter("lid",   "INT64",  int(lid)),
            bigquery.ScalarQueryParameter("gname", "STRING", group_name),
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
            bigquery.ScalarQueryParameter("by",    "STRING", created_by),
        ])).result()

    # Refresh da tabela materializada pmp_lines_enriched — sem isso o
    # group_id não chega no frontend até o próximo sync diário (04:00 BRT).
    _refresh_enriched()
    return get_group(group_id)


def ungroup_line(source: str, line_id: int, admin_email: str) -> dict:
    """Remove (source, line_id) do grupo. Se sobrar 1 line, dissolve o grupo.

    Retorna {dissolved: bool, group_id, remaining: int}.
    """
    src = source or DEFAULT_SOURCE
    group_id = get_group_id_for_line(src, line_id)
    if not group_id:
        raise InvalidGroupError(f"Line {src}:{line_id} não está em grupo")

    # Deleta o membro
    sql_del = (f"DELETE FROM {_full(TABLE_GROUPS)} "
               f"WHERE line_id = @lid AND source = @src AND group_id = @gid")
    bq.query(sql_del, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("lid", "INT64",  int(line_id)),
        bigquery.ScalarQueryParameter("src", "STRING", src),
        bigquery.ScalarQueryParameter("gid", "STRING", group_id),
    ])).result()

    # Conta remanescentes
    sql_count = f"SELECT COUNT(*) AS n FROM {_full(TABLE_GROUPS)} WHERE group_id = @gid"
    rows = list(bq.query(sql_count, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("gid", "STRING", group_id)]
    )).result())
    remaining = int(rows[0]["n"]) if rows else 0

    dissolved = False
    if remaining < 2:
        # Dissolve grupo todo (single member não faz sentido)
        sql_dissolve = f"DELETE FROM {_full(TABLE_GROUPS)} WHERE group_id = @gid"
        bq.query(sql_dissolve, job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("gid", "STRING", group_id)]
        )).result()
        dissolved = True

    _refresh_enriched()
    return {"dissolved": dissolved, "group_id": group_id, "remaining": remaining}


def prune_orphan_groups() -> int:
    """Deleta grupos com <2 membros (estado inválido, restos de ungroup).

    Pode acontecer se uma op falhar no meio ou um membro for removido
    direto do BQ sem passar pelo `ungroup_line`. Idempotente.
    Retorna quantas linhas em pmp_line_groups foram apagadas.
    """
    sql = f"""
        DELETE FROM {_full(TABLE_GROUPS)}
        WHERE group_id IN (
          SELECT group_id FROM {_full(TABLE_GROUPS)}
          GROUP BY group_id HAVING COUNT(*) < 2
        )
    """
    job = bq.query(sql)
    job.result()
    return int(job.num_dml_affected_rows or 0)


def _refresh_enriched():
    """Auto-prune órfãos + refresh da tabela materializada.

    Roda em toda operação de grupo (group/ungroup). Garante que o frontend
    veja o estado atualizado IMEDIATAMENTE em vez de esperar o sync diário.
    Import lazy pra evitar ciclo (pmp_lines importa pmp_groups indiretamente).
    """
    try:
        prune_orphan_groups()
        from pmp_lines import refresh_enriched_table
        refresh_enriched_table()
    except Exception as e:
        # Não derruba a op de grupo se o refresh falhar — o sync diário
        # corrige depois. Loga pra investigação.
        import logging
        logging.getLogger(__name__).exception(f"refresh_enriched_table falhou: {e}")


def update_group_meta(group_id: str,
                      group_name: Optional[str] = None,
                      short_token: Optional[str] = None,
                      notes: Optional[str] = None,
                      updated_by: str = "system") -> dict:
    """Atualiza metadados do grupo (nome, short_token, notas). Não mexe em membros."""
    fields = {}
    if group_name is not None:  fields["group_name"]  = group_name
    if short_token is not None: fields["short_token"] = short_token
    if notes is not None:       fields["notes"]       = notes
    if not fields:
        return get_group(group_id)

    set_clauses = ", ".join(f"{k} = @{k}" for k in fields)
    sql = f"""
        UPDATE {_full(TABLE_GROUPS)}
        SET {set_clauses}, updated_by = @by, updated_at = CURRENT_TIMESTAMP()
        WHERE group_id = @gid
    """
    params = [
        bigquery.ScalarQueryParameter("gid", "STRING", group_id),
        bigquery.ScalarQueryParameter("by",  "STRING", updated_by),
    ]
    for k, v in fields.items():
        params.append(bigquery.ScalarQueryParameter(k, "STRING", v))
    bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    return get_group(group_id)
