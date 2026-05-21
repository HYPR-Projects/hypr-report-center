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


logger = logging.getLogger(__name__)

PROJECT_ID = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET    = "prod_assets"
TABLE_GROUPS = "pmp_line_groups"
TABLE_LINES  = "pmp_line_items"
TABLE_IOS    = "pmp_insertion_orders"

bq = bigquery.Client()


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


def _fetch_lines_metadata(line_ids: List[int]) -> dict:
    """Retorna {line_id: {customer, line_name, short_token, group_id}}."""
    if not line_ids:
        return {}
    sql = f"""
        SELECT
          li.line_id, li.line_name, li.short_token,
          io.customer AS customer,
          g.group_id  AS current_group_id
        FROM {_full(TABLE_LINES)} li
        LEFT JOIN {_full(TABLE_IOS)} io ON io.io_id = li.io_id
        LEFT JOIN {_full(TABLE_GROUPS)} g ON g.line_id = li.line_id
        WHERE li.line_id IN UNNEST(@ids)
    """
    rows = bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ArrayQueryParameter("ids", "INT64", line_ids)]
    )).result()
    return {r["line_id"]: dict(r) for r in rows}


# ─── Reads ──────────────────────────────────────────────────────────────────
def get_group(group_id: str) -> Optional[dict]:
    """Retorna {group_id, group_name, short_token, members: [...]} ou None."""
    sql = f"""
        SELECT g.group_id, g.group_name, g.short_token, g.notes,
               g.line_id, li.line_name,
               g.created_by, g.created_at
        FROM {_full(TABLE_GROUPS)} g
        JOIN {_full(TABLE_LINES)} li ON li.line_id = g.line_id
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
            {"line_id": r["line_id"], "line_name": r.get("line_name")}
            for r in rows
        ],
    }


def get_group_id_for_line(line_id: int) -> Optional[str]:
    sql = f"SELECT group_id FROM {_full(TABLE_GROUPS)} WHERE line_id = @lid LIMIT 1"
    rows = list(bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("lid", "INT64", int(line_id))]
    )).result())
    return rows[0]["group_id"] if rows else None


def list_groupable_lines(line_id: int) -> List[dict]:
    """Lista lines do MESMO CLIENTE que podem ser agrupadas com `line_id`.

    Critério: mesmo customer (via IO), e line ainda não está em outro grupo.
    Inclui a própria `line_id` se ela já está num grupo (pra mostrar contexto).
    Exclui lines arquivadas e em estado 'inactive' há muito tempo.
    """
    sql = f"""
        WITH target AS (
          SELECT io.customer
          FROM {_full(TABLE_LINES)} li
          JOIN {_full(TABLE_IOS)} io ON io.io_id = li.io_id
          WHERE li.line_id = @lid
        )
        SELECT
          li.line_id, li.line_name, li.state, li.start_date, li.end_date,
          li.bid_type, li.short_token,
          io.customer,
          COALESCE(li.status, 'Pendente') AS status,
          enr.delivery_status,
          g.group_id  AS current_group_id,
          g.group_name AS current_group_name
        FROM {_full(TABLE_LINES)} li
        JOIN {_full(TABLE_IOS)} io ON io.io_id = li.io_id
        CROSS JOIN target t
        LEFT JOIN `site-hypr.prod_assets.pmp_lines_enriched` enr ON enr.line_id = li.line_id
        LEFT JOIN {_full(TABLE_GROUPS)} g ON g.line_id = li.line_id
        WHERE io.customer = t.customer
          AND li.line_id != @lid
          AND COALESCE(li.is_archived, FALSE) = FALSE
        ORDER BY li.state DESC, li.start_date DESC, li.line_id
    """
    rows = bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("lid", "INT64", int(line_id))]
    )).result()
    out = []
    for r in rows:
        out.append({
            "line_id":           r["line_id"],
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
def group_lines(line_ids: List[int],
                 short_token: Optional[str],
                 group_name: Optional[str],
                 created_by: str) -> dict:
    """Cria grupo OU anexa lines a grupo existente.

    Regras (igual ao merge_tokens):
      • Se nenhuma das lines está em grupo → cria grupo novo
      • Se UMA já está em grupo → anexa as outras a esse grupo
      • Se DUAS+ estão em grupos DIFERENTES → erro (admin precisa ungrupar
        antes)
      • Todas as lines devem ser do MESMO customer (validação)

    Retorna o grupo completo após o merge.
    """
    if not line_ids or len(line_ids) < 2:
        raise InvalidGroupError("Grupo precisa de pelo menos 2 lines")
    line_ids = sorted({int(x) for x in line_ids})

    meta = _fetch_lines_metadata(line_ids)
    missing = [lid for lid in line_ids if lid not in meta]
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

    # Insere/atualiza membros que ainda não estão no grupo
    to_insert = [lid for lid in line_ids if meta[lid].get("current_group_id") != group_id]
    if not to_insert:
        # Tudo já tá no grupo — nothing to do, só retorna o estado atual
        return get_group(group_id)

    # Resolve short_token e group_name
    if not short_token:
        # Usa o short_token compartilhado entre as lines se todas tiverem o mesmo
        tokens = {m.get("short_token") for m in meta.values() if m.get("short_token")}
        if len(tokens) == 1:
            short_token = tokens.pop()
    if not group_name:
        # Fallback: nome do customer
        customer = customers.pop() if customers else None
        group_name = customer

    sql = f"""
        INSERT INTO {_full(TABLE_GROUPS)}
          (group_id, line_id, group_name, short_token, created_by, created_at, updated_by, updated_at)
        VALUES (@gid, @lid, @gname, @token, @by, CURRENT_TIMESTAMP(), @by, CURRENT_TIMESTAMP())
    """
    for lid in to_insert:
        bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("gid",   "STRING", group_id),
            bigquery.ScalarQueryParameter("lid",   "INT64",  int(lid)),
            bigquery.ScalarQueryParameter("gname", "STRING", group_name),
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
            bigquery.ScalarQueryParameter("by",    "STRING", created_by),
        ])).result()

    # Refresh da tabela materializada pmp_lines_enriched — sem isso o
    # group_id não chega no frontend até o próximo sync diário (04:00 BRT).
    _refresh_enriched()
    return get_group(group_id)


def ungroup_line(line_id: int, admin_email: str) -> dict:
    """Remove `line_id` do grupo. Se sobrar 1 line, dissolve o grupo todo.

    Retorna {dissolved: bool, group_id, remaining: int}.
    """
    group_id = get_group_id_for_line(line_id)
    if not group_id:
        raise InvalidGroupError(f"Line {line_id} não está em grupo")

    # Deleta o membro
    sql_del = f"DELETE FROM {_full(TABLE_GROUPS)} WHERE line_id = @lid AND group_id = @gid"
    bq.query(sql_del, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("lid", "INT64",  int(line_id)),
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
