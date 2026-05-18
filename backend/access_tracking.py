"""
Access tracking — eventos crus de acesso ao report compartilhado +
agregações que alimentam o ReportAnalyticsModal.

Arquitetura
-----------
Duas tabelas:

1. `report_access_events` — raw events (streaming inserts). Cada
   pageview/heartbeat/tab_change/session_end vira uma row. Particionada
   por DATE(created_at) com retention de 90 dias (depois disso só o
   rollup sobrevive).

2. `report_access_daily` — rollup por (short_token, day). Alimentada
   por scheduled query em backend/sql/access_daily_rollup.sql que roda
   1x/dia agregando o dia anterior. Modal sempre lê daqui pra não
   escanear events crus.

Anti-abuse
----------
O endpoint público (POST track_access) NÃO tem JWT. Defesas:
  - validate_short_token rejeita tokens que não existem em
    campaign_share_ids (lixo é silenciosamente ignorado)
  - is_blocked_bot filtra unfurlers (Slackbot/WhatsApp/Telegram) por UA
  - rate_limit_check derruba IP-hashes acima do teto
  - rejeitar timestamps absurdos (>5min de drift do server clock)

Privacidade
-----------
IP é hasheado com salt antes de gravar. User-agent é parsed pra
device_family (Desktop|Mobile|Tablet) e descartado — não armazenamos UA
cru. Sem cookies, sem fingerprint canvas. LGPD-friendly por design.

Admin tracking
--------------
Hook frontend NÃO dispara eventos quando isAdmin=true. Backend faz
double-check via ip_internal_allowlist (opcional) — qualquer evento que
escape do filtro frontend ainda é marcado is_internal=true e sai do
default view.
"""

import hashlib
import hmac
import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from google.cloud import bigquery

logger = logging.getLogger(__name__)

bq = bigquery.Client()

PROJECT_ID         = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET_ASSETS     = "prod_assets"
TABLE_EVENTS       = "report_access_events"
TABLE_DAILY        = "report_access_daily"
TABLE_SHARES       = "campaign_share_ids"

# Salt do IP hash — variável de ambiente. Em prod, configurar no Cloud
# Function via Secret Manager. Default só pra dev local não quebrar.
IP_HASH_SALT = os.environ.get("ACCESS_TRACKING_IP_SALT", "dev-only-do-not-use-in-prod")

# Janela permitida pra drift de timestamp do client. Eventos com
# created_at fora desta janela são rejeitados (provável replay/abuso).
TIMESTAMP_DRIFT_TOLERANCE = timedelta(minutes=5)

# Retention dos events crus. Rollup sobrevive indefinidamente. Configurada
# diretamente no CREATE TABLE via partition_expiration_days.
EVENTS_RETENTION_DAYS = 90

# Rate limit em memória — quota POR INSTÂNCIA do Cloud Function. Como
# Cloud Functions escalam horizontalmente, esse limite é generoso (é
# multiplicado pelo número de instâncias warm). Suficiente pra puxar o
# tapete de loops óbvios sem prejudicar usuários legítimos.
RATE_LIMIT_WINDOW_SEC = 60
RATE_LIMIT_MAX_EVENTS = 200
_rate_limit_state: dict[str, list[float]] = {}
_rate_limit_lock = threading.Lock()

# Bot/preview unfurlers comuns. Match por substring case-insensitive no
# user-agent cru. Defesa secundária ao filtro JS-required do frontend.
_BOT_UA_PATTERNS = (
    "slackbot", "whatsapp", "telegrambot", "linkedinbot", "twitterbot",
    "facebookexternalhit", "discordbot", "skypeuripreview", "googlebot",
    "bingbot", "yandexbot", "duckduckbot", "applebot", "preview",
)

_table_ensured = False
_ensure_lock = threading.Lock()


# ─── Table refs ─────────────────────────────────────────────────────────

def _events_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.{TABLE_EVENTS}"


def _events_table_ref() -> str:
    return f"`{_events_table_id()}`"


def _daily_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.{TABLE_DAILY}"


def _daily_table_ref() -> str:
    return f"`{_daily_table_id()}`"


def _shares_table_ref() -> str:
    return f"`{PROJECT_ID}.{DATASET_ASSETS}.{TABLE_SHARES}`"


# ─── Schema setup ───────────────────────────────────────────────────────

def ensure_tables_exist() -> None:
    """Cria events + daily rollup se não existirem. Idempotente."""
    global _table_ensured
    if _table_ensured:
        return
    with _ensure_lock:
        if _table_ensured:
            return
        # Events — particionada com expiração de 90d. Cluster por token
        # (queries sempre filtram por 1 token) + session_id (drill-down).
        bq.query(f"""
            CREATE TABLE IF NOT EXISTS {_events_table_ref()} (
                event_id      STRING    NOT NULL,
                short_token   STRING    NOT NULL,
                share_id      STRING,
                session_id    STRING    NOT NULL,
                event_type    STRING    NOT NULL,
                tab_id        STRING,
                prev_tab_id   STRING,
                device_family STRING,
                ip_hash       STRING,
                is_internal   BOOL,
                duration_ms   INT64,
                viewport_w    INT64,
                viewport_h    INT64,
                referrer_host STRING,
                created_at    TIMESTAMP NOT NULL
            )
            PARTITION BY DATE(created_at)
            CLUSTER BY short_token, session_id
            OPTIONS(
                partition_expiration_days={EVENTS_RETENTION_DAYS},
                description="Raw access events from public report dashboards. Retention 90d. See backend/access_tracking.py."
            )
        """).result()

        # Daily rollup — populada por scheduled query (sql/access_daily_rollup.sql).
        # Sem expiração; cresce devagar (1 row por (token, dia)).
        bq.query(f"""
            CREATE TABLE IF NOT EXISTS {_daily_table_ref()} (
                short_token        STRING NOT NULL,
                day                DATE   NOT NULL,
                total_pageviews    INT64,
                unique_sessions    INT64,
                internal_sessions  INT64,
                external_sessions  INT64,
                avg_duration_sec   FLOAT64,
                top_tabs           JSON,
                devices            JSON,
                hour_histogram     JSON,
                computed_at        TIMESTAMP
            )
            PARTITION BY day
            CLUSTER BY short_token
            OPTIONS(
                description="Daily rollup of report access events. Populated by scheduled query."
            )
        """).result()
        _table_ensured = True


# ─── Helpers de normalização ────────────────────────────────────────────

def hash_ip(raw_ip: str) -> str:
    """HMAC-SHA256(IP, salt) → primeiros 16 hex (~64 bits).

    Suficiente pra distinguir sessões; insuficiente pra reverter o IP
    original. Sem o salt do ambiente, o hash é inerte pra correlação
    cross-database.
    """
    if not raw_ip:
        return ""
    digest = hmac.new(
        IP_HASH_SALT.encode("utf-8"),
        raw_ip.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return digest[:16]


def device_family_from_ua(ua: str) -> str:
    """Mapeia user-agent pra Desktop|Mobile|Tablet. Heurística simples.

    Não armazenamos UA cru — só essa classificação. Padrão tablet ANTES
    de mobile porque iPads carregam "Mobile" no UA mas são tablets.
    """
    if not ua:
        return "Unknown"
    lower = ua.lower()
    if "ipad" in lower or "tablet" in lower:
        return "Tablet"
    if "mobile" in lower or "android" in lower or "iphone" in lower:
        return "Mobile"
    return "Desktop"


def is_blocked_bot(ua: str) -> bool:
    """True se UA bate algum unfurler/crawler conhecido."""
    if not ua:
        return False
    lower = ua.lower()
    return any(pat in lower for pat in _BOT_UA_PATTERNS)


def extract_referrer_host(referrer: str) -> Optional[str]:
    """Apenas o host, sem path/query — privacidade + utilidade.

    "https://mail.google.com/u/0/?ogbl#inbox" → "mail.google.com"
    """
    if not referrer:
        return None
    m = re.match(r"https?://([^/?#]+)", referrer)
    return m.group(1).lower() if m else None


def validate_short_token(short_token: str) -> bool:
    """True se o token existe em campaign_share_ids.

    Cache em memória de 5min — endpoint público pode receber rajadas pro
    mesmo token, sem cache cada request seria 1 query BQ.
    """
    if not short_token:
        return False
    return _token_in_shares_table(short_token)


_token_cache: dict[str, tuple[bool, float]] = {}
_token_cache_lock = threading.Lock()
_TOKEN_CACHE_TTL_SEC = 300


def _token_in_shares_table(short_token: str) -> bool:
    now = time.time()
    with _token_cache_lock:
        cached = _token_cache.get(short_token)
        if cached and (now - cached[1]) < _TOKEN_CACHE_TTL_SEC:
            return cached[0]
    sql = f"""
        SELECT 1 FROM {_shares_table_ref()}
        WHERE short_token = @token
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    rows = list(bq.query(sql, job_config=job_config).result())
    exists = len(rows) > 0
    with _token_cache_lock:
        _token_cache[short_token] = (exists, now)
    return exists


def rate_limit_check(ip_hash: str) -> bool:
    """True se o IP-hash está dentro do limite. False derruba o request.

    Sliding window in-memory. Limite por instância do Cloud Function —
    escala horizontalmente com warm pool, o que é OK porque o objetivo
    é puxar tapete de loops óbvios, não rate-limit fino.

    Memory: a cada chamada, expira eventos antigos da própria key E
    purga TODA key cuja janela ficou vazia. Sem isso o dict cresce
    monotônicamente com cada IP novo (Cloud Function instance warm dura
    horas — vira leak detectável). O purge é O(1) amortizado: roda só
    quando a key chamada ficou vazia.
    """
    if not ip_hash:
        return True
    now = time.time()
    cutoff = now - RATE_LIMIT_WINDOW_SEC
    with _rate_limit_lock:
        events = _rate_limit_state.setdefault(ip_hash, [])
        # Compacta janela da key atual
        while events and events[0] < cutoff:
            events.pop(0)
        if len(events) >= RATE_LIMIT_MAX_EVENTS:
            return False
        events.append(now)
        # Garbage collect oportunístico: a cada ~100 inserts, varre o
        # dict inteiro e remove keys cuja janela esvaziou. Caro em CPU
        # (O(N)) mas raro (1 a cada 100 hits da própria key).
        if len(events) % 100 == 1 and len(_rate_limit_state) > 1000:
            stale_keys = [k for k, v in _rate_limit_state.items() if not v or v[-1] < cutoff]
            for k in stale_keys:
                _rate_limit_state.pop(k, None)
    return True


def validate_timestamp(client_ts_str: Optional[str]) -> Optional[datetime]:
    """Aceita ISO 8601 do client, rejeita se for fora da janela de drift.

    Sem timestamp ou com drift inaceitável, retorna NOW() — confiamos
    no relógio do server.
    """
    if not client_ts_str:
        return datetime.now(timezone.utc)
    try:
        # Aceita "2026-05-18T12:34:56Z" e "2026-05-18T12:34:56+00:00"
        client_ts = datetime.fromisoformat(client_ts_str.replace("Z", "+00:00"))
        if client_ts.tzinfo is None:
            client_ts = client_ts.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return datetime.now(timezone.utc)
    now = datetime.now(timezone.utc)
    drift = abs(client_ts - now)
    if drift > TIMESTAMP_DRIFT_TOLERANCE:
        return now
    return client_ts


# Whitelist de event_types aceitos do client. Nomes sincronizados com
# o hook useReportTracking no frontend.
ALLOWED_EVENT_TYPES = frozenset({
    "pageview",      # render inicial do dashboard
    "heartbeat",     # tick a cada 60s enquanto a aba está visível
    "tab_change",    # admin/cliente trocou de aba dentro do report
    "session_end",   # último evento (sendBeacon em pagehide)
})


# ─── Ingestão ───────────────────────────────────────────────────────────

def write_event(
    *,
    short_token: str,
    share_id: Optional[str],
    session_id: str,
    event_type: str,
    event_id: Optional[str] = None,
    tab_id: Optional[str] = None,
    prev_tab_id: Optional[str] = None,
    device_family: Optional[str] = None,
    ip_hash: Optional[str] = None,
    is_internal: bool = False,
    duration_ms: Optional[int] = None,
    viewport_w: Optional[int] = None,
    viewport_h: Optional[int] = None,
    referrer_host: Optional[str] = None,
    when: Optional[datetime] = None,
) -> Optional[str]:
    """Insere 1 row em report_access_events via streaming insert.

    Caller é responsável por já ter validado short_token, bot UA e
    rate limit — esta função NÃO refaz essas checagens.

    event_id: se vier do client (caller passou), é reusado — habilita
    dedupe REAL de retry no rollup (ROW_NUMBER PARTITION BY event_id).
    Sem isso, cada retry vira row extra. Se ausente, gera server-side.

    Retorna event_id ou None em caso de falha. Falhas são logadas mas
    NÃO propagadas — o endpoint público devolve 200 mesmo em falha pra
    não vazar info pra atacante.
    """
    if not short_token or not session_id:
        return None
    if event_type not in ALLOWED_EVENT_TYPES:
        logger.warning(f"[access_tracking] event_type inválido: {event_type}")
        return None

    ensure_tables_exist()

    # Aceita event_id do client (idempotência de retry). Validação leve:
    # tem que ser string razoável (UUID-like). Lixo cai pra novo UUID.
    if event_id and isinstance(event_id, str) and 8 <= len(event_id) <= 64:
        pass  # reusa o do client
    else:
        event_id = str(uuid.uuid4())
    ts = when or datetime.now(timezone.utc)
    row = {
        "event_id":      event_id,
        "short_token":   short_token,
        "share_id":      share_id,
        "session_id":    session_id,
        "event_type":    event_type,
        "tab_id":        tab_id,
        "prev_tab_id":   prev_tab_id,
        "device_family": device_family,
        "ip_hash":       ip_hash,
        "is_internal":   bool(is_internal),
        "duration_ms":   int(duration_ms) if duration_ms is not None else None,
        "viewport_w":    int(viewport_w)  if viewport_w  is not None else None,
        "viewport_h":    int(viewport_h)  if viewport_h  is not None else None,
        "referrer_host": referrer_host,
        "created_at":    ts.isoformat(),
    }
    errors = bq.insert_rows_json(_events_table_id(), [row])
    if errors:
        logger.error(f"[access_tracking] streaming insert errors: {errors}")
        return None
    return event_id


def safe_write_event(**kwargs) -> None:
    """Wrapper que engole exceção. Usado pelo endpoint público — degraded
    analytics é melhor que 500 vazando."""
    try:
        write_event(**kwargs)
    except Exception as e:
        logger.error(f"[access_tracking] safe_write_event silenciou: {e}")


# ─── Agregações pro modal ───────────────────────────────────────────────

def query_summary_batch(short_tokens: list[str], range_days: int = 30) -> dict[str, dict]:
    """Versão batched do query_summary pro menu admin.

    Recebe lista de tokens, devolve { token: {total_pageviews,
    unique_sessions, last_access_at, range_days} }. Single query agrupada
    por token — barato mesmo com 300 tokens, pois lê só do rollup (uma
    linha por token×dia, cluster por token).

    Tokens sem nenhum evento no período aparecem no resultado com zeros
    pra simplificar o caller (não precisa checar "key in result").
    """
    ensure_tables_exist()
    if not short_tokens:
        return {}
    # Híbrido raw+daily, agora batched por N tokens. Dias passados vêm
    # do rollup; dia atual é live agg dos events. Soma os dois e retorna
    # um summary por token.
    sql = f"""
        WITH daily_per_token AS (
            -- Dias passados (excluindo hoje pra não duplicar com today)
            SELECT
                short_token,
                SUM(total_pageviews) AS total_pageviews,
                SUM(external_sessions) AS unique_sessions,
                MAX(day) AS last_day
            FROM {_daily_table_ref()}
            WHERE short_token IN UNNEST(@tokens)
              AND day >= DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL @range DAY)
              AND day < CURRENT_DATE("America/Sao_Paulo")
            GROUP BY short_token
        ),
        today_sessions AS (
            SELECT
                short_token,
                session_id,
                COALESCE(MAX(is_internal), FALSE) AS is_internal
            FROM {_events_table_ref()}
            WHERE short_token IN UNNEST(@tokens)
              AND DATE(created_at, "America/Sao_Paulo") = CURRENT_DATE("America/Sao_Paulo")
            GROUP BY short_token, session_id
        ),
        today_pageviews AS (
            SELECT short_token, COUNT(*) AS total_pageviews
            FROM {_events_table_ref()}
            WHERE short_token IN UNNEST(@tokens)
              AND event_type = 'pageview'
              AND DATE(created_at, "America/Sao_Paulo") = CURRENT_DATE("America/Sao_Paulo")
              AND COALESCE(is_internal, FALSE) = FALSE
            GROUP BY short_token
        ),
        today_per_token AS (
            SELECT
                ts.short_token,
                COALESCE(tp.total_pageviews, 0) AS total_pageviews,
                COUNTIF(NOT ts.is_internal) AS unique_sessions
            FROM today_sessions ts
            LEFT JOIN today_pageviews tp USING(short_token)
            GROUP BY ts.short_token, tp.total_pageviews
        ),
        combined AS (
            SELECT
                COALESCE(d.short_token, t.short_token) AS short_token,
                COALESCE(d.total_pageviews, 0) + COALESCE(t.total_pageviews, 0) AS total_pageviews,
                COALESCE(d.unique_sessions, 0) + COALESCE(t.unique_sessions, 0) AS unique_sessions,
                IF(COALESCE(t.unique_sessions, 0) > 0,
                   CURRENT_DATE("America/Sao_Paulo"),
                   d.last_day) AS last_day
            FROM daily_per_token d
            FULL OUTER JOIN today_per_token t USING(short_token)
        ),
        last_access AS (
            -- Último timestamp granular pra cada token — pega o MAX de
            -- events do dia mais recente que tem dado (today se há, ou
            -- last_day do rollup). Cluster por short_token + filtro por
            -- partition deixa essa query cheap.
            SELECT
                e.short_token,
                MAX(e.created_at) AS last_at
            FROM {_events_table_ref()} e
            JOIN combined c USING(short_token)
            WHERE DATE(e.created_at, "America/Sao_Paulo") = c.last_day
              AND COALESCE(e.is_internal, FALSE) = FALSE
            GROUP BY e.short_token
        )
        SELECT c.short_token, c.total_pageviews, c.unique_sessions, l.last_at
        FROM combined c
        LEFT JOIN last_access l USING(short_token)
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ArrayQueryParameter("tokens", "STRING", short_tokens),
            bigquery.ScalarQueryParameter("range", "INT64", range_days),
        ]
    )
    result: dict[str, dict] = {}
    for r in bq.query(sql, job_config=job_config).result():
        result[r["short_token"]] = {
            "total_pageviews": int(r["total_pageviews"] or 0),
            "unique_sessions": int(r["unique_sessions"] or 0),
            "last_access_at":  r["last_at"].isoformat() if r["last_at"] else None,
            "range_days":      range_days,
        }
    # Preenche zeros pra tokens sem dado no período — caller não precisa
    # checar "in result"
    for t in short_tokens:
        if t not in result:
            result[t] = {
                "total_pageviews": 0,
                "unique_sessions": 0,
                "last_access_at":  None,
                "range_days":      range_days,
            }
    return result


def query_summary(short_token: str, range_days: int = 30, include_internal: bool = False) -> dict:
    """Resumo agregado pro card de acessos no menu admin + KPIs do modal.

    Híbrido raw+daily: dias passados vêm do rollup (`report_access_daily`),
    dia atual vem dos events crus (`report_access_events`). Garante
    latência segundo-real pra eventos do dia, sem custo significativo —
    o range do dia atual é pequeno e o cluster por short_token deixa o
    scan cheap.

    Retorna { total_pageviews, unique_sessions, avg_duration_sec,
    last_access_at, range_days }.
    """
    ensure_tables_exist()
    field_sessions = "unique_sessions" if include_internal else "external_sessions"
    today_session_filter = "TRUE" if include_internal else "NOT is_internal"
    today_pageview_filter = "" if include_internal else "AND COALESCE(is_internal, FALSE) = FALSE"

    sql = f"""
        WITH daily_agg AS (
            -- Dias passados: lê do rollup. Exclui CURRENT_DATE pra não
            -- duplicar com today_agg (mesmo dia em ambas as fontes).
            SELECT
                COALESCE(SUM(total_pageviews), 0) AS total_pageviews,
                COALESCE(SUM({field_sessions}), 0) AS unique_sessions,
                COALESCE(SUM(avg_duration_sec * {field_sessions}), 0) AS sum_weighted_dur,
                MAX(day) AS last_day
            FROM {_daily_table_ref()}
            WHERE short_token = @token
              AND day >= DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL @range DAY)
              AND day < CURRENT_DATE("America/Sao_Paulo")
        ),
        today_sessions AS (
            SELECT
                session_id,
                COALESCE(MAX(is_internal), FALSE) AS is_internal,
                LEAST(4 * 3600, COUNTIF(event_type = 'heartbeat') * 60 + 30) AS active_duration_sec
            FROM {_events_table_ref()}
            WHERE short_token = @token
              AND DATE(created_at, "America/Sao_Paulo") = CURRENT_DATE("America/Sao_Paulo")
            GROUP BY session_id
        ),
        today_agg AS (
            SELECT
                (SELECT COUNT(*) FROM {_events_table_ref()}
                 WHERE short_token = @token
                   AND event_type = 'pageview'
                   AND DATE(created_at, "America/Sao_Paulo") = CURRENT_DATE("America/Sao_Paulo")
                   {today_pageview_filter}
                ) AS total_pageviews,
                COUNTIF({today_session_filter}) AS unique_sessions,
                SUM(IF({today_session_filter}, active_duration_sec, 0)) AS sum_weighted_dur
            FROM today_sessions
        )
        SELECT
            d.total_pageviews + t.total_pageviews AS total_pageviews,
            d.unique_sessions + t.unique_sessions AS unique_sessions,
            SAFE_DIVIDE(
                d.sum_weighted_dur + t.sum_weighted_dur,
                NULLIF(d.unique_sessions + t.unique_sessions, 0)
            ) AS avg_duration_sec,
            IF(t.unique_sessions > 0, CURRENT_DATE("America/Sao_Paulo"), d.last_day) AS last_day
        FROM daily_agg d CROSS JOIN today_agg t
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
            bigquery.ScalarQueryParameter("range", "INT64", range_days),
        ]
    )
    row = next(iter(bq.query(sql, job_config=job_config).result()), None)

    # last_access_at: granularidade hora/min, vem de events crus do
    # dia mais recente que tem dado. Quando hoje tem evento, busca em
    # CURRENT_DATE; senão usa o last_day do rollup.
    last_access_at = None
    if row and row["last_day"]:
        last_sql = f"""
            SELECT MAX(created_at) AS last_at
            FROM {_events_table_ref()}
            WHERE short_token = @token
              AND DATE(created_at, "America/Sao_Paulo") = @day
              AND (@include_internal OR COALESCE(is_internal, FALSE) = FALSE)
        """
        last_job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("token", "STRING", short_token),
                bigquery.ScalarQueryParameter("day", "DATE", row["last_day"]),
                bigquery.ScalarQueryParameter("include_internal", "BOOL", include_internal),
            ]
        )
        last_row = next(iter(bq.query(last_sql, job_config=last_job_config).result()), None)
        if last_row and last_row["last_at"]:
            last_access_at = last_row["last_at"].isoformat()

    return {
        "total_pageviews":  int(row["total_pageviews"]) if row else 0,
        "unique_sessions":  int(row["unique_sessions"]) if row else 0,
        "avg_duration_sec": float(row["avg_duration_sec"]) if row and row["avg_duration_sec"] is not None else 0.0,
        "last_access_at":   last_access_at,
        "range_days":       range_days,
    }


def query_timeline(short_token: str, range_days: int = 30, include_internal: bool = False) -> list[dict]:
    """Série diária pro chart 'Acessos ao longo do tempo'.

    Retorna list[{ day, accesses, sessions }] preenchida pra TODOS os
    dias da janela (inclusive dias com 0). Garante a faixa contínua que
    o sparkline espera.
    """
    ensure_tables_exist()
    sessions_field = "unique_sessions" if include_internal else "external_sessions"
    today_session_filter = "TRUE" if include_internal else "NOT is_internal"
    today_pageview_filter = "" if include_internal else "AND COALESCE(is_internal, FALSE) = FALSE"
    # Híbrido raw+daily: pros dias passados, rollup. Pro dia atual,
    # agregação live de events. ATENÇÃO: nomes de CTE não podem ser
    # palavras reservadas (rollup, window) — ver fix em query_summary.
    sql = f"""
        WITH days AS (
            SELECT day FROM UNNEST(
                GENERATE_DATE_ARRAY(
                    DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL @range - 1 DAY),
                    CURRENT_DATE("America/Sao_Paulo")
                )
            ) AS day
        ),
        daily_data AS (
            SELECT day, total_pageviews, {sessions_field} AS sessions
            FROM {_daily_table_ref()}
            WHERE short_token = @token
              AND day >= DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL @range - 1 DAY)
              AND day < CURRENT_DATE("America/Sao_Paulo")
        ),
        today_sessions AS (
            SELECT session_id, COALESCE(MAX(is_internal), FALSE) AS is_internal
            FROM {_events_table_ref()}
            WHERE short_token = @token
              AND DATE(created_at, "America/Sao_Paulo") = CURRENT_DATE("America/Sao_Paulo")
            GROUP BY session_id
        ),
        today_data AS (
            SELECT
                CURRENT_DATE("America/Sao_Paulo") AS day,
                (SELECT COUNT(*) FROM {_events_table_ref()}
                 WHERE short_token = @token AND event_type = 'pageview'
                   AND DATE(created_at, "America/Sao_Paulo") = CURRENT_DATE("America/Sao_Paulo")
                   {today_pageview_filter}
                ) AS total_pageviews,
                COUNTIF({today_session_filter}) AS sessions
            FROM today_sessions
        )
        SELECT
            days.day AS day,
            COALESCE(daily_data.total_pageviews, today_data.total_pageviews, 0) AS accesses,
            COALESCE(daily_data.sessions, today_data.sessions, 0) AS sessions
        FROM days
        LEFT JOIN daily_data USING(day)
        LEFT JOIN today_data USING(day)
        ORDER BY day ASC
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
            bigquery.ScalarQueryParameter("range", "INT64", range_days),
        ]
    )
    rows = bq.query(sql, job_config=job_config).result()
    return [
        {
            "day":      r["day"].isoformat(),
            "accesses": int(r["accesses"]),
            "sessions": int(r["sessions"]),
        }
        for r in rows
    ]


def query_tabs_breakdown(short_token: str, range_days: int = 30, include_internal: bool = False) -> list[dict]:
    """Ranking de abas mais acessadas no período. Lê events crus —
    rollup só guarda top_tabs do dia, mas pra mostrar todos somando
    precisamos varrer eventos. Mantemos barato via cluster por token."""
    ensure_tables_exist()
    sql = f"""
        SELECT
            tab_id,
            COUNT(*) AS views
        FROM {_events_table_ref()}
        WHERE short_token = @token
          AND event_type IN ('pageview', 'tab_change')
          AND tab_id IS NOT NULL
          AND DATE(created_at, "America/Sao_Paulo") >= DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL @range - 1 DAY)
          AND (@include_internal OR COALESCE(is_internal, FALSE) = FALSE)
        GROUP BY tab_id
        ORDER BY views DESC
        LIMIT 10
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
            bigquery.ScalarQueryParameter("range", "INT64", range_days),
            bigquery.ScalarQueryParameter("include_internal", "BOOL", include_internal),
        ]
    )
    rows = bq.query(sql, job_config=job_config).result()
    return [{"tab_id": r["tab_id"], "views": int(r["views"])} for r in rows]


def query_devices_breakdown(short_token: str, range_days: int = 30, include_internal: bool = False) -> list[dict]:
    """Distribuição por device_family. Soma sessões únicas (não pageviews
    — múltiplas pageviews da mesma sessão não contam como múltiplos
    devices)."""
    ensure_tables_exist()
    sql = f"""
        SELECT
            COALESCE(device_family, 'Unknown') AS device_family,
            COUNT(DISTINCT session_id) AS sessions
        FROM {_events_table_ref()}
        WHERE short_token = @token
          AND DATE(created_at, "America/Sao_Paulo") >= DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL @range - 1 DAY)
          AND (@include_internal OR COALESCE(is_internal, FALSE) = FALSE)
        GROUP BY device_family
        ORDER BY sessions DESC
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
            bigquery.ScalarQueryParameter("range", "INT64", range_days),
            bigquery.ScalarQueryParameter("include_internal", "BOOL", include_internal),
        ]
    )
    rows = bq.query(sql, job_config=job_config).result()
    total = 0
    raw = []
    for r in rows:
        s = int(r["sessions"])
        total += s
        raw.append((r["device_family"], s))
    if total == 0:
        return []
    return [{"device_family": name, "sessions": s, "share": s / total} for name, s in raw]


def query_heatmap(short_token: str, range_days: int = 30, include_internal: bool = False) -> list[list[int]]:
    """Heatmap dia-da-semana × hora (7×24). Quantil-normalizado client-side
    pelo modal. Backend só agrega o COUNT.

    Convenção: linha 0 = Segunda, linha 6 = Domingo (ISO weekday-1).
    """
    ensure_tables_exist()
    sql = f"""
        SELECT
            -- BQ EXTRACT(DAYOFWEEK) = 1..7 (1=Sun). Subtraindo 1 e usando
            -- MOD pra alinhar com convenção ISO (0=Seg, 6=Dom).
            MOD(EXTRACT(DAYOFWEEK FROM created_at AT TIME ZONE "America/Sao_Paulo") + 5, 7) AS weekday_idx,
            EXTRACT(HOUR FROM created_at AT TIME ZONE "America/Sao_Paulo") AS hour_idx,
            COUNT(*) AS events
        FROM {_events_table_ref()}
        WHERE short_token = @token
          AND event_type IN ('pageview', 'heartbeat', 'tab_change')
          AND DATE(created_at, "America/Sao_Paulo") >= DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL @range - 1 DAY)
          AND (@include_internal OR COALESCE(is_internal, FALSE) = FALSE)
        GROUP BY weekday_idx, hour_idx
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
            bigquery.ScalarQueryParameter("range", "INT64", range_days),
            bigquery.ScalarQueryParameter("include_internal", "BOOL", include_internal),
        ]
    )
    grid = [[0] * 24 for _ in range(7)]
    for r in bq.query(sql, job_config=job_config).result():
        wd = int(r["weekday_idx"])
        hr = int(r["hour_idx"])
        if 0 <= wd < 7 and 0 <= hr < 24:
            grid[wd][hr] = int(r["events"])
    return grid


def query_recent_sessions(short_token: str, limit: int = 8, include_internal: bool = False) -> list[dict]:
    """Últimas N sessões com duração ATIVA e abas visitadas.

    Duração ativa = nº de heartbeats × 60s + 30s baseline (cap 4h). NÃO
    usa duration_ms cru do client porque ele infla quando a aba fica
    aberta idle (heartbeat só dispara visível, mas duration_ms é
    Date.now - startedAt). Vide comentário no rollup SQL.
    """
    ensure_tables_exist()
    sql = f"""
        WITH session_agg AS (
            SELECT
                session_id,
                ANY_VALUE(device_family) AS device_family,
                COALESCE(MAX(is_internal), FALSE) AS is_internal,
                MIN(created_at) AS started_at,
                MAX(created_at) AS last_at,
                LEAST(
                    4 * 3600,
                    COUNTIF(event_type = 'heartbeat') * 60 + 30
                ) AS active_duration_sec,
                ARRAY_AGG(DISTINCT tab_id IGNORE NULLS) AS tabs
            FROM {_events_table_ref()}
            WHERE short_token = @token
              AND DATE(created_at, "America/Sao_Paulo") >= DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL 30 DAY)
            GROUP BY session_id
        )
        SELECT *
        FROM session_agg
        WHERE @include_internal OR is_internal = FALSE
        ORDER BY last_at DESC
        LIMIT @limit
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
            bigquery.ScalarQueryParameter("limit", "INT64", limit),
            bigquery.ScalarQueryParameter("include_internal", "BOOL", include_internal),
        ]
    )
    rows = bq.query(sql, job_config=job_config).result()
    out = []
    for r in rows:
        out.append({
            "session_id":    r["session_id"],
            "device_family": r["device_family"] or "Unknown",
            "is_internal":   bool(r["is_internal"]),
            "last_at":       r["last_at"].isoformat() if r["last_at"] else None,
            "duration_sec":  int(r["active_duration_sec"]) if r["active_duration_sec"] is not None else 0,
            "tabs":          list(r["tabs"]) if r["tabs"] else [],
        })
    return out


def query_tracking_start_date() -> Optional[str]:
    """Data do primeiro evento jamais registrado. Alimenta o disclaimer
    'Tracking iniciado em DD/MM' enquanto a base é nova.

    Cache simples — esse valor só muda 1x na história. Re-checa depois
    de 1h só por garantia.
    """
    ensure_tables_exist()
    cached = _tracking_start_cache.get("value")
    cached_at = _tracking_start_cache.get("at", 0)
    if cached and (time.time() - cached_at) < 3600:
        return cached
    sql = f"""
        SELECT MIN(DATE(created_at, "America/Sao_Paulo")) AS first_day
        FROM {_events_table_ref()}
    """
    row = next(iter(bq.query(sql).result()), None)
    if not row or not row["first_day"]:
        return None
    iso = row["first_day"].isoformat()
    _tracking_start_cache["value"] = iso
    _tracking_start_cache["at"] = time.time()
    return iso


_tracking_start_cache: dict = {}
