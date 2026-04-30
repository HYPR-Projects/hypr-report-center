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
      AND status != 'deleted'
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
    Upsert via MERGE — atualiza row existente (mesmo short_token, qualquer
    status incluindo 'deleted') ou insere nova. Tudo numa única operação
    DML transacional.

    Por que MERGE em vez de DELETE+INSERT
    -------------------------------------
    DELETE em row recém-criada cai em 'streaming buffer' error mesmo com
    DML INSERT. MERGE evita esse caminho: faz UPDATE in-place se a row
    existe (mesmo se ela está em buffer, o UPDATE não move da posição,
    apenas muda valores).

    Comportamento esperado
    ----------------------
    - Primeira ativação dessa campanha: INSERT
    - Re-ativação após delete: UPDATE (status=deleted → status=active,
      novos tokens, novo spreadsheet_id, etc.)
    - Re-ativação de uma já ativa: UPDATE (rotação de tokens etc.)
    """
    ensure_table_exists()
    refresh_token_enc_bytes = _b64_to_bytes(row["refresh_token_enc"])

    sql = f"""
    MERGE INTO `{_table_id()}` T
    USING (
        SELECT
            @short_token        AS short_token,
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
    WHEN MATCHED THEN UPDATE SET
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
        short_token, spreadsheet_id, spreadsheet_url, created_by_email,
        refresh_token_enc, created_at, last_synced_at, sync_until,
        status, last_error
    ) VALUES (
        S.short_token, S.spreadsheet_id, S.spreadsheet_url, S.created_by_email,
        S.refresh_token_enc, S.created_at, S.last_synced_at, S.sync_until,
        S.status, S.last_error
    )
    """

    params = [
        bigquery.ScalarQueryParameter("short_token",       "STRING",    row["short_token"]),
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


def delete_integration(short_token: str, delete_sheet: bool = False) -> Dict:
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
    ensure_table_exists()
    sheet_deleted = False

    if delete_sheet:
        # Pega a row antes de marcar como deleted — precisamos do
        # refresh_token e spreadsheet_id pra deletar via Drive API.
        integ = get_integration(short_token)
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
                print(f"[WARN delete_integration drive {short_token}] {e}")

    sql = f"""
    UPDATE `{_table_id()}`
    SET status = 'deleted',
        last_error = NULL
    WHERE short_token = @short_token
      AND status != 'deleted'
    """
    _bq_client().query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("short_token", "STRING", short_token),
            ],
        ),
    ).result()
    return {"sheet_deleted": sheet_deleted}


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


def sync_all_due(detail_loader) -> Dict:
    """
    Roda o sync de todas as integrações elegíveis. Chamado pelo cron diário.

    `detail_loader` é um callable `(short_token) -> (detail_rows, totals_rows)`
    que carrega as rows necessárias. Injetado por dependency injection pra
    evitar import circular (módulo sheets_integration não pode importar main).

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
        "synced":      0,
        "revoked":     0,
        "errors":      0,
        "paused":      0,
        "total_active": 0,
    }

    # Pausa primeiro as expiradas (não tenta sync nelas).
    for row in list_expired_integrations():
        try:
            _update_status(row["short_token"], status="paused")
            summary["paused"] += 1
        except Exception as e:
            print(f"[WARN sheets sync_all_due pause {row['short_token']}] {e}")

    active = list_active_integrations()
    summary["total_active"] = len(active)

    for integ in active:
        short_token = integ["short_token"]
        try:
            detail_rows, totals_rows = detail_loader(short_token)
            sync_sheet(short_token, detail_rows or [], totals_rows or [])
            summary["synced"] += 1
        except PermissionError:
            summary["revoked"] += 1
            print(f"[INFO sheets sync_all_due] {short_token} revoked")
        except Exception as e:
            summary["errors"] += 1
            print(f"[ERROR sheets sync_all_due {short_token}] {e}")

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

    # Soma denominadores (vi pra display, v100 pra video) por grupo
    group_sums = {}
    for r in detail_rows:
        key = f"{r.get('media_type')}|{r.get('tactic_type')}"
        if key not in group_sums:
            group_sums[key] = {"vi": 0, "v100": 0}
        group_sums[key]["vi"]   += r.get("viewable_impressions") or 0
        group_sums[key]["v100"] += r.get("video_view_100")       or 0

    enriched = []
    for r in detail_rows:
        key = f"{r.get('media_type')}|{r.get('tactic_type')}"
        tot = totals_map.get(key)
        grp = group_sums.get(key)
        new_row = dict(r)
        if not tot or not grp:
            new_row["effective_total_cost"]     = 0
            new_row["effective_cost_with_over"] = 0
            enriched.append(new_row)
            continue
        is_video = r.get("media_type") == "VIDEO"
        delivered = (r.get("video_view_100") or 0) if is_video else (r.get("viewable_impressions") or 0)
        total_delivered = grp["v100"] if is_video else grp["vi"]
        proportion = (delivered / total_delivered) if total_delivered > 0 else 0
        new_row["effective_total_cost"]     = round(proportion * (tot.get("effective_total_cost")     or 0), 2)
        new_row["effective_cost_with_over"] = round(proportion * (tot.get("effective_cost_with_over") or 0), 2)
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
    sheets_svc   = _build_sheets_client(access_token)

    title = _build_sheet_title(
        short_token=short_token,
        client_name=client_name,
        campaign_name=campaign_name,
        start_date=start_date,
        end_date=end_date,
    )

    # Cria spreadsheet com 2 abas: "README" e "Base de Dados"
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

    # Resolve sheetIds reais por título da aba.
    sheet_id_by_title = {
        s["properties"]["title"]: s["properties"]["sheetId"]
        for s in created.get("sheets", [])
    }
    base_sheet_id = sheet_id_by_title.get("Base de Dados")
    if base_sheet_id is None:
        # Não deveria acontecer (acabamos de criar), mas se o Google mudou
        # algo no payload, melhor falhar explícito do que estourar adiante.
        _try_delete_spreadsheet(spreadsheet_id, access_token)
        raise RuntimeError("Aba 'Base de Dados' não encontrada na sheet recém-criada")

    # A partir daqui, qualquer falha deixa a sheet órfã no Drive do usuário.
    # Envolvemos o resto em try/except pra deletar nesse caso — UX
    # melhor que acumular sheets vazias quando o user clica de novo.
    try:
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

        # Negrito no header da Base de Dados + frozen row.
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

    # Move pra pasta compartilhada do Drive HYPR (se configurada).
    # Best-effort: se falhar (ex.: usuário sem acesso à pasta), mantém
    # a sheet no My Drive raiz dele e segue. Não é fatal.
    if DRIVE_FOLDER_ID:
        try:
            drive_svc = _build_drive_client(access_token)
            # Pega parents atuais pra remover (geralmente "root" do user).
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
            print(f"[WARN move sheet to folder {spreadsheet_id}] {e}")

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
    totals_rows: List[Dict],
) -> Dict:
    """
    Re-popula a aba Base de Dados de uma sheet existente. Usa refresh_token
    salvo. Atualiza last_synced_at; em caso de erro de auth, marca como
    revoked; outros erros marcam como error.

    detail_rows é enriquecido via _enrich_detail_costs antes da escrita —
    garante consistência com o dash.
    """
    detail_rows = _enrich_detail_costs(detail_rows, totals_rows)
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
        print(f"[WARN _try_delete_spreadsheet {spreadsheet_id}] {e}")


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
