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
    short_token        STRING NOT NULL  -- chave da campanha (1 sheet por campanha)
    spreadsheet_id     STRING           -- id da sheet criada
    spreadsheet_url    STRING           -- url pra abrir
    created_by_email   STRING           -- membro HYPR que ativou
    refresh_token_enc  BYTES            -- KMS-encrypted refresh_token
    created_at         TIMESTAMP
    last_synced_at     TIMESTAMP
    sync_until         DATE             -- end_date + 30 dias
    status             STRING           -- active | paused | revoked | error
    last_error         STRING           -- detalhe do último erro de sync

Tabela criada idempotentemente via `ensure_table_exists` na primeira
chamada de qualquer endpoint de sheets.
"""

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


# ─── Config ──────────────────────────────────────────────────────────────────
PROJECT_ID     = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET_ASSETS = "prod_assets"
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
            spreadsheet_id     STRING,
            spreadsheet_url    STRING,
            created_by_email   STRING,
            refresh_token_enc  BYTES,
            created_at         TIMESTAMP,
            last_synced_at     TIMESTAMP,
            sync_until         DATE,
            status             STRING,
            last_error         STRING
        )
        """
        _bq_client().query(sql).result()
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
def get_integration(short_token: str) -> Optional[Dict]:
    """Busca a integração ativa de uma campanha. None se não existe."""
    ensure_table_exists()
    sql = f"""
    SELECT
        short_token,
        spreadsheet_id,
        spreadsheet_url,
        created_by_email,
        refresh_token_enc,
        created_at,
        last_synced_at,
        sync_until,
        status,
        last_error
    FROM `{_table_id()}`
    WHERE short_token = @short_token
    LIMIT 1
    """
    job = _bq_client().query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("short_token", "STRING", short_token),
            ],
        ),
    )
    rows = list(job.result())
    if not rows:
        return None
    r = rows[0]
    return {
        "short_token":      r["short_token"],
        "spreadsheet_id":   r["spreadsheet_id"],
        "spreadsheet_url":  r["spreadsheet_url"],
        "created_by_email": r["created_by_email"],
        "refresh_token_enc": r["refresh_token_enc"],
        "created_at":       r["created_at"],
        "last_synced_at":   r["last_synced_at"],
        "sync_until":       r["sync_until"],
        "status":           r["status"],
        "last_error":       r["last_error"],
    }


def _upsert_integration(row: Dict) -> None:
    """
    Insert ou update via DELETE+INSERT (1 sheet por campanha).
    BigQuery não tem UPSERT nativo em DML simples; MERGE seria overkill
    pra um caso de write-light. Como a tabela é small (1 linha por
    campanha integrada) e operações são raras, esse padrão é OK.
    """
    ensure_table_exists()
    short_token = row["short_token"]
    delete_sql = f"DELETE FROM `{_table_id()}` WHERE short_token = @short_token"
    _bq_client().query(
        delete_sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("short_token", "STRING", short_token),
            ],
        ),
    ).result()
    errors = _bq_client().insert_rows_json(_table_id(), [row])
    if errors:
        raise RuntimeError(f"BQ insert falhou: {errors}")


def _update_status(
    short_token: str,
    *,
    status: Optional[str] = None,
    last_synced_at: Optional[datetime] = None,
    last_error: Optional[str] = None,
) -> None:
    """Atualiza apenas campos de status/erro/sync. Não toca refresh_token."""
    sets = []
    params = [bigquery.ScalarQueryParameter("short_token", "STRING", short_token)]
    if status is not None:
        sets.append("status = @status")
        params.append(bigquery.ScalarQueryParameter("status", "STRING", status))
    if last_synced_at is not None:
        sets.append("last_synced_at = @last_synced_at")
        params.append(bigquery.ScalarQueryParameter("last_synced_at", "TIMESTAMP", last_synced_at))
    if last_error is not None:
        sets.append("last_error = @last_error")
        params.append(bigquery.ScalarQueryParameter("last_error", "STRING", last_error))
    if not sets:
        return
    sql = f"UPDATE `{_table_id()}` SET {', '.join(sets)} WHERE short_token = @short_token"
    _bq_client().query(
        sql,
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    ).result()


def delete_integration(short_token: str) -> None:
    ensure_table_exists()
    sql = f"DELETE FROM `{_table_id()}` WHERE short_token = @short_token"
    _bq_client().query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("short_token", "STRING", short_token),
            ],
        ),
    ).result()


def list_active_integrations() -> List[Dict]:
    """
    Retorna todas as integrações que ainda devem sincronizar
    (status='active' AND sync_until >= today). Usado pelo cron diário.
    """
    ensure_table_exists()
    sql = f"""
    SELECT short_token, spreadsheet_id, refresh_token_enc, created_by_email
    FROM `{_table_id()}`
    WHERE status = 'active'
      AND sync_until >= CURRENT_DATE("America/Sao_Paulo")
    """
    rows = list(_bq_client().query(sql).result())
    return [
        {
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
    SELECT short_token
    FROM `{_table_id()}`
    WHERE status = 'active'
      AND sync_until < CURRENT_DATE("America/Sao_Paulo")
    """
    rows = list(_bq_client().query(sql).result())
    return [{"short_token": r["short_token"]} for r in rows]


# ─── Sheet creation + sync ───────────────────────────────────────────────────
# Schema das colunas escritas. Replica DataTableV2 do frontend exatamente:
# se quiser mexer aqui, mexe no frontend também (e vice-versa). Centralizar
# essa lista em um lugar só seria ideal mas exigiria refactor cross-stack.
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
    ("ctr",                       "CTR"),
    ("video_view_25",             "Views 25%"),
    ("video_view_50",             "Views 50%"),
    ("video_view_75",             "Views 75%"),
    ("video_view_100",            "Views 100%"),
    ("vtr",                       "VTR"),
    ("effective_total_cost",      "Custo Efetivo"),
    ("effective_cost_with_over",  "Custo Ef. + Over"),
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


def _build_sheet_payload(detail_rows: List[Dict]) -> List[List]:
    """Monta a matriz de cells da aba Base de Dados a partir do detail."""
    header = [label for _, label in SHEET_COLUMNS]
    body = [
        [_format_cell(key, row.get(key)) for key, _ in SHEET_COLUMNS]
        for row in detail_rows
    ]
    return [header] + body


def create_sheet_for_campaign(
    short_token: str,
    refresh_token: str,
    member_email: str,
    detail_rows: List[Dict],
    campaign_name: str,
    end_date: Optional[date],
) -> Dict:
    """
    Cria uma sheet nova no Drive do membro que ativou (via refresh_token),
    popula com README + Base de Dados, e persiste a integração.
    Retorna dict com spreadsheet_id e spreadsheet_url.
    """
    ensure_table_exists()
    access_token = _refresh_access_token(refresh_token)
    sheets_svc   = _build_sheets_client(access_token)

    title = f"HYPR Report — {campaign_name or short_token}"

    # Cria spreadsheet com 2 abas: "README" e "Base de Dados"
    create_body = {
        "properties": {"title": title},
        "sheets": [
            {"properties": {"title": "README"}},
            {"properties": {"title": "Base de Dados"}},
        ],
    }
    created = sheets_svc.spreadsheets().create(
        body=create_body,
        fields="spreadsheetId,spreadsheetUrl",
    ).execute()
    spreadsheet_id  = created["spreadsheetId"]
    spreadsheet_url = created["spreadsheetUrl"]

    # Popula as 2 abas. README é estático; Base de Dados vem do detail.
    payload = _build_sheet_payload(detail_rows)
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

    # Negrito no header da Base de Dados (visual de tabela). Aba é sheetId=1
    # porque criamos README primeiro (sheetId=0). Tomei a decisão consciente
    # de não buscar o sheetId via API após o create — o ordering acima é
    # determinístico (Google preserva a ordem de `sheets[]` no payload).
    sheets_svc.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            "requests": [
                {
                    "repeatCell": {
                        "range": {"sheetId": 1, "startRowIndex": 0, "endRowIndex": 1},
                        "cell": {"userEnteredFormat": {"textFormat": {"bold": True}}},
                        "fields": "userEnteredFormat.textFormat.bold",
                    }
                },
                {
                    "updateSheetProperties": {
                        "properties": {"sheetId": 1, "gridProperties": {"frozenRowCount": 1}},
                        "fields": "gridProperties.frozenRowCount",
                    }
                },
            ],
        },
    ).execute()

    # Persiste a integração no BQ.
    sync_until = (end_date + timedelta(days=SYNC_GRACE_DAYS)) if end_date else None
    now = datetime.now(timezone.utc)
    _upsert_integration({
        "short_token":       short_token,
        "spreadsheet_id":    spreadsheet_id,
        "spreadsheet_url":   spreadsheet_url,
        "created_by_email":  member_email,
        # BQ JSON insert aceita BYTES como base64. Encodamos pra string base64.
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


def sync_sheet(
    short_token: str,
    detail_rows: List[Dict],
) -> Dict:
    """
    Re-popula a aba Base de Dados de uma sheet existente. Usa refresh_token
    salvo. Atualiza last_synced_at; em caso de erro de auth, marca como
    revoked; outros erros marcam como error.
    """
    integ = get_integration(short_token)
    if not integ:
        raise ValueError(f"Integração não encontrada para {short_token}")

    refresh_token_enc = integ["refresh_token_enc"]
    if not refresh_token_enc:
        raise ValueError(f"refresh_token_enc vazio para {short_token}")

    try:
        # BQ retorna BYTES como bytes Python — não precisa b64 decode aqui.
        # Mas se inseriu via JSON como base64, o read traz bytes diretos
        # (BQ faz o decode). Em caso de discrepância, esse cast resolve.
        if isinstance(refresh_token_enc, str):
            refresh_token_enc = _b64_to_bytes(refresh_token_enc)
        refresh_token = _decrypt(refresh_token_enc)
    except Exception as e:
        _update_status(short_token, status="error", last_error=f"decrypt failed: {e}")
        raise

    try:
        access_token = _refresh_access_token(refresh_token)
    except PermissionError:
        _update_status(short_token, status="revoked", last_error="refresh_token revogado pelo usuário")
        raise
    except Exception as e:
        _update_status(short_token, status="error", last_error=str(e)[:500])
        raise

    sheets_svc = _build_sheets_client(access_token)
    payload = _build_sheet_payload(detail_rows)

    try:
        # Limpa primeiro pra não deixar rows residuais se a base diminuiu
        sheets_svc.spreadsheets().values().clear(
            spreadsheetId=integ["spreadsheet_id"],
            range="Base de Dados!A:Z",
        ).execute()
        sheets_svc.spreadsheets().values().update(
            spreadsheetId=integ["spreadsheet_id"],
            range="Base de Dados!A1",
            valueInputOption="RAW",
            body={"values": payload},
        ).execute()
    except HttpError as e:
        # 404 = sheet deletada pelo usuário. 403 = permissão revogada.
        msg = f"HTTP {e.resp.status}: {str(e)[:300]}"
        status = "error"
        if e.resp.status in (403, 404):
            status = "revoked"
        _update_status(short_token, status=status, last_error=msg)
        raise

    _update_status(
        short_token,
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


def status_for_response(short_token: str, *, is_admin: bool) -> Optional[Dict]:
    """
    Monta o objeto de status pro frontend consumir. Cliente vê apenas
    campos não-sensíveis (url da sheet); admin vê tudo.
    """
    integ = get_integration(short_token)
    if not integ:
        return None
    public = {
        "spreadsheet_url": integ["spreadsheet_url"],
        "status":          integ["status"],
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
        "sync_until":       integ["sync_until"].isoformat() if integ["sync_until"] else None,
        "last_error":       integ["last_error"],
    }
