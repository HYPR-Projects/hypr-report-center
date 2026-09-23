"""
Aba Max Attention do report do cliente — lado backend.

Contexto
--------
As peças Max Attention (rich media da HYPR) vivem no o2o-platform
(platform.hypr.mobi). Até aqui o cliente via essas peças só como impressões e
cliques das linhas de Display; funil, superfícies, endereços, slides e
widgets existiam apenas no painel interno da Platform, atrás do login HYPR.

Este módulo leva isso pro report em três partes:

1. VÍNCULO peça → campanha (`report_ma_links`, BigQuery do RC). A Platform
   não tem campo que ligue peça a campanha, então o admin vincula na aba (com
   sugestões vindas da busca da Platform) e nada é vinculado sozinho — mesma
   regra do Survey.
2. BUSCA de peças (admin): proxy do endpoint de serviço da Platform, que
   devolve candidatos já pontuados (AdBolt, token no nome, nome parecido com
   os criativos da DSP, cliente).
3. MÉTRICAS das peças vinculadas: o report chama o endpoint de serviço da
   Platform, que usa o MESMO serviço que monta o painel de cada criativo lá.
   O número do report e o da Platform batem por construção — reescrever a
   lógica aqui em SQL garantiria o contrário.

Configuração (env da Cloud Function)
------------------------------------
    MA_SERVICE_KEY   = mesmo valor de REPORT_CENTER_SERVICE_KEY na Platform
    MA_PLATFORM_URL  = opcional, default https://platform.hypr.mobi

Sem MA_SERVICE_KEY o módulo responde "não configurado" (nunca erro 500
silencioso): o admin vê a instrução; o cliente não vê a aba.

O que o cliente NUNCA recebe
----------------------------
A normalização (`normalize_piece`) é uma lista de permissão: só sai o que
está escrito ali. Métricas internas da Platform (taxa de medição, saúde de
entrega, giroscópio bloqueado, endereços não resolvidos, diagnósticos) não
atravessam, mesmo que a Platform passe a devolver campos novos.
"""

import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from google.cloud import bigquery

import bq_client

logger = logging.getLogger(__name__)

PROJECT_ID = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET_ASSETS = "prod_assets"

PLATFORM_URL_DEFAULT = "https://platform.hypr.mobi"

# Teto de peças por report. O endpoint da Platform aceita até 20 ids por
# chamada; uma campanha com mais que isso é caso a revisar, não a paginar.
MAX_PIECES = 20

# Cache das métricas por (ids, período). 10 min: os números principais da
# Platform são recalculados a cada ~15 min, então um cache menor que isso não
# deixaria o dado mais novo — só multiplicaria chamadas (e queries no lake).
PIECES_TTL = 600
# Cache da tabela de vínculos inteira (pequena). Curto: o admin vincula e
# recarrega o report, possivelmente em outra instância.
LINKS_TTL = 60
# Busca admin: 1 min basta pra digitação e re-renders.
SEARCH_TTL = 60

HTTP_TIMEOUT_S = 25

_TOKEN_RE = re.compile(r"^[A-Za-z0-9]{4,10}$")
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SLUG_RE = re.compile(r"^[A-Za-z0-9_-]{4,80}$")

_lock = threading.Lock()
_pieces_cache = {}   # key -> (ts, value)
_links_cache = {}    # "all" -> (ts, dict)
_search_cache = {}   # key -> (ts, value)


class NotConfigured(RuntimeError):
    """MA_SERVICE_KEY ausente."""


class PlatformError(RuntimeError):
    """A Platform respondeu erro ou não respondeu."""


def _bq():
    return bq_client.get_client()


# ─── Configuração ──────────────────────────────────────────────────────────

def service_key() -> str:
    return (os.environ.get("MA_SERVICE_KEY") or "").strip()


def is_configured() -> bool:
    return bool(service_key())


def platform_url() -> str:
    raw = (os.environ.get("MA_PLATFORM_URL") or PLATFORM_URL_DEFAULT).strip().rstrip("/")
    # Só https (ou http em localhost pra desenvolvimento): a chave de serviço
    # vai no header, e mandar segredo em texto puro pra fora não é opção.
    if not (raw.startswith("https://") or raw.startswith("http://localhost") or raw.startswith("http://127.0.0.1")):
        raise NotConfigured("MA_PLATFORM_URL precisa ser https://")
    return raw


def not_configured_message() -> str:
    return (
        "Integração com o Max Attention não configurada: defina MA_SERVICE_KEY "
        "na Cloud Function com o mesmo valor de REPORT_CENTER_SERVICE_KEY do "
        "o2o-platform (e, se preciso, MA_PLATFORM_URL)."
    )


# ─── Cache simples ─────────────────────────────────────────────────────────

def _cget(store, key, ttl):
    with _lock:
        hit = store.get(key)
        if hit and (time.time() - hit[0]) < ttl:
            return hit[1]
    return None


def _cset(store, key, value):
    with _lock:
        store[key] = (time.time(), value)
        # Poda preguiçosa: evita crescer sem limite numa instância longeva.
        if len(store) > 500:
            for k in sorted(store, key=lambda k: store[k][0])[:100]:
                store.pop(k, None)


def clear_caches():
    with _lock:
        _pieces_cache.clear()
        _links_cache.clear()
        _search_cache.clear()


# ─── Validação ─────────────────────────────────────────────────────────────

def valid_token(t) -> bool:
    return isinstance(t, str) and bool(_TOKEN_RE.match(t.strip()))


def valid_creative_id(cid) -> bool:
    return isinstance(cid, str) and bool(_UUID_RE.match(cid.strip()))


def valid_date(d) -> bool:
    if not isinstance(d, str) or not _DATE_RE.match(d):
        return False
    try:
        datetime.strptime(d, "%Y-%m-%d")
        return True
    except ValueError:
        return False


# ─── HTTP com a Platform ───────────────────────────────────────────────────

def _http_get_json(path: str, params: dict, timeout: float = HTTP_TIMEOUT_S):
    key = service_key()
    if not key:
        raise NotConfigured(not_configured_message())
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "", [])})
    url = f"{platform_url()}{path}" + (f"?{qs}" if qs else "")
    req = urllib.request.Request(url, headers={
        "x-service-key": key,
        "accept": "application/json",
        "user-agent": "hypr-report-center/ma_report",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        snippet = ""
        try:
            snippet = e.read(300).decode("utf-8", "replace")
        except Exception:
            pass
        raise PlatformError(f"Platform HTTP {e.code} em {path}: {snippet}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise PlatformError(f"Platform inacessível em {path}: {e}") from e
    try:
        return json.loads(body)
    except ValueError as e:
        raise PlatformError(f"Platform devolveu JSON inválido em {path}") from e


# ─── Vínculos (BigQuery) ───────────────────────────────────────────────────

def links_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.report_ma_links"


_table_ensured = False
_ensure_lock = threading.Lock()


def _ensure_links_table():
    global _table_ensured
    if _table_ensured:
        return
    with _ensure_lock:
        if _table_ensured:
            return
        _bq().query(f"""
            CREATE TABLE IF NOT EXISTS `{links_table_id()}` (
                short_token        STRING NOT NULL,
                creative_id        STRING NOT NULL,
                position           INT64,
                name               STRING,
                template_slug      STRING,
                public_slug        STRING,
                size               STRING,
                client_name        STRING,
                dsp_creative_names STRING,
                linked_by          STRING,
                linked_at          TIMESTAMP
            )
        """).result()
        _table_ensured = True


def _parse_names(raw):
    if not raw:
        return []
    try:
        val = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return []
    if not isinstance(val, list):
        return []
    return [str(v)[:300] for v in val if isinstance(v, (str, int, float)) and str(v).strip()][:50]


def _row_to_link(row) -> dict:
    ts = row.get("linked_at")
    return {
        "creative_id": row.get("creative_id"),
        "position": row.get("position") or 0,
        "name": row.get("name") or "",
        "template_slug": row.get("template_slug") or "",
        "public_slug": row.get("public_slug") or "",
        "size": row.get("size") or "",
        "client_name": row.get("client_name") or "",
        "dsp_creative_names": _parse_names(row.get("dsp_creative_names")),
        "linked_by": row.get("linked_by") or "",
        "linked_at": ts.isoformat() if hasattr(ts, "isoformat") else (ts or None),
    }


def _all_links() -> dict:
    cached = _cget(_links_cache, "all", LINKS_TTL)
    if cached is not None:
        return cached
    _ensure_links_table()
    out = {}
    rows = _bq().query(
        f"SELECT * FROM `{links_table_id()}` ORDER BY short_token, position, linked_at"
    ).result()
    for r in rows:
        row = dict(r.items()) if hasattr(r, "items") else dict(r)
        tok = (row.get("short_token") or "").upper()
        if not tok:
            continue
        out.setdefault(tok, []).append(_row_to_link(row))
    _cset(_links_cache, "all", out)
    return out


def links_for_tokens(tokens) -> list:
    """Vínculos dos tokens pedidos, sem repetir peça (o primeiro vínculo de
    cada creative_id vence — importa no report agrupado, onde a mesma peça
    pode estar vinculada a vários meses)."""
    allv = _all_links()
    seen, out = set(), []
    for t in tokens or []:
        for link in allv.get((t or "").upper(), []):
            cid = link.get("creative_id")
            if cid and cid not in seen:
                seen.add(cid)
                out.append(link)
    return out[:MAX_PIECES]


def public_link(link: dict) -> dict:
    """O que o payload do report carrega sobre cada vínculo (cliente vê)."""
    return {
        "creative_id": link.get("creative_id"),
        "name": link.get("name") or "",
        "format": link.get("template_slug") or "",
        "size": link.get("size") or "",
        "public_slug": link.get("public_slug") or "",
        "dsp_creative_names": list(link.get("dsp_creative_names") or []),
    }


def sanitize_links_input(raw_links) -> list:
    """Valida o corpo do POST de vínculos. Levanta ValueError com a causa."""
    if not isinstance(raw_links, list):
        raise ValueError("links precisa ser uma lista")
    if len(raw_links) > MAX_PIECES:
        raise ValueError(f"no máximo {MAX_PIECES} peças por campanha")
    out, seen = [], set()
    for i, item in enumerate(raw_links):
        if not isinstance(item, dict):
            raise ValueError(f"links[{i}] inválido")
        cid = (item.get("creative_id") or "").strip()
        if not valid_creative_id(cid):
            raise ValueError(f"links[{i}].creative_id inválido")
        if cid in seen:
            continue
        seen.add(cid)
        slug = (item.get("public_slug") or "").strip()
        if slug and not _SLUG_RE.match(slug):
            slug = ""
        out.append({
            "creative_id": cid.lower(),
            "position": len(out),
            "name": str(item.get("name") or "")[:300],
            "template_slug": str(item.get("template_slug") or "")[:40],
            "public_slug": slug,
            "size": str(item.get("size") or "")[:20],
            "client_name": str(item.get("client_name") or "")[:200],
            "dsp_creative_names": _parse_names(item.get("dsp_creative_names") or []),
        })
    return out


def save_links(short_token: str, links: list, linked_by: str | None = None) -> list:
    """Substitui os vínculos do token (transação: DELETE + INSERT)."""
    if not valid_token(short_token):
        raise ValueError("short_token inválido")
    token = short_token.strip().upper()
    clean = sanitize_links_input(links)
    _ensure_links_table()
    params = [bigquery.ScalarQueryParameter("token", "STRING", token)]
    if clean:
        struct_rows = [
            bigquery.StructQueryParameter(
                None,
                bigquery.ScalarQueryParameter("creative_id", "STRING", l["creative_id"]),
                bigquery.ScalarQueryParameter("position", "INT64", l["position"]),
                bigquery.ScalarQueryParameter("name", "STRING", l["name"]),
                bigquery.ScalarQueryParameter("template_slug", "STRING", l["template_slug"]),
                bigquery.ScalarQueryParameter("public_slug", "STRING", l["public_slug"]),
                bigquery.ScalarQueryParameter("size", "STRING", l["size"]),
                bigquery.ScalarQueryParameter("client_name", "STRING", l["client_name"]),
                bigquery.ScalarQueryParameter("dsp_creative_names", "STRING", json.dumps(l["dsp_creative_names"], ensure_ascii=False)),
            )
            for l in clean
        ]
        params += [
            bigquery.ArrayQueryParameter("rows", "STRUCT", struct_rows),
            bigquery.ScalarQueryParameter("by", "STRING", linked_by),
        ]
        sql = f"""
            BEGIN TRANSACTION;
            DELETE FROM `{links_table_id()}` WHERE short_token = @token;
            INSERT INTO `{links_table_id()}`
                (short_token, creative_id, position, name, template_slug, public_slug,
                 size, client_name, dsp_creative_names, linked_by, linked_at)
            SELECT @token, r.creative_id, r.position, r.name, r.template_slug, r.public_slug,
                   r.size, r.client_name, r.dsp_creative_names, @by, CURRENT_TIMESTAMP()
            FROM UNNEST(@rows) AS r;
            COMMIT TRANSACTION;
        """
    else:
        sql = f"DELETE FROM `{links_table_id()}` WHERE short_token = @token"
    _bq().query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    with _lock:
        _links_cache.clear()
        _pieces_cache.clear()
    return [dict(l, linked_by=linked_by or "", linked_at=datetime.now(timezone.utc).isoformat()) for l in clean]


# ─── Busca (admin) ─────────────────────────────────────────────────────────

def search_creatives(*, q=None, client=None, token=None, names=None, limit=30) -> list:
    """Candidatos da Platform, já pontuados. `names` são os criativos da DSP
    nesta campanha (sinal de "nome parecido")."""
    names = [n for n in (names or []) if isinstance(n, str) and n.strip()][:50]
    params = {
        "q": (q or "").strip()[:120] or None,
        "client": (client or "").strip()[:120] or None,
        "token": token.strip().upper() if valid_token(token or "") else None,
        "names": "|".join(n.replace("|", " ")[:200] for n in names) or None,
        "limit": max(1, min(int(limit or 30), 100)),
    }
    if not any(params[k] for k in ("q", "client", "token", "names")):
        return []
    key = json.dumps(params, sort_keys=True)
    cached = _cget(_search_cache, key, SEARCH_TTL)
    if cached is not None:
        return cached
    data = _http_get_json("/api/v1/service/report-center/creatives/search", params)
    items = []
    for it in (data or {}).get("items") or []:
        if not isinstance(it, dict) or not valid_creative_id(it.get("id") or ""):
            continue
        items.append({
            "creative_id": it.get("id"),
            "name": it.get("name") or "",
            "status": it.get("status") or "",
            "template_slug": it.get("templateSlug") or "",
            "public_slug": it.get("publicSlug") or "",
            "client_name": it.get("clientName") or "",
            "size": it.get("size") or "",
            "created_at": it.get("createdAt"),
            "updated_at": it.get("updatedAt"),
            "score": it.get("score") or 0,
            "reasons": [r for r in (it.get("reasons") or []) if r in ("adbolt", "token", "name", "client", "query")],
        })
    _cset(_search_cache, key, items)
    return items


# ─── Métricas das peças ────────────────────────────────────────────────────

def _num(v):
    try:
        if v is None:
            return 0
        f = float(v)
        return int(f) if f.is_integer() else f
    except (TypeError, ValueError):
        return 0


def _pick(src, keys):
    """Copia só as chaves permitidas, numéricas."""
    src = src if isinstance(src, dict) else {}
    return {k: _num(src.get(k)) for k in keys}


# Chaves de sessão distinta por etapa (Platform → sessionSteps). Lista de
# permissão: chave nova na Platform não vaza sem passar por aqui.
SESSION_STEP_KEYS = (
    "impression", "viewable", "engaged", "overlay_click", "overlay_dismissed",
    "split_creative_click", "map_interaction", "pin_click", "cta_click",
    "cta_directions", "cta_whatsapp", "cta_website", "scratch_started",
    "scratch_completed", "tilt_activated", "nav", "survey_answer",
    "survey_complete", "game_started", "game_ended", "game_challenge_won",
    "brand_reveal_viewed", "game_restarted", "video_start", "video_complete",
    "widget_view", "close_to_locate",
)


def normalize_piece(item: dict, link: dict) -> dict:
    """Item da Platform → peça client-safe do report."""
    c = item.get("creative") or {}
    a = item.get("analytics") or {}
    t = a.get("totals") or {}
    slug = c.get("publicSlug") or link.get("public_slug") or ""
    status = c.get("status") or ""
    preview_url = None
    if slug and _SLUG_RE.match(slug) and status != "archived":
        preview_url = f"{platform_url()}/share/creatives/{urllib.parse.quote(slug)}?preview=1"

    steps = item.get("sessionSteps")
    steps = _pick(steps, SESSION_STEP_KEYS) if isinstance(steps, dict) else None

    top_pins = []
    for p in (a.get("topPins") or [])[:100]:
        if not isinstance(p, dict):
            continue
        by_button = _pick(p.get("ctaByButton"), ("directions", "whatsapp", "website"))
        top_pins.append({
            "name": str(p.get("pinName") or p.get("pinId") or "")[:200],
            "lat": p.get("lat") if isinstance(p.get("lat"), (int, float)) else None,
            "lng": p.get("lng") if isinstance(p.get("lng"), (int, float)) else None,
            "views": _num(p.get("views")),
            "pin_clicks": _num(p.get("pinClicks")),
            "cta_clicks": _num(p.get("ctaClicks")),
            "by_button": by_button,
        })

    sc = a.get("scratch") if isinstance(a.get("scratch"), dict) else None
    car = a.get("carrossel") if isinstance(a.get("carrossel"), dict) else None
    ff = a.get("freeform") if isinstance(a.get("freeform"), dict) else None
    sv = a.get("survey") if isinstance(a.get("survey"), dict) else None
    pl = a.get("play") if isinstance(a.get("play"), dict) else None
    cal = a.get("calendar") if isinstance(a.get("calendar"), dict) else None
    wg = a.get("widgets") if isinstance(a.get("widgets"), dict) else {}

    widgets = []
    for w in (wg.get("items") or [])[:4]:
        if not isinstance(w, dict):
            continue
        widgets.append({
            "id": str(w.get("widgetId") or w.get("id") or "")[:80],
            "type": str(w.get("widgetType") or w.get("type") or "")[:40],
            "label": str(w.get("label") or "")[:120],
            "views": _num(w.get("views")),
            "taps": _num(w.get("taps")),
            "tap_sessions": _num(w.get("tapSessions") or w.get("sessions")),
            "final_actions": _num(w.get("finalActions") or w.get("final")),
        })

    close_to = None
    ct = wg.get("closeTo") if isinstance(wg.get("closeTo"), dict) else None
    if ct:
        addrs = []
        for ad in (ct.get("addresses") or [])[:100]:
            if not isinstance(ad, dict):
                continue
            addrs.append({
                "name": str(ad.get("name") or ad.get("pinName") or "")[:200],
                "identified": _num(ad.get("identified") or ad.get("views")),
                "clicks": _num(ad.get("clicks")),
                "route": _num(ad.get("route") or ad.get("directions")),
                "site": _num(ad.get("site") or ad.get("website")),
            })
        close_to = {
            **_pick(ct, ("views", "taps", "tapSessions", "identified", "gps", "ip", "gpsGranted",
                         "gpsDenied", "clicks", "route", "site")),
            "addresses": addrs,
        }

    daily = []
    for row in (a.get("timeseries") or [])[:400]:
        if not isinstance(row, dict):
            continue
        daily.append({
            "date": str(row.get("bucket") or "")[:10],
            "impressions": _num(row.get("impression")),
            "viewable": _num(row.get("viewable")),
            "pin_clicks": _num(row.get("pinClick")),
            "cta_clicks": _num(row.get("ctaClick")),
            "engaged_sessions": _num(row.get("engagedSessions")),
        })

    return {
        "creative_id": c.get("id") or link.get("creative_id"),
        "name": c.get("name") or link.get("name") or "",
        "format": c.get("templateSlug") or link.get("template_slug") or "",
        "size": c.get("size") or link.get("size") or "",
        "status": status,
        "client_name": c.get("clientName") or link.get("client_name") or "",
        "cta_text": str(c.get("ctaText") or "")[:80],
        "mechanic": c.get("mechanic") or None,
        "survey_mode": c.get("surveyMode") or None,
        "game": c.get("game") or None,
        "has_overlay": bool(c.get("hasOverlay")),
        "updated_at": c.get("updatedAt") or None,
        "preview_url": preview_url,
        "dsp_creative_names": list(link.get("dsp_creative_names") or []),
        "totals": _pick(t, ("impressionServed", "impression", "viewable", "uniqueSessions",
                             "engagedSessions", "ctaClick", "pinClick", "mapInteraction",
                             "overlayDismissed", "overlayClick", "splitCreativeClick",
                             "clicksTotal", "clickSessions")),
        "steps": steps,
        "cta_by_button": _pick(a.get("ctaByButton"), ("directions", "whatsapp", "website")),
        "cta_by_surface": _pick(a.get("ctaBySurface"), ("pin_card", "nearest_card", "header", "overlay", "split_creative")),
        "top_pins": top_pins,
        "scratch": _pick(sc, ("scratchedSessions", "revealedSessions", "avgTimeToCompleteMs",
                              "ctaImage", "ctaButton", "ctaCover")) if sc else None,
        "carousel": {
            **_pick(car, ("slideChanges", "swipes", "navSessions", "ctaSlide", "ctaBackground", "ctaButton")),
            "nav_by_surface": _pick(car.get("navBySurface"), ("swipe", "arrow", "dot")),
            "top_slides": [
                {
                    "index": _num(s.get("index") if s.get("index") is not None else s.get("slideIndex")),
                    "label": str(s.get("label") or s.get("slideLabel") or "")[:120],
                    "navigations": _num(s.get("navigations") or s.get("views")),
                    "clicks": _num(s.get("clicks")),
                }
                for s in (car.get("topSlides") or [])[:24] if isinstance(s, dict)
            ],
        } if car else None,
        "freeform": _pick(ff, ("ctaMedia", "ctaButton", "videoStart", "videoFirstQuartile",
                               "videoMidpoint", "videoThirdQuartile", "videoComplete", "videoUnmute")) if ff else None,
        "survey": {
            **_pick(sv, ("answeredSessions", "avgTimeToAnswerMs", "completedSessions",
                         "ctaPayoff", "ctaButton", "ctaQuestion", "ctaOption")),
            "top_options": [
                {
                    "label": str(o.get("label") or o.get("optionLabel") or "")[:200],
                    "answers": _num(o.get("answers") or o.get("count")),
                    "clicks": _num(o.get("clicks")),
                }
                for o in (sv.get("topOptions") or [])[:20] if isinstance(o, dict)
            ],
        } if sv else None,
        "game": _pick(pl, ("playedSessions", "completedSessions", "avgScore", "avgPlayTimeMs",
                           "revealSessions", "replays", "challengeWon", "challengeLost",
                           "ctaPostGame", "ctaButton")) if pl else None,
        "calendar": _pick(cal, ("adds", "opens")) if cal else None,
        "widgets": widgets,
        "close_to": close_to,
        "daily": daily,
    }


def fetch_pieces(links: list, date_from: str | None = None, date_to: str | None = None) -> dict:
    """Métricas das peças vinculadas, normalizadas. Cacheado por (ids, período)."""
    links = [l for l in (links or []) if valid_creative_id(l.get("creative_id") or "")][:MAX_PIECES]
    if not links:
        return {"pieces": [], "errors": [], "fetched_at": None}
    date_from = date_from if valid_date(date_from or "") else None
    date_to = date_to if valid_date(date_to or "") else None
    ids = [l["creative_id"] for l in links]
    key = f"{','.join(sorted(ids))}|{date_from or ''}|{date_to or ''}"
    cached = _cget(_pieces_cache, key, PIECES_TTL)
    if cached is None:
        raw = _http_get_json("/api/v1/service/report-center/creatives", {
            "ids": ",".join(ids),
            "from": date_from,
            "to": date_to,
        })
        cached = {
            "items": {it.get("id"): it for it in (raw or {}).get("items") or [] if isinstance(it, dict)},
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
        _cset(_pieces_cache, key, cached)
    pieces, errors = [], []
    for link in links:
        it = cached["items"].get(link["creative_id"])
        if not it or not it.get("ok"):
            errors.append({
                "creative_id": link["creative_id"],
                "name": link.get("name") or "",
                "error": (it or {}).get("error") or "missing",
            })
            continue
        try:
            pieces.append(normalize_piece(it, link))
        except Exception as e:  # peça malformada não derruba as outras
            logger.warning(f"[ma_report] normalize {link['creative_id']}: {e}")
            errors.append({"creative_id": link["creative_id"], "name": link.get("name") or "", "error": "internal"})
    return {"pieces": pieces, "errors": errors, "fetched_at": cached["fetched_at"]}
