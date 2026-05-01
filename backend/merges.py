"""
Merge Reports — unifica múltiplos short_tokens (PIs mensais) do mesmo
cliente em uma "campanha agregada" exibida sob um único link público.

Contexto
--------
Cada PI (Pedido de Inserção) gera um short_token. Uma campanha que roda
3 meses consecutivos vira 3 short_tokens distintos — 3 reports separados.
Esse módulo cria um agrupamento opcional entre tokens do mesmo cliente
para que a visualização possa ser apresentada de forma unificada, sem
mexer nos cálculos por token (pacing/CPM/rentabilidade continuam sendo
calculados isoladamente em `query_totals`, por token).

Estratégia
----------
Tabela física `campaign_merge_groups` mapeando token → merge_id, com a
config do grupo (modo de RMND/PDOOH) denormalizada em cada linha.
Denormalização é segura porque grupos são pequenos (poucos tokens) e
mutações de config são raras.

Camada de composição (não neste módulo): `fetch_merged_report(merge_id)`
chama `fetch_campaign_data(token)` em paralelo para cada token do grupo
e combina os payloads. Pacing/over no merged espelha o token ativo.

Tabela
------
`{PROJECT_ID}.{DATASET_ASSETS}.campaign_merge_groups`:
    merge_id     STRING NOT NULL  -- chave do grupo (token_urlsafe(8))
    short_token  STRING NOT NULL  -- membro do grupo, único globalmente
    client_name  STRING NOT NULL  -- snapshot do cliente no momento do merge (defensivo)
    rmnd_mode    STRING           -- 'merge' | 'latest' (default 'merge')
    pdooh_mode   STRING           -- 'merge' | 'latest' (default 'merge')
    created_by   STRING           -- email do admin que adicionou este token ao grupo
    created_at   TIMESTAMP

Invariantes
-----------
1. UNIQUE(short_token): um token só pode estar em UM grupo por vez.
2. Todos os rows de um mesmo merge_id têm o mesmo client_name.
3. Todos os rows de um mesmo merge_id têm a mesma config (rmnd_mode/pdooh_mode).
4. Grupo mínimo = 2 tokens. Após unmerge, se sobrar 1 token o grupo é
   automaticamente dissolvido.

Compatibilidade
---------------
Tokens não-merged continuam funcionando exatamente como antes. Esse
módulo é puramente aditivo — `fetch_campaign_data` não muda.
"""

import os
import re
import secrets
import threading
import unicodedata

from google.cloud import bigquery

bq = bigquery.Client()

PROJECT_ID     = os.environ.get("GCP_PROJECT",     "site-hypr")
DATASET_ASSETS = "prod_assets"
DATASET_HUB    = os.environ.get("BQ_DATASET_HUB",  "prod_prod_hypr_reporthub")
TABLE_HUB      = os.environ.get("BQ_TABLE",        "campaign_results")
TABLE_MERGES   = "campaign_merge_groups"

VALID_ASSET_MODES = ("merge", "latest")
DEFAULT_ASSET_MODE = "merge"

# Idempotência de criação da tabela (1× por instância warm).
_table_ensured = False
_ensure_lock = threading.Lock()


# ─── Erros tipados (handler HTTP traduz em 400/404/409) ─────────────────────
class MergeError(Exception):
    """Base de erros de merge — handler usa o atributo `code` pra status HTTP."""
    code = 400

class TokenNotFoundError(MergeError):
    code = 404

class ClientMismatchError(MergeError):
    code = 409

class TokenAlreadyMergedError(MergeError):
    code = 409

class InvalidMergeError(MergeError):
    code = 400


# ─── Identificadores e referências de tabela ────────────────────────────────
def _merges_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.{TABLE_MERGES}"


def _campaigns_table_id() -> str:
    return f"`{PROJECT_ID}.{DATASET_HUB}.{TABLE_HUB}`"


def _generate_merge_id() -> str:
    """~12 chars URL-safe, ~64 bits de entropia — colisão desprezível
    no volume esperado (poucos grupos por mês). Não vai em URL pública,
    mas reaproveitamos token_urlsafe pra simetria com share_id."""
    return secrets.token_urlsafe(8)


def ensure_table_exists() -> None:
    """Cria a tabela se ainda não existir. Idempotente, com flag de
    instância pra evitar query repetida em warm path."""
    global _table_ensured
    if _table_ensured:
        return
    with _ensure_lock:
        if _table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_merges_table_id()}` (
                merge_id     STRING NOT NULL,
                short_token  STRING NOT NULL,
                client_name  STRING NOT NULL,
                rmnd_mode    STRING,
                pdooh_mode   STRING,
                created_by   STRING,
                created_at   TIMESTAMP
            )
        """
        bq.query(sql).result()
        _table_ensured = True


# ─── Normalização de client_name (paridade com clients.normalize_client_slug)
# Usada APENAS na validação "tokens do mesmo cliente". Espelha o slug do
# admin pra que "L'Oréal" e "LOREAL" sejam aceitos como mesmo cliente.
_NORM_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _normalize_client(name: str) -> str:
    if not name:
        return ""
    s = name.strip().lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = _NORM_NON_ALNUM.sub("-", s).strip("-")
    return s


def _validate_mode(mode: str | None, label: str) -> str:
    """Valida e normaliza um modo de asset. None ou vazio → default."""
    if mode is None or mode == "":
        return DEFAULT_ASSET_MODE
    if mode not in VALID_ASSET_MODES:
        raise InvalidMergeError(
            f"{label}_mode inválido: '{mode}'. Use 'merge' ou 'latest'."
        )
    return mode


# ─── Leituras ───────────────────────────────────────────────────────────────
def get_merge_id_for_token(short_token: str) -> str | None:
    """Retorna o merge_id ao qual `short_token` pertence, ou None."""
    if not short_token:
        return None
    ensure_table_exists()
    sql = f"""
        SELECT merge_id
        FROM `{_merges_table_id()}`
        WHERE UPPER(short_token) = UPPER(@token)
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    rows = list(bq.query(sql, job_config=job_config).result())
    return rows[0]["merge_id"] if rows else None


def get_merge_group(merge_id: str) -> dict | None:
    """Retorna a estrutura completa de um grupo:

      {
        "merge_id": str,
        "client_name": str,
        "rmnd_mode": "merge" | "latest",
        "pdooh_mode": "merge" | "latest",
        "members": [
          {"short_token": str, "created_by": str | None, "created_at": str | None},
          ...
        ]
      }

    Retorna None se o grupo não existe ou não tem membros.
    """
    if not merge_id:
        return None
    ensure_table_exists()
    sql = f"""
        SELECT merge_id, short_token, client_name, rmnd_mode, pdooh_mode,
               created_by, created_at
        FROM `{_merges_table_id()}`
        WHERE merge_id = @mid
        ORDER BY created_at ASC
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("mid", "STRING", merge_id)]
    )
    rows = list(bq.query(sql, job_config=job_config).result())
    if not rows:
        return None

    first = rows[0]
    return {
        "merge_id":    first["merge_id"],
        "client_name": first["client_name"],
        "rmnd_mode":   first["rmnd_mode"]  or DEFAULT_ASSET_MODE,
        "pdooh_mode":  first["pdooh_mode"] or DEFAULT_ASSET_MODE,
        "members": [
            {
                "short_token": r["short_token"],
                "created_by":  r["created_by"],
                "created_at":  str(r["created_at"]) if r["created_at"] else None,
            }
            for r in rows
        ],
    }


def get_all_merge_groups_lookup() -> dict:
    """Bulk read pra enriquecer payload da listagem admin.

    Retorna {short_token: {merge_id, rmnd_mode, pdooh_mode}} para todos
    os tokens em algum grupo. Tabela é pequena (poucos grupos × poucos
    tokens) então um full scan vale mais que N round-trips.

    Mantemos o case original de short_token na chave (vem do banco).
    """
    ensure_table_exists()
    sql = f"""
        SELECT short_token, merge_id, rmnd_mode, pdooh_mode
        FROM `{_merges_table_id()}`
    """
    rows = list(bq.query(sql).result())
    out = {}
    for r in rows:
        if not r["short_token"]:
            continue
        out[r["short_token"]] = {
            "merge_id":   r["merge_id"],
            "rmnd_mode":  r["rmnd_mode"]  or DEFAULT_ASSET_MODE,
            "pdooh_mode": r["pdooh_mode"] or DEFAULT_ASSET_MODE,
        }
    return out


def get_groups_summary() -> list[dict]:
    """Devolve a lista de grupos com seus membros (um row por grupo).

    Útil para diagnostics e para a view "Por cliente" agrupar visualmente.
    Não é usado pelo report público.
    """
    ensure_table_exists()
    sql = f"""
        SELECT
            merge_id,
            ANY_VALUE(client_name) AS client_name,
            ANY_VALUE(rmnd_mode)   AS rmnd_mode,
            ANY_VALUE(pdooh_mode)  AS pdooh_mode,
            ARRAY_AGG(short_token ORDER BY created_at ASC) AS tokens,
            MIN(created_at) AS created_at
        FROM `{_merges_table_id()}`
        GROUP BY merge_id
    """
    rows = list(bq.query(sql).result())
    return [
        {
            "merge_id":    r["merge_id"],
            "client_name": r["client_name"],
            "rmnd_mode":   r["rmnd_mode"]  or DEFAULT_ASSET_MODE,
            "pdooh_mode":  r["pdooh_mode"] or DEFAULT_ASSET_MODE,
            "tokens":      list(r["tokens"] or []),
            "created_at":  str(r["created_at"]) if r["created_at"] else None,
        }
        for r in rows
    ]


# ─── Validação ──────────────────────────────────────────────────────────────
def _fetch_tokens_metadata(short_tokens: list[str]) -> dict:
    """Busca client_name canônico para cada short_token na hub table.

    Retorna {short_token_upper: client_name}. Tokens ausentes não aparecem
    no dict — caller deve validar contra a lista original.
    """
    if not short_tokens:
        return {}
    sql = f"""
        SELECT short_token, ANY_VALUE(client_name) AS client_name
        FROM {_campaigns_table_id()}
        WHERE UPPER(short_token) IN UNNEST(@tokens)
        GROUP BY short_token
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ArrayQueryParameter(
            "tokens", "STRING", [t.upper() for t in short_tokens if t]
        )]
    )
    rows = list(bq.query(sql, job_config=job_config).result())
    return {r["short_token"].upper(): r["client_name"] for r in rows if r["short_token"]}


# ─── Mutations ──────────────────────────────────────────────────────────────
def merge_tokens(
    tokens: list[str],
    admin_email: str,
    rmnd_mode: str | None = None,
    pdooh_mode: str | None = None,
) -> dict:
    """Cria um novo grupo com `tokens`, ou adiciona ao grupo existente.

    Regra de fusão:
      - Se nenhum dos tokens já está em um grupo → cria grupo novo.
      - Se exatamente 1 dos tokens já está em um grupo → adiciona os
        outros a esse grupo existente (preservando rmnd_mode/pdooh_mode
        já definidos do grupo, a menos que o caller informe novos).
      - Se 2+ tokens já estão em grupos diferentes → raise (precisa
        unmerge antes; merge entre grupos é decisão explícita do admin).

    Validações:
      - Min 2 tokens.
      - Todos os tokens existem em campaign_results.
      - Todos os tokens têm o mesmo client_name (slug normalizado).
      - Modos válidos.

    Retorna o grupo final via get_merge_group().
    """
    ensure_table_exists()

    if not tokens or len(tokens) < 2:
        raise InvalidMergeError("Merge requer ao menos 2 tokens.")

    # Dedup preservando order (case-insensitive)
    seen = set()
    clean_tokens = []
    for t in tokens:
        if not t:
            continue
        key = t.strip().upper()
        if not key or key in seen:
            continue
        seen.add(key)
        clean_tokens.append(key)
    if len(clean_tokens) < 2:
        raise InvalidMergeError("Merge requer ao menos 2 tokens distintos.")

    rmnd_mode  = _validate_mode(rmnd_mode,  "rmnd")
    pdooh_mode = _validate_mode(pdooh_mode, "pdooh")

    # 1) Verifica que todos existem na hub e batem o mesmo cliente
    metadata = _fetch_tokens_metadata(clean_tokens)
    missing = [t for t in clean_tokens if t not in metadata]
    if missing:
        raise TokenNotFoundError(
            f"Token(s) não encontrado(s): {', '.join(missing)}"
        )

    canonical_client = metadata[clean_tokens[0]] or ""
    canonical_slug   = _normalize_client(canonical_client)
    for t in clean_tokens[1:]:
        if _normalize_client(metadata[t] or "") != canonical_slug:
            raise ClientMismatchError(
                "Todos os tokens devem ser do mesmo cliente. "
                f"Encontrado '{metadata[t]}' vs '{canonical_client}'."
            )

    # 2) Verifica grupos existentes desses tokens
    sql_existing = f"""
        SELECT short_token, merge_id, rmnd_mode, pdooh_mode
        FROM `{_merges_table_id()}`
        WHERE UPPER(short_token) IN UNNEST(@tokens)
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ArrayQueryParameter("tokens", "STRING", clean_tokens)]
    )
    existing_rows = list(bq.query(sql_existing, job_config=job_config).result())

    existing_by_token = {r["short_token"].upper(): dict(r) for r in existing_rows}
    distinct_merge_ids = {r["merge_id"] for r in existing_rows}

    if len(distinct_merge_ids) > 1:
        raise TokenAlreadyMergedError(
            "Tokens já pertencem a grupos distintos. "
            "Desfaça o merge antes de unificar."
        )

    if len(distinct_merge_ids) == 1:
        # Adiciona ao grupo existente. Mantém SEMPRE os modes do grupo —
        # alterar config requer chamada explícita a update_merge_settings.
        # Justificativa: merge_tokens pode ser disparado em fluxos diferentes
        # (UI clica "adicionar mais um token") onde o caller não tem intenção
        # de mudar config. Settings só mudam via endpoint dedicado.
        existing_merge_id = next(iter(distinct_merge_ids))
        any_existing = next(iter(existing_by_token.values()))
        rmnd_mode  = any_existing["rmnd_mode"]  or rmnd_mode
        pdooh_mode = any_existing["pdooh_mode"] or pdooh_mode

        # Insere apenas os tokens que ainda não estão no grupo
        new_tokens = [t for t in clean_tokens if t not in existing_by_token]
        if new_tokens:
            _insert_members(
                merge_id=existing_merge_id,
                tokens=new_tokens,
                client_name=canonical_client,
                rmnd_mode=rmnd_mode,
                pdooh_mode=pdooh_mode,
                admin_email=admin_email,
            )
        # Mesmo sem novos tokens, devolve o estado atual (idempotência: chamar
        # merge com tokens já mergeados não falha).
        return get_merge_group(existing_merge_id) or {}

    # Nenhum dos tokens em grupo: cria grupo novo
    new_merge_id = _generate_merge_id()
    _insert_members(
        merge_id=new_merge_id,
        tokens=clean_tokens,
        client_name=canonical_client,
        rmnd_mode=rmnd_mode,
        pdooh_mode=pdooh_mode,
        admin_email=admin_email,
    )
    return get_merge_group(new_merge_id) or {}


def _insert_members(
    merge_id: str,
    tokens: list[str],
    client_name: str,
    rmnd_mode: str,
    pdooh_mode: str,
    admin_email: str,
) -> None:
    """INSERT batch de N tokens no mesmo merge_id. Usa UNNEST para 1
    única query independente do número de tokens."""
    if not tokens:
        return
    sql = f"""
        INSERT INTO `{_merges_table_id()}`
            (merge_id, short_token, client_name, rmnd_mode, pdooh_mode,
             created_by, created_at)
        SELECT
            @mid, t, @client, @rmnd, @pdooh, @by, CURRENT_TIMESTAMP()
        FROM UNNEST(@tokens) AS t
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("mid",    "STRING", merge_id),
            bigquery.ScalarQueryParameter("client", "STRING", client_name),
            bigquery.ScalarQueryParameter("rmnd",   "STRING", rmnd_mode),
            bigquery.ScalarQueryParameter("pdooh",  "STRING", pdooh_mode),
            bigquery.ScalarQueryParameter("by",     "STRING", admin_email),
            bigquery.ArrayQueryParameter("tokens",  "STRING", tokens),
        ]
    )
    bq.query(sql, job_config=job_config).result()


def unmerge_token(short_token: str, admin_email: str) -> dict:
    """Remove `short_token` do seu grupo. Se sobrar apenas 1 token no
    grupo, dissolve o grupo todo (apaga ambos rows).

    Retorna:
      {
        "removed": [list of tokens that were removed],
        "merge_id": merge_id afetado (ou None se token não estava em grupo)
      }
    """
    if not short_token:
        raise InvalidMergeError("short_token vazio")
    ensure_table_exists()

    merge_id = get_merge_id_for_token(short_token)
    if not merge_id:
        return {"removed": [], "merge_id": None}

    group = get_merge_group(merge_id)
    if not group:
        return {"removed": [], "merge_id": None}

    members = [m["short_token"] for m in group["members"]]
    remaining = [t for t in members if t.upper() != short_token.upper()]

    if len(remaining) <= 1:
        # Dissolve o grupo inteiro — single-token group não tem sentido
        sql_del = f"""
            DELETE FROM `{_merges_table_id()}`
            WHERE merge_id = @mid
        """
        bq.query(
            sql_del,
            job_config=bigquery.QueryJobConfig(query_parameters=[
                bigquery.ScalarQueryParameter("mid", "STRING", merge_id),
            ])
        ).result()
        return {"removed": members, "merge_id": merge_id}

    # Remove só este token
    sql_del = f"""
        DELETE FROM `{_merges_table_id()}`
        WHERE merge_id = @mid AND UPPER(short_token) = UPPER(@token)
    """
    bq.query(
        sql_del,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("mid",   "STRING", merge_id),
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
        ])
    ).result()
    return {"removed": [short_token], "merge_id": merge_id}


def update_merge_settings(
    merge_id: str,
    admin_email: str,
    rmnd_mode: str | None = None,
    pdooh_mode: str | None = None,
) -> dict:
    """Atualiza rmnd_mode/pdooh_mode em todos os rows do grupo.

    Argumentos None → mantém valor atual (a query usa COALESCE).
    Retorna o grupo atualizado.
    """
    ensure_table_exists()
    if not merge_id:
        raise InvalidMergeError("merge_id vazio")

    if rmnd_mode is None and pdooh_mode is None:
        # Nada a atualizar
        existing = get_merge_group(merge_id)
        if not existing:
            raise InvalidMergeError(f"Grupo {merge_id} não encontrado")
        return existing

    # Validação só nos campos que vão mudar
    new_rmnd  = _validate_mode(rmnd_mode,  "rmnd")  if rmnd_mode  is not None else None
    new_pdooh = _validate_mode(pdooh_mode, "pdooh") if pdooh_mode is not None else None

    sql = f"""
        UPDATE `{_merges_table_id()}`
        SET
            rmnd_mode  = COALESCE(@new_rmnd,  rmnd_mode),
            pdooh_mode = COALESCE(@new_pdooh, pdooh_mode)
        WHERE merge_id = @mid
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("mid",       "STRING", merge_id),
        bigquery.ScalarQueryParameter("new_rmnd",  "STRING", new_rmnd),
        bigquery.ScalarQueryParameter("new_pdooh", "STRING", new_pdooh),
    ])
    result = bq.query(sql, job_config=job_config).result()

    # Se UPDATE não afetou linhas, o grupo não existia
    updated = get_merge_group(merge_id)
    if not updated:
        raise InvalidMergeError(f"Grupo {merge_id} não encontrado")
    return updated


# ─── Listagem auxiliar para o admin: tokens elegíveis pra merge ─────────────
def list_mergeable_tokens(short_token: str) -> list[dict]:
    """Lista tokens do MESMO cliente que podem ser mergeados com `short_token`.

    "Mergeáveis" = mesmo client_name canônico, ainda não pertencentes a
    OUTRO grupo. Tokens já no mesmo grupo do `short_token` aparecem
    marcados como `already_in_group=True` (UI mostra como selecionados).

    Não inclui o próprio `short_token` na lista.

    Retorna lista de:
      {
        "short_token": str,
        "campaign_name": str,
        "start_date": str | None,
        "end_date": str | None,
        "in_other_group": bool,   -- já em grupo de outro
        "already_in_group": bool, -- já no MESMO grupo do short_token
      }
    """
    if not short_token:
        return []
    ensure_table_exists()

    # 1) Descobre o cliente do token base
    base_meta = _fetch_tokens_metadata([short_token])
    if short_token.upper() not in base_meta:
        raise TokenNotFoundError(f"Token base não encontrado: {short_token}")
    base_client_slug = _normalize_client(base_meta[short_token.upper()] or "")
    if not base_client_slug:
        return []

    # 2) Pega todos os tokens do mesmo cliente. Normalização igual ao
    # _normalize_client mas em SQL: lower + remove acentos não dá em BQ
    # standard sem JS UDF — então fazemos LOWER + REGEX_REPLACE pra
    # aproximar e refinamos em Python.
    sql = f"""
        SELECT
            short_token,
            ANY_VALUE(client_name)   AS client_name,
            ANY_VALUE(campaign_name) AS campaign_name,
            MAX(start_date)          AS start_date,
            MAX(end_date)            AS end_date
        FROM {_campaigns_table_id()}
        WHERE UPPER(short_token) != UPPER(@self)
        GROUP BY short_token
    """
    rows = list(bq.query(
        sql,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("self", "STRING", short_token),
        ])
    ).result())

    same_client = [
        r for r in rows
        if _normalize_client(r["client_name"] or "") == base_client_slug
    ]

    # 3) Quais já estão em algum grupo, e qual?
    base_merge_id = get_merge_id_for_token(short_token)
    all_groups = get_all_merge_groups_lookup()

    out = []
    for r in same_client:
        token = r["short_token"]
        info = all_groups.get(token)
        in_other = bool(info and info["merge_id"] != base_merge_id)
        already_in = bool(info and base_merge_id and info["merge_id"] == base_merge_id)
        out.append({
            "short_token":      token,
            "campaign_name":    r["campaign_name"],
            "start_date":       str(r["start_date"]) if r["start_date"] else None,
            "end_date":         str(r["end_date"])   if r["end_date"]   else None,
            "in_other_group":   in_other,
            "already_in_group": already_in,
        })

    # Ordena por start_date desc (mais recente primeiro)
    out.sort(key=lambda x: x["start_date"] or "", reverse=True)
    return out
