"""
Notas internas de campanha — thread estilo chat, ADMIN-ONLY.

Contexto
--------
O time precisava registrar "o que aconteceu" numa campanha (pausa
combinada com o cliente, troca de criativo, problema no DSP, decisão
de reduzir budget) num lugar que sobrevivesse ao Slack e que qualquer
pessoa do time visse ao abrir a campanha — no menu "Por mês" ou no
Diagnóstico.

Não confundir com `campaign_comments` (módulo em main.py): aquele é o
chat do REPORT, aberto ao cliente (GET público por short_token). Este
aqui é interno: leitura e escrita exigem JWT admin, e nada aqui entra
no payload do report nem no Portal do Cliente.

Identidade
----------
`author_email` vem SEMPRE do JWT (`sub`) — nunca do body. O cliente só
manda `author_name` como fallback de display (o nome do Google), que é
cosmético: o email é a fonte de verdade de quem escreveu. Isso impede
alguém se passar por outra pessoa na thread.

Escrita via DML (não streaming)
-------------------------------
`insert_rows_json` cairia no streaming buffer, onde UPDATE/DELETE são
rejeitados por ~30min — e editar/apagar a nota que você acabou de
escrever é justamente o caso comum. Volume é baixíssimo (dezenas por
dia), então DML INSERT + UPDATE (soft delete) é a escolha certa aqui.

Tabela
------
`{PROJECT_ID}.{DATASET_ASSETS}.campaign_notes`:
    note_id      STRING    NOT NULL  -- UUID
    short_token  STRING    NOT NULL  -- campanha alvo
    author_email STRING    NOT NULL  -- do JWT, autoritativo
    author_name  STRING              -- display denormalizado (fallback)
    body         STRING    NOT NULL  -- texto da nota
    created_at   TIMESTAMP NOT NULL
    updated_at   TIMESTAMP           -- setado em edição
    deleted      BOOL                -- soft delete (thread preserva ordem)

Particionada por DATE(created_at) e clusterizada por short_token —
a leitura típica é "todas as notas de um token".
"""

import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Optional

from google.cloud import bigquery

logger = logging.getLogger(__name__)

bq = bigquery.Client()

PROJECT_ID     = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET_ASSETS = "prod_assets"
TABLE_NOTES    = "campaign_notes"

# Limites de sanitização. Nota é registro operacional curto, não documento.
MAX_BODY_LEN   = 4000
MAX_NAME_LEN   = 80
MAX_NOTES_READ = 300
MAX_TOKENS_BATCH = 500
# Snippet da última nota que vai pro tooltip do badge no card.
SNIPPET_LEN    = 140

_table_ensured = False
_ensure_lock = threading.Lock()


def _notes_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.{TABLE_NOTES}"


def ensure_table_exists() -> None:
    """Cria campaign_notes se não existir. Idempotente, cached por instância."""
    global _table_ensured
    if _table_ensured:
        return
    with _ensure_lock:
        if _table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_notes_table_id()}` (
                note_id      STRING    NOT NULL,
                short_token  STRING    NOT NULL,
                author_email STRING    NOT NULL,
                author_name  STRING,
                body         STRING    NOT NULL,
                created_at   TIMESTAMP NOT NULL,
                updated_at   TIMESTAMP,
                deleted      BOOL
            )
            PARTITION BY DATE(created_at)
            CLUSTER BY short_token
        """
        bq.query(sql).result()
        _table_ensured = True


def sanitize_body(raw) -> str:
    """Normaliza o texto da nota. Devolve "" quando não sobra conteúdo."""
    if not isinstance(raw, str):
        return ""
    # Normaliza CRLF e colapsa sequências absurdas de linha em branco —
    # o textarea do front deixa o admin colar qualquer coisa.
    body = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
    while "\n\n\n" in body:
        body = body.replace("\n\n\n", "\n\n")
    return body[:MAX_BODY_LEN]


def _sanitize_name(raw) -> Optional[str]:
    if not isinstance(raw, str):
        return None
    name = " ".join(raw.split())[:MAX_NAME_LEN]
    return name or None


def _row_to_note(r) -> dict:
    return {
        "note_id":      r["note_id"],
        "short_token":  r["short_token"],
        "author_email": r["author_email"],
        "author_name":  r["author_name"],
        "body":         r["body"],
        "created_at":   r["created_at"].isoformat() if r["created_at"] else None,
        "updated_at":   r["updated_at"].isoformat() if r["updated_at"] else None,
    }


def create_note(short_token: str, author_email: str, body: str,
                author_name: Optional[str] = None) -> dict:
    """Insere uma nota e devolve a row criada (pronta pro front renderizar)."""
    ensure_table_exists()

    note_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    name = _sanitize_name(author_name)

    sql = f"""
        INSERT INTO `{_notes_table_id()}`
            (note_id, short_token, author_email, author_name, body, created_at, deleted)
        VALUES (@note_id, @token, @email, @name, @body, @created_at, FALSE)
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("note_id",    "STRING",    note_id),
            bigquery.ScalarQueryParameter("token",      "STRING",    short_token),
            bigquery.ScalarQueryParameter("email",      "STRING",    author_email),
            bigquery.ScalarQueryParameter("name",       "STRING",    name),
            bigquery.ScalarQueryParameter("body",       "STRING",    body),
            bigquery.ScalarQueryParameter("created_at", "TIMESTAMP", now.isoformat()),
        ]
    )
    bq.query(sql, job_config=job_config).result()

    return {
        "note_id":      note_id,
        "short_token":  short_token,
        "author_email": author_email,
        "author_name":  name,
        "body":         body,
        "created_at":   now.isoformat(),
        "updated_at":   None,
    }


def update_note(note_id: str, author_email: str, body: str) -> bool:
    """Edita o texto de uma nota. Só o autor pode editar a própria nota.

    Returns True quando alguma row foi afetada (nota existe, é do autor e
    não está apagada) — False quando não (o handler devolve 404/403).
    """
    ensure_table_exists()
    sql = f"""
        UPDATE `{_notes_table_id()}`
        SET body = @body, updated_at = @now
        WHERE note_id = @note_id
          AND author_email = @email
          AND NOT COALESCE(deleted, FALSE)
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("body",    "STRING",    body),
            bigquery.ScalarQueryParameter("now",     "TIMESTAMP", datetime.now(timezone.utc).isoformat()),
            bigquery.ScalarQueryParameter("note_id", "STRING",    note_id),
            bigquery.ScalarQueryParameter("email",   "STRING",    author_email),
        ]
    )
    job = bq.query(sql, job_config=job_config)
    job.result()
    return (job.num_dml_affected_rows or 0) > 0


def delete_note(note_id: str, author_email: str) -> bool:
    """Soft delete. Só o autor apaga a própria nota."""
    ensure_table_exists()
    sql = f"""
        UPDATE `{_notes_table_id()}`
        SET deleted = TRUE, updated_at = @now
        WHERE note_id = @note_id
          AND author_email = @email
          AND NOT COALESCE(deleted, FALSE)
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("now",     "TIMESTAMP", datetime.now(timezone.utc).isoformat()),
            bigquery.ScalarQueryParameter("note_id", "STRING",    note_id),
            bigquery.ScalarQueryParameter("email",   "STRING",    author_email),
        ]
    )
    job = bq.query(sql, job_config=job_config)
    job.result()
    return (job.num_dml_affected_rows or 0) > 0


def list_notes(short_token: str, limit: int = MAX_NOTES_READ) -> list[dict]:
    """Thread completa de um token, ordem cronológica (mais antiga primeiro).

    Ordem ascendente porque a UI é um chat: o composer fica embaixo, a nota
    mais recente logo acima dele.
    """
    ensure_table_exists()
    sql = f"""
        SELECT note_id, short_token, author_email, author_name, body,
               created_at, updated_at
        FROM `{_notes_table_id()}`
        WHERE short_token = @token
          AND NOT COALESCE(deleted, FALSE)
        ORDER BY created_at ASC
        LIMIT @limit
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
            bigquery.ScalarQueryParameter("limit", "INT64", max(1, min(limit, MAX_NOTES_READ))),
        ]
    )
    rows = bq.query(sql, job_config=job_config).result()
    return [_row_to_note(r) for r in rows]


def summary_batch(tokens: list[str]) -> dict:
    """Contagem + última nota por token, pra o indicador nos cards do menu.

    Resposta: { short_token: {count, last_at, last_author_email,
                              last_author_name, last_snippet} }.
    Tokens sem nota simplesmente não aparecem no dict (o front trata
    ausência como zero).
    """
    clean = list({t.strip() for t in (tokens or []) if isinstance(t, str) and t.strip()})
    clean = clean[:MAX_TOKENS_BATCH]
    if not clean:
        return {}

    ensure_table_exists()
    sql = f"""
        WITH live AS (
            SELECT short_token, author_email, author_name, body, created_at
            FROM `{_notes_table_id()}`
            WHERE short_token IN UNNEST(@tokens)
              AND NOT COALESCE(deleted, FALSE)
        )
        SELECT
            short_token,
            COUNT(*) AS note_count,
            MAX(created_at) AS last_at,
            -- ARRAY_AGG(STRUCT ORDER BY ... LIMIT 1) é o jeito canônico de
            -- pegar "a última row do grupo" sem window function extra.
            ARRAY_AGG(
                STRUCT(author_email, author_name, body)
                ORDER BY created_at DESC LIMIT 1
            )[SAFE_OFFSET(0)] AS last
        FROM live
        GROUP BY short_token
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ArrayQueryParameter("tokens", "STRING", clean),
        ]
    )
    out = {}
    for r in bq.query(sql, job_config=job_config).result():
        last = r["last"] or {}
        body = last.get("body") or ""
        snippet = " ".join(body.split())[:SNIPPET_LEN]
        out[r["short_token"]] = {
            "count":             int(r["note_count"] or 0),
            "last_at":           r["last_at"].isoformat() if r["last_at"] else None,
            "last_author_email": last.get("author_email"),
            "last_author_name":  last.get("author_name"),
            "last_snippet":      snippet,
        }
    return out
