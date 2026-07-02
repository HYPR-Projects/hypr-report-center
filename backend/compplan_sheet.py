"""
Compplan Sheet — planilha Google auto-atualizada com o compplan do PMP.

Espelha a aba "Compplan" do export do PMP Deals (frontend:
src/v2/admin/lib/compplanExport.js) numa planilha Google que fica SEMPRE
atualizada, sem exportar/colar manual. Modelo da HYPR_PMP_Deals_All-Time:
1 row por DEAL (grupos Fixed+Flex colapsam no PI compartilhado), all-time.

Como funciona
-------------
- Integração singleton na tabela `sheets_integrations` com
  target_type='compplan', target_id='pmp_compplan'. Reusa TODA a infra de
  sheets_integration.py (OAuth drive.file, refresh_token no KMS, write-first,
  retries de transiente, alerta de stale).
- O membro conecta uma vez via OAuth (botão no PMP Deals); o backend CRIA
  uma planilha nova no Drive dele ("HYPR_PMP_Deals_All-Time (Auto)") — o
  scope drive.file não permite escrever numa sheet pré-existente criada à
  mão, então a planilha antiga é substituída por esta.
- Push automático ao fim de cada `pmp_sync_v2` (cron diário 04:00 BRT),
  best-effort — falha no push não derruba o sync do Xandr. Também há
  sync manual via endpoint.
- `sync_until` fica NULL de propósito: mantém a row FORA do cron genérico
  `sheets_sync_all` (que filtra sync_until >= hoje) e do auto-pause de
  expiradas. O ciclo de vida dela é o do pmp_sync_v2.

Diferenças deliberadas vs sheets de campanha
--------------------------------------------
- SEM permissão de link público ("anyone") — compplan é dado de comp
  pessoal, só o Drive do dono.
- SEM mover pra pasta compartilhada HYPR (mesma razão).

IMPORTANTE: a lógica de negócio (build_compplan_rows) DEVE ficar em
sincronia com compplanExport.js — constantes e regras são as mesmas.
"""

import logging
import os
from datetime import date, datetime, timezone
from typing import Dict, List, Optional

from google.cloud import bigquery
from googleapiclient.errors import HttpError

import sheets_integration
from sheets_integration import (
    TARGET_COMPPLAN,
    _SHEETS_NUM_RETRIES,
)

logger = logging.getLogger(__name__)

PROJECT_ID = os.environ.get("GCP_PROJECT", "site-hypr")

# Id lógico da integração singleton (coluna short_token da sheets_integrations).
COMPPLAN_TARGET_ID = "pmp_compplan"

SHEET_TITLE = "HYPR_PMP_Deals_All-Time (Auto)"
TAB_NAME    = "Compplan"

# ─── Regras de negócio (espelho de compplanExport.js) ────────────────────────
# PI líquido = PI negociado × fator (comissão/impostos).
PI_NET_FACTOR = 0.8347

# Comp: entrega total (% Delivery Rev ≥ 99%) paga 0,75% do PI líquido;
# abaixo disso paga 0,25%.
COMPP_FULL_RATE          = 0.0075
COMPP_PARTIAL_RATE       = 0.0025
COMPP_DELIVERY_THRESHOLD = 0.99

STATUS_EN = {
    "Finalizado": "Finished",
    "Andamento":  "Running",
    "Pausado":    "Paused",
    "Pendente":   "Not Started",
    "Revisão":    "Review",
    "Cancelado":  "Canceled",
}

# Status do deal quando o grupo tem lines em estados diferentes: o mais
# "vivo" ganha (uma line rodando = deal rodando).
STATUS_PRIORITY = ["Andamento", "Revisão", "Pausado", "Pendente", "Finalizado", "Cancelado"]

COMPPLAN_COLUMNS = [
    "Customer", "Deal ID", "Campaign Total", "Flight Date",
    "Client PI Negotiation", "Client PI Net", "Impressions",
    "Curator Cost", "Curator Revenue", "Curator Margin",
    "Margin %", "% Delivery Margin", "% Delivery Rev.",
    "eCPM", "Status", "Compp",
]

# Índices 0-based das colunas por formato (mesmos do applyCompplanFormats).
CURRENCY_COLS = [4, 5, 7, 8, 9, 13, 15]
PERCENT_COLS  = [10, 11, 12]
INT_COLS      = [6]

# ─── Colunas calculadas como FÓRMULA na sheet ────────────────────────────────
# Pedido do João: Client PI Net e Compp precisam ficar auditáveis — célula
# com a conta visível, não número pronto. O write principal (RAW) já deixa
# os valores estáticos corretos; um overlay reescreve F e P como fórmulas
# equivalentes (mesmos números após recálculo). Se o overlay falhar, os
# valores estáticos permanecem — por isso é best-effort.
#
# Letras das colunas (ordem de COMPPLAN_COLUMNS):
#   E = Client PI Negotiation · F = Client PI Net · I = Curator Revenue
#   M = % Delivery Rev. · P = Compp
PI_COL      = "E"
PI_NET_COL  = "F"
REV_COL     = "I"
PCT_REV_COL = "M"
COMPP_COL   = "P"


def pi_net_formula(n: int) -> str:
    """Fórmula do PI líquido na linha `n` (1-based da sheet)."""
    return f'=IF({PI_COL}{n}="","",ROUND({PI_COL}{n}*{PI_NET_FACTOR},2))'


def compp_formula(n: int) -> str:
    """Fórmula do Compp na linha `n`: 0,75% do PI líquido se %Delivery Rev
    ≥ 99%, senão 0,25%; em branco sem PI ou sem delivery."""
    return (
        f'=IF(OR({PI_NET_COL}{n}="",{REV_COL}{n}<=0),"",'
        f'ROUND({PI_NET_COL}{n}*IF({PCT_REV_COL}{n}>={COMPP_DELIVERY_THRESHOLD},'
        f'{COMPP_FULL_RATE},{COMPP_PARTIAL_RATE}),2))'
    )

README_TEXT = [
    ["HYPR — Compplan PMP Deals (All-Time)"],
    [""],
    ["• Esta planilha é alimentada automaticamente pelo HYPR Report Center."],
    ["• A aba 'Compplan' é totalmente sobrescrita após cada sync diário do"],
    ["  PMP (~04:00 BRT) e a cada 'Sincronizar agora' no PMP Deals."],
    ["• Edições manuais na aba 'Compplan' serão perdidas na próxima"],
    ["  atualização. Use abas adicionais (criadas por você) pra anotações,"],
    ["  fórmulas ou pivots — essas não são tocadas."],
    ["• Modelo: 1 linha por deal, lifetime. Grupos de lines (Fixed+Flex sob"],
    ["  o mesmo PI) aparecem colapsados numa linha só."],
]


# ─── Port de buildCompplanRows (compplanExport.js) ───────────────────────────
def _num(v) -> float:
    """Coage NUMERIC/Decimal/str/None do BQ pra float (0 se vazio)."""
    if v is None:
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _round2(v: float) -> float:
    return round(v * 100) / 100


def effective_status(line: Dict) -> str:
    """Port de pmpFormat.effectiveStatus: 'Pendente' é tratado como 'auto'
    (deriva do delivery_status); qualquer outro valor é override manual."""
    s = line.get("status")
    if s and s != "Pendente":
        return s
    ds = line.get("delivery_status")
    if ds in ("live", "running"):
        return "Andamento"
    if ds == "slowing":
        return "Pausado"
    if ds in ("stopped", "ended", "archived"):
        return "Finalizado"
    return "Pendente"


def resolve_group_pi(members: List[Dict]) -> Optional[float]:
    """PI compartilhado de um grupo: primeiro membro com pi_brl > 0 (nem
    todo membro tem PI setado — só os com Command vinculado)."""
    for m in members:
        pi = m.get("pi_brl")
        if pi is not None and _num(pi) > 0:
            return _num(pi)
    return None


def quarter_label(ymd) -> str:
    """'2026-05-06' (str ou date) → 'Q2 - 26' (formato Flight Date)."""
    if not ymd:
        return ""
    s = ymd.isoformat() if isinstance(ymd, (date, datetime)) else str(ymd)
    parts = s[:10].split("-")
    if len(parts) < 2:
        return ""
    try:
        y, m = int(parts[0]), int(parts[1])
    except ValueError:
        return ""
    if not y or not m:
        return ""
    q = (m + 2) // 3
    return f"Q{q} - {y % 100:02d}"


def build_compplan_rows(lines: List[Dict]) -> List[Dict]:
    """1 unidade-de-conta por deal: grupo colapsa, line solta fica 1:1.
    Retorna list de dicts com as chaves de COMPPLAN_COLUMNS, ordenada
    cronologicamente por flight (start_date)."""
    units: Dict[str, List[Dict]] = {}
    for l in lines:
        if l.get("is_archived"):
            continue
        if effective_status(l) == "Cancelado":
            continue
        key = l.get("group_id") or f"line:{l.get('line_id')}"
        units.setdefault(key, []).append(l)

    rows = []
    for members in units.values():
        def pick(fn):
            for m in members:
                v = fn(m)
                if v:
                    return v
            return None

        def acc(field):
            return sum(_num(m.get(field)) for m in members)

        pi      = resolve_group_pi(members)
        pi_net  = _round2(pi * PI_NET_FACTOR) if pi is not None and pi > 0 else None
        imps    = acc("imps")
        cost    = acc("curator_total_cost")
        revenue = acc("curator_revenue")
        margin  = acc("curator_margin")

        deal_ids = []
        for m in members:
            for d in (m.get("deal_ids") or []):
                if d not in deal_ids:
                    deal_ids.append(d)

        status_pt = next(
            (s for s in STATUS_PRIORITY
             if any(effective_status(m) == s for m in members)),
            "Pendente",
        )
        starts = sorted(
            s.isoformat() if isinstance(s, (date, datetime)) else str(s)
            for s in (m.get("start_date") for m in members) if s
        )
        start_date = starts[0] if starts else None

        pct_margin = (margin / pi) if pi and pi > 0 else None
        pct_rev    = (revenue / pi) if pi and pi > 0 else None
        # Comp só calculado quando já houve delivery — deal Not Started
        # fica em branco (não dá pra saber a faixa ainda).
        compp = None
        if pi_net is not None and revenue > 0:
            rate = COMPP_FULL_RATE if pct_rev >= COMPP_DELIVERY_THRESHOLD else COMPP_PARTIAL_RATE
            compp = _round2(pi_net * rate)

        rows.append({
            "_sort": start_date or "9999-99-99",
            "Customer":              pick(lambda m: m.get("customer")) or "",
            "Deal ID":               ", ".join(str(d) for d in deal_ids),
            "Campaign Total":        pick(lambda m: m.get("group_name") if m.get("group_id") else None)
                                     or pick(lambda m: m.get("campaign_name")) or "",
            "Flight Date":           quarter_label(start_date),
            "Client PI Negotiation": pi if pi is not None else "",
            "Client PI Net":         pi_net if pi_net is not None else "",
            "Impressions":           imps,
            "Curator Cost":          _round2(cost),
            "Curator Revenue":       _round2(revenue),
            "Curator Margin":        _round2(margin),
            "Margin %":              (margin / revenue) if revenue > 0 else "",
            "% Delivery Margin":     pct_margin if pct_margin is not None else "",
            "% Delivery Rev.":       pct_rev if pct_rev is not None else "",
            "eCPM":                  _round2(revenue * 1000 / imps) if imps > 0 else "",
            "Status":                STATUS_EN.get(status_pt, status_pt),
            "Compp":                 compp if compp is not None else "",
        })

    rows.sort(key=lambda r: r["_sort"])
    for r in rows:
        del r["_sort"]
    return rows


def build_payload(rows: List[Dict]) -> List[List]:
    """Header + rows na ordem de COMPPLAN_COLUMNS, pronto pra values.update."""
    return [list(COMPPLAN_COLUMNS)] + [
        [r.get(c, "") for c in COMPPLAN_COLUMNS] for r in rows
    ]


# ─── Leitura das lines (BQ) ──────────────────────────────────────────────────
def fetch_lines() -> List[Dict]:
    """Lê da pmp_lines_enriched só os campos que o compplan usa. Sem filtro
    de estado — build_compplan_rows filtra archived/cancelado (mesmo dataset
    do frontend, que carrega include_archived=true + only_active=false)."""
    sql = f"""
        SELECT
          line_id, group_id, group_name, customer, campaign_name,
          deal_ids, start_date, status, delivery_status, is_archived,
          pi_brl, imps, curator_total_cost, curator_revenue, curator_margin
        FROM `{PROJECT_ID}.prod_assets.pmp_lines_enriched`
    """
    out = []
    for r in sheets_integration._bq_client().query(sql).result():
        d = dict(r)
        if isinstance(d.get("deal_ids"), (list, tuple)):
            d["deal_ids"] = list(d["deal_ids"])
        out.append(d)
    return out


def _write_formula_columns(sheets_svc, spreadsheet_id: str, n_data_rows: int) -> None:
    """Sobrepõe as colunas F (Client PI Net) e P (Compp) com fórmulas.

    USER_ENTERED faz o Sheets parsear a string como fórmula — mas o parse
    depende do LOCALE do spreadsheet (pt_BR usa ';' como separador e ','
    decimal, o que quebraria '0.0075'). Normalizamos o locale pra en_US
    antes — mesmo formato da planilha manual original do compplan
    (números R$1,234.56), então zero mudança visual pro João.
    """
    if n_data_rows <= 0:
        return
    sheets_svc.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": [{
            "updateSpreadsheetProperties": {
                "properties": {"locale": "en_US"},
                "fields": "locale",
            }
        }]},
    ).execute(num_retries=_SHEETS_NUM_RETRIES)

    end = n_data_rows + 1  # +1 pelo header (dados começam na linha 2)
    sheets_svc.spreadsheets().values().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            "valueInputOption": "USER_ENTERED",
            "data": [
                {
                    "range": f"'{TAB_NAME}'!{PI_NET_COL}2:{PI_NET_COL}{end}",
                    "values": [[pi_net_formula(i + 2)] for i in range(n_data_rows)],
                },
                {
                    "range": f"'{TAB_NAME}'!{COMPP_COL}2:{COMPP_COL}{end}",
                    "values": [[compp_formula(i + 2)] for i in range(n_data_rows)],
                },
            ],
        },
    ).execute(num_retries=_SHEETS_NUM_RETRIES)


# ─── Criação da sheet ────────────────────────────────────────────────────────
def _format_requests(tab_sheet_id: int) -> List[Dict]:
    """batchUpdate requests: header bold + frozen + numberFormat por coluna
    + larguras. Formatos são aplicados na COLUNA inteira (persistem entre
    syncs — values.update RAW não toca formatação)."""
    reqs = [
        {
            "repeatCell": {
                "range": {"sheetId": tab_sheet_id, "startRowIndex": 0, "endRowIndex": 1},
                "cell": {"userEnteredFormat": {"textFormat": {"bold": True}}},
                "fields": "userEnteredFormat.textFormat.bold",
            }
        },
        {
            "updateSheetProperties": {
                "properties": {
                    "sheetId": tab_sheet_id,
                    "gridProperties": {"frozenRowCount": 1},
                },
                "fields": "gridProperties.frozenRowCount",
            }
        },
    ]

    def _fmt(cols, fmt_type, pattern):
        for c in cols:
            reqs.append({
                "repeatCell": {
                    "range": {
                        "sheetId": tab_sheet_id,
                        "startRowIndex": 1,
                        "startColumnIndex": c,
                        "endColumnIndex": c + 1,
                    },
                    "cell": {"userEnteredFormat": {
                        "numberFormat": {"type": fmt_type, "pattern": pattern},
                    }},
                    "fields": "userEnteredFormat.numberFormat",
                }
            })

    _fmt(CURRENCY_COLS, "CURRENCY", '"R$"#,##0.00')
    _fmt(PERCENT_COLS,  "PERCENT",  "0.00%")
    _fmt(INT_COLS,      "NUMBER",   "#,##0")

    # Larguras (px ≈ wch×7+12, valores do applyCompplanFormats)
    widths = [124, 110, 250, 82, 138, 124, 103, 110, 124, 117, 75, 124, 110, 89, 96, 89]
    for c, w in enumerate(widths):
        reqs.append({
            "updateDimensionProperties": {
                "range": {
                    "sheetId": tab_sheet_id, "dimension": "COLUMNS",
                    "startIndex": c, "endIndex": c + 1,
                },
                "properties": {"pixelSize": w},
                "fields": "pixelSize",
            }
        })
    return reqs


def create_compplan_sheet(refresh_token: str, member_email: str) -> Dict:
    """Cria a planilha no Drive do membro (via refresh_token), popula a aba
    Compplan com o dataset atual e persiste a integração singleton.

    Deliberadamente NÃO seta link público nem move pra pasta compartilhada
    (dado de comp pessoal) — por isso não reusa _create_spreadsheet_with_payload.
    """
    sheets_integration.ensure_table_exists()
    payload = build_payload(build_compplan_rows(fetch_lines()))
    access_token = sheets_integration._refresh_access_token(refresh_token)
    sheets_svc = sheets_integration._build_sheets_client(access_token)

    created = sheets_svc.spreadsheets().create(
        body={
            "properties": {"title": SHEET_TITLE},
            "sheets": [
                {"properties": {"title": "README"}},
                {"properties": {"title": TAB_NAME}},
            ],
        },
        fields="spreadsheetId,spreadsheetUrl,sheets.properties.sheetId,sheets.properties.title",
    ).execute(num_retries=_SHEETS_NUM_RETRIES)
    spreadsheet_id  = created["spreadsheetId"]
    spreadsheet_url = created["spreadsheetUrl"]

    tab_sheet_id = next(
        (s["properties"]["sheetId"] for s in created.get("sheets", [])
         if s["properties"]["title"] == TAB_NAME),
        None,
    )
    if tab_sheet_id is None:
        sheets_integration._try_delete_spreadsheet(spreadsheet_id, access_token)
        raise RuntimeError(f"Aba '{TAB_NAME}' não encontrada na sheet recém-criada")

    try:
        sheets_svc.spreadsheets().values().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={
                "valueInputOption": "RAW",
                "data": [
                    {"range": "README!A1",       "values": README_TEXT},
                    {"range": f"{TAB_NAME}!A1",  "values": payload},
                ],
            },
        ).execute(num_retries=_SHEETS_NUM_RETRIES)

        sheets_svc.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": _format_requests(tab_sheet_id)},
        ).execute(num_retries=_SHEETS_NUM_RETRIES)
    except Exception:
        sheets_integration._try_delete_spreadsheet(spreadsheet_id, access_token)
        raise

    # Overlay de fórmulas (F/P). Best-effort: os valores estáticos já
    # escritos acima são idênticos — falha aqui não invalida a sheet.
    try:
        _write_formula_columns(sheets_svc, spreadsheet_id, len(payload) - 1)
    except Exception as e:
        logger.warning(f"[compplan create formulas] {e} (valores estáticos permanecem)")

    now = datetime.now(timezone.utc)
    sheets_integration._upsert_integration({
        "target_id":         COMPPLAN_TARGET_ID,
        "target_type":       TARGET_COMPPLAN,
        "spreadsheet_id":    spreadsheet_id,
        "spreadsheet_url":   spreadsheet_url,
        "created_by_email":  member_email,
        "refresh_token_enc": sheets_integration._bytes_to_b64(
            sheets_integration._encrypt(refresh_token)
        ),
        "created_at":        now.isoformat(),
        "last_synced_at":    now.isoformat(),
        # NULL de propósito — fica fora do cron sheets_sync_all e do
        # auto-pause de expiradas (o push vive no pmp_sync_v2).
        "sync_until":        None,
        "status":            "active",
        "last_error":        None,
    })

    return {"spreadsheet_id": spreadsheet_id, "spreadsheet_url": spreadsheet_url}


# ─── Sync ────────────────────────────────────────────────────────────────────
def sync_compplan_sheet() -> Dict:
    """Reescreve a aba Compplan da planilha existente com o dataset atual.
    Mesma semântica de erro do sync de campanha (write-first, transiente
    preserva status, 403/404 → revoked)."""
    integ = sheets_integration.get_integration(
        COMPPLAN_TARGET_ID, target_type=TARGET_COMPPLAN,
    )
    if not integ:
        raise ValueError("Integração compplan não encontrada")

    sheets_integration._mark_attempt(COMPPLAN_TARGET_ID, TARGET_COMPPLAN)
    refresh_token = sheets_integration._resolve_refresh_token(
        integ, COMPPLAN_TARGET_ID, TARGET_COMPPLAN,
    )
    access_token = sheets_integration._exchange_or_mark(
        refresh_token, COMPPLAN_TARGET_ID, TARGET_COMPPLAN,
    )
    sheets_svc = sheets_integration._build_sheets_client(access_token)

    payload = build_payload(build_compplan_rows(fetch_lines()))
    sheets_integration._write_base_de_dados(
        sheets_svc, integ["spreadsheet_id"], payload,
        COMPPLAN_TARGET_ID, TARGET_COMPPLAN, tab_name=TAB_NAME,
    )

    # Overlay de fórmulas (F/P) por cima dos valores estáticos recém-escritos.
    # Best-effort: se falhar, a sheet fica com os mesmos números (só sem a
    # conta visível na célula) — não derruba o sync.
    try:
        _write_formula_columns(sheets_svc, integ["spreadsheet_id"], len(payload) - 1)
    except Exception as e:
        logger.warning(f"[compplan sync formulas] {e} (valores estáticos permanecem)")

    sheets_integration._update_status(
        COMPPLAN_TARGET_ID, target_type=TARGET_COMPPLAN,
        status="active",
        last_synced_at=datetime.now(timezone.utc),
        last_error="",
    )
    return {"spreadsheet_id": integ["spreadsheet_id"], "rows": len(payload) - 1}


def sync_if_connected() -> Optional[Dict]:
    """Push pós pmp_sync_v2. Retorna None quando não há integração conectada
    (ou está revoked/paused — sem sentido re-tentar automaticamente).
    'error' re-tenta: pode ter sido transiente do Google no dia anterior."""
    integ = sheets_integration.get_integration(
        COMPPLAN_TARGET_ID, target_type=TARGET_COMPPLAN,
    )
    if not integ or integ.get("status") not in ("active", "error"):
        return None
    return sync_compplan_sheet()
