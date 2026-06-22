"""
Audit log — registro imutável de ações admin sobre um report.

Contexto
--------
Cada mutation que o admin faz num report (anexar Loom, trocar owner,
agrupar tokens, pausar campanha, etc.) é registrada aqui com timestamp,
ator e payload. Alimenta o "Log de mudanças (admin)" no
ReportAnalyticsModal e qualquer auditoria futura.

Estratégia
----------
Streaming inserts (`insert_rows_json`) em vez de DML INSERT pra escalar
sem cair em quotas. Cada write é fire-and-forget do ponto de vista da
mutation original — se o audit log falhar, a mutation original NÃO
falha (`safe_write_event` engole exceção e loga). Trade-off explícito:
preferimos perder um evento de auditoria a quebrar uma ação operacional.

Backfill
--------
Entries históricas (anteriores ao deploy do tracking) entram com
`synthetic=true`. O frontend marca essas linhas com "(retroativo)"
discreto pra admin saber que o timestamp é estimado, não preciso.

Tabela
------
`{PROJECT_ID}.{DATASET_ASSETS}.report_audit_log`:
    event_id     STRING  NOT NULL  -- UUID, idempotência de retry
    short_token  STRING  NOT NULL  -- campanha alvo
    actor_email  STRING            -- quem fez (NULL pra synthetic/sistema)
    event_type   STRING  NOT NULL  -- loom_added | owner_changed | ...
    message      STRING            -- denormalizado pra display direto
    payload      JSON              -- dados type-specific
    synthetic    BOOL              -- true se veio de backfill
    created_at   TIMESTAMP NOT NULL

Particionada por DATE(created_at) e clusterizada por short_token —
leitura típica filtra "últimos 30d de um token" e ambos os critérios
batem com o partition pruning + cluster scan.
"""

import json
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
TABLE_AUDIT    = "report_audit_log"

_table_ensured = False
_ensure_lock = threading.Lock()


def _audit_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.{TABLE_AUDIT}"


def ensure_table_exists() -> None:
    """Cria report_audit_log se não existir. Idempotente, cached por instância."""
    global _table_ensured
    if _table_ensured:
        return
    with _ensure_lock:
        if _table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_audit_table_id()}` (
                event_id     STRING    NOT NULL,
                short_token  STRING    NOT NULL,
                actor_email  STRING,
                event_type   STRING    NOT NULL,
                message      STRING,
                payload      JSON,
                synthetic    BOOL,
                created_at   TIMESTAMP NOT NULL
            )
            PARTITION BY DATE(created_at)
            CLUSTER BY short_token
        """
        bq.query(sql).result()
        _table_ensured = True


# Whitelist de event_types aceitos — protege contra typo silencioso que
# faria o frontend não conseguir mapear ícone/cor. Adicionar tipo novo
# aqui antes de usar em qualquer mutation.
ALLOWED_EVENT_TYPES = frozenset({
    "loom_added", "loom_replaced", "loom_removed",
    "survey_created", "survey_updated", "survey_removed",
    "logo_changed",
    "owner_changed",
    "merge_linked", "merge_unlinked",
    "campaign_closed", "campaign_reopened",
    "campaign_paused", "campaign_resumed",
    "campaign_early_ended", "campaign_early_end_reverted",
    "abs_toggled",
    "rmnd_uploaded", "pdooh_uploaded",
    "alcance_frequencia_saved",
    "comment_saved",
    "alias_saved",
    "audience_override_saved", "audience_override_deleted",
    "label_override_saved", "label_override_deleted",
})


def write_event(
    short_token: str,
    event_type: str,
    *,
    actor_email: Optional[str] = None,
    message: Optional[str] = None,
    payload: Optional[dict] = None,
    synthetic: bool = False,
    when: Optional[datetime] = None,
) -> Optional[str]:
    """Insere uma row de auditoria.

    Args:
        short_token: alvo da ação. Required.
        event_type: tipo da ação. Required, deve estar em ALLOWED_EVENT_TYPES.
        actor_email: email do admin que fez a ação. NULL pra ações sistema.
        message: texto humano denormalizado ("subiu CSV do Amazon Ads").
            Opcional — frontend tem fallback por event_type.
        payload: dict type-specific, serializado como JSON.
        synthetic: True quando a entry vem de backfill (timestamp estimado).
        when: timestamp do evento. Default = NOW(). Backfill passa
            o tempo estimado da ação original.

    Returns:
        event_id (UUID) se gravado, None em caso de falha.
    """
    if not short_token:
        logger.warning("[audit_log] write_event chamado sem short_token, ignorando")
        return None
    if event_type not in ALLOWED_EVENT_TYPES:
        logger.warning(f"[audit_log] event_type não whitelisted: {event_type}")
        return None

    ensure_table_exists()

    event_id = str(uuid.uuid4())
    ts = when or datetime.now(timezone.utc)
    row = {
        "event_id":    event_id,
        "short_token": short_token,
        "actor_email": actor_email,
        "event_type":  event_type,
        "message":     message,
        # Coluna do tipo JSON exige string serializada via streaming insert
        # (`insert_rows_json` trata dict como RECORD/STRUCT e BQ rejeita
        # com "This field: payload is not a record"). json.dumps resolve.
        "payload":     json.dumps(payload) if payload is not None else None,
        "synthetic":   bool(synthetic),
        # ISO 8601 com timezone — formato canônico do BQ
        "created_at":  ts.isoformat(),
    }
    errors = bq.insert_rows_json(_audit_table_id(), [row])
    if errors:
        logger.error(f"[audit_log] streaming insert errors: {errors}")
        return None
    return event_id


def safe_write_event(*args, **kwargs) -> None:
    """Wrapper que NUNCA propaga exceção.

    Usado pelas mutations em main.py — auditoria é cosmética relativa à
    ação principal. Falha aqui não pode fazer um "save_loom" 500ar.
    """
    try:
        write_event(*args, **kwargs)
    except Exception as e:
        logger.error(f"[audit_log] safe_write_event silenciou: {e}")


def query_recent_events(short_token: str, limit: int = 50) -> list[dict]:
    """Retorna os últimos N eventos de um short_token, mais recente primeiro.

    Usado pelo endpoint GET ?action=report_audit_log. Filtra somente o
    token alvo — particionamento + cluster fazem essa consulta ser barata
    independente do volume total da tabela.
    """
    ensure_table_exists()
    sql = f"""
        SELECT
            event_id,
            actor_email,
            event_type,
            message,
            TO_JSON_STRING(payload) AS payload_json,
            COALESCE(synthetic, FALSE) AS synthetic,
            created_at
        FROM `{_audit_table_id()}`
        WHERE short_token = @token
        ORDER BY created_at DESC
        LIMIT @limit
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
            bigquery.ScalarQueryParameter("limit", "INT64", limit),
        ]
    )
    rows = bq.query(sql, job_config=job_config).result()
    out = []
    for r in rows:
        out.append({
            "event_id":    r["event_id"],
            "actor_email": r["actor_email"],
            "event_type":  r["event_type"],
            "message":     r["message"],
            "payload":     r["payload_json"],  # frontend faz JSON.parse se quiser
            "synthetic":   r["synthetic"],
            # ISO 8601 — frontend parseia com new Date()
            "created_at":  r["created_at"].isoformat() if r["created_at"] else None,
        })
    return out
