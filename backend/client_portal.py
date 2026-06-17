"""
backend/client_portal.py

Portal do Cliente — dashboard central client-facing por cliente.

Um link compartilhado (`/c/<share_id>`) onde o cliente externo (PicPay,
Kenvue…) vê TODAS as campanhas que rodou com a HYPR, agregadas, com quebra
por mês / por campanha e acesso aos reports individuais.

Decisões (definidas com o time)
────────────────────────────────
• Acesso = link opaco + senha (share_id ~96 bits, senha definida pelo admin).
• Campanhas = curadas pelo admin (toggle "publicar" por campanha — nada vaza
  por acidente, nenhuma campanha nova aparece sem revisão).
• Dados = ao vivo, gated. Agregamos sobre o MESMO cache de campanhas que o
  menu admin usa (`query_campaigns_list`, TTL existente) — custo BQ zero além
  do que já roda. Nenhuma query nova.

REGRA DE OURO — nada de dado interno HYPR
─────────────────────────────────────────
O `build_portal_payload` usa **whitelist explícita** de campos (não blacklist).
Assim, se amanhã alguém adicionar um campo `admin_*` novo em
`query_campaigns_list`, ele NÃO vaza pro cliente por descuido — só passa o que
está explicitamente listado aqui. Campos proibidos: qualquer custo real
(admin_total_cost / admin_ecpm / *_admin_*), margem, rentabilidade, tech cost,
monthly_cost_full.

Tabelas (prod_assets)
─────────────────────
`client_portal_config` — 1 linha por cliente:
    client_slug    STRING NOT NULL  -- chave (slug normalizado de clients.py)
    share_id       STRING NOT NULL  -- vai na URL pública (/c/<share_id>)
    password_hash  STRING           -- pbkdf2_sha256$iter$salt$hash (ver _hash)
    display_name   STRING           -- nome exibido (override do agregado)
    logo_base64    STRING           -- data-URL da logo do cliente (co-brand)
    accent_color   STRING           -- cor de marca (#RRGGBB) — re-tematiza
    active         BOOL             -- portal ligado/desligado
    created_by     STRING
    created_at     TIMESTAMP
    updated_at     TIMESTAMP

`client_portal_campaigns` — curadoria (1 linha por campanha publicada):
    client_slug   STRING NOT NULL
    short_token   STRING NOT NULL
    published     BOOL
    published_by  STRING
    published_at  TIMESTAMP

Ambas criadas idempotentemente via `ensure_tables_exist` (CREATE IF NOT EXISTS),
chamado em todo acesso. Custo: zero quando já existem (flag por instância).
"""

import hashlib
import hmac
import logging
import os
import secrets
import threading
from collections import Counter

from google.cloud import bigquery

from clients import normalize_client_slug

logger = logging.getLogger(__name__)

bq = bigquery.Client()

PROJECT_ID            = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET_ASSETS        = "prod_assets"
TABLE_CONFIG          = "client_portal_config"
TABLE_CAMPAIGNS       = "client_portal_campaigns"

# PBKDF2 — stdlib, sem dependência extra (mesma filosofia do auth.py/HMAC).
# 120k iterações: ~50ms por verificação, custo aceitável num caminho raro
# (resolve roda 1x por unlock de cliente, depois o front cacheia).
_PBKDF2_ITER = 120_000

_tables_ensured = False
_ensure_lock = threading.Lock()


def _config_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.{TABLE_CONFIG}"


def _campaigns_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.{TABLE_CAMPAIGNS}"


def ensure_tables_exist() -> None:
    """Cria as duas tabelas do portal se ainda não existirem. Idempotente."""
    global _tables_ensured
    if _tables_ensured:
        return
    with _ensure_lock:
        if _tables_ensured:
            return
        bq.query(f"""
            CREATE TABLE IF NOT EXISTS `{_config_table_id()}` (
                client_slug    STRING NOT NULL,
                share_id       STRING NOT NULL,
                password_hash  STRING,
                password_plain STRING,
                display_name   STRING,
                logo_base64    STRING,
                accent_color   STRING,
                active         BOOL,
                created_by     STRING,
                created_at     TIMESTAMP,
                updated_at     TIMESTAMP
            )
        """).result()
        # Coluna password_plain: guarda a senha em texto pra o admin exibir e
        # repassar ao cliente (é um código de acesso compartilhado, não uma
        # credencial de conta). Admin-only — NUNCA sai no payload público.
        # ADD IF NOT EXISTS cobre tabelas criadas antes desta coluna existir.
        bq.query(f"""
            ALTER TABLE `{_config_table_id()}`
            ADD COLUMN IF NOT EXISTS password_plain STRING
        """).result()
        bq.query(f"""
            CREATE TABLE IF NOT EXISTS `{_campaigns_table_id()}` (
                client_slug   STRING NOT NULL,
                short_token   STRING NOT NULL,
                published     BOOL,
                published_by  STRING,
                published_at  TIMESTAMP
            )
        """).result()
        _tables_ensured = True


# ─── Senha (pbkdf2_sha256) ─────────────────────────────────────────────────────
def _hash_password(password: str) -> str:
    """Deriva `pbkdf2_sha256$<iter>$<salt_hex>$<hash_hex>`."""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITER)
    return f"pbkdf2_sha256${_PBKDF2_ITER}${salt.hex()}${dk.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    """Compara senha em texto com o hash armazenado (constant-time)."""
    if not password or not stored:
        return False
    try:
        algo, iter_s, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iter_s)
        )
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def _generate_share_id() -> str:
    """16 chars URL-safe, ~96 bits — mesmo padrão de shares.py."""
    return secrets.token_urlsafe(12)


# ─── Config CRUD ───────────────────────────────────────────────────────────────
def _row_to_config(row, *, include_secret=False) -> dict:
    """Serializa uma linha de config. NUNCA inclui password_hash no payload
    público — `include_secret` só pra uso interno (verificação de senha)."""
    plain = None
    try:
        plain = row["password_plain"]
    except (KeyError, IndexError):
        plain = None
    out = {
        "slug":         row["client_slug"],
        "share_id":     row["share_id"],
        "display_name": row["display_name"],
        "logo_base64":  row["logo_base64"],
        "accent_color": row["accent_color"],
        "active":       bool(row["active"]) if row["active"] is not None else False,
        "has_password": bool(row["password_hash"] or plain),
        "created_by":   row["created_by"],
        "created_at":   str(row["created_at"]) if row["created_at"] else None,
        "updated_at":   str(row["updated_at"]) if row["updated_at"] else None,
    }
    if include_secret:
        out["_password_hash"] = row["password_hash"]
        out["_password_plain"] = plain
    return out


def get_config(slug: str, *, include_secret=False) -> dict | None:
    """Config do cliente por slug, ou None."""
    ensure_tables_exist()
    slug = normalize_client_slug(slug)
    if not slug:
        return None
    sql = f"""
        SELECT * FROM `{_config_table_id()}`
        WHERE client_slug = @slug
        LIMIT 1
    """
    jc = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("slug", "STRING", slug)]
    )
    rows = list(bq.query(sql, job_config=jc).result())
    return _row_to_config(rows[0], include_secret=include_secret) if rows else None


def get_config_by_share_id(share_id: str, *, include_secret=False) -> dict | None:
    """Config por share_id (case-sensitive — base64url). Caminho público."""
    ensure_tables_exist()
    if not share_id:
        return None
    sql = f"""
        SELECT * FROM `{_config_table_id()}`
        WHERE share_id = @sid
        LIMIT 1
    """
    jc = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("sid", "STRING", share_id)]
    )
    rows = list(bq.query(sql, job_config=jc).result())
    return _row_to_config(rows[0], include_secret=include_secret) if rows else None


def save_config(slug: str, *, password=None, display_name=None, logo_base64=None,
                accent_color=None, active=None, updated_by=None) -> dict:
    """Upsert da config. Cria share_id na primeira vez. Campos None não são
    tocados (preserva o valor atual) — exceto `active`, que é explícito.

    Retorna a config (sem o hash de senha).
    """
    ensure_tables_exist()
    slug = normalize_client_slug(slug)
    if not slug:
        raise ValueError("slug inválido")

    existing = get_config(slug, include_secret=True)
    share_id = existing["share_id"] if existing else _generate_share_id()
    pw_hash = existing.get("_password_hash") if existing else None
    pw_plain = None
    if password:
        password = password.strip()
        pw_hash = _hash_password(password)
        pw_plain = password

    # MERGE pra upsert atômico. Campos None caem no COALESCE (preserva atual).
    sql = f"""
        MERGE `{_config_table_id()}` T
        USING (SELECT @slug AS client_slug) S
        ON T.client_slug = S.client_slug
        WHEN MATCHED THEN UPDATE SET
            password_hash  = COALESCE(@pw_hash, T.password_hash),
            password_plain = COALESCE(@pw_plain, T.password_plain),
            display_name   = COALESCE(@display_name, T.display_name),
            logo_base64    = COALESCE(@logo_base64, T.logo_base64),
            accent_color   = COALESCE(@accent_color, T.accent_color),
            active         = COALESCE(@active, T.active),
            updated_at     = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT
            (client_slug, share_id, password_hash, password_plain, display_name,
             logo_base64, accent_color, active, created_by, created_at, updated_at)
        VALUES
            (@slug, @share_id, @pw_hash, @pw_plain, @display_name, @logo_base64,
             @accent_color, COALESCE(@active, FALSE), @updated_by,
             CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())
    """
    params = [
        bigquery.ScalarQueryParameter("slug",         "STRING", slug),
        bigquery.ScalarQueryParameter("share_id",     "STRING", share_id),
        bigquery.ScalarQueryParameter("pw_hash",      "STRING", pw_hash),
        bigquery.ScalarQueryParameter("pw_plain",     "STRING", pw_plain),
        bigquery.ScalarQueryParameter("display_name", "STRING", display_name),
        bigquery.ScalarQueryParameter("logo_base64",  "STRING", logo_base64),
        bigquery.ScalarQueryParameter("accent_color", "STRING", accent_color),
        bigquery.ScalarQueryParameter("active",       "BOOL",   active),
        bigquery.ScalarQueryParameter("updated_by",   "STRING", updated_by),
    ]
    bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    return get_config(slug)


def verify_share_password(share_id: str, password: str) -> str | None:
    """Resolve (share_id, senha) → slug se a senha bate E o portal está ativo.
    Senão None. Caminho público (resolve_client_share)."""
    cfg = get_config_by_share_id(share_id, include_secret=True)
    if not cfg or not cfg.get("active"):
        return None
    pw = (password or "").strip()
    # 1) Senha configurada (texto novo, ou hash de linhas antigas).
    plain = cfg.get("_password_plain")
    if plain and hmac.compare_digest(pw, plain.strip()):
        return cfg["slug"]
    if not plain and cfg.get("_password_hash") and _verify_password(pw, cfg["_password_hash"]):
        return cfg["slug"]
    # 2) Conveniência (igual aos reports): o short_token de QUALQUER campanha
    #    publicada do cliente também abre o portal. Facilita o acesso quando o
    #    cliente já tem em mãos o código de um report.
    published = get_published_tokens(cfg["slug"])
    if pw.upper() in published:
        return cfg["slug"]
    return None


# ─── Curadoria (publish) ───────────────────────────────────────────────────────
def set_publish(slug: str, short_token: str, published: bool, *, by=None) -> None:
    """Liga/desliga a publicação de uma campanha no portal do cliente."""
    ensure_tables_exist()
    slug = normalize_client_slug(slug)
    if not slug or not short_token:
        raise ValueError("slug e short_token são obrigatórios")
    sql = f"""
        MERGE `{_campaigns_table_id()}` T
        USING (SELECT @slug AS client_slug, @token AS short_token) S
        ON T.client_slug = S.client_slug AND UPPER(T.short_token) = UPPER(S.short_token)
        WHEN MATCHED THEN UPDATE SET
            published = @published, published_by = @by, published_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT
            (client_slug, short_token, published, published_by, published_at)
        VALUES (@slug, @token, @published, @by, CURRENT_TIMESTAMP())
    """
    params = [
        bigquery.ScalarQueryParameter("slug",      "STRING", slug),
        bigquery.ScalarQueryParameter("token",     "STRING", short_token),
        bigquery.ScalarQueryParameter("published", "BOOL",   bool(published)),
        bigquery.ScalarQueryParameter("by",        "STRING", by),
    ]
    bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()


def get_published_tokens(slug: str) -> set[str]:
    """Set de short_tokens (UPPER) publicados pro cliente."""
    ensure_tables_exist()
    slug = normalize_client_slug(slug)
    if not slug:
        return set()
    sql = f"""
        SELECT short_token FROM `{_campaigns_table_id()}`
        WHERE client_slug = @slug AND published = TRUE
    """
    jc = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("slug", "STRING", slug)]
    )
    rows = list(bq.query(sql, job_config=jc).result())
    return {r["short_token"].upper() for r in rows if r["short_token"]}


def get_publish_map(slug: str) -> dict[str, bool]:
    """Mapa {short_token_upper: published} — pra o admin renderizar os toggles
    (inclui linhas published=FALSE explícitas, distinto de 'nunca tocado')."""
    ensure_tables_exist()
    slug = normalize_client_slug(slug)
    if not slug:
        return {}
    sql = f"""
        SELECT short_token, published FROM `{_campaigns_table_id()}`
        WHERE client_slug = @slug
    """
    jc = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("slug", "STRING", slug)]
    )
    rows = list(bq.query(sql, job_config=jc).result())
    return {r["short_token"].upper(): bool(r["published"]) for r in rows if r["short_token"]}


# ─── Serializer client-safe (WHITELIST) ────────────────────────────────────────
def _derive_tactics(entry: dict) -> list:
    """Core products ativados, derivados da presença dos pacings por tática."""
    out = []
    if entry.get("display_pacing_o2o") is not None or entry.get("video_pacing_o2o") is not None:
        out.append("O2O")
    if entry.get("display_pacing_ooh") is not None or entry.get("video_pacing_ooh") is not None:
        out.append("OOH")
    if (entry.get("display_pacing_groundflow") is not None
            or entry.get("video_pacing_groundflow") is not None):
        out.append("GROUNDFLOW")
    return out


def _combined_pacing(entry: dict):
    """Pacing geral = média dos pacings de display/vídeo presentes."""
    parts = [p for p in (entry.get("display_pacing"), entry.get("video_pacing")) if p is not None]
    return round(sum(parts) / len(parts)) if parts else None


def _safe_campaign(entry: dict, share_id_map: dict, logos_map: dict = None,
                   elements_map: dict = None) -> dict:
    """Converte uma entry de query_campaigns_list no formato client-safe do
    portal. WHITELIST: só os campos abaixo saem. Combina display+video nos
    totais que o cliente enxerga; calcula CTR/VTR agregados; deriva `media`.

    Nunca emite: admin_total_cost, admin_ecpm, *_admin_*, monthly_cost_full,
    client_delivered_value (faturável é leitura interna), pacing por frente.
    """
    d_vi   = int(entry.get("display_viewable_impressions", 0) or 0)
    v_vi   = int(entry.get("video_viewable_impressions",   0) or 0)
    d_clk  = int(entry.get("display_clicks",               0) or 0)
    v_clk  = int(entry.get("video_clicks",                 0) or 0)
    v_comp = int(entry.get("video_viewable_completions",   0) or 0)
    d_bud  = float(entry.get("d_client_budget", 0) or 0)
    v_bud  = float(entry.get("v_client_budget", 0) or 0)

    impressions = d_vi + v_vi
    clicks      = d_clk + v_clk
    # CTR agregado = cliques / impressões visíveis (Σnum/Σdenom, não média de razões).
    ctr = round(clicks / impressions * 100, 2) if impressions > 0 else None
    # VTR já vem como razão do backend (viewable completions / viewable impr de vídeo).
    vtr = entry.get("video_vtr")

    media = []
    if d_vi > 0 or d_bud > 0:
        media.append("DISPLAY")
    if v_vi > 0 or v_bud > 0:
        media.append("VIDEO")

    token = entry.get("short_token")
    token_key = (token or "").upper()
    logos_map = logos_map or {}
    elements = (elements_map or {}).get(token) or {}
    assets = elements.get("assets") or []
    features = [f for f in ("survey", "rmnd", "pdooh") if f in assets]
    return {
        "short_token":         token,
        "pacing":              _combined_pacing(entry),
        # Pacing por mídia (client-safe — % de entrega vs contratado, mesmo
        # nível do pacing combinado que o cliente já vê). Alimenta o gráfico
        # de pacing médio mensal Display × Vídeo no Analytics do portal.
        "display_pacing":      entry.get("display_pacing"),
        "video_pacing":        entry.get("video_pacing"),
        "tactics":             _derive_tactics(entry),
        "features":            features,
        "aggregated":          bool(entry.get("merge_id")),
        "merge_id":            entry.get("merge_id") or None,
        # share_id do report individual (link "Ver relatório"). Fallback no
        # próprio short_token (a rota /report/<short_token> legacy funciona).
        "share_id":            share_id_map.get(token_key) or share_id_map.get(token) or token,
        # Logo PRÓPRIA da campanha (data-URL), se houver. O front cai na
        # co-brand do cliente quando ausente.
        "logo_base64":         logos_map.get(token_key),
        "campaign_name":       entry.get("campaign_name"),
        "start_date":          entry.get("start_date"),
        "end_date":            entry.get("end_date"),
        "d_client_budget":     d_bud or None,
        "v_client_budget":     v_bud or None,
        "viewable_impressions": impressions or None,
        "clicks":              clicks or None,
        "completions":         v_comp or None,
        "ctr":                 ctr,
        "vtr":                 vtr,
        "media":               media,
    }


def build_portal_payload(config: dict, campaigns: list, published_tokens: set,
                         share_id_map: dict, logos_map: dict = None,
                         elements_map: dict = None) -> dict:
    """Monta o payload final do portal a partir da lista de campanhas (já
    cacheada) filtrando pelas publicadas e reserializando client-safe.

    `config` é a config do cliente (sem segredo); `campaigns` é o resultado de
    query_campaigns_list; `published_tokens` é o set de tokens curados;
    `share_id_map` é {short_token: report_share_id} pros links.
    """
    slug = config["slug"]
    safe = []
    name_counter = Counter()
    for c in campaigns:
        token = (c.get("short_token") or "").upper()
        if token not in published_tokens:
            continue
        if normalize_client_slug(c.get("client_name", "")) != slug:
            continue
        cn = (c.get("client_name") or "").strip()
        if cn:
            name_counter[cn] += 1
        safe.append(_safe_campaign(c, share_id_map, logos_map, elements_map))

    # Ordena por start_date desc (mais recente primeiro) — o front reordena
    # por mês/nome conforme o filtro, mas a ordem default importa.
    safe.sort(key=lambda x: (x.get("start_date") or ""), reverse=True)

    # display_name: o que o admin definiu, senão o client_name real mais
    # frequente das campanhas (evita o slug "Jlr" feio — usa "JLR").
    display_name = config.get("display_name")
    if not display_name and name_counter:
        display_name = name_counter.most_common(1)[0][0]

    return {
        "client": {
            "slug":         config["slug"],
            "display_name": display_name,
            "logo_base64":  config.get("logo_base64"),
            "accent_color": config.get("accent_color"),
        },
        "campaigns": safe,
    }
