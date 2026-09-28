"""
DoubleVerify (Pinnacle) Report Data API — qualidade de mídia no admin.

Alimenta a seção "DoubleVerify" do menu admin: os Key Quality Indicators do
Pinnacle (Viewable, Authentic Viewable, Authentic, Brand Suitable, Fraud/SIVT
Free, In Geo) mais o "At a Glance" (Blocks, Incidents, Filters), filtráveis
por Brand Name e Campaign Name.

Contrato da API (validado ao vivo em 28/09/2026 com o token da HYPR)
--------------------------------------------------------------------
Host: https://data-reporting.doubleverify.com
Auth: header `Authorization: Bearer <DV_API_TOKEN>` (token criado no Pinnacle
em Analytics → Data API; vale para os Reporting Programs escolhidos na
criação. O "Access Token Hash" que o Pinnacle mostra junto NÃO é usado na
chamada — é só a identificação do token na lista do Pinnacle).

Fluxo assíncrono, em três passos:
  POST /requests                → {id, status: "Queued", hrefStatus}
  GET  /requests/{id}/status    → status Queued | In Progress | Success | Failed
  GET  /requests/{id}/data      → CSV (Accept: text/csv, gzip recomendado)

Catálogo (usado só pra descoberta, IDs fixados abaixo):
  GET /requestTypes                         → 1 = "Standard" (tag-based)
  GET /requestTypes/1/dimensions|metrics
  GET /1/dimensions/{id}/values?filter=...  → valores de filtro

Por que as TAXAS são recalculadas aqui e não pedidas prontas
------------------------------------------------------------
Toda taxa do Pinnacle é razão de duas contagens aditivas — conferido linha a
linha no CSV real (ex.: Viewable Rate = Viewable Impressions ÷ Measured
Impressions; Authentic Rate = Authentic Ads ÷ Monitored Ads; Block Rate =
Blocks ÷ Requests). Então pedimos só CONTAGENS por Brand × Campaign × Dia e o
front soma e divide. Isso deixa o filtro de Brand/Campaign instantâneo (sem
novo pedido à DV a cada clique) e o total de qualquer recorte sai exato — somar
taxas de linhas diferentes daria errado.

Datas em horário de Brasília
----------------------------
O `timeZone` sozinho NÃO basta: com `dateRange` em data
pura a DV interpreta a janela em UTC e devolve um pedaço do dia anterior
(pedido 20→26 voltou 19→25). Com o offset explícito (`YYYY-MM-DDT00:00-03:00`)
a janela bate com o dia BRT. O `to` vai como meia-noite do dia seguinte e
linhas fora de [from, to] são descartadas no parse, então tanto faz se a DV
trata o limite como inclusivo ou exclusivo.
"""
import csv
import gzip
import io
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

logger = logging.getLogger(__name__)

BASE_URL = os.environ.get("DV_API_BASE_URL", "https://data-reporting.doubleverify.com")
REQUEST_TYPE_STANDARD = 1
# America/Sao_Paulo não está na lista de fusos do Standard (/requestTypes/1).
# Buenos Aires está e é o mesmo UTC-3 sem horário de verão — conferido: os dois
# devolvem exatamente os mesmos números por dia.
TIME_ZONE = "America/Argentina/Buenos_Aires"
BRT = timezone(timedelta(hours=-3))

HTTP_TIMEOUT_S = float(os.environ.get("DV_HTTP_TIMEOUT_S", "60"))
# Orçamento total do polling. Um Brand × Campaign × Dia de 60 dias volta em
# poucos segundos; o teto existe pra não segurar a Cloud Function (540s).
POLL_BUDGET_S = float(os.environ.get("DV_POLL_BUDGET_S", "150"))

MAX_RANGE_DAYS = 366

# Dimensões (requestType 1 / Standard).
DIM_BRAND = 348137
DIM_CAMPAIGN = 41496607
DIM_DATE = 56819777

# (chave no payload, id DV, nome da coluna no CSV). Só contagens — ver
# docstring. A ordem é a ordem das colunas no payload.
METRICS = [
    ("monitored_ads",            76388229, "Monitored Ads"),
    ("measured_impressions",     88318928, "Measured Impressions"),
    ("viewable_impressions",     99940181, "Viewable Impressions"),
    ("authentic_viewable_imps",  23077222, "Authentic Viewable Impressions"),
    ("authentic_ads",            88237188, "Authentic Ads"),
    ("brand_suitable_ads",       59059021, "Brand Suitable Ads"),
    ("fraud_free_ads",           54395606, "Fraud/SIVT Free Ads"),
    ("in_geo_ads",               65270244, "In Geo Ads"),
    ("requests",                 58780407, "Requests"),
    ("blocks",                   75416410, "Blocks"),
    ("brand_suitability_blocks", 68766554, "Brand Suitability Blocks"),
    ("fraud_blocks",             93651947, "Fraud/SIVT Blocks"),
    ("out_of_geo_blocks",        39966565, "Out of Geo Blocks"),
    ("unique_incidents",         97580207, "Unique Incidents"),
    ("brand_suitability_incidents", 25318618, "Brand Suitability Incidents"),
    ("fraud_incidents",          71483969, "Fraud/SIVT Incidents"),
    ("out_of_geo_incidents",     33663864, "Out of Geo Incidents"),
    ("evaluations",              99940158, "Evaluations"),
    ("filters",                  99940110, "Filters"),
    ("allowed_evaluations",      99940091, "Allowed Evaluations"),
]
METRIC_KEYS = [k for k, _, _ in METRICS]


class DoubleVerifyError(Exception):
    """Falha falando com a DV (auth, pedido recusado, timeout, CSV inválido)."""


def is_configured() -> bool:
    return bool(os.environ.get("DV_API_TOKEN", "").strip())


def _token() -> str:
    tok = os.environ.get("DV_API_TOKEN", "").strip()
    if not tok:
        raise DoubleVerifyError("DV_API_TOKEN não configurado")
    return tok


def _http(method, path, *, body=None, accept="application/json"):
    url = path if path.startswith("http") else f"{BASE_URL}{path}"
    headers = {"Authorization": f"Bearer {_token()}", "Accept": accept}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if accept == "text/csv":
        headers["Accept-Encoding"] = "gzip"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding", "").lower() == "gzip":
                raw = gzip.decompress(raw)
            return resp.status, raw
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        if e.code in (401, 403):
            raise DoubleVerifyError(f"DV recusou o token (HTTP {e.code})") from e
        raise DoubleVerifyError(f"DV HTTP {e.code} em {path}: {detail}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise DoubleVerifyError(f"DV inacessível: {e}") from e


def _json(method, path, **kw):
    _, raw = _http(method, path, **kw)
    try:
        return json.loads(raw.decode("utf-8-sig"))
    except ValueError as e:
        raise DoubleVerifyError(f"Resposta não-JSON da DV em {path}") from e


# ─── Janela ──────────────────────────────────────────────────────────────────
def yesterday_brt() -> date:
    return (datetime.now(BRT) - timedelta(days=1)).date()


def resolve_window(from_s, to_s):
    """Valida/normaliza o período pedido e devolve (from, to, prev_from, prev_to).

    Default: últimos 30 dias fechados (até D-1 BRT — o dia corrente é parcial).
    O período anterior tem o mesmo tamanho e termina na véspera do `from`; ele
    alimenta as setas de variação dos KQIs.
    """
    cap = yesterday_brt()
    if to_s:
        to_d = date.fromisoformat(to_s)
    else:
        to_d = cap
    to_d = min(to_d, cap)
    from_d = date.fromisoformat(from_s) if from_s else to_d - timedelta(days=29)
    if from_d > to_d:
        raise ValueError("from depois de to")
    days = (to_d - from_d).days + 1
    if days > MAX_RANGE_DAYS:
        raise ValueError(f"período máximo é {MAX_RANGE_DAYS} dias")
    prev_to = from_d - timedelta(days=1)
    prev_from = prev_to - timedelta(days=days - 1)
    return from_d, to_d, prev_from, prev_to


def build_request_body(from_d: date, to_d: date) -> dict:
    end_excl = to_d + timedelta(days=1)
    return {
        "requestType": REQUEST_TYPE_STANDARD,
        "dateRange": {
            "from": f"{from_d.isoformat()}T00:00-03:00",
            "to": f"{end_excl.isoformat()}T00:00-03:00",
        },
        "timeZone": TIME_ZONE,
        "dimensions": [{"id": DIM_BRAND}, {"id": DIM_CAMPAIGN}, {"id": DIM_DATE}],
        "metrics": [{"id": mid} for _, mid, _ in METRICS],
    }


# ─── Pedido assíncrono ───────────────────────────────────────────────────────
def run_report(body: dict, *, sleep=time.sleep, clock=time.monotonic) -> str:
    """POST → polling do status → CSV (texto). Levanta DoubleVerifyError."""
    created = _json("POST", "/requests", body=body)
    req_id = created.get("id")
    if not req_id:
        raise DoubleVerifyError(f"DV não devolveu id do pedido: {created.get('message') or created}")
    quoted = urllib.parse.quote(req_id, safe="")
    deadline = clock() + POLL_BUDGET_S
    wait = 1.0
    status = created
    while True:
        st = (status.get("status") or "").lower()
        if st == "success":
            break
        if st == "failed":
            raise DoubleVerifyError(f"Pedido DV falhou: {status.get('message') or 'sem detalhe'}")
        if clock() >= deadline:
            raise DoubleVerifyError("DV demorou demais para gerar o relatório")
        sleep(wait)
        wait = min(wait * 1.5, 5.0)
        status = _json("GET", f"/requests/{quoted}/status")
    _, raw = _http("GET", f"/requests/{quoted}/data", accept="text/csv")
    return raw.decode("utf-8-sig")


def _num(v):
    if v is None:
        return 0
    v = v.strip()
    if not v:
        return 0
    try:
        f = float(v)
    except ValueError:
        return 0
    return int(f) if f.is_integer() else f


def parse_csv(text: str, from_d: date, to_d: date) -> dict:
    """CSV da DV → payload colunar {brands, campaigns, columns, rows}.

    rows = [brand_idx, campaign_idx, "YYYY-MM-DD", *contagens na ordem de
    METRIC_KEYS]. Índices em vez de strings porque nomes de campanha da DV têm
    100+ caracteres e se repetem em toda linha diária.
    """
    reader = csv.DictReader(io.StringIO(text))
    missing = [name for _, _, name in METRICS if name not in (reader.fieldnames or [])]
    if reader.fieldnames is None or "Date" not in reader.fieldnames:
        raise DoubleVerifyError("CSV da DV sem cabeçalho esperado")
    if missing:
        # Métrica sumiu do catálogo: segue com zero em vez de derrubar a tela.
        logger.warning(f"[doubleverify] colunas ausentes no CSV: {missing}")

    brands, brand_idx = [], {}
    campaigns, camp_idx = [], {}
    rows = []
    lo, hi = from_d.isoformat(), to_d.isoformat()
    for r in reader:
        day = (r.get("Date") or "").strip()[:10]
        if not (lo <= day <= hi):
            continue
        brand = (r.get("Brand Name") or "").strip() or "(sem brand)"
        camp = (r.get("Campaign Name") or "").strip() or "(sem campanha)"
        vals = [_num(r.get(name)) for _, _, name in METRICS]
        if not any(vals):
            continue
        if brand not in brand_idx:
            brand_idx[brand] = len(brands)
            brands.append(brand)
        ck = (brand, camp)
        if ck not in camp_idx:
            camp_idx[ck] = len(campaigns)
            campaigns.append({"name": camp, "brand": brand_idx[brand]})
        rows.append([brand_idx[brand], camp_idx[ck], day, *vals])
    rows.sort(key=lambda x: x[2])
    return {"brands": brands, "campaigns": campaigns, "columns": METRIC_KEYS, "rows": rows}


def fetch_quality(from_s=None, to_s=None) -> dict:
    """Payload do endpoint `dv_quality`: período + período anterior num pedido só."""
    from_d, to_d, prev_from, prev_to = resolve_window(from_s, to_s)
    text = run_report(build_request_body(prev_from, to_d))
    data = parse_csv(text, prev_from, to_d)
    data.update({
        "from": from_d.isoformat(),
        "to": to_d.isoformat(),
        "prev_from": prev_from.isoformat(),
        "prev_to": prev_to.isoformat(),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    })
    return data
