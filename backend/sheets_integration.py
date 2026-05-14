"""
Google Sheets integration for HYPR Report Center.

Modelo de operação
------------------
- Apenas membros @hypr.mobi (admins) podem ativar a integração.
- Quando um admin clica "Conectar Google Sheets" no frontend, ele autoriza
  via OAuth (authorization code flow) com a própria conta. O Google nos
  devolve um `refresh_token` que armazenamos criptografado via Cloud KMS.
- Com esse refresh_token, o backend consegue agir como aquele membro pra
  criar a sheet no Drive pessoal dele e sincronizar os dados diariamente.
- A sheet vive no Drive do membro que ativou. Ele compartilha manualmente
  com o cliente (mesmo fluxo que ele usa hoje pra qualquer planilha).
- Sync para automaticamente 30 dias após `end_date` da campanha. A sheet
  permanece acessível no Drive do membro indefinidamente.

Por que SA não foi usada
------------------------
Service accounts não têm quota de storage no Drive desde 2025 — qualquer
tentativa de criar arquivo retorna 403 storageQuotaExceeded. As alternativas
oficiais do Google são (a) Shared Drives (Workspace Business+, requer admin),
ou (b) OAuth de usuário humano. Como a HYPR não tem acesso ao Workspace
admin pra criar Shared Drive, usamos (b).

Por que KMS pra refresh_token
-----------------------------
Refresh token é credencial sensível: quem o tem age como aquele usuário
no escopo `drive.file`. Não pode viver em texto claro no BigQuery.
Usamos Cloud KMS pra envelope encryption — chave gerenciada pelo Google,
rotação automática anual, audit log completo. Custo trivial (~$0.06/mês).

Schema da tabela
----------------
`{PROJECT_ID}.{DATASET_ASSETS}.sheets_integrations`:
    short_token        STRING NOT NULL  -- target_id (column name é histórico —
                                          quando target_type='token' guarda o
                                          short_token da campanha; quando
                                          target_type='merge' guarda o merge_id)
    target_type        STRING           -- 'token' | 'merge' (default 'token'
                                          via backfill — coluna adicionada
                                          em PR-merge-sheets)
    spreadsheet_id     STRING           -- id da sheet criada
    spreadsheet_url    STRING           -- url pra abrir
    created_by_email   STRING           -- membro HYPR que ativou
    refresh_token_enc  BYTES            -- KMS-encrypted refresh_token
    created_at         TIMESTAMP
    last_synced_at     TIMESTAMP        -- timestamp da última sync com SUCESSO
    last_attempt_at    TIMESTAMP        -- timestamp da última TENTATIVA de sync
                                          (gravado ANTES de processar a row).
                                          Permite detectar falha silenciosa:
                                          se last_attempt_at >> last_synced_at,
                                          o cron tentou mas crashou antes de
                                          completar (timeout/OOM/exception
                                          fora do try/except). Sem isso, rows
                                          mortas ficam com status='active' e
                                          UI mente.
    sync_until         DATE             -- end_date + 30 dias (token: do próprio
                                          token; merge: maior end_date do grupo)
    status             STRING           -- active | paused | revoked | error
    last_error         STRING           -- detalhe do último erro de sync

Chave lógica: (target_type, short_token). A coluna `short_token` mantém o
nome por compat — funcionalmente é o "target_id". Pra um cliente, podem
existir simultaneamente:
  - 1 row (target_type='merge', short_token=<merge_id>)         → sheet do agregado
  - N rows (target_type='token', short_token=<short_token_X>)   → 1 sheet por mês

Tabela criada idempotentemente via `ensure_table_exists` na primeira
chamada de qualquer endpoint de sheets.
"""

import logging
import os
import json
import time
import threading
import urllib.request
import urllib.parse
import urllib.error
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

from google.cloud import bigquery
from google.cloud import kms
from google.auth import default as google_auth_default
from googleapiclient.discovery import build as build_google_api
from googleapiclient.errors import HttpError
from google.oauth2.credentials import Credentials


logger = logging.getLogger(__name__)


# ─── Config ──────────────────────────────────────────────────────────────────
PROJECT_ID     = os.environ.get("GCP_PROJECT", "site-hypr")
# Dataset onde a tabela de integrações fica.
# IMPORTANTE: precisa ser um dataset REGIONAL na mesma região da Cloud
# Function (southamerica-east1). Multi-region (US/EU) tem lag entre
# DML INSERT e visibility nas DML UPDATE/DELETE — rows ficam em
# streaming buffer por até 90min, fazendo "deletar agora" falhar com
# "would affect rows in the streaming buffer".
#
# `prod_prod_hypr_reporthub` é southamerica-east1 (mesmo da campaign_results).
# Histórico: a tabela viveu em `prod_assets` (US multi-region) por engano
# antes de PR-fix-soft-delete-region.
DATASET_ASSETS = os.environ.get("SHEETS_DATASET", "prod_prod_hypr_reporthub")
TABLE_NAME     = "sheets_integrations"

# OAuth Client ID — mesmo já usado pro login admin no frontend.
# Client secret precisa estar disponível como envvar (configurado no
# deploy.sh — capturado da revisão atual igual JWT_SECRET).
GOOGLE_OAUTH_CLIENT_ID     = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
GOOGLE_OAUTH_CLIENT_SECRET = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")

# KMS key pra encrypt/decrypt do refresh_token.
# Localização: southamerica-east1 (mesma região da Cloud Function — latência baixa).
KMS_LOCATION = os.environ.get("KMS_LOCATION", "southamerica-east1")
KMS_KEYRING  = os.environ.get("KMS_KEYRING", "report-center")
KMS_KEY      = os.environ.get("KMS_KEY", "sheets-integration")

# Scope mínimo necessário — cria/edita só arquivos criados por este app.
# Não dá acesso a nada que o usuário tenha de antes.
OAUTH_SCOPE = "https://www.googleapis.com/auth/drive.file"

# Token endpoint do Google — troca de auth code por access/refresh tokens.
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

# Janela após end_date pra continuar sincronizando. Depois disso o sync
# para mas a sheet permanece acessível no Drive do membro.
SYNC_GRACE_DAYS = 30

# ID da pasta compartilhada no Drive HYPR onde as sheets são movidas
# após criação. Vazio = mantém no Meu Drive raiz do membro que ativou.
# Como a sheet é criada via OAuth do membro, ele precisa ter acesso
# de Editor à pasta destino (caso típico: foi ele quem compartilhou).
DRIVE_FOLDER_ID = os.environ.get("SHEETS_DRIVE_FOLDER_ID", "")


# ─── Lazy singletons ─────────────────────────────────────────────────────────
_bq = None
_kms = None

def _bq_client() -> bigquery.Client:
    global _bq
    if _bq is None:
        _bq = bigquery.Client()
    return _bq


def _kms_client() -> kms.KeyManagementServiceClient:
    global _kms
    if _kms is None:
        _kms = kms.KeyManagementServiceClient()
    return _kms


def _kms_key_name() -> str:
    return _kms_client().crypto_key_path(
        PROJECT_ID, KMS_LOCATION, KMS_KEYRING, KMS_KEY,
    )


def _table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.{TABLE_NAME}"


# ─── Table bootstrap (idempotent) ────────────────────────────────────────────
_table_ensured = False
_ensure_lock = threading.Lock()


def ensure_table_exists() -> None:
    """
    Cria a tabela `sheets_integrations` se ainda não existe. Idempotente.
    Chamada antes de qualquer leitura/escrita.

    Migra schema antigo (sem target_type) adicionando a coluna e backfilling
    rows existentes com target_type='token'. ALTER TABLE ADD COLUMN é
    no-op se a coluna já existe (BQ ignora silenciosamente via
    `IF NOT EXISTS`-like behavior usando try/except — BQ DDL não suporta
    a sintaxe `IF NOT EXISTS` em ADD COLUMN ainda).
    """
    global _table_ensured
    if _table_ensured:
        return
    with _ensure_lock:
        if _table_ensured:
            return
        sql = f"""
        CREATE TABLE IF NOT EXISTS `{_table_id()}` (
            short_token        STRING NOT NULL,
            target_type        STRING,
            spreadsheet_id     STRING,
            spreadsheet_url    STRING,
            created_by_email   STRING,
            refresh_token_enc  BYTES,
            created_at         TIMESTAMP,
            last_synced_at     TIMESTAMP,
            last_attempt_at    TIMESTAMP,
            sync_until         DATE,
            status             STRING,
            last_error         STRING
        )
        """
        _bq_client().query(sql).result()
        # Migration: adiciona target_type em tabelas pré-existentes.
        # ADD COLUMN IF NOT EXISTS é suportado em BQ desde 2023.
        try:
            _bq_client().query(
                f"ALTER TABLE `{_table_id()}` ADD COLUMN IF NOT EXISTS target_type STRING"
            ).result()
        except Exception as e:
            logger.warning(f"[WARN ensure_table_exists ADD COLUMN target_type] {e}")
        # Backfill rows legacy onde target_type ficou NULL.
        try:
            _bq_client().query(
                f"UPDATE `{_table_id()}` SET target_type = 'token' WHERE target_type IS NULL"
            ).result()
        except Exception as e:
            logger.warning(f"[WARN ensure_table_exists backfill target_type] {e}")
        # Migration: adiciona last_attempt_at (PR-attempt-tracking).
        # Usado pra detectar sync que tentou e morreu silenciosamente
        # (timeout/OOM/exception não capturada). Sem default — rows
        # legacy ficam com NULL até a próxima tentativa.
        try:
            _bq_client().query(
                f"ALTER TABLE `{_table_id()}` ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMP"
            ).result()
        except Exception as e:
            logger.warning(f"[WARN ensure_table_exists ADD COLUMN last_attempt_at] {e}")
        _table_ensured = True


# ─── KMS encrypt/decrypt ─────────────────────────────────────────────────────
def _encrypt(plaintext: str) -> bytes:
    resp = _kms_client().encrypt(
        request={"name": _kms_key_name(), "plaintext": plaintext.encode("utf-8")},
    )
    return resp.ciphertext


def _decrypt(ciphertext: bytes) -> str:
    resp = _kms_client().decrypt(
        request={"name": _kms_key_name(), "ciphertext": ciphertext},
    )
    return resp.plaintext.decode("utf-8")


# ─── OAuth flow ──────────────────────────────────────────────────────────────
def exchange_code_for_tokens(code: str, redirect_uri: str) -> Dict:
    """
    Troca um authorization code por access_token + refresh_token.

    Frontend abre popup OAuth via Google Identity Services usando
    `google.accounts.oauth2.initCodeClient({ ux_mode: "popup", ... })`,
    captura o `code` e chama o backend via POST com `{code, redirect_uri}`.

    `redirect_uri` no popup mode é literalmente "postmessage" — string
    fixa exigida pelo Google quando usado com `ux_mode: "popup"`.
    """
    if not GOOGLE_OAUTH_CLIENT_ID or not GOOGLE_OAUTH_CLIENT_SECRET:
        raise RuntimeError(
            "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET não configurados. "
            "Veja setup_sheets_integration.sh."
        )
    body = urllib.parse.urlencode({
        "code":          code,
        "client_id":     GOOGLE_OAUTH_CLIENT_ID,
        "client_secret": GOOGLE_OAUTH_CLIENT_SECRET,
        "redirect_uri":  redirect_uri,
        "grant_type":    "authorization_code",
    }).encode("utf-8")
    req = urllib.request.Request(
        GOOGLE_TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OAuth token exchange falhou ({e.code}): {detail}")


def _refresh_access_token(refresh_token: str) -> str:
    """Pega novo access_token a partir do refresh_token salvo."""
    body = urllib.parse.urlencode({
        "client_id":     GOOGLE_OAUTH_CLIENT_ID,
        "client_secret": GOOGLE_OAUTH_CLIENT_SECRET,
        "refresh_token": refresh_token,
        "grant_type":    "refresh_token",
    }).encode("utf-8")
    req = urllib.request.Request(
        GOOGLE_TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["access_token"]
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        # Se refresh_token foi revogado, Google retorna 400 com
        # `invalid_grant`. Sinaliza pra cima pra marcar status=revoked.
        if e.code == 400 and "invalid_grant" in detail:
            raise PermissionError("refresh_token revogado")
        raise RuntimeError(f"refresh_token exchange falhou ({e.code}): {detail}")


def _build_drive_client(access_token: str):
    creds = Credentials(token=access_token)
    return build_google_api("drive", "v3", credentials=creds, cache_discovery=False)


def _build_sheets_client(access_token: str):
    creds = Credentials(token=access_token)
    return build_google_api("sheets", "v4", credentials=creds, cache_discovery=False)


# ─── BigQuery row ops ────────────────────────────────────────────────────────
TARGET_TOKEN = "token"
TARGET_MERGE = "merge"
_VALID_TARGETS = (TARGET_TOKEN, TARGET_MERGE)


def _validate_target_type(target_type: str) -> str:
    if target_type not in _VALID_TARGETS:
        raise ValueError(f"target_type inválido: {target_type!r}. Use 'token' ou 'merge'.")
    return target_type


def get_integration(target_id: str, target_type: str = TARGET_TOKEN) -> Optional[Dict]:
    """Busca a integração ativa de uma target (token ou merge). None se não existe.

    Compat: chamadas antigas com `get_integration(short_token)` continuam
    válidas — default target_type='token' preserva o comportamento original.
    """
    _validate_target_type(target_type)
    ensure_table_exists()
    sql = f"""
    SELECT
        short_token,
        target_type,
        spreadsheet_id,
        spreadsheet_url,
        created_by_email,
        refresh_token_enc,
        created_at,
        last_synced_at,
        last_attempt_at,
        sync_until,
        status,
        last_error
    FROM `{_table_id()}`
    WHERE short_token = @target_id
      AND COALESCE(target_type, 'token') = @target_type
      AND status != 'deleted'
    LIMIT 1
    """
    job = _bq_client().query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("target_id",   "STRING", target_id),
                bigquery.ScalarQueryParameter("target_type", "STRING", target_type),
            ],
        ),
    )
    rows = list(job.result())
    if not rows:
        return None
    r = rows[0]
    return {
        "target_id":        r["short_token"],
        "target_type":      r["target_type"] or TARGET_TOKEN,
        # Alias retrocompat: muitos callers ainda leem "short_token".
        # Pra target_type='merge' isso será o merge_id (consistente com a
        # semântica nova do campo).
        "short_token":      r["short_token"],
        "spreadsheet_id":   r["spreadsheet_id"],
        "spreadsheet_url":  r["spreadsheet_url"],
        "created_by_email": r["created_by_email"],
        "refresh_token_enc": r["refresh_token_enc"],
        "created_at":       r["created_at"],
        "last_synced_at":   r["last_synced_at"],
        "last_attempt_at":  r["last_attempt_at"],
        "sync_until":       r["sync_until"],
        "status":           r["status"],
        "last_error":       r["last_error"],
    }


def _upsert_integration(row: Dict) -> None:
    """
    Upsert via MERGE — atualiza row existente (mesma chave (target_type,
    target_id), qualquer status incluindo 'deleted') ou insere nova. Tudo
    numa única operação DML transacional.

    Por que MERGE em vez de DELETE+INSERT
    -------------------------------------
    DELETE em row recém-criada cai em 'streaming buffer' error mesmo com
    DML INSERT. MERGE evita esse caminho: faz UPDATE in-place se a row
    existe (mesmo se ela está em buffer, o UPDATE não move da posição,
    apenas muda valores).

    Comportamento esperado
    ----------------------
    - Primeira ativação desse target: INSERT
    - Re-ativação após delete: UPDATE (status=deleted → status=active,
      novos tokens, novo spreadsheet_id, etc.)
    - Re-ativação de uma já ativa: UPDATE (rotação de tokens etc.)
    """
    ensure_table_exists()
    refresh_token_enc_bytes = _b64_to_bytes(row["refresh_token_enc"])
    target_type = _validate_target_type(row.get("target_type", TARGET_TOKEN))
    # `target_id` é a string opaca persistida na coluna `short_token`.
    # Aceita tanto a chave nova quanto o legado pra simplificar callsites.
    target_id = row.get("target_id") or row.get("short_token")
    if not target_id:
        raise ValueError("_upsert_integration: target_id é obrigatório")

    sql = f"""
    MERGE INTO `{_table_id()}` T
    USING (
        SELECT
            @target_id          AS short_token,
            @target_type        AS target_type,
            @spreadsheet_id     AS spreadsheet_id,
            @spreadsheet_url    AS spreadsheet_url,
            @created_by_email   AS created_by_email,
            @refresh_token_enc  AS refresh_token_enc,
            @created_at         AS created_at,
            @last_synced_at     AS last_synced_at,
            @sync_until         AS sync_until,
            @status             AS status,
            @last_error         AS last_error
    ) S
    ON T.short_token = S.short_token
       AND COALESCE(T.target_type, 'token') = S.target_type
    WHEN MATCHED THEN UPDATE SET
        target_type        = S.target_type,
        spreadsheet_id     = S.spreadsheet_id,
        spreadsheet_url    = S.spreadsheet_url,
        created_by_email   = S.created_by_email,
        refresh_token_enc  = S.refresh_token_enc,
        created_at         = S.created_at,
        last_synced_at     = S.last_synced_at,
        sync_until         = S.sync_until,
        status             = S.status,
        last_error         = S.last_error
    WHEN NOT MATCHED THEN INSERT (
        short_token, target_type, spreadsheet_id, spreadsheet_url, created_by_email,
        refresh_token_enc, created_at, last_synced_at, sync_until,
        status, last_error
    ) VALUES (
        S.short_token, S.target_type, S.spreadsheet_id, S.spreadsheet_url, S.created_by_email,
        S.refresh_token_enc, S.created_at, S.last_synced_at, S.sync_until,
        S.status, S.last_error
    )
    """

    params = [
        bigquery.ScalarQueryParameter("target_id",         "STRING",    target_id),
        bigquery.ScalarQueryParameter("target_type",       "STRING",    target_type),
        bigquery.ScalarQueryParameter("spreadsheet_id",    "STRING",    row["spreadsheet_id"]),
        bigquery.ScalarQueryParameter("spreadsheet_url",   "STRING",    row["spreadsheet_url"]),
        bigquery.ScalarQueryParameter("created_by_email",  "STRING",    row["created_by_email"]),
        bigquery.ScalarQueryParameter("refresh_token_enc", "BYTES",     refresh_token_enc_bytes),
        bigquery.ScalarQueryParameter("created_at",        "TIMESTAMP", row["created_at"]),
        bigquery.ScalarQueryParameter("last_synced_at",    "TIMESTAMP", row["last_synced_at"]),
        bigquery.ScalarQueryParameter("sync_until",        "DATE",      row["sync_until"]),
        bigquery.ScalarQueryParameter("status",            "STRING",    row["status"]),
        bigquery.ScalarQueryParameter("last_error",        "STRING",    row["last_error"]),
    ]
    _bq_client().query(
        sql,
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    ).result()


def _update_status(
    target_id: str,
    *,
    target_type: str = TARGET_TOKEN,
    status: Optional[str] = None,
    last_synced_at: Optional[datetime] = None,
    last_attempt_at: Optional[datetime] = None,
    last_error: Optional[str] = None,
) -> None:
    """Atualiza apenas campos de status/erro/sync. Não toca refresh_token.

    `last_error=None` no caller significa "não mexer". Pra zerar o erro
    explicitamente (ex.: sync recuperou), passa string vazia "" — convertida
    aqui pra NULL no SQL (BQ aceita STRING NULL).
    """
    _validate_target_type(target_type)
    sets = []
    params = [
        bigquery.ScalarQueryParameter("target_id",   "STRING", target_id),
        bigquery.ScalarQueryParameter("target_type", "STRING", target_type),
    ]
    if status is not None:
        sets.append("status = @status")
        params.append(bigquery.ScalarQueryParameter("status", "STRING", status))
    if last_synced_at is not None:
        sets.append("last_synced_at = @last_synced_at")
        params.append(bigquery.ScalarQueryParameter("last_synced_at", "TIMESTAMP", last_synced_at))
    if last_attempt_at is not None:
        sets.append("last_attempt_at = @last_attempt_at")
        params.append(bigquery.ScalarQueryParameter("last_attempt_at", "TIMESTAMP", last_attempt_at))
    if last_error is not None:
        sets.append("last_error = @last_error")
        params.append(bigquery.ScalarQueryParameter("last_error", "STRING", last_error))
    if not sets:
        return
    sql = (
        f"UPDATE `{_table_id()}` SET {', '.join(sets)} "
        f"WHERE short_token = @target_id "
        f"  AND COALESCE(target_type, 'token') = @target_type"
    )
    _bq_client().query(
        sql,
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    ).result()


def _mark_attempt(target_id: str, target_type: str) -> None:
    """Marca o início de uma tentativa de sync. Chamado ANTES de processar
    a row no loop do cron — antes de qualquer chamada que possa estourar
    timeout/memória.

    Best-effort: se a própria escrita falhar (BQ down), loga e segue. O
    objetivo é rastrear "tentei processar essa row" pro frontend distinguir
    "sync travado" de "sync nem chegou nessa row". Não pode bloquear a
    iteração do cron — se essa update falhar, o sync ainda deve tentar.
    """
    try:
        _update_status(
            target_id,
            target_type=target_type,
            last_attempt_at=datetime.now(timezone.utc),
        )
    except Exception as e:
        logger.warning(f"[WARN _mark_attempt {target_type}/{target_id}] {e}")


def delete_integration(
    target_id: str,
    delete_sheet: bool = False,
    target_type: str = TARGET_TOKEN,
) -> Dict:
    """
    Soft delete: marca status='deleted' em vez de DELETE FROM.

    Se delete_sheet=True, também deleta o arquivo do Drive antes do soft
    delete. Usa o refresh_token salvo pra autenticar — daí a ordem
    matters: deleta no Drive primeiro (precisa do token decifrado),
    depois marca a row.

    Retorna dict com 'sheet_deleted' (bool) indicando se a deleção do
    arquivo no Drive foi efetiva. False quando delete_sheet=False ou
    quando a deleção falhou (best-effort: não bloqueia o soft delete
    da row, pra não deixar integração órfã).

    Por que soft delete
    -------------------
    DELETE/UPDATE em rows recém-INSERT podem cair no erro do streaming
    buffer ("would affect rows in the streaming buffer, which is not
    supported"). Em datasets regionais isso é raro, mas ainda pode
    acontecer em alta concorrência.

    UPDATE numa row 'deleted' não toca a row no buffer (ela já foi
    flushed quando o user clicou). Caso o flush ainda não tenha rolado,
    documentamos que retry resolve. Pra usuário final, o card volta ao
    estado "Conectar" assim que o status é 'deleted', então UX OK.

    A re-criação subsequente (save_integration) usa MERGE — atualiza a
    row existente ao invés de DELETE+INSERT, evitando outro caminho
    pro mesmo erro.
    """
    _validate_target_type(target_type)
    ensure_table_exists()
    sheet_deleted = False

    if delete_sheet:
        # Pega a row antes de marcar como deleted — precisamos do
        # refresh_token e spreadsheet_id pra deletar via Drive API.
        integ = get_integration(target_id, target_type=target_type)
        if integ and integ.get("spreadsheet_id"):
            try:
                refresh_token = _decrypt(integ["refresh_token_enc"])
                access_token  = _refresh_access_token(refresh_token)
                _try_delete_spreadsheet(integ["spreadsheet_id"], access_token)
                sheet_deleted = True
            except Exception as e:
                # Best-effort. Continua o soft delete da row mesmo se a
                # deleção do arquivo falhou (ex.: file já apagado manual,
                # token expirado etc.). Logamos pra investigação.
                logger.warning(f"[WARN delete_integration drive {target_type}/{target_id}] {e}")

    sql = f"""
    UPDATE `{_table_id()}`
    SET status = 'deleted',
        last_error = NULL
    WHERE short_token = @target_id
      AND COALESCE(target_type, 'token') = @target_type
      AND status != 'deleted'
    """
    _bq_client().query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("target_id",   "STRING", target_id),
                bigquery.ScalarQueryParameter("target_type", "STRING", target_type),
            ],
        ),
    ).result()
    return {"sheet_deleted": sheet_deleted}


def list_active_integrations() -> List[Dict]:
    """
    Retorna todas as integrações que ainda devem sincronizar
    (status='active' AND sync_until >= today). Usado pelo cron diário.

    Cada item traz target_type/target_id pra que `sync_all_due` saiba se
    é uma integração token ou merge e roteie pro loader correto.
    """
    ensure_table_exists()
    sql = f"""
    SELECT
        short_token,
        COALESCE(target_type, 'token') AS target_type,
        spreadsheet_id,
        refresh_token_enc,
        created_by_email
    FROM `{_table_id()}`
    WHERE status = 'active'
      AND sync_until >= CURRENT_DATE("America/Sao_Paulo")
    """
    rows = list(_bq_client().query(sql).result())
    return [
        {
            "target_id":         r["short_token"],
            "target_type":       r["target_type"],
            # Compat retro:
            "short_token":       r["short_token"],
            "spreadsheet_id":    r["spreadsheet_id"],
            "refresh_token_enc": r["refresh_token_enc"],
            "created_by_email":  r["created_by_email"],
        }
        for r in rows
    ]


def list_expired_integrations() -> List[Dict]:
    """
    Retorna integrações cujo sync_until passou e que ainda estão active.
    Usado pelo cron diário pra marcar como 'paused'.
    """
    ensure_table_exists()
    sql = f"""
    SELECT
        short_token,
        COALESCE(target_type, 'token') AS target_type
    FROM `{_table_id()}`
    WHERE status = 'active'
      AND sync_until < CURRENT_DATE("America/Sao_Paulo")
    """
    rows = list(_bq_client().query(sql).result())
    return [
        {
            "target_id":   r["short_token"],
            "target_type": r["target_type"],
            "short_token": r["short_token"],  # compat
        }
        for r in rows
    ]


def sync_all_due(token_loader, merge_loader=None) -> Dict:
    """
    Roda o sync de todas as integrações elegíveis. Chamado pelo cron diário.

    Args
    ----
    token_loader : callable
        `(short_token) -> (detail_rows, totals_rows)` — carrega as rows do
        token único. Injetado por DI pra evitar import circular.
    merge_loader : callable | None
        `(merge_id) -> list[(short_token, detail_rows, totals_rows, member_meta)]`
        — carrega rows de cada membro do grupo já anotadas com a
        identificação do mês/token. Se None, integrações com
        target_type='merge' são puladas com warning.

    Retorna sumário com contagens. Erros individuais não interrompem o loop —
    cada falha é registrada em last_error/status do registro afetado.

    Esse loop é sequencial de propósito. Cloud Function gen2 com concurrency
    e múltiplas requisições simultâneas dá pra paralelizar, mas:
      (1) Sheets API tem quotas per-user (60 writes/min) — paralelizar com
          mesmo refresh_token não acelera.
      (2) Volume previsto de integrações (~dezenas) é pequeno.
      (3) Sequencial é mais fácil de debugar e dá retry granular natural.
    """
    summary = {
        "synced":       0,
        "revoked":      0,
        "errors":       0,
        "paused":       0,
        "total_active": 0,
    }

    # Pausa primeiro as expiradas (não tenta sync nelas).
    for row in list_expired_integrations():
        try:
            _update_status(
                row["target_id"],
                target_type=row.get("target_type", TARGET_TOKEN),
                status="paused",
            )
            summary["paused"] += 1
        except Exception as e:
            logger.warning(
                f"[WARN sheets sync_all_due pause "
                f"{row.get('target_type','token')}/{row['target_id']}] {e}"
            )

    active = list_active_integrations()
    summary["total_active"] = len(active)

    for integ in active:
        target_id   = integ["target_id"]
        target_type = integ.get("target_type", TARGET_TOKEN)
        # Marca a tentativa ANTES de qualquer processamento. Se o cron
        # crashar (timeout/OOM/exception fora do try), o frontend usa
        # `last_attempt_at` recente + `last_synced_at` antigo pra mostrar
        # "tentou mas falhou" em vez de mentir "ATIVO" com sync velho.
        _mark_attempt(target_id, target_type)
        try:
            if target_type == TARGET_MERGE:
                if merge_loader is None:
                    logger.warning(
                        f"[WARN sheets sync_all_due] merge_loader não fornecido — "
                        f"pulando merge_id={target_id}"
                    )
                    continue
                members = merge_loader(target_id) or []
                sync_merge_sheet(target_id, members)
            else:
                detail_rows, totals_rows = token_loader(target_id)
                sync_sheet(target_id, detail_rows or [], totals_rows or [])
            summary["synced"] += 1
        except PermissionError:
            summary["revoked"] += 1
            logger.info(f"[INFO sheets sync_all_due] {target_type}/{target_id} revoked")
        except Exception as e:
            summary["errors"] += 1
            logger.error(f"[ERROR sheets sync_all_due {target_type}/{target_id}] {e}")

    return summary


# ─── Sheet creation + sync ───────────────────────────────────────────────────
# Schema das colunas escritas — fonte da verdade é src/v2/components/DataTableV2.jsx
# (FIELDS no topo do arquivo). Manter os 2 lugares em sincronia: cliente
# espera ver na sheet o mesmo schema do download CSV do dash.
#
# IMPORTANTE: só campos que vêm BRUTOS no detail. Métricas derivadas como
# CTR e VTR não estão aqui — quem quiser elas faz fórmula no próprio Sheets.
SHEET_COLUMNS = [
    ("date",                     "Data"),
    ("campaign_name",             "Campanha"),
    ("line_name",                 "Line"),
    ("creative_name",             "Criativo"),
    ("creative_size",             "Tamanho"),
    ("media_type",                "Tipo"),
    ("impressions",               "Impressões"),
    ("viewable_impressions",      "Imp. Visíveis"),
    ("clicks",                    "Cliques"),
    ("video_starts",              "Video Starts"),
    ("video_view_25",             "25%"),
    ("video_view_50",             "50%"),
    ("video_view_75",             "75%"),
    ("video_view_100",            "100%"),
    ("effective_total_cost",      "Custo Efetivo"),
    ("effective_cost_with_over",  "Custo Ef. + Over"),
]

# Colunas extras pra sheet de merge (1 linha por dia × line × criativo
# de CADA token do grupo). `_token_label` é o nome legível do mês
# (ex.: "Abr 2026") + short_token entre parênteses pra desambiguar
# quando dois tokens compartilham mês.
SHEET_COLUMNS_MERGE_PREFIX = [
    ("_token_label",  "Mês"),
    ("_short_token",  "Token"),
]

# README escrito na primeira aba como informativo. Cliente abre, vê o
# disclaimer, e qualquer edição manual nas outras abas é sobrescrita
# no próximo sync — não na README, que fica intocada.
README_TEXT = [
    ["HYPR Report Center — Base de Dados"],
    [""],
    ["• Esta planilha é alimentada automaticamente pelo HYPR Report Center."],
    ["• Atualização: diariamente às 06:00 BRT, a aba 'Base de Dados' é"],
    ["  totalmente sobrescrita com os dados mais recentes da campanha."],
    ["• Edições manuais na aba 'Base de Dados' serão perdidas na próxima"],
    ["  atualização. Use abas adicionais (criadas por você) pra análises"],
    ["  customizadas, fórmulas ou pivots — essas não são tocadas."],
    ["• A sincronização para automaticamente 30 dias após o término da"],
    ["  campanha. Esta planilha permanecerá acessível indefinidamente."],
    [""],
    ["Para suporte: contate o time HYPR Report Center."],
]


def _format_cell(key: str, value) -> str:
    """Converte tipos pythonicos pra string de célula. Sheets API aceita
    strings/números, mas datas tem que vir como ISO ou similar."""
    if value is None:
        return ""
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def _build_sheet_payload(detail_rows: List[Dict], *, merged: bool = False) -> List[List]:
    """Monta a matriz de cells da aba Base de Dados a partir do detail.

    Quando `merged=True`, prepende as colunas `Mês` / `Token` —
    `detail_rows` precisam vir com `_token_label` e `_short_token`
    populados (anotação feita em `_annotate_merge_rows`).
    """
    cols = (SHEET_COLUMNS_MERGE_PREFIX + SHEET_COLUMNS) if merged else SHEET_COLUMNS
    header = [label for _, label in cols]
    body = [
        [_format_cell(key, row.get(key)) for key, _ in cols]
        for row in detail_rows
    ]
    return [header] + body


def _annotate_merge_rows(
    short_token: str,
    detail_rows: List[Dict],
    start_date: Optional[date],
    end_date: Optional[date],
) -> List[Dict]:
    """Anota cada row do detail com `_token_label` (mês legível) +
    `_short_token` pra escrita na sheet merged. Não muta o input."""
    label = _format_period(start_date, end_date) or short_token
    out = []
    for r in detail_rows:
        nr = dict(r)
        nr["_token_label"] = label
        nr["_short_token"] = short_token
        out.append(nr)
    return out


def _sort_merge_rows_by_date(rows: List[Dict]) -> List[Dict]:
    """Ordena rows da sheet merged por data ascendente — sem isso a
    concatenação fica na ordem dos tokens (created_at no grupo), o que
    quebra a leitura cronológica esperada pelo cliente.

    Tiebreaker: `_short_token` pra estabilidade (rows do mesmo dia
    aparecem agrupadas por mês). Datas faltando vão pro final."""
    def _key(r):
        d = r.get("date")
        # date / datetime sortam direto; strings ISO sortam corretamente
        # quando o formato é YYYY-MM-DD ou YYYY-MM-DDT...
        if isinstance(d, (date, datetime)):
            sort_d = d.isoformat()
        elif isinstance(d, str):
            sort_d = d
        else:
            sort_d = "9999-99-99"  # vazias por último
        return (sort_d, r.get("_short_token") or "")
    return sorted(rows, key=_key)


def _distribute_largest_remainder(weights: List[float], target_total: float) -> List[float]:
    """
    Distribui `target_total` (em reais) entre N posições proporcionalmente a
    `weights`, garantindo Σ resultado == round(target_total, 2) ao centavo
    exato. Método dos restos (Hamilton/Hare).

    Por que: arredondar `proportion × target` linha-a-linha acumula até R$1
    de deriva em ~100 linhas. Esta função aloca cada centavo do alvo entre
    as linhas — quem tem o maior resto descartado ganha o centavo extra.

    Empate: índice menor primeiro (estável, reprodutível).
    """
    n = len(weights)
    if n == 0:
        return []
    target_cents = round(target_total * 100)
    if target_cents == 0:
        return [0.0] * n
    total_weight = sum(weights)
    if total_weight <= 0:
        return [0.0] * n
    raw_cents  = [(w / total_weight) * target_cents for w in weights]
    floor_cents = [int(c) for c in raw_cents]   # floor de não-negativo
    remainder = target_cents - sum(floor_cents)
    # Ordena índices por maior fração descartada; tiebreaker: índice menor
    order = sorted(range(n), key=lambda i: (-(raw_cents[i] - floor_cents[i]), i))
    result = list(floor_cents)
    k = 0
    while remainder > 0 and k < n:
        result[order[k]] += 1
        remainder -= 1
        k += 1
    # Edge case target_cents < 0 (não deveria ocorrer, mas seguro)
    k = 0
    while remainder < 0 and k < n:
        result[order[k]] -= 1
        remainder += 1
        k += 1
    return [c / 100.0 for c in result]


def _enrich_detail_costs(detail_rows: List[Dict], totals_rows: List[Dict]) -> List[Dict]:
    """
    Porta de src/shared/enrichDetail.js (frontend) pra Python.

    Por que existe
    --------------
    O detail vindo de unified_daily_performance_metrics traz custos brutos
    da plataforma (DSP) que NÃO batem com o custo efetivo negociado da
    HYPR. O custo "real" pra exibição vive em campaign_results (totals),
    agregado por (media_type, tactic_type).

    O frontend distribui esse custo total proporcionalmente entre as
    rows de detail, usando como peso:
      - viewable_impressions, pra DISPLAY
      - video_view_100,         pra VIDEO

    Mantém a soma do detail enriquecido = total exibido no dash.
    Sem isso, a sheet exibe ~46% menos do que o dash mostra (custos brutos
    do DSP costumam ser bem menores que custo HYPR negociado).

    Largest-remainder
    -----------------
    Usa _distribute_largest_remainder pra garantir
        Σ detail.effective_total_cost == round(tot.effective_total_cost, 2)
    ao centavo. Substitui o `round(proportion × total, 2)` ingênuo que
    acumulava ~R$0,77 de deriva contra o dashboard em campanhas com
    ~100+ linhas de detail.

    Esta função DEVE ficar em sincronia com enrichDetail.js. Se um dia
    extrair pra serviço único compartilhado, atualizar ambos.
    """
    if not detail_rows or not totals_rows:
        return detail_rows

    # Index totals por (media_type, tactic_type)
    totals_map = {}
    for t in totals_rows:
        key = f"{t.get('media_type')}|{t.get('tactic_type')}"
        totals_map[key] = t

    # Indexa rows de cada grupo preservando ordem original
    group_indices: Dict[str, List[int]] = {}
    for idx, r in enumerate(detail_rows):
        key = f"{r.get('media_type')}|{r.get('tactic_type')}"
        group_indices.setdefault(key, []).append(idx)

    # Pré-aloca custo redistribuído por linha
    cost_by_idx      = [0.0] * len(detail_rows)
    cost_over_by_idx = [0.0] * len(detail_rows)

    for key, idxs in group_indices.items():
        tot = totals_map.get(key)
        if not tot:
            continue
        is_video = key.startswith("VIDEO|")
        weights = []
        for i in idxs:
            r = detail_rows[i]
            w = (r.get("video_view_100") or 0) if is_video else (r.get("viewable_impressions") or 0)
            weights.append(float(w))
        shares_cost = _distribute_largest_remainder(weights, float(tot.get("effective_total_cost")     or 0))
        shares_over = _distribute_largest_remainder(weights, float(tot.get("effective_cost_with_over") or 0))
        for k, orig in enumerate(idxs):
            cost_by_idx[orig]      = shares_cost[k]
            cost_over_by_idx[orig] = shares_over[k]

    enriched = []
    for idx, r in enumerate(detail_rows):
        key = f"{r.get('media_type')}|{r.get('tactic_type')}"
        new_row = dict(r)
        if key not in totals_map:
            new_row["effective_total_cost"]     = 0
            new_row["effective_cost_with_over"] = 0
        else:
            new_row["effective_total_cost"]     = cost_by_idx[idx]
            new_row["effective_cost_with_over"] = cost_over_by_idx[idx]
        enriched.append(new_row)
    return enriched


def _format_period(start: Optional[date], end: Optional[date]) -> str:
    """
    Formata o período pro título da sheet de forma compacta e legível.

    - Mesmo mês/ano:        "01-30 abr 2026"
    - Mesmo ano, meses dif: "20 mar - 15 abr 2026"
    - Anos diferentes:      "20 dez 2025 - 15 jan 2026"
    - Apenas end:           "até 30 abr 2026"
    - Apenas start:         "desde 01 abr 2026"
    - Nenhum:               "" (chamador decide se inclui no título)
    """
    months_pt = [
        "jan", "fev", "mar", "abr", "mai", "jun",
        "jul", "ago", "set", "out", "nov", "dez",
    ]
    if not start and not end:
        return ""
    if start and not end:
        return f"desde {start.day:02d} {months_pt[start.month-1]} {start.year}"
    if end and not start:
        return f"até {end.day:02d} {months_pt[end.month-1]} {end.year}"
    if start.year == end.year and start.month == end.month:
        return f"{start.day:02d}-{end.day:02d} {months_pt[start.month-1]} {start.year}"
    if start.year == end.year:
        return f"{start.day:02d} {months_pt[start.month-1]} - {end.day:02d} {months_pt[end.month-1]} {start.year}"
    return (
        f"{start.day:02d} {months_pt[start.month-1]} {start.year} - "
        f"{end.day:02d} {months_pt[end.month-1]} {end.year}"
    )


def _build_sheet_title(
    short_token: str,
    client_name: Optional[str],
    campaign_name: Optional[str],
    start_date: Optional[date],
    end_date: Optional[date],
) -> str:
    """
    Constrói o título no padrão:
      'HYPR - {Cliente} - {Campanha} - {Período} - {token}'
    Pula partes vazias pra evitar separadores duplos. Token sempre presente.
    """
    parts = ["HYPR"]
    if client_name:
        parts.append(client_name.strip())
    if campaign_name:
        parts.append(campaign_name.strip())
    period = _format_period(start_date, end_date)
    if period:
        parts.append(period)
    parts.append(short_token)
    return " - ".join(parts)


def _build_merge_sheet_title(
    merge_id: str,
    client_name: Optional[str],
    campaign_name: Optional[str],
    earliest_start: Optional[date],
    latest_end: Optional[date],
) -> str:
    """Título da sheet agregada — mesma estrutura, mas marca '(agrupado)'
    pra cliente diferenciar do mês individual no Drive."""
    parts = ["HYPR"]
    if client_name:
        parts.append(client_name.strip())
    if campaign_name:
        parts.append(campaign_name.strip())
    period = _format_period(earliest_start, latest_end)
    if period:
        parts.append(period)
    parts.append("agrupado")
    return " - ".join(parts)


def _create_spreadsheet_with_payload(
    *,
    title: str,
    payload: List[List],
    access_token: str,
) -> Tuple[str, str]:
    """Cria spreadsheet com 2 abas (README + Base de Dados), popula, formata
    header bold + frozen row, move pra pasta HYPR (best-effort) e seta
    permissão de link público (best-effort). Retorna (id, url).

    Em caso de falha pós-criação, deleta a sheet pra não deixar órfã.
    """
    sheets_svc = _build_sheets_client(access_token)

    create_body = {
        "properties": {"title": title},
        "sheets": [
            {"properties": {"title": "README"}},
            {"properties": {"title": "Base de Dados"}},
        ],
    }
    # IMPORTANTE: incluir `sheets.properties.{sheetId,title}` em `fields`.
    # O Google atribui sheetIds aleatórios na criação (não são 0,1,2...
    # sequenciais como eu assumi inicialmente). Precisamos dos IDs reais
    # pra usar no batchUpdate de formatação adiante.
    created = sheets_svc.spreadsheets().create(
        body=create_body,
        fields="spreadsheetId,spreadsheetUrl,sheets.properties.sheetId,sheets.properties.title",
    ).execute()
    spreadsheet_id  = created["spreadsheetId"]
    spreadsheet_url = created["spreadsheetUrl"]

    sheet_id_by_title = {
        s["properties"]["title"]: s["properties"]["sheetId"]
        for s in created.get("sheets", [])
    }
    base_sheet_id = sheet_id_by_title.get("Base de Dados")
    if base_sheet_id is None:
        _try_delete_spreadsheet(spreadsheet_id, access_token)
        raise RuntimeError("Aba 'Base de Dados' não encontrada na sheet recém-criada")

    try:
        sheets_svc.spreadsheets().values().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={
                "valueInputOption": "RAW",
                "data": [
                    {"range": "README!A1",        "values": README_TEXT},
                    {"range": "Base de Dados!A1", "values": payload},
                ],
            },
        ).execute()

        sheets_svc.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={
                "requests": [
                    {
                        "repeatCell": {
                            "range": {
                                "sheetId": base_sheet_id,
                                "startRowIndex": 0,
                                "endRowIndex": 1,
                            },
                            "cell": {"userEnteredFormat": {"textFormat": {"bold": True}}},
                            "fields": "userEnteredFormat.textFormat.bold",
                        }
                    },
                    {
                        "updateSheetProperties": {
                            "properties": {
                                "sheetId": base_sheet_id,
                                "gridProperties": {"frozenRowCount": 1},
                            },
                            "fields": "gridProperties.frozenRowCount",
                        }
                    },
                ],
            },
        ).execute()
    except Exception:
        _try_delete_spreadsheet(spreadsheet_id, access_token)
        raise

    # Move pra pasta compartilhada (best-effort)
    if DRIVE_FOLDER_ID:
        try:
            drive_svc = _build_drive_client(access_token)
            file_meta = drive_svc.files().get(
                fileId=spreadsheet_id, fields="parents",
            ).execute()
            current_parents = ",".join(file_meta.get("parents", []))
            drive_svc.files().update(
                fileId=spreadsheet_id,
                addParents=DRIVE_FOLDER_ID,
                removeParents=current_parents,
                fields="id,parents",
            ).execute()
        except Exception as e:
            logger.warning(f"[WARN move sheet to folder {spreadsheet_id}] {e}")

    # Permissão de link público (best-effort)
    try:
        drive_svc = _build_drive_client(access_token)
        drive_svc.permissions().create(
            fileId=spreadsheet_id,
            body={"role": "reader", "type": "anyone"},
            fields="id",
        ).execute()
    except Exception as e:
        logger.warning(f"[WARN set anyone-link permission {spreadsheet_id}] {e}")

    return spreadsheet_id, spreadsheet_url


def create_sheet_for_campaign(
    short_token: str,
    refresh_token: str,
    member_email: str,
    detail_rows: List[Dict],
    totals_rows: List[Dict],
    campaign_name: str,
    client_name: Optional[str],
    start_date: Optional[date],
    end_date: Optional[date],
) -> Dict:
    """
    Cria uma sheet nova no Drive do membro que ativou (via refresh_token),
    popula com README + Base de Dados, e persiste a integração.
    Retorna dict com spreadsheet_id e spreadsheet_url.

    detail_rows é enriquecido internamente via _enrich_detail_costs(detail, totals)
    pra reproduzir os mesmos números do dash (que faz o enrich no frontend).
    """
    ensure_table_exists()
    detail_rows = _enrich_detail_costs(detail_rows, totals_rows)
    access_token = _refresh_access_token(refresh_token)

    title = _build_sheet_title(
        short_token=short_token,
        client_name=client_name,
        campaign_name=campaign_name,
        start_date=start_date,
        end_date=end_date,
    )
    payload = _build_sheet_payload(detail_rows)
    spreadsheet_id, spreadsheet_url = _create_spreadsheet_with_payload(
        title=title, payload=payload, access_token=access_token,
    )

    sync_until = (end_date + timedelta(days=SYNC_GRACE_DAYS)) if end_date else None
    now = datetime.now(timezone.utc)
    _upsert_integration({
        "target_id":         short_token,
        "target_type":       TARGET_TOKEN,
        "spreadsheet_id":    spreadsheet_id,
        "spreadsheet_url":   spreadsheet_url,
        "created_by_email":  member_email,
        "refresh_token_enc": _bytes_to_b64(_encrypt(refresh_token)),
        "created_at":        now.isoformat(),
        "last_synced_at":    now.isoformat(),
        "sync_until":        sync_until.isoformat() if sync_until else None,
        "status":            "active",
        "last_error":        None,
    })

    return {
        "spreadsheet_id":  spreadsheet_id,
        "spreadsheet_url": spreadsheet_url,
    }


def create_sheet_for_merge(
    merge_id: str,
    refresh_token: str,
    member_email: str,
    members: List[Dict],
    client_name: Optional[str],
    campaign_name: Optional[str],
) -> Dict:
    """Cria sheet agregada (1 row por dia × line × criativo de cada token
    do grupo, com colunas extras `Mês`/`Token`). Persiste com
    target_type='merge', short_token=merge_id.

    `members` é uma lista de dicts:
       {"short_token": str, "detail_rows": [...], "totals_rows": [...],
        "start_date": date|None, "end_date": date|None}
    Já enriquecidos? Não — esta função enriquece cada membro internamente,
    pra manter consistência com o caminho single-token.
    """
    ensure_table_exists()
    if not members:
        raise ValueError("create_sheet_for_merge: members vazio")
    access_token = _refresh_access_token(refresh_token)

    annotated_rows: List[Dict] = []
    starts: List[date] = []
    ends:   List[date] = []
    for m in members:
        st = m.get("short_token") or ""
        detail = _enrich_detail_costs(m.get("detail_rows") or [], m.get("totals_rows") or [])
        s_d = m.get("start_date")
        e_d = m.get("end_date")
        if s_d: starts.append(s_d)
        if e_d: ends.append(e_d)
        annotated_rows.extend(_annotate_merge_rows(st, detail, s_d, e_d))

    earliest_start = min(starts) if starts else None
    latest_end     = max(ends)   if ends   else None

    title = _build_merge_sheet_title(
        merge_id=merge_id,
        client_name=client_name,
        campaign_name=campaign_name,
        earliest_start=earliest_start,
        latest_end=latest_end,
    )
    annotated_rows = _sort_merge_rows_by_date(annotated_rows)
    payload = _build_sheet_payload(annotated_rows, merged=True)
    spreadsheet_id, spreadsheet_url = _create_spreadsheet_with_payload(
        title=title, payload=payload, access_token=access_token,
    )

    sync_until = (latest_end + timedelta(days=SYNC_GRACE_DAYS)) if latest_end else None
    now = datetime.now(timezone.utc)
    _upsert_integration({
        "target_id":         merge_id,
        "target_type":       TARGET_MERGE,
        "spreadsheet_id":    spreadsheet_id,
        "spreadsheet_url":   spreadsheet_url,
        "created_by_email":  member_email,
        "refresh_token_enc": _bytes_to_b64(_encrypt(refresh_token)),
        "created_at":        now.isoformat(),
        "last_synced_at":    now.isoformat(),
        "sync_until":        sync_until.isoformat() if sync_until else None,
        "status":            "active",
        "last_error":        None,
    })

    return {
        "spreadsheet_id":  spreadsheet_id,
        "spreadsheet_url": spreadsheet_url,
    }


def _resolve_refresh_token(integ: Dict, target_id: str, target_type: str) -> str:
    """Decifra o refresh_token a partir da row de integração. Atualiza
    status='error' em caso de falha de decrypt e propaga a exceção."""
    refresh_token_enc = integ["refresh_token_enc"]
    if not refresh_token_enc:
        raise ValueError(f"refresh_token_enc vazio para {target_type}/{target_id}")
    try:
        if isinstance(refresh_token_enc, str):
            refresh_token_enc = _b64_to_bytes(refresh_token_enc)
        return _decrypt(refresh_token_enc)
    except Exception as e:
        _update_status(target_id, target_type=target_type, status="error", last_error=f"decrypt failed: {e}")
        raise


def _exchange_or_mark(refresh_token: str, target_id: str, target_type: str) -> str:
    """Troca refresh_token por access_token. Marca revoked/error se falhar."""
    try:
        return _refresh_access_token(refresh_token)
    except PermissionError:
        _update_status(target_id, target_type=target_type, status="revoked",
                       last_error="refresh_token revogado pelo usuário")
        raise
    except Exception as e:
        _update_status(target_id, target_type=target_type, status="error", last_error=str(e)[:500])
        raise


def _write_base_de_dados(
    sheets_svc, spreadsheet_id: str, payload: List[List],
    target_id: str, target_type: str,
) -> None:
    """Limpa + reescreve a aba 'Base de Dados'. Marca status corretamente
    em caso de HttpError (403/404 = revoked; resto = error)."""
    try:
        sheets_svc.spreadsheets().values().clear(
            spreadsheetId=spreadsheet_id,
            range="Base de Dados!A:Z",
        ).execute()
        sheets_svc.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id,
            range="Base de Dados!A1",
            valueInputOption="RAW",
            body={"values": payload},
        ).execute()
    except HttpError as e:
        msg = f"HTTP {e.resp.status}: {str(e)[:300]}"
        status = "error"
        if e.resp.status in (403, 404):
            status = "revoked"
        _update_status(target_id, target_type=target_type, status=status, last_error=msg)
        raise


def sync_sheet(
    short_token: str,
    detail_rows: List[Dict],
    totals_rows: List[Dict],
) -> Dict:
    """
    Re-popula a aba Base de Dados de uma sheet single-token existente.
    Usa refresh_token salvo. Atualiza last_synced_at; em caso de erro de
    auth, marca como revoked; outros erros marcam como error.
    """
    detail_rows = _enrich_detail_costs(detail_rows, totals_rows)
    integ = get_integration(short_token, target_type=TARGET_TOKEN)
    if not integ:
        raise ValueError(f"Integração token não encontrada para {short_token}")

    refresh_token = _resolve_refresh_token(integ, short_token, TARGET_TOKEN)
    access_token  = _exchange_or_mark(refresh_token, short_token, TARGET_TOKEN)
    sheets_svc    = _build_sheets_client(access_token)
    payload       = _build_sheet_payload(detail_rows)

    _write_base_de_dados(sheets_svc, integ["spreadsheet_id"], payload,
                         short_token, TARGET_TOKEN)

    _update_status(
        short_token, target_type=TARGET_TOKEN,
        status="active",
        last_synced_at=datetime.now(timezone.utc),
        last_error=None,
    )
    return {"spreadsheet_id": integ["spreadsheet_id"]}


def sync_merge_sheet(merge_id: str, members: List[Dict]) -> Dict:
    """
    Re-popula a aba Base de Dados de uma sheet AGREGADA existente.
    `members` é a mesma lista de `create_sheet_for_merge`.
    """
    integ = get_integration(merge_id, target_type=TARGET_MERGE)
    if not integ:
        raise ValueError(f"Integração merge não encontrada para {merge_id}")
    if not members:
        # Grupo ficou vazio (todos os tokens removidos). Marca paused
        # pra que o cron pare de tentar; admin decide se exclui.
        _update_status(merge_id, target_type=TARGET_MERGE, status="paused",
                       last_error="grupo sem membros")
        return {"spreadsheet_id": integ["spreadsheet_id"], "skipped": True}

    refresh_token = _resolve_refresh_token(integ, merge_id, TARGET_MERGE)
    access_token  = _exchange_or_mark(refresh_token, merge_id, TARGET_MERGE)
    sheets_svc    = _build_sheets_client(access_token)

    annotated_rows: List[Dict] = []
    for m in members:
        st = m.get("short_token") or ""
        detail = _enrich_detail_costs(m.get("detail_rows") or [], m.get("totals_rows") or [])
        annotated_rows.extend(_annotate_merge_rows(
            st, detail, m.get("start_date"), m.get("end_date"),
        ))
    annotated_rows = _sort_merge_rows_by_date(annotated_rows)
    payload = _build_sheet_payload(annotated_rows, merged=True)

    _write_base_de_dados(sheets_svc, integ["spreadsheet_id"], payload,
                         merge_id, TARGET_MERGE)

    _update_status(
        merge_id, target_type=TARGET_MERGE,
        status="active",
        last_synced_at=datetime.now(timezone.utc),
        last_error=None,
    )
    return {"spreadsheet_id": integ["spreadsheet_id"]}


# ─── Helpers ─────────────────────────────────────────────────────────────────
def _bytes_to_b64(b: bytes) -> str:
    import base64
    return base64.b64encode(b).decode("ascii")


def _b64_to_bytes(s: str) -> bytes:
    import base64
    return base64.b64decode(s)


def _try_delete_spreadsheet(spreadsheet_id: str, access_token: str) -> None:
    """
    Best-effort cleanup de uma sheet criada que falhou no setup posterior.
    Evita acumular sheets órfãs no Drive do usuário a cada retry.
    Falha silenciosamente — não queremos mascarar a exceção original.
    """
    try:
        drive_svc = _build_drive_client(access_token)
        drive_svc.files().delete(fileId=spreadsheet_id).execute()
    except Exception as e:
        logger.warning(f"[WARN _try_delete_spreadsheet {spreadsheet_id}] {e}")


def status_for_response(
    target_id: str,
    *,
    is_admin: bool,
    target_type: str = TARGET_TOKEN,
) -> Optional[Dict]:
    """
    Monta o objeto de status pro frontend consumir. Cliente vê apenas
    campos não-sensíveis (url da sheet); admin vê tudo.
    """
    _validate_target_type(target_type)
    integ = get_integration(target_id, target_type=target_type)
    if not integ:
        return None
    public = {
        "spreadsheet_url": integ["spreadsheet_url"],
        "status":          integ["status"],
        "target_type":     integ["target_type"],
    }
    if not is_admin:
        # Cliente só vê o link se está ativa (não vê erros internos).
        if integ["status"] != "active":
            return None
        return public
    # Admin vê tudo.
    return {
        **public,
        "spreadsheet_id":   integ["spreadsheet_id"],
        "created_by_email": integ["created_by_email"],
        "created_at":       integ["created_at"].isoformat() if integ["created_at"] else None,
        "last_synced_at":   integ["last_synced_at"].isoformat() if integ["last_synced_at"] else None,
        "last_attempt_at":  integ["last_attempt_at"].isoformat() if integ.get("last_attempt_at") else None,
        "sync_until":       integ["sync_until"].isoformat() if integ["sync_until"] else None,
        "last_error":       integ["last_error"],
    }
