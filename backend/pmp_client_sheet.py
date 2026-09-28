"""
Planilha de cliente do PMP — entrega diária de um deal numa Google Sheet
dedicada, pra o cliente acompanhar sem acesso ao hub.

Mesma ideia das sheets de report de campanha (sheets_integration.py), com o
recorte de dados que PODE ir pro cliente num deal PMP. Só 6 colunas:

    Dia · Token · Line · ID do Seat · Receita Bruta (R$) · Impressões

Custo, margem HYPR, PI, % entrega e tudo o mais do hub ficam de fora. O
recorte é garantido em `build_client_rows`/`build_payload` (as únicas portas
de saída de dado pra planilha) e travado por teste: acrescentar coluna aqui é
decisão comercial, não refactor.

Deal = tudo o que está ligado
-----------------------------
Quem conecta clica numa line, mas quer o DEAL inteiro. A planilha pega
automaticamente todas as lines ligadas à clicada, de forma transitiva:
  • pelos tokens do Command (principal + extras) — lines que compartilham
    qualquer token entram;
  • pelo grupo (Fixed+Flex sob o mesmo PI).
Sem precisar agrupar nada: agrupar mexe em PI/Compplan, e a planilha não
pode exigir isso. A coluna Token diz de qual campanha do Command é cada
row (a entrega vem por line da SSP; line com 2 tokens mostra os 2).

Os membros são recalculados a cada sync: token novo vinculado a outra line
passa a entrar na planilha sozinho.

Chave (`unit_key`, target_id em sheets_integrations, target_type='pmp_line'):
    token:<TOKEN>             âncora = token principal da line clicada
    group:<group_id>          line sem token, agrupada
    line:<source>:<line_id>   line sem token e sem grupo
A chave é só a ÂNCORA — o conjunto real é o fecho a partir dela. Clicar em
qualquer line do mesmo deal acha a mesma planilha (`resolve_for_line`).

ID do Seat
----------
As fontes não expõem o seat do comprador (PubMatic só dá dealMetaId +
publisherDealId; Xandr dá os curated deal ids). O default é o Deal ID que o
cliente ativa no seat da DSP dele, por line: `external_deal_id`
(PM-XXXX-0000) na PubMatic, `deal_ids` no Xandr. Quem conecta pode
sobrescrever — fica em `config_json.seat_id` e vale pra todas as rows.

Ciclo de vida
-------------
- Criação: OAuth do membro (drive.file), igual às sheets de campanha. A
  planilha vai pra pasta HYPR (se configurada) e ganha link público de
  leitura — é o link que se manda pro cliente.
- Sync: push ao fim de cada pmp_sync_v2 (04h BRT) e de cada
  pmp_sync_pubmatic que trouxe dia novo. Best-effort — falha aqui não derruba
  o sync do PMP. Também há sync manual por endpoint.
- `sync_until` = fim do flight/última entrega + SYNC_GRACE_DAYS. Depois disso
  a planilha fica congelada com o dado final (status continua 'active') e o
  alerta de stale não dispara. Fora do cron genérico `sheets_sync_all` (que só
  lê token/merge).
"""

import logging
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional

from google.cloud import bigquery

import sheets_integration
from sheets_integration import (
    BASE_TAB_TITLE,
    SYNC_GRACE_DAYS,
    TARGET_PMP_LINE,
)

logger = logging.getLogger(__name__)

PROJECT_ID = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET    = "prod_assets"
TABLE_LINES_ENRICHED = "pmp_lines_enriched"
TABLE_DELIVERY       = "pmp_line_delivery_daily"

# ─── Recorte de dados do cliente ─────────────────────────────────────────────
# (chave interna da row, header na planilha). Ordem = ordem das colunas.
CLIENT_COLUMNS = [
    ("day",       "Dia"),
    ("tokens",    "Token"),
    ("line_name", "Line"),
    ("seat_id",   "ID do Seat"),
    ("revenue",   "Receita Bruta (R$)"),
    ("imps",      "Impressões"),
]

# Índices 0-based das colunas formatadas (ordem de CLIENT_COLUMNS).
DATE_COL, REVENUE_COL, IMPS_COL = 0, 4, 5
COLUMN_WIDTHS_PX = [96, 130, 360, 160, 150, 120]

# Epoch dos seriais de data do Sheets. O dia vai como NÚMERO (write RAW) com
# formato de data na coluna: ordena e filtra como data de verdade — string ISO
# ficaria texto.
_SHEETS_EPOCH = date(1899, 12, 30)

README_TEXT = [
    ["HYPR — Entrega diária do deal"],
    [""],
    ["• Esta planilha é atualizada automaticamente pela HYPR todos os dias,"],
    ["  na parte da manhã (horário de Brasília)."],
    ["• A aba 'Base de Dados' traz 1 linha por dia e line: Dia, Token, Line,"],
    ["  ID do Seat, Receita Bruta (R$) e Impressões."],
    ["• Só entram dias fechados. Alguns SSPs consolidam a entrega com 1 a 2"],
    ["  dias de atraso, e o dia pode ser revisado nesse período."],
    ["• Edições manuais na aba 'Base de Dados' são sobrescritas na próxima"],
    ["  atualização. Use abas próprias para fórmulas, pivots e gráficos."],
    ["• A atualização para 30 dias após o fim do deal. A planilha continua"],
    ["  acessível depois disso."],
    [""],
    ["Dúvidas: fale com o seu contato na HYPR."],
]

# ─── unit_key ────────────────────────────────────────────────────────────────
_SOURCE_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_GROUP_RE  = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Mesmo formato do pmp_lines.TOKEN_RE (short_token do Command, já UPPER).
_TOKEN_RE  = re.compile(r"^[A-Z0-9][A-Z0-9_-]{1,39}$")


def parse_unit_key(key: str) -> Dict:
    """'token:1PIT7I' → {kind:'token', token}; 'group:ab12' → {kind:'group',
    group_id}; 'line:pubmatic:735537' → {kind:'line', source, line_id}.
    ValueError se malformada — a chave vem do request, então valida antes de
    virar parâmetro de query."""
    key = (key or "").strip()
    parts = key.split(":")
    if len(parts) == 2 and parts[0] == "token" and _TOKEN_RE.match(parts[1]):
        return {"kind": "token", "token": parts[1]}
    if len(parts) == 2 and parts[0] == "group" and _GROUP_RE.match(parts[1]):
        return {"kind": "group", "group_id": parts[1]}
    if len(parts) == 3 and parts[0] == "line" and _SOURCE_RE.match(parts[1]) and parts[2].isdigit():
        return {"kind": "line", "source": parts[1], "line_id": int(parts[2])}
    raise ValueError(f"unit_key inválida: {key!r}")


def _member_key(source, line_id) -> str:
    return f"{source or 'xandr'}:{int(line_id)}"


def line_tokens(line: Dict) -> List[str]:
    """Tokens do Command da line, principal primeiro, normalizados e sem
    repetição. Lê `linked_tokens` (enriched nova) e cai pra short_token +
    extra_short_tokens."""
    raw = line.get("linked_tokens")
    if not raw:
        raw = [line.get("short_token")] + list(line.get("extra_short_tokens") or [])
    out = []
    for t in raw:
        t = str(t or "").strip().upper()
        if t and t not in out:
            out.append(t)
    return out


def anchor_key_for(line: Dict) -> str:
    """Chave de uma planilha NOVA a partir da line clicada: o token principal
    (mais estável que grupo/line — sobrevive a reagrupamento); sem token, o
    grupo; sem grupo, a própria line."""
    toks = line_tokens(line)
    if toks and _TOKEN_RE.match(toks[0]):
        return f"token:{toks[0]}"
    if line.get("group_id"):
        return f"group:{line['group_id']}"
    return f"line:{line.get('source') or 'xandr'}:{int(line['line_id'])}"


def resolve_cluster(all_lines: List[Dict], seeds: List[Dict]) -> List[Dict]:
    """Fecho transitivo a partir de `seeds`: entra toda line que compartilha
    token ou grupo com alguma que já entrou. Ordem estável (a de all_lines)."""
    by_token: Dict[str, List[str]] = {}
    by_group: Dict[str, List[str]] = {}
    by_key: Dict[str, Dict] = {}
    for l in all_lines:
        k = _member_key(l.get("source"), l["line_id"])
        by_key[k] = l
        for t in line_tokens(l):
            by_token.setdefault(t, []).append(k)
        if l.get("group_id"):
            by_group.setdefault(l["group_id"], []).append(k)

    seen = set()
    stack = [_member_key(s.get("source"), s["line_id"]) for s in seeds]
    seen_tokens, seen_groups = set(), set()
    while stack:
        k = stack.pop()
        if k in seen or k not in by_key:
            continue
        seen.add(k)
        l = by_key[k]
        for t in line_tokens(l):
            if t not in seen_tokens:
                seen_tokens.add(t)
                stack.extend(by_token.get(t, []))
        g = l.get("group_id")
        if g and g not in seen_groups:
            seen_groups.add(g)
            stack.extend(by_group.get(g, []))
    return [l for l in all_lines if _member_key(l.get("source"), l["line_id"]) in seen]


def seeds_for_key(all_lines: List[Dict], unit_key: str) -> List[Dict]:
    """Lines onde o fecho começa, conforme a âncora."""
    unit = parse_unit_key(unit_key)
    if unit["kind"] == "token":
        return [l for l in all_lines if unit["token"] in line_tokens(l)]
    if unit["kind"] == "group":
        return [l for l in all_lines if l.get("group_id") == unit["group_id"]]
    return [l for l in all_lines
            if (l.get("source") or "xandr") == unit["source"] and int(l["line_id"]) == unit["line_id"]]


def candidate_keys(members: List[Dict]) -> List[str]:
    """Todas as chaves que uma planilha já existente desse deal pode ter
    (qualquer token, grupo ou line do fecho)."""
    keys = []
    for m in members:
        keys += [f"token:{t}" for t in line_tokens(m)]
        if m.get("group_id"):
            keys.append(f"group:{m['group_id']}")
        keys.append(f"line:{m.get('source') or 'xandr'}:{int(m['line_id'])}")
    return list(dict.fromkeys(keys))


# ─── Regras puras (testadas) ─────────────────────────────────────────────────
def _num(v) -> float:
    if v is None:
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _as_date(v) -> Optional[date]:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def default_seat_id(line: Dict) -> str:
    """Deal ID que o cliente ativa no seat da DSP. PubMatic: publisherDealId
    (external_deal_id). Xandr: curated deal ids (pode ter mais de um)."""
    ext = (line.get("external_deal_id") or "").strip()
    if ext:
        return ext
    ids = line.get("deal_ids") or []
    if isinstance(ids, (int, str)):
        ids = [ids]
    return ", ".join(str(i) for i in ids if i not in (None, ""))


def build_client_rows(
    members: List[Dict],
    delivery: List[Dict],
    seat_override: Optional[str] = None,
) -> List[Dict]:
    """Rows da planilha: 1 por dia × line, só com as colunas do cliente.

    `members`: lines do deal (enriched) — dão nome, token e seat.
    `delivery`: [{source, line_id, day, imps, revenue}] (1+ por dia/line; soma).
    Dia sem impressão nem receita não entra (não é entrega). Ordem: dia, line.
    """
    meta = {_member_key(m.get("source"), m["line_id"]): m for m in members}
    seat_override = (seat_override or "").strip() or None

    acc: Dict[tuple, Dict] = {}
    for d in delivery:
        mk = _member_key(d.get("source"), d["line_id"])
        day = _as_date(d.get("day"))
        if mk not in meta or day is None:
            continue
        row = acc.setdefault((day, mk), {"imps": 0, "revenue": 0.0})
        row["imps"]    += int(_num(d.get("imps")))
        row["revenue"] += _num(d.get("revenue"))

    rows = []
    for (day, mk), r in acc.items():
        if r["imps"] == 0 and round(r["revenue"], 2) == 0:
            continue
        m = meta[mk]
        rows.append({
            "day":       day,
            "tokens":    ", ".join(line_tokens(m)),
            "line_name": m.get("line_name") or m.get("campaign_name") or str(m["line_id"]),
            "seat_id":   seat_override or default_seat_id(m),
            "revenue":   round(r["revenue"], 2),
            "imps":      r["imps"],
        })
    rows.sort(key=lambda r: (r["day"], r["line_name"]))
    return rows


def _date_serial(d: date) -> int:
    return (d - _SHEETS_EPOCH).days


def build_payload(rows: List[Dict]) -> List[List]:
    """Header + rows na ordem de CLIENT_COLUMNS. Só essas chaves saem —
    qualquer campo extra na row é ignorado aqui."""
    out = [[label for _, label in CLIENT_COLUMNS]]
    for r in rows:
        cells = []
        for key, _ in CLIENT_COLUMNS:
            v = r.get(key)
            if key == "day":
                v = _date_serial(v) if isinstance(v, date) else ""
            cells.append("" if v is None else v)
        out.append(cells)
    return out


def compute_sync_until(members: List[Dict]) -> Optional[date]:
    """Fim da janela de sync: o maior entre fim do flight e última entrega,
    + SYNC_GRACE_DAYS. None quando o deal não tem nenhum dos dois (ainda não
    começou) — o caller decide o que manter."""
    candidates = []
    for m in members:
        for f in ("end_date", "last_delivery_day"):
            d = _as_date(m.get(f))
            if d:
                candidates.append(d)
    if not candidates:
        return None
    return max(candidates) + timedelta(days=SYNC_GRACE_DAYS)


def build_title(members: List[Dict]) -> str:
    """'HYPR - {Cliente} - {Campanha} - Entrega PMP'. Partes vazias somem."""
    def first(field):
        for m in members:
            v = str(m.get(field) or "").strip()
            if v:
                return v
        return None

    customer = first("customer")
    campaign = first("campaign_name") or first("group_name") or first("line_name")
    return " - ".join(["HYPR"] + [p for p in (customer, campaign) if p] + ["Entrega PMP"])


def members_summary(members: List[Dict]) -> Dict:
    """O que a UI mostra antes de conectar: quais lines e tokens entram."""
    tokens = []
    for m in members:
        for t in line_tokens(m):
            if t not in tokens:
                tokens.append(t)
    return {
        "tokens": tokens,
        "lines": [
            {
                "source":    m.get("source") or "xandr",
                "line_id":   int(m["line_id"]),
                "line_name": m.get("line_name"),
                "tokens":    line_tokens(m),
            }
            for m in members
        ],
    }


def _format_requests(sheet_id: int) -> List[Dict]:
    """Formato por coluna (persiste entre syncs — write RAW não toca)."""
    def fmt(col, fmt_type, pattern):
        return {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id, "startRowIndex": 1,
                    "startColumnIndex": col, "endColumnIndex": col + 1,
                },
                "cell": {"userEnteredFormat": {
                    "numberFormat": {"type": fmt_type, "pattern": pattern},
                }},
                "fields": "userEnteredFormat.numberFormat",
            }
        }

    reqs = [
        fmt(DATE_COL,    "DATE",     "dd/mm/yyyy"),
        fmt(REVENUE_COL, "CURRENCY", '"R$" #,##0.00'),
        fmt(IMPS_COL,    "NUMBER",   "#,##0"),
    ]
    for col, px in enumerate(COLUMN_WIDTHS_PX):
        reqs.append({
            "updateDimensionProperties": {
                "range": {"sheetId": sheet_id, "dimension": "COLUMNS",
                          "startIndex": col, "endIndex": col + 1},
                "properties": {"pixelSize": px},
                "fields": "pixelSize",
            }
        })
    return reqs


# ─── Leitura (BQ) ────────────────────────────────────────────────────────────
def _full(t: str) -> str:
    return f"`{PROJECT_ID}.{DATASET}.{t}`"


def fetch_all_lines() -> List[Dict]:
    """Todas as lines (~centenas) com o necessário pro fecho e pra planilha.
    Barato, e é o que permite achar o deal inteiro a partir de uma line."""
    sql = f"""
        SELECT COALESCE(source, 'xandr') AS source, line_id, line_name,
               external_deal_id, deal_ids, customer, campaign_name,
               group_id, group_name, end_date, last_delivery_day,
               short_token, extra_short_tokens, linked_tokens
        FROM {_full(TABLE_LINES_ENRICHED)}
        ORDER BY line_id
    """
    out = []
    for r in sheets_integration._bq_client().query(sql).result():
        d = dict(r)
        for f in ("deal_ids", "extra_short_tokens", "linked_tokens"):
            if isinstance(d.get(f), (list, tuple)):
                d[f] = list(d[f])
        out.append(d)
    return out


def fetch_delivery(members: List[Dict]) -> List[Dict]:
    """Entrega diária das lines do deal. Casa pelo par (source, line_id) —
    um dealMetaId PubMatic pode colidir com um line_id Xandr."""
    if not members:
        return []
    pairs = [_member_key(m.get("source"), m["line_id"]) for m in members]
    ids = sorted({int(m["line_id"]) for m in members})
    sql = f"""
        SELECT COALESCE(source, 'xandr') AS source, line_id, day,
               SUM(imps)            AS imps,
               SUM(curator_revenue) AS revenue
        FROM {_full(TABLE_DELIVERY)}
        WHERE line_id IN UNNEST(@ids)
          AND CONCAT(COALESCE(source, 'xandr'), ':', CAST(line_id AS STRING)) IN UNNEST(@pairs)
        GROUP BY 1, 2, 3
    """
    rows = sheets_integration._bq_client().query(
        sql, job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ArrayQueryParameter("ids", "INT64", ids),
            bigquery.ArrayQueryParameter("pairs", "STRING", pairs),
        ]),
    ).result()
    return [dict(r) for r in rows]


def members_for_key(unit_key: str, all_lines: Optional[List[Dict]] = None) -> List[Dict]:
    all_lines = fetch_all_lines() if all_lines is None else all_lines
    return resolve_cluster(all_lines, seeds_for_key(all_lines, unit_key))


def _find_existing(keys: List[str]) -> Optional[str]:
    """Chave da planilha já conectada pra esse deal, se houver (a mais antiga
    ganha — é o link que o cliente já recebeu)."""
    if not keys:
        return None
    sheets_integration.ensure_table_exists()
    sql = f"""
        SELECT short_token
        FROM `{sheets_integration._table_id()}`
        WHERE target_type = @tt AND status != 'deleted'
          AND short_token IN UNNEST(@keys)
        ORDER BY created_at
        LIMIT 1
    """
    rows = list(sheets_integration._bq_client().query(
        sql, job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("tt", "STRING", TARGET_PMP_LINE),
            bigquery.ArrayQueryParameter("keys", "STRING", keys),
        ]),
    ).result())
    return rows[0]["short_token"] if rows else None


def resolve_for_line(source: str, line_id: int) -> Dict:
    """A partir da line clicada: deal inteiro (fecho), chave da planilha
    (existente ou a que seria criada) e resumo pra UI."""
    all_lines = fetch_all_lines()
    clicked = [l for l in all_lines
               if (l.get("source") or "xandr") == (source or "xandr") and int(l["line_id"]) == int(line_id)]
    if not clicked:
        raise ValueError(f"Line {source}:{line_id} não encontrada")
    members = resolve_cluster(all_lines, clicked)
    existing = _find_existing(candidate_keys(members))
    return {
        "unit_key": existing or anchor_key_for(clicked[0]),
        "existing": bool(existing),
        "members":  members,
    }


def _load(unit_key: str, seat_override: Optional[str],
          all_lines: Optional[List[Dict]] = None):
    members = members_for_key(unit_key, all_lines)
    if not members:
        raise ValueError(f"Nenhuma line encontrada pra {unit_key}")
    rows = build_client_rows(members, fetch_delivery(members), seat_override=seat_override)
    return members, build_payload(rows)


def _set_sync_until(unit_key: str, sync_until: Optional[date]) -> None:
    """Best-effort: é régua de alerta/janela, não dado do cliente."""
    if sync_until is None:
        return
    try:
        sheets_integration._bq_client().query(
            f"UPDATE `{sheets_integration._table_id()}` SET sync_until = @su "
            f"WHERE short_token = @tid AND target_type = @tt",
            job_config=bigquery.QueryJobConfig(query_parameters=[
                bigquery.ScalarQueryParameter("su",  "DATE",   sync_until.isoformat()),
                bigquery.ScalarQueryParameter("tid", "STRING", unit_key),
                bigquery.ScalarQueryParameter("tt",  "STRING", TARGET_PMP_LINE),
            ]),
        ).result()
    except Exception as e:
        logger.warning(f"[pmp_client_sheet sync_until {unit_key}] {e}")


def _today_brt() -> date:
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


# ─── Criação ─────────────────────────────────────────────────────────────────
def connect(source: str, line_id: int, refresh_token: str, member_email: str,
            seat_id: Optional[str] = None) -> Dict:
    """Conecta a planilha do deal da line clicada.

    Se o deal já tem planilha (por qualquer line/token dele) e o token novo
    ainda enxerga ela, reaproveita — o cliente não perde o link — e só
    re-sincroniza. Senão cria uma nova. Retorna {unit_key, spreadsheet_id,
    spreadsheet_url, reused}.
    """
    sheets_integration.ensure_table_exists()
    seat_id = (seat_id or "").strip() or None
    resolved = resolve_for_line(source, line_id)
    unit_key = resolved["unit_key"]

    if resolved["existing"]:
        reused = sheets_integration.reattach_existing_sheet(
            unit_key, TARGET_PMP_LINE, refresh_token, member_email,
        )
        if reused:
            sheets_integration.set_integration_config(unit_key, TARGET_PMP_LINE, {"seat_id": seat_id})
            sync(unit_key)
            return {**reused, "unit_key": unit_key, "reused": True}

    members, payload = _load(unit_key, seat_id)
    access_token = sheets_integration._refresh_access_token(refresh_token)
    spreadsheet_id, spreadsheet_url, base_gid = sheets_integration._create_spreadsheet_with_payload(
        title=build_title(members),
        payload=payload,
        access_token=access_token,
        readme_text=README_TEXT,
        extra_format_requests=_format_requests,
    )

    sync_until = compute_sync_until(members) or (_today_brt() + timedelta(days=SYNC_GRACE_DAYS))
    now = datetime.now(timezone.utc)
    sheets_integration._upsert_integration({
        "target_id":         unit_key,
        "target_type":       TARGET_PMP_LINE,
        "spreadsheet_id":    spreadsheet_id,
        "spreadsheet_url":   spreadsheet_url,
        "created_by_email":  member_email,
        "refresh_token_enc": sheets_integration._bytes_to_b64(
            sheets_integration._encrypt(refresh_token)
        ),
        "created_at":        now.isoformat(),
        "last_synced_at":    now.isoformat(),
        "sync_until":        sync_until.isoformat(),
        "status":            "active",
        "last_error":        None,
        "base_sheet_gid":    base_gid,
        "base_tab_title":    BASE_TAB_TITLE,
    })
    sheets_integration.set_integration_config(unit_key, TARGET_PMP_LINE, {"seat_id": seat_id})
    return {"unit_key": unit_key, "spreadsheet_id": spreadsheet_id,
            "spreadsheet_url": spreadsheet_url, "reused": False}


# ─── Sync ────────────────────────────────────────────────────────────────────
def sync(unit_key: str, all_lines: Optional[List[Dict]] = None) -> Dict:
    """Reescreve a Base de Dados da planilha do deal. Mesma semântica de
    erro das sheets de campanha (write-first, transiente preserva status,
    403/404 → revoked, aba renomeada é reencontrada)."""
    integ = sheets_integration.get_integration(unit_key, target_type=TARGET_PMP_LINE)
    if not integ:
        raise ValueError(f"Integração pmp_line não encontrada para {unit_key}")

    sheets_integration._mark_attempt(unit_key, TARGET_PMP_LINE)
    seat_override = (integ.get("config") or {}).get("seat_id")
    try:
        members, payload = _load(unit_key, seat_override, all_lines)
    except ValueError as e:
        # Token desvinculado de todas as lines / grupo desfeito. Não escreve
        # nada (apagaria o histórico do cliente); só registra.
        sheets_integration._update_status(unit_key, target_type=TARGET_PMP_LINE,
                                          last_error=str(e)[:500])
        raise

    refresh_token = sheets_integration._resolve_refresh_token(integ, unit_key, TARGET_PMP_LINE)
    access_token  = sheets_integration._exchange_or_mark(refresh_token, unit_key, TARGET_PMP_LINE)
    sheets_svc    = sheets_integration._build_sheets_client(access_token)

    sheets_integration._write_base_de_dados(
        sheets_svc, integ["spreadsheet_id"], payload,
        unit_key, TARGET_PMP_LINE,
        tab_name=integ.get("base_tab_title") or BASE_TAB_TITLE,
        base_gid=integ.get("base_sheet_gid"),
    )
    sheets_integration._update_status(
        unit_key, target_type=TARGET_PMP_LINE,
        status="active",
        last_synced_at=datetime.now(timezone.utc),
        last_error="",
    )
    _set_sync_until(unit_key, compute_sync_until(members))
    return {"spreadsheet_id": integ["spreadsheet_id"], "rows": len(payload) - 1}


def list_due() -> List[str]:
    """unit_keys que o push pós-sync deve atualizar: active/error dentro da
    janela. Quem está há mais tempo sem sync vem primeiro (se o orçamento de
    tempo estourar, o atrasado não fica atrás de novo)."""
    sheets_integration.ensure_table_exists()
    sql = f"""
        SELECT short_token
        FROM `{sheets_integration._table_id()}`
        WHERE target_type = @tt
          AND status IN ('active', 'error')
          AND (sync_until IS NULL OR sync_until >= CURRENT_DATE("America/Sao_Paulo"))
        ORDER BY last_synced_at NULLS FIRST
    """
    rows = sheets_integration._bq_client().query(
        sql, job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("tt", "STRING", TARGET_PMP_LINE),
        ]),
    ).result()
    return [r["short_token"] for r in rows]


# Teto de tempo do push pós-sync. O pmp_sync_pubmatic/pmp_sync_v2 têm
# deadline de 540s e já gastam boa parte no report + refresh da enriched; o
# que não couber vai no próximo sync (a ordem de `list_due` garante rodízio).
PUSH_TIME_BUDGET_S = 150


def sync_all_connected(time_budget_s: float = PUSH_TIME_BUDGET_S) -> Dict:
    """Push pós-sync do PMP. Erro de uma planilha não para as outras."""
    t0 = time.time()
    summary = {"due": 0, "synced": 0, "errors": 0, "deferred": 0}
    due = list_due()
    summary["due"] = len(due)
    if not due:
        return summary
    # 1 leitura da enriched pro lote todo (o fecho de cada deal sai dela).
    all_lines = fetch_all_lines()
    for i, key in enumerate(due):
        if time.time() - t0 > time_budget_s:
            summary["deferred"] = len(due) - i
            logger.warning(f"[pmp_client_sheet push] orçamento de {time_budget_s}s "
                           f"estourou — {summary['deferred']} ficam pro próximo sync")
            break
        try:
            sync(key, all_lines)
            summary["synced"] += 1
        except Exception as e:
            summary["errors"] += 1
            logger.warning(f"[pmp_client_sheet push {key}] {e}")
    return summary
