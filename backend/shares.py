"""
Share IDs — desacopla a URL pública compartilhada da senha do cliente.

Contexto
--------
Antes deste módulo, a URL do report (`/report/{short_token}`) expunha
literalmente a senha de acesso (o próprio `short_token`). Quem recebia
o link já tinha a senha — a tela de senha era teatro de segurança.

Estratégia
----------
Cada short_token ganha um `share_id` — string aleatória de 16 chars
(URL-safe, ~96 bits de entropia, gerada via `secrets.token_urlsafe`).

A URL nova vira `/report/{share_id}` e a senha continua sendo o
short_token. O frontend troca `(share_id, password)` por `short_token`
chamando o endpoint `resolve_share` antes de carregar dados.

Compatibilidade legacy
----------------------
URLs antigas (`/report/SHORT_TOKEN`) continuam funcionando: quando
`resolve_share` recebe um identificador que não bate com nenhum
share_id, trata como short_token e valida diretamente. A senha
exposta na URL legacy continua sendo o problema (que é justamente
o que motivou esta mudança), mas links já compartilhados não quebram.

Tabela
------
`{PROJECT_ID}.{DATASET_ASSETS}.campaign_share_ids`:
    share_id    STRING NOT NULL  -- chave pública, vai na URL
    short_token STRING NOT NULL  -- referência interna, é a senha
    created_at  TIMESTAMP

Criada idempotentemente via `ensure_table_exists` (CREATE TABLE IF NOT
EXISTS), chamado em todo `get_or_create_share_id`. Custo: zero quando
a tabela já existe.
"""

import os
import secrets
import threading

from google.cloud import bigquery

bq = bigquery.Client()

PROJECT_ID         = os.environ.get("GCP_PROJECT",     "site-hypr")
DATASET_ASSETS     = "prod_assets"
DATASET_HUB        = os.environ.get("BQ_DATASET_HUB",  "prod_prod_hypr_reporthub")
TABLE_HUB          = os.environ.get("BQ_TABLE",        "campaign_results")
TABLE_SHARES       = "campaign_share_ids"

# Garante que ensure_table_exists só roda uma vez por instância (warm).
_table_ensured = False
_ensure_lock = threading.Lock()


def _shares_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.{TABLE_SHARES}"


def _campaigns_table_id() -> str:
    return f"`{PROJECT_ID}.{DATASET_HUB}.{TABLE_HUB}`"


def ensure_table_exists() -> None:
    """Cria a tabela campaign_share_ids se ainda não existir.

    Idempotente. Marcamos com flag por instância pra evitar sobrecarga
    na warm path. Cold start paga uma única query CREATE IF NOT EXISTS.
    """
    global _table_ensured
    if _table_ensured:
        return
    with _ensure_lock:
        if _table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_shares_table_id()}` (
                share_id STRING NOT NULL,
                short_token STRING NOT NULL,
                created_at TIMESTAMP
            )
        """
        bq.query(sql).result()
        _table_ensured = True


def _generate_share_id() -> str:
    """16 chars URL-safe, ~96 bits de entropia.

    Suficiente pra resistir a ataques de adivinhação por brute-force
    em URLs públicas. Caracteres possíveis: A-Z a-z 0-9 - _ (sem
    confundir com short_tokens, que são curtos e maiúsculos puros).
    """
    return secrets.token_urlsafe(12)


def get_share_id_for_token(short_token: str) -> str | None:
    """Retorna o share_id existente do short_token, ou None."""
    ensure_table_exists()
    sql = f"""
        SELECT share_id
        FROM `{_shares_table_id()}`
        WHERE UPPER(short_token) = UPPER(@token)
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    rows = list(bq.query(sql, job_config=job_config).result())
    return rows[0]["share_id"] if rows else None


def get_token_for_share_id(share_id: str) -> str | None:
    """Retorna o short_token associado a um share_id, ou None.

    Comparação case-sensitive: share_id é base64url e diferencia case.
    """
    ensure_table_exists()
    sql = f"""
        SELECT short_token
        FROM `{_shares_table_id()}`
        WHERE share_id = @sid
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("sid", "STRING", share_id)]
    )
    rows = list(bq.query(sql, job_config=job_config).result())
    return rows[0]["short_token"] if rows else None


def get_or_create_share_id(short_token: str) -> str:
    """Retorna share_id existente, ou cria e retorna um novo.

    Em caso de colisão (improvável), tenta até 5x. Se ainda assim
    falhar (nunca deveria), levanta RuntimeError.
    """
    existing = get_share_id_for_token(short_token)
    if existing:
        return existing

    for _ in range(5):
        candidate = _generate_share_id()
        # Confere se o ID candidato já existe (collision check).
        if get_token_for_share_id(candidate) is None:
            sql = f"""
                INSERT INTO `{_shares_table_id()}` (share_id, short_token, created_at)
                VALUES (@sid, @token, CURRENT_TIMESTAMP())
            """
            job_config = bigquery.QueryJobConfig(
                query_parameters=[
                    bigquery.ScalarQueryParameter("sid",   "STRING", candidate),
                    bigquery.ScalarQueryParameter("token", "STRING", short_token),
                ]
            )
            bq.query(sql, job_config=job_config).result()
            return candidate

    raise RuntimeError("Falha ao gerar share_id único após 5 tentativas")


def _campaign_exists(short_token: str) -> bool:
    """Verifica se short_token corresponde a uma campanha real.

    Importante para evitar que `resolve_share` valide credenciais
    "fantasmas" no caminho legacy: sem essa checagem, qualquer string
    igual à senha (ex: ABC123 = ABC123) seria aceita mesmo sem
    campanha correspondente, vazando que o sistema aceita inputs
    arbitrários.
    """
    sql = f"""
        SELECT 1 FROM {_campaigns_table_id()}
        WHERE UPPER(short_token) = UPPER(@token)
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    rows = list(bq.query(sql, job_config=job_config).result())
    return len(rows) > 0


def resolve_share(share_id_or_token: str, password: str) -> str | None:
    """Resolve credenciais públicas → short_token. Compatível com legacy.

    Fluxo:
      1) Trata input como share_id novo. Se existe na tabela,
         valida password contra o short_token associado.
      2) Se não existe, trata input como short_token legacy
         (compatibilidade). Valida que: (a) input == password
         (URL antiga embute a senha no path), e (b) a campanha
         existe na tabela principal.

    Retorna o short_token canônico (case do banco) se válido,
    senão None. Comparação de senha é case-insensitive — replica
    o comportamento atual do front (`pw.toUpperCase()`).
    """
    if not share_id_or_token or not password:
        return None

    pw_upper = password.strip().upper()

    # ─── 1) Caminho novo: share_id ────────────────────────────────────
    short_token = get_token_for_share_id(share_id_or_token)
    if short_token:
        return short_token if pw_upper == short_token.upper() else None

    # ─── 2) Caminho legacy: URL contém o próprio short_token ─────────
    candidate = share_id_or_token.strip()
    # Heurística: short_tokens são curtos (até ~12 chars) e alfanuméricos.
    # Evita gastar query em strings que claramente são share_ids inválidos.
    if 1 <= len(candidate) <= 12 and candidate.isalnum():
        if candidate.upper() == pw_upper and _campaign_exists(candidate):
            return candidate.upper()

    return None
