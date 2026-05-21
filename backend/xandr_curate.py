"""
Xandr Curate Analytics API — integração com a Cloud Function HYPR Report Hub.

Substitui o fluxo manual de baixar reports do Curator Analytics e alimentar
a planilha "HYPR Product Performance". O sync popula `pmp_deals_delivery`
via `pmp_deals.upsert_delivery_rows`.

Fluxo da API (https://learn.microsoft.com/en-us/xandr/digital-platform-api/)
-------------------------------------------------------------------------
  1. POST /auth com user/pass → token (TTL 2h sliding, 24h hard).
  2. POST /report com JSON {report_type, columns, report_interval, ...}
     → recebe report_id. Async.
  3. GET /report?id=... em loop até execution_status="ready".
  4. GET /report-download?id=... → CSV bytes.

Credenciais
-----------
Vivem no Secret Manager (`XANDR_CURATE_USER`, `XANDR_CURATE_PASS`,
`XANDR_CURATE_MEMBER_ID`) — a Cloud Function injeta como envvars no deploy
(ver deploy.sh). Fora do GCP (ex: rodando o script local) lê do ambiente
do shell direto.

Token cache
-----------
Token vale 2h. Cacheamos em memória entre invocações da mesma instância
da Cloud Function. Cold start re-autentica (50-100ms extra) — aceitável
por rodar 1x/dia via scheduler ou raras vezes via botão admin.

Rate limit
----------
API permite só 10 auths/5min — por isso é importante reusar o token.
Sem cache, um burst de 11 syncs em 5min bateria limite e quebraria.
"""

import csv
import io
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional

import pmp_deals


logger = logging.getLogger(__name__)


BASE_URL = "https://api.appnexus.com"

# Colunas v1 (deal-level) — legado, mantidas pra retrocompat.
REPORT_COLUMNS = [
    "day",
    "curated_deal_id",
    "curated_deal_name",
    "curated_deal_insertion_order_name",
    "imps",
    "viewed_imps",
    "clicks",
    "curator_net_media_cost",
    "curator_tech_fees",
    "curator_total_cost",
    "curator_revenue",
    "curator_margin",
]

# Colunas v2 (line-level) — granularidade real do negócio. O Curator
# Analytics suporta a dimensão `curated_deal_line_item_id` que mapeia
# direto pra Line do Xandr (objeto onde vive flighting/budget/bid).
#
# CURRENCY: o Xandr Curate sempre retorna os valores monetários na
# `member_currency` do seat (USD pra HYPR). Pra obter os valores em
# moeda local (BRL = billing_currency da HYPR), MULTIPLICAMOS por
# `billing_exchange_rate` — que é a taxa USD→BRL do DIA daquele auction.
# Sem isso, os valores aparecem ~5x menores que a realidade (taxa atual
# do real). Ver `parse_csv_line_level` pra aplicação.
REPORT_COLUMNS_LINE = [
    "day",
    "curated_deal_line_item_id",
    "curated_deal_line_item_name",
    "curated_deal_id",
    "billing_exchange_rate",     # ← USD → BRL desse dia (5.0~5.2 atualmente)
    "billing_currency",          # ← guardamos pra auditoria/sanity check
    "imps",
    "viewed_imps",
    "clicks",
    "curator_net_media_cost",
    "curator_tech_fees",
    "curator_total_cost",
    "curator_revenue",
    "curator_margin",
]

# Polling
POLL_INTERVAL_SEC = 2
POLL_MAX_ATTEMPTS = 90    # 90 × 2s = 3min — reports curtos voltam em <5s,
                           # mas janelas maiores podem precisar de mais.

# Cache de token em memória (process-local, sobrevive entre invocations
# da mesma instância da Cloud Function).
_cached_token: Optional[str] = None
_cached_token_exp_ms: float = 0.0
# Janela de segurança — renova 5min antes do limite oficial de 2h pra
# evitar ser pego com token expirado no meio de uma chamada.
_TOKEN_TTL_MS = (2 * 60 * 60 - 5 * 60) * 1000


class XandrError(RuntimeError):
    """Erros específicos da integração Xandr (auth, report, download)."""
    pass


def _env(name: str) -> str:
    """Lê env var com erro útil se ausente."""
    val = os.environ.get(name)
    if not val:
        raise XandrError(
            f"Variável de ambiente '{name}' não definida. Configure no "
            f"Secret Manager e re-deploye a Cloud Function (ver deploy.sh)."
        )
    return val


def _http(method: str, path: str, token: Optional[str] = None,
          body: Optional[dict] = None, timeout: int = 60) -> dict:
    """Chama a Xandr API e devolve o JSON parsed.

    Levanta XandrError em HTTP != 2xx ou em respostas com `status != OK`.
    """
    url = BASE_URL + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            err = json.loads(raw).get("response", {}).get("error", raw.decode("utf-8", "ignore"))
        except Exception:
            err = raw.decode("utf-8", "ignore")
        raise XandrError(f"HTTP {e.code} {method} {path}: {err}")
    except urllib.error.URLError as e:
        raise XandrError(f"Falha de rede {method} {path}: {e}")

    try:
        payload = json.loads(raw)
    except Exception as e:
        raise XandrError(f"Resposta não-JSON em {method} {path}: {e}")

    resp = payload.get("response") or {}
    if resp.get("status") not in (None, "OK"):
        raise XandrError(f"Xandr retornou status={resp.get('status')}: {resp.get('error') or resp}")
    return payload


def _http_get_bytes(path: str, token: str, timeout: int = 120) -> bytes:
    """GET binário (usado pelo /report-download que retorna CSV cru)."""
    url = BASE_URL + path
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise XandrError(f"HTTP {e.code} GET {path}: {e.read().decode('utf-8','ignore')}")
    except urllib.error.URLError as e:
        raise XandrError(f"Falha de rede GET {path}: {e}")


def get_token(force_refresh: bool = False) -> str:
    """Retorna um token Xandr válido. Re-autentica se cache expirou.

    Token cacheado em memória do process (sobrevive entre requests da
    mesma instância da Cloud Function). Cold start re-autentica.
    """
    global _cached_token, _cached_token_exp_ms
    now_ms = time.time() * 1000
    if not force_refresh and _cached_token and now_ms < _cached_token_exp_ms:
        return _cached_token

    user = _env("XANDR_CURATE_USER")
    password = _env("XANDR_CURATE_PASS")
    payload = _http("POST", "/auth", body={"auth": {"username": user, "password": password}})
    token = (payload.get("response") or {}).get("token")
    if not token:
        raise XandrError(f"Auth bem-sucedido mas sem token na resposta: {payload}")
    _cached_token = token
    _cached_token_exp_ms = now_ms + _TOKEN_TTL_MS
    logger.info("[xandr] novo token emitido (TTL %dmin)", _TOKEN_TTL_MS // 60_000)
    return token


def _build_report_body(start_date: Optional[date] = None,
                       end_date: Optional[date]   = None,
                       report_interval: str = "last_7_days") -> dict:
    """Monta o JSON do POST /report.

    Se start_date e end_date forem passados, eles sobrescrevem o
    report_interval (Xandr aceita ambos — start/end têm precedência).

    O filter por member_id é obrigatório pra escopo do curator.
    """
    member_id = int(_env("XANDR_CURATE_MEMBER_ID"))
    body = {
        "report": {
            "report_type":     "curator_analytics",
            "columns":         REPORT_COLUMNS,
            "format":          "csv",
            "report_interval": report_interval,
            "filters":         [{"member_id": member_id}],
        }
    }
    if start_date and end_date:
        body["report"]["start_date"] = start_date.strftime("%Y-%m-%d %H:%M:%S")
        body["report"]["end_date"]   = end_date.strftime("%Y-%m-%d %H:%M:%S")
        # Quando temos datas explícitas, removemos report_interval pra
        # evitar conflito de prioridade (a API aceita os dois mas é
        # melhor não ambiguar).
        body["report"].pop("report_interval", None)
    return body


def request_report(start_date: Optional[date] = None,
                   end_date: Optional[date]   = None,
                   report_interval: str = "last_7_days") -> str:
    """POSTa o request e devolve o report_id."""
    token = get_token()
    body = _build_report_body(start_date, end_date, report_interval)
    payload = _http("POST", "/report", token=token, body=body)
    report_id = (payload.get("response") or {}).get("report_id")
    if not report_id:
        raise XandrError(f"POST /report sem report_id: {payload}")
    return report_id


def wait_for_report(report_id: str,
                    interval_sec: float = POLL_INTERVAL_SEC,
                    max_attempts: int   = POLL_MAX_ATTEMPTS) -> None:
    """Bloqueia até o report ficar ready. Levanta XandrError em erro/timeout."""
    token = get_token()
    for attempt in range(max_attempts):
        time.sleep(interval_sec)
        payload = _http("GET", f"/report?id={report_id}", token=token)
        status = (payload.get("response") or {}).get("execution_status")
        if status == "ready":
            return
        if status in ("error", "canceled"):
            raise XandrError(f"Report {report_id} terminou com status={status}: {payload}")
    raise XandrError(
        f"Timeout aguardando report {report_id} ({max_attempts * interval_sec:.0f}s)."
    )


def download_report(report_id: str) -> str:
    """Baixa o CSV pronto. Retorna o conteúdo como string utf-8."""
    token = get_token()
    raw = _http_get_bytes(f"/report-download?id={report_id}", token=token)
    return raw.decode("utf-8", errors="replace")


def parse_csv(csv_text: str) -> List[dict]:
    """Parse do CSV pra lista de dicts no shape esperado pelo
    `pmp_deals.upsert_delivery_rows`.

    Faz validação de schema: se faltar coluna esperada, levanta.
    Linhas com `day` ou `curated_deal_id` vazios são puladas.
    """
    rows: List[dict] = []
    reader = csv.DictReader(io.StringIO(csv_text))
    fields = set(reader.fieldnames or [])
    missing = set(REPORT_COLUMNS) - fields
    if missing:
        raise XandrError(f"CSV sem colunas esperadas: {sorted(missing)} (encontradas: {sorted(fields)})")

    def _num(v):
        if v in (None, ""): return 0.0
        try: return float(v)
        except: return 0.0
    def _int(v):
        if v in (None, ""): return 0
        try: return int(float(v))
        except: return 0

    for r in reader:
        day_raw = (r.get("day") or "").strip()
        deal_id = (r.get("curated_deal_id") or "").strip()
        if not day_raw or not deal_id:
            continue
        # Day vem como "YYYY-MM-DD" (granularidade dia, default sem agrupamento).
        try:
            day_iso = datetime.strptime(day_raw[:10], "%Y-%m-%d").date()
        except ValueError:
            logger.warning("[xandr] day inválido, pulando: %r", day_raw)
            continue
        rows.append({
            "deal_id":                str(deal_id),
            "day":                    day_iso,
            "imps":                   _int(r.get("imps")),
            "viewable_imps":          _int(r.get("viewed_imps")),
            "clicks":                 _int(r.get("clicks")),
            "curator_net_media_cost": _num(r.get("curator_net_media_cost")),
            "curator_tech_fees":      _num(r.get("curator_tech_fees")),
            "curator_total_cost":     _num(r.get("curator_total_cost")),
            "curator_revenue":        _num(r.get("curator_revenue")),
            "curator_margin":         _num(r.get("curator_margin")),
            # Aproveitamos o curated_deal_name/io_name pra criar master
            # automaticamente em sync (deals novos que aparecem no Xandr).
            "_curated_deal_name":     (r.get("curated_deal_name") or "").strip(),
            "_io_name":               (r.get("curated_deal_insertion_order_name") or "").strip(),
        })
    return rows


def sync(start_date: Optional[date] = None,
         end_date:   Optional[date] = None,
         report_interval: str = "last_7_days",
         created_by: str = "xandr-sync") -> dict:
    """Orquestra o sync completo: request → poll → download → upsert.

    Retorna um summary:
      {
        "report_id":      str,
        "rows_processed": int,
        "deals_touched":  int,
        "deals_created":  int,    # novos masters criados via auto-parsing
        "duration_sec":   float,
        "window":         str,    # descrição amigável
      }
    """
    t0 = time.time()
    if start_date and end_date:
        window = f"{start_date.isoformat()} → {end_date.isoformat()}"
    else:
        window = report_interval

    logger.info("[xandr] sync iniciado (window=%s)", window)
    report_id = request_report(start_date, end_date, report_interval)
    logger.info("[xandr] report_id=%s", report_id)
    wait_for_report(report_id)
    csv_text = download_report(report_id)
    rows = parse_csv(csv_text)
    logger.info("[xandr] %d linhas parseadas do CSV", len(rows))

    # Cria masters de deals que ainda não existem (auto-parsing do nome).
    deals_created = 0
    seen_deals = {}
    for r in rows:
        did = r["deal_id"]
        if did in seen_deals:
            continue
        seen_deals[did] = (r.get("_curated_deal_name"), r.get("_io_name"))
    for did, (deal_name, io_name) in seen_deals.items():
        if not deal_name:
            continue
        try:
            if pmp_deals.ensure_deal_from_xandr(did, deal_name, io_name, created_by=created_by):
                deals_created += 1
        except Exception as e:
            logger.warning("[xandr] ensure_deal_from_xandr falhou pra %s: %s", did, e)

    # Limpa campos internos antes do upsert
    delivery_rows = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    upsert_res = pmp_deals.upsert_delivery_rows(delivery_rows)

    duration = time.time() - t0
    summary = {
        "report_id":      report_id,
        "rows_processed": upsert_res.get("rows_processed", 0),
        "deals_touched":  upsert_res.get("deals_touched", 0),
        "deals_created":  deals_created,
        "duration_sec":   round(duration, 2),
        "window":         window,
        "synced_at":      datetime.now(timezone.utc).isoformat(),
    }
    logger.info("[xandr] sync concluído em %.1fs: %s", duration, summary)
    return summary


# ═════════════════════════════════════════════════════════════════════════════
# v2 — Sync por LINE ITEM (granularidade real do negócio)
# ═════════════════════════════════════════════════════════════════════════════
# A v1 modelava por curated_deal_id. A v2 modela por line_item_id porque
# essa é a unidade onde vivem: PI/budget, flighting, bid type, estado
# ativo/inativo, e (futuramente) o link com Hypr Command via line.code.
#
# Tabelas alvo:
#   • prod_assets.pmp_insertion_orders     (mestre do IO / cliente)
#   • prod_assets.pmp_line_items           (mestre da line / campanha)
#   • prod_assets.pmp_line_delivery_daily  (fato diário, partition by day)


from google.cloud import bigquery as _bq  # noqa: E402 — usado só aqui

_bq_client = _bq.Client()
_PROJECT = os.environ.get("GCP_PROJECT", "site-hypr")
_DATASET = "prod_assets"


# ─── HTTP helpers extras ──────────────────────────────────────────────────────
def _http_put(path: str, body: dict, timeout: int = 30) -> dict:
    """PUT com auth + JSON, retorna response.response como dict."""
    token = get_token()
    url = BASE_URL + path
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="PUT")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raise XandrError(f"HTTP {e.code} PUT {path}: {e.read().decode('utf-8','ignore')}")
    payload = json.loads(raw)
    resp = payload.get("response") or {}
    if resp.get("status") not in (None, "OK"):
        raise XandrError(f"Xandr PUT retornou status={resp.get('status')}: {resp.get('error') or resp}")
    return resp


def _paginated_get(path_prefix: str, list_key: str, page_size: int = 100):
    """Itera por todas as páginas de um endpoint de listagem (IO ou line).

    Yields objetos individuais. Xandr usa `start_element` + `num_elements`
    pra paginação, e retorna `count` total. Auth via token do cache (lazy).
    """
    start = 0
    while True:
        sep = "&" if "?" in path_prefix else "?"
        url = f"{path_prefix}{sep}start_element={start}&num_elements={page_size}"
        payload = _http("GET", url, token=get_token())
        resp = payload.get("response") or {}
        items = resp.get(list_key) or []
        if not items:
            break
        for it in items:
            yield it
        total = int(resp.get("count") or 0)
        start += len(items)
        if start >= total:
            break


# ─── Parsing de IOs ──────────────────────────────────────────────────────────
# Padrão dos IO names da HYPR: HYPR_PMP_DV360_<CUSTOMER>[_FY25] etc.
# Tokens "ruído" que sempre pulam: HYPR, PMP, DV360, DSP, XANDR, CURATED, IO,
# CURATE. O primeiro token útil restante é o cliente.
_IO_SKIP_TOKENS = {"HYPR", "PMP", "XANDR", "CURATED",
                   "CURATE", "IO", "FY24", "FY25", "FY26", "FY27", "FY"}
# DSPs/plataformas: pulam SEMPRE (não são cliente). Inclui versões
# hifenizadas como AMAZON-DSP (que é a Amazon DSP, plataforma — não
# a Amazon como cliente). Sem isso, IO `HYPR_PMP_AMAZON-DSP_3-CORACOES`
# atribui "Amazon DSP" como cliente, quando o cliente real é "3 Corações".
_IO_DSP_TOKENS = {"DV360", "DSP", "AMAZON-DSP", "AMAZONDSP",
                  "TRADEDESK", "STACKADAPT", "AMAZON-ADS", "AMAZONADS"}
_FY_SUFFIX_RE = re.compile(r"FY\d{2}$", re.IGNORECASE)


def _customer_from_io_name(io_name: str) -> Optional[str]:
    """Best-effort extract do nome do cliente a partir do IO name.

    Estratégia: split por `_` ou `-`, descarta tokens em `_IO_SKIP_TOKENS`,
    o primeiro restante é o cliente. Normaliza via `CUSTOMER_DISPLAY`.

    Ex:
      HYPR_PMP_DV360_NESTLE        → "Nestlé"
      HYPR_PMP_DV360_BOTICARIO     → "O Boticário"
      HYPR_PMP_DV360_ITAU_FY25     → "Itaú"
      HYPR_PMP_PICPAY              → "PicPay"
      HYPR_Curated_IO_FY25         → None (sem cliente identificável)
    """
    if not io_name:
        return None
    # Split SÓ por `_` (não por `-`) pra preservar clientes hifenizados
    # tipo "FLASH-BENEFICIOS", "MERCADO-LIVRE", "RD-SAUDE".
    tokens = [t for t in io_name.split("_") if t]
    for t in tokens:
        upper = t.upper()
        # Pula tokens ruído, DSPs e sufixos FY
        if upper in _IO_SKIP_TOKENS:
            continue
        if upper in _IO_DSP_TOKENS:
            continue
        if _FY_SUFFIX_RE.match(upper):
            continue
        # Limpa o sufixo FY se vier colado ao customer (ex: NESTLE_FY25 — não
        # cai aqui porque já estaria em token separado, mas FLASH-BENEFICIOSFY25
        # cairia).
        cleaned = _FY_SUFFIX_RE.sub("", upper)
        if not cleaned:
            continue
        # Lookup em CUSTOMER_DISPLAY: tenta uppercase sem hífen (chave) e
        # depois fallback pra title case com hífen→espaço.
        key = cleaned.replace("-", "")
        if key in pmp_deals.CUSTOMER_DISPLAY:
            return pmp_deals.CUSTOMER_DISPLAY[key]
        return cleaned.replace("-", " ").title()
    return None


# ─── Bid type inference ──────────────────────────────────────────────────────
def infer_bid_type(line: dict) -> tuple[Optional[str], str]:
    """Retorna (bid_type, source) onde bid_type ∈ {"fixed", "flex", None}.

    Regras (ordem de confiança):
      1. Nome da line: FLEX-BID / FIXED-BID explícito.
      2. valuation:
         - min_margin_pct > 0  → flex (curator margin percentual)
         - min_revenue_value definido + max_revenue_value null → flex (floor)
         - min_revenue_value == max_revenue_value (definidos) → fixed
      3. None: fallback — admin define manualmente via UI.
    """
    name_upper = (line.get("name") or "").upper()
    if "FLEX-BID" in name_upper or "FLEX_BID" in name_upper or "FLEXBID" in name_upper:
        return ("flex", "name")
    if any(p in name_upper for p in ("FIXED-BID", "FIXED_BID", "FIXEDBID", "FIXED-PRICE", "FIXED_PRICE")):
        return ("fixed", "name")

    val = line.get("valuation") or {}
    min_margin_pct = val.get("min_margin_pct")
    min_rev = val.get("min_revenue_value")
    max_rev = val.get("max_revenue_value")
    if min_margin_pct:
        return ("flex", "valuation")
    if min_rev is not None and max_rev is not None and min_rev == max_rev:
        return ("fixed", "valuation")
    if min_rev is not None and max_rev is None:
        return ("flex", "valuation")
    return (None, "unknown")


# ─── Sync IOs ────────────────────────────────────────────────────────────────
def sync_insertion_orders(advertiser_id: int) -> dict:
    """Lê todos os IOs do advertiser e upserta em pmp_insertion_orders.

    Não recria a tabela (assumimos schema já existe via migration manual).
    Retorna {"ios_processed": N, "ios_active": K}.
    """
    t0 = time.time()
    rows = []
    for io in _paginated_get(f"/insertion-order?advertiser_id={advertiser_id}", "insertion-orders"):
        rows.append({
            "io_id":         int(io["id"]),
            "io_name":       io.get("name"),
            "advertiser_id": int(io.get("advertiser_id") or advertiser_id),
            "state":         io.get("state"),
            "customer":      _customer_from_io_name(io.get("name") or ""),
            "currency":      io.get("currency"),
            "start_date":    (io.get("start_date") or "")[:10] or None,
            "end_date":      (io.get("end_date") or "")[:10] or None,
            "last_modified": io.get("last_modified"),
        })

    if not rows:
        return {"ios_processed": 0, "ios_active": 0, "duration_sec": 0}

    # Upsert via staging + MERGE
    _upsert_via_staging(
        target_table="pmp_insertion_orders",
        rows=rows,
        key_columns=["io_id"],
        schema=[
            _bq.SchemaField("io_id", "INT64"),
            _bq.SchemaField("io_name", "STRING"),
            _bq.SchemaField("advertiser_id", "INT64"),
            _bq.SchemaField("state", "STRING"),
            _bq.SchemaField("customer", "STRING"),
            _bq.SchemaField("currency", "STRING"),
            _bq.SchemaField("start_date", "DATE"),
            _bq.SchemaField("end_date", "DATE"),
            _bq.SchemaField("last_modified", "TIMESTAMP"),
        ],
        update_cols=["io_name","advertiser_id","state","customer","currency",
                      "start_date","end_date","last_modified"],
        timestamp_col="last_synced_at",
    )

    active = sum(1 for r in rows if r["state"] == "active")
    return {
        "ios_processed": len(rows),
        "ios_active":    active,
        "duration_sec":  round(time.time() - t0, 2),
    }


# ─── Sync Line Items ─────────────────────────────────────────────────────────
def _extract_line_dates(line: dict) -> tuple[Optional[str], Optional[str]]:
    """Extrai start/end. Lines ALI (standard_v2) podem ter datas em
    `budget_intervals[0].start_date/end_date` em vez do nível root."""
    start = (line.get("start_date") or "")[:10]
    end   = (line.get("end_date")   or "")[:10]
    if not start or not end:
        intervals = line.get("budget_intervals") or []
        if intervals:
            bi = intervals[0]
            start = start or (bi.get("start_date") or "")[:10]
            end   = end   or (bi.get("end_date")   or "")[:10]
    return (start or None, end or None)


def sync_line_items(advertiser_id: int) -> dict:
    """Lê todas as lines do advertiser e upserta em pmp_line_items.

    Para cada line:
      - Extrai io_id do primeiro insertion_orders[].id (lines têm 1:N IOs;
        usamos o primeiro pq na prática é sempre 1:1 na HYPR — admin
        ajusta no edge case M:N).
      - Infere bid_type via name + valuation.
      - Extrai deal_ids[] do array deals.
      - Preserva campos manuais (status, notes, overrides) — só sobrescreve
        os campos do Xandr na MERGE.
    """
    t0 = time.time()
    rows = []
    for li in _paginated_get(
        f"/line-item?advertiser_id={advertiser_id}&include_insertion_order_id=true",
        "line-items",
    ):
        bid_type, bid_source = infer_bid_type(li)
        deals = li.get("deals") or []
        ios   = li.get("insertion_orders") or []
        val   = li.get("valuation") or {}
        start, end = _extract_line_dates(li)

        cur_margin_type = li.get("curator_margin_type")
        cur_margin_pct  = val.get("min_margin_pct") if cur_margin_type in (None, "Percent") else None
        cur_margin_cpm  = val.get("min_margin_cpm") if cur_margin_type == "CPM" else None

        rows.append({
            "line_id":             int(li["id"]),
            "line_name":           li.get("name"),
            "line_code":           li.get("code"),
            "advertiser_id":       int(li.get("advertiser_id") or advertiser_id),
            "io_id":               int(ios[0]["id"]) if ios else None,
            "state":               li.get("state"),
            "line_item_subtype":   li.get("line_item_subtype"),
            "start_date":          start,
            "end_date":            end,
            "currency":            li.get("currency"),
            "bid_type":            bid_type,
            "bid_type_source":     bid_source,
            "revenue_type":        li.get("revenue_type"),
            "revenue_value":       li.get("revenue_value"),
            "curator_margin_type": cur_margin_type,
            "curator_margin_pct":  cur_margin_pct,
            "curator_margin_cpm":  cur_margin_cpm,
            "min_revenue_value":   val.get("min_revenue_value"),
            "max_revenue_value":   val.get("max_revenue_value"),
            "deal_ids":            [int(d["id"]) for d in deals if d.get("id")],
            "deal_count":          int(li.get("deal_count") or 0),
            "xandr_last_modified": li.get("last_modified"),
            "short_token":         li.get("code"),  # mirror de line_code; facilita JOIN
        })

    if not rows:
        return {"lines_processed": 0, "lines_active": 0, "lines_with_token": 0,
                "duration_sec": round(time.time() - t0, 2)}

    _upsert_via_staging(
        target_table="pmp_line_items",
        rows=rows,
        key_columns=["line_id"],
        schema=[
            _bq.SchemaField("line_id", "INT64"),
            _bq.SchemaField("line_name", "STRING"),
            _bq.SchemaField("line_code", "STRING"),
            _bq.SchemaField("advertiser_id", "INT64"),
            _bq.SchemaField("io_id", "INT64"),
            _bq.SchemaField("state", "STRING"),
            _bq.SchemaField("line_item_subtype", "STRING"),
            _bq.SchemaField("start_date", "DATE"),
            _bq.SchemaField("end_date", "DATE"),
            _bq.SchemaField("currency", "STRING"),
            _bq.SchemaField("bid_type", "STRING"),
            _bq.SchemaField("bid_type_source", "STRING"),
            _bq.SchemaField("revenue_type", "STRING"),
            _bq.SchemaField("revenue_value", "NUMERIC"),
            _bq.SchemaField("curator_margin_type", "STRING"),
            _bq.SchemaField("curator_margin_pct", "NUMERIC"),
            _bq.SchemaField("curator_margin_cpm", "NUMERIC"),
            _bq.SchemaField("min_revenue_value", "NUMERIC"),
            _bq.SchemaField("max_revenue_value", "NUMERIC"),
            _bq.SchemaField("deal_ids", "INT64", mode="REPEATED"),
            _bq.SchemaField("deal_count", "INT64"),
            _bq.SchemaField("xandr_last_modified", "TIMESTAMP"),
            _bq.SchemaField("short_token", "STRING"),
        ],
        # Campos que vêm do Xandr — sobrescrevem sempre.
        # Campos manuais (status, notes, is_archived, *_override) NUNCA são
        # tocados pelo sync.
        update_cols=[
            "line_name","line_code","advertiser_id","io_id","state",
            "line_item_subtype","start_date","end_date","currency",
            "bid_type","bid_type_source","revenue_type","revenue_value",
            "curator_margin_type","curator_margin_pct","curator_margin_cpm",
            "min_revenue_value","max_revenue_value",
            "deal_ids","deal_count","xandr_last_modified","short_token",
        ],
        timestamp_col="last_synced_at",
    )

    active = sum(1 for r in rows if r["state"] == "active")
    with_token = sum(1 for r in rows if r["line_code"])
    return {
        "lines_processed":  len(rows),
        "lines_active":     active,
        "lines_with_token": with_token,
        "duration_sec":     round(time.time() - t0, 2),
    }


# ─── Sync delivery por LINE ───────────────────────────────────────────────────
def parse_csv_line_level(csv_text: str) -> list:
    """Parse do CSV pra shape esperado por upsert em pmp_line_delivery_daily.

    POLÍTICA D-1: descarta linhas do DIA CORRENTE (BRT). O Xandr atualiza
    dados intra-dia mas com latência irregular — pra evitar valores parciais
    flutuando, só armazenamos dias FECHADOS (D-1 e anteriores). Usuário
    sempre vê dia completo. Ver decisão em `sync_delivery_by_line`.
    """
    from datetime import date as _date
    rows = []
    reader = csv.DictReader(io.StringIO(csv_text))
    fields = set(reader.fieldnames or [])
    missing = set(REPORT_COLUMNS_LINE) - fields
    if missing:
        raise XandrError(f"CSV sem colunas v2 esperadas: {sorted(missing)}")

    def _n(v):
        try: return float(v) if v not in (None,"") else 0.0
        except: return 0.0
    def _i(v):
        try: return int(float(v)) if v not in (None,"") else 0
        except: return 0

    # Hoje em BRT — pra filtrar dia corrente (parcial).
    today_brt = _date.today()
    skipped_today = 0

    for r in reader:
        day_raw = (r.get("day") or "").strip()
        line_id = (r.get("curated_deal_line_item_id") or "").strip()
        if not day_raw or not line_id:
            continue
        try:
            day_iso = datetime.strptime(day_raw[:10], "%Y-%m-%d").date()
        except ValueError:
            continue
        # D-1: ignora o dia corrente (parcial).
        if day_iso >= today_brt:
            skipped_today += 1
            continue
        try:
            line_id_int = int(line_id)
        except ValueError:
            continue

        # Conversão USD → BRL: multiplica pelo billing_exchange_rate
        # FECHADO DAQUELE DIA (cotação USD/BRL do dia da auction). Sem rate
        # → fallback 1.0 (não converte) e logamos.
        # Bate com o que o UI do Microsoft Curate mostra quando você
        # seleciona "Currency: Billing" no dropdown (verificado empiricamente
        # contra export do user — diferença <1% pra todos os clientes).
        rate = _n(r.get("billing_exchange_rate")) or 1.0
        if rate <= 0:
            rate = 1.0
        billing = (r.get("billing_currency") or "").upper()
        if billing and billing != "BRL":
            logger.warning("[xandr] billing_currency inesperada: %s (esperado BRL)", billing)

        rows.append({
            "line_id":                line_id_int,
            "day":                    day_iso,
            "imps":                   _i(r.get("imps")),
            "viewable_imps":          _i(r.get("viewed_imps")),
            "clicks":                 _i(r.get("clicks")),
            "curator_net_media_cost": _n(r.get("curator_net_media_cost")) * rate,
            "curator_tech_fees":      _n(r.get("curator_tech_fees"))      * rate,
            "curator_total_cost":     _n(r.get("curator_total_cost"))     * rate,
            "curator_revenue":        _n(r.get("curator_revenue"))        * rate,
            "curator_margin":         _n(r.get("curator_margin"))         * rate,
            "billing_exchange_rate":  rate,
        })
    if skipped_today:
        logger.info("[xandr v2] descartadas %d linhas do dia corrente (política D-1)", skipped_today)
    return rows


def sync_delivery_by_line(start_date: Optional[date] = None,
                          end_date:   Optional[date] = None,
                          report_interval: str = "last_7_days") -> dict:
    """Equivalente v2 do `sync()` legado, mas pivota por line_id.

    Não cria masters automaticamente (assume que sync_line_items rodou antes
    e populou pmp_line_items). Linhas órfãs (delivery sem master) ficam com
    io_id NULL — útil pra debug.
    """
    t0 = time.time()
    if start_date and end_date:
        window = f"{start_date.isoformat()} → {end_date.isoformat()}"
    else:
        window = report_interval

    logger.info("[xandr v2] sync delivery iniciado (window=%s)", window)
    member_id = int(_env("XANDR_CURATE_MEMBER_ID"))

    body = {
        "report": {
            "report_type":     "curator_analytics",
            "columns":         REPORT_COLUMNS_LINE,
            "format":          "csv",
            "report_interval": report_interval,
            "filters":         [{"member_id": member_id}],
            # CRÍTICO: timezone America/Sao_Paulo. API default é UTC, o que
            # faz impressões servidas entre 21h-23h59 BRT entrarem no dia
            # SEGUINTE em UTC. Sem isso, dias individuais não batem com o
            # UI do Microsoft Curate (que usa tz local). Validado vs export
            # do user — diferença era ~5-9% por dia, 100% causada por tz.
            "timezone":        "America/Sao_Paulo",
        },
    }
    if start_date and end_date:
        body["report"]["start_date"] = start_date.strftime("%Y-%m-%d %H:%M:%S")
        body["report"]["end_date"]   = end_date.strftime("%Y-%m-%d %H:%M:%S")
        body["report"].pop("report_interval", None)

    token = get_token()
    payload = _http("POST", "/report", token=token, body=body)
    report_id = (payload.get("response") or {}).get("report_id")
    if not report_id:
        raise XandrError(f"POST /report sem report_id: {payload}")
    logger.info("[xandr v2] report_id=%s", report_id)
    wait_for_report(report_id)
    csv_text = download_report(report_id)
    rows = parse_csv_line_level(csv_text)
    logger.info("[xandr v2] %d linhas parseadas", len(rows))

    if not rows:
        return {"report_id": report_id, "rows_processed": 0,
                "lines_touched": 0, "duration_sec": round(time.time() - t0, 2),
                "window": window, "synced_at": datetime.now(timezone.utc).isoformat()}

    # Dedupe por (line_id, day) — o Xandr pode retornar múltiplas rows
    # quando varia uma dimension extra (ex: billing_currency diferente,
    # exchange_rate diferente em rerun do mesmo dia). Somamos métricas e
    # usamos o exchange_rate mais alto (cotação fechada do dia).
    dedup = {}
    for r in rows:
        k = (r["line_id"], r["day"])
        if k in dedup:
            agg = dedup[k]
            for f in ("imps","viewable_imps","clicks","curator_net_media_cost",
                       "curator_tech_fees","curator_total_cost","curator_revenue","curator_margin"):
                agg[f] = (agg.get(f) or 0) + (r.get(f) or 0)
            # mantém o exchange_rate maior (cotação fechada do dia tende a ser final)
            agg["billing_exchange_rate"] = max(agg.get("billing_exchange_rate") or 0,
                                                r.get("billing_exchange_rate") or 0)
        else:
            dedup[k] = dict(r)
    rows = list(dedup.values())
    logger.info("[xandr v2] após dedupe: %d linhas únicas (line_id, day)", len(rows))

    # Enriquece com io_id buscando do master (1 query)
    line_ids = sorted({r["line_id"] for r in rows})
    line_id_set = list(line_ids)
    io_map_sql = f"""
        SELECT line_id, io_id FROM `{_PROJECT}.{_DATASET}.pmp_line_items`
        WHERE line_id IN UNNEST(@ids)
    """
    io_map_job = _bq_client.query(io_map_sql, job_config=_bq.QueryJobConfig(
        query_parameters=[_bq.ArrayQueryParameter("ids", "INT64", line_id_set)]
    ))
    io_map = {r["line_id"]: r["io_id"] for r in io_map_job.result()}
    for r in rows:
        r["io_id"] = io_map.get(r["line_id"])

    _upsert_via_staging(
        target_table="pmp_line_delivery_daily",
        rows=rows,
        key_columns=["line_id", "day"],
        schema=[
            _bq.SchemaField("line_id", "INT64"),
            _bq.SchemaField("io_id", "INT64"),
            _bq.SchemaField("day", "DATE"),
            _bq.SchemaField("imps", "INT64"),
            _bq.SchemaField("viewable_imps", "INT64"),
            _bq.SchemaField("clicks", "INT64"),
            _bq.SchemaField("curator_net_media_cost", "NUMERIC"),
            _bq.SchemaField("curator_tech_fees", "NUMERIC"),
            _bq.SchemaField("curator_total_cost", "NUMERIC"),
            _bq.SchemaField("curator_revenue", "NUMERIC"),
            _bq.SchemaField("curator_margin", "NUMERIC"),
            _bq.SchemaField("billing_exchange_rate", "NUMERIC"),
        ],
        update_cols=["io_id","imps","viewable_imps","clicks",
                      "curator_net_media_cost","curator_tech_fees","curator_total_cost",
                      "curator_revenue","curator_margin","billing_exchange_rate"],
        timestamp_col="synced_at",
    )

    lines_touched = len(line_id_set)
    return {
        "report_id":      report_id,
        "rows_processed": len(rows),
        "lines_touched":  lines_touched,
        "duration_sec":   round(time.time() - t0, 2),
        "window":         window,
        "synced_at":      datetime.now(timezone.utc).isoformat(),
    }


# ─── PUT line code (auto-vinculação) ─────────────────────────────────────────
def set_line_code(line_id: int, code: str) -> dict:
    """Atribui um `code` (short_token HYPR) a uma Line no Xandr via PUT.

    Útil pra fluxo de auto-vinculação Command ↔ Xandr line. Após setar,
    o próximo sync_line_items vai capturar e popular `pmp_line_items.line_code`.
    """
    advertiser_id = 5472841  # HYPR — tem só 1 advertiser no member 13053
    body = {"line-item": {"code": code or None}}
    resp = _http_put(f"/line-item?id={line_id}&advertiser_id={advertiser_id}", body)
    return {"line_id": line_id, "code": code, "resp": resp}


# ─── Upsert helper genérico (load → MERGE) ───────────────────────────────────
def _upsert_via_staging(target_table: str, rows: list, key_columns: list,
                        schema: list, update_cols: list,
                        timestamp_col: Optional[str] = None) -> dict:
    """Faz load → staging table temporária → MERGE no alvo.

    `update_cols` é a lista de colunas que DEVEM ser sobrescritas em UPDATE.
    Demais colunas do alvo não são tocadas (preserva campos manuais).

    `timestamp_col` (opcional): se passado, é setado como CURRENT_TIMESTAMP()
    tanto em INSERT quanto UPDATE (ex: last_synced_at, synced_at).
    """
    import uuid
    staging_name = f"_pmp_v2_staging_{uuid.uuid4().hex[:8]}"
    staging_ref = _bq.TableReference.from_string(f"{_PROJECT}.{_DATASET}.{staging_name}")
    table = _bq.Table(staging_ref, schema=schema)
    table.expires = datetime.now(timezone.utc) + timedelta(hours=1)
    _bq_client.create_table(table)
    try:
        # Stringify campos NUMERIC/DATE/TIMESTAMP pra evitar JSON quirks
        rows_json = []
        for r in rows:
            row_out = {}
            for f in schema:
                v = r.get(f.name)
                if v is None:
                    row_out[f.name] = None
                elif f.field_type == "NUMERIC":
                    # BigQuery NUMERIC: max 9 casas decimais. Multiplicação
                    # USD × exchange_rate pode gerar 10+ decimais (ex:
                    # 4381.75028073205). Arredondamos pra 4 casas — o
                    # extra de precisão é ruído de cotação, não vale o overflow.
                    try:
                        row_out[f.name] = str(round(float(v), 4))
                    except (TypeError, ValueError):
                        row_out[f.name] = str(v)
                elif f.field_type == "DATE":
                    row_out[f.name] = str(v)
                elif f.field_type == "TIMESTAMP":
                    row_out[f.name] = str(v) if v else None
                elif f.mode == "REPEATED":
                    row_out[f.name] = list(v) if v else []
                else:
                    row_out[f.name] = v
            rows_json.append(row_out)
        errors = _bq_client.insert_rows_json(table, rows_json)
        if errors:
            raise XandrError(f"staging insert errors em {target_table}: {errors[:3]}")

        # MERGE
        on_clauses = " AND ".join(f"T.{c} = S.{c}" for c in key_columns)
        upd_set = ", ".join(f"{c} = S.{c}" for c in update_cols)
        if timestamp_col:
            upd_set += f", {timestamp_col} = CURRENT_TIMESTAMP()"
        insert_cols = key_columns + update_cols
        if timestamp_col:
            insert_cols = insert_cols + [timestamp_col]
        insert_vals = [f"S.{c}" for c in (key_columns + update_cols)]
        if timestamp_col:
            insert_vals = insert_vals + ["CURRENT_TIMESTAMP()"]

        merge_sql = f"""
            MERGE `{_PROJECT}.{_DATASET}.{target_table}` T
            USING `{_PROJECT}.{_DATASET}.{staging_name}` S
            ON {on_clauses}
            WHEN MATCHED THEN UPDATE SET {upd_set}
            WHEN NOT MATCHED THEN INSERT ({", ".join(insert_cols)}) VALUES ({", ".join(insert_vals)})
        """
        _bq_client.query(merge_sql).result()
    finally:
        try:
            _bq_client.delete_table(staging_ref, not_found_ok=True)
        except Exception as e:
            logger.warning("[xandr v2] falhou deletando staging %s: %s", staging_name, e)
    return {"merged": len(rows)}


# Regex usado por _customer_from_io_name
import re  # noqa: E402 — re-import pra clareza
