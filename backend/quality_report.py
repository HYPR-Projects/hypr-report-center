"""
Aba "Quality" do report do cliente — verificação DoubleVerify por campanha.

O admin conecta a campanha HYPR (short_token) a uma ou mais campanhas da DV
e escolhe o período que entra na análise; o report do cliente mostra os KQIs
do Pinnacle (Viewable, Authentic, Brand Suitable, Fraud/SIVT Free, In Geo…)
só daquele recorte. A conexão existe porque os nomes de campanha da DV
(ex.: "Gatorade_F1_2026") não casam com os tokens do HYPR — só quem opera sabe
qual é qual.

Armazenamento
-------------
`prod_assets.report_quality_links`, uma linha por campanha DV vinculada; o
período (date_from/date_to) é o mesmo em todas as linhas do token. Criada sob
demanda (CREATE IF NOT EXISTS), gravada em transação DELETE+INSERT por token —
mesmo padrão dos vínculos do Max Attention (ma_report.py), que não usa
streaming insert porque o buffer bloqueia DELETE por ~30 min.

Relatório
---------
Campaign × Dia filtrado às campanhas vinculadas, só contagens (as taxas saem
no front, como no admin — ver doubleverify.py). O pedido à DV é assíncrono e
leva 5-15s, então o resultado fica em memória por 1h por (campanhas, período),
com single-flight pra que vários clientes abrindo o mesmo report não disparem
vários relatórios iguais na DV.
"""
import logging
import os
import threading
import time
from datetime import date, datetime, timezone

from google.cloud import bigquery

import bq_client
import doubleverify as dv
import ma_report

logger = logging.getLogger(__name__)

PROJECT_ID = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET_ASSETS = "prod_assets"

MAX_CAMPAIGNS = 20
MAX_PERIOD_DAYS = 366
LINKS_TTL = 60
REPORT_TTL = 3600
CAMPAIGNS_TTL = 600

_lock = threading.Lock()
_links_cache = {}      # "all" -> (ts, {TOKEN: config})
_report_cache = {}     # (campaigns, from, to) -> (ts, payload)
_campaigns_cache = {}  # "all" -> (ts, [nomes])
_inflight = {}         # chave do report -> threading.Lock (single-flight)


def _cget(store, key, ttl):
    with _lock:
        hit = store.get(key)
        if hit and (time.time() - hit[0]) < ttl:
            return hit[1]
    return None


def _cset(store, key, value):
    with _lock:
        store[key] = (time.time(), value)
        if len(store) > 300:
            for k in sorted(store, key=lambda k: store[k][0])[:60]:
                store.pop(k, None)


def _bq():
    return bq_client.get_client()


# Mesma regra de token do Max Attention (report_ma_links).
valid_token = ma_report.valid_token


# ─── Vínculos (BigQuery) ────────────────────────────────────────────────────
def links_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.report_quality_links"


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
                short_token      STRING NOT NULL,
                dv_campaign_name STRING NOT NULL,
                position         INT64,
                date_from        DATE,
                date_to          DATE,
                linked_by        STRING,
                linked_at        TIMESTAMP
            )
        """).result()
        _table_ensured = True


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else (v or None)


def _all_links() -> dict:
    cached = _cget(_links_cache, "all", LINKS_TTL)
    if cached is not None:
        return cached
    _ensure_links_table()
    out = {}
    rows = _bq().query(
        f"SELECT * FROM `{links_table_id()}` ORDER BY short_token, position"
    ).result()
    for r in rows:
        row = dict(r.items()) if hasattr(r, "items") else dict(r)
        tok = (row.get("short_token") or "").upper()
        name = row.get("dv_campaign_name")
        if not tok or not name:
            continue
        cfg = out.setdefault(tok, {
            "campaigns": [],
            "date_from": _iso(row.get("date_from")),
            "date_to": _iso(row.get("date_to")),
            "linked_by": row.get("linked_by") or "",
            "linked_at": _iso(row.get("linked_at")),
        })
        cfg["campaigns"].append(name)
    _cset(_links_cache, "all", out)
    return out


def config_for_token(token: str):
    return _all_links().get((token or "").upper())


def config_for_tokens(tokens):
    """Config efetiva de uma visão. Token avulso = a própria config. Visão
    agregada de um grupo = união das campanhas DV dos membros e o período
    que cobre todos (do menor início ao maior fim)."""
    cfgs = [c for c in (config_for_token(t) for t in tokens or []) if c]
    if not cfgs:
        return None
    if len(cfgs) == 1:
        return cfgs[0]
    names, seen = [], set()
    for c in cfgs:
        for n in c["campaigns"]:
            if n not in seen:
                seen.add(n)
                names.append(n)
    froms = [c["date_from"] for c in cfgs if c.get("date_from")]
    tos = [c["date_to"] for c in cfgs if c.get("date_to")]
    return {
        "campaigns": names[:MAX_CAMPAIGNS],
        "date_from": min(froms) if froms else None,
        "date_to": max(tos) if tos else None,
    }


def public_config(cfg) -> dict:
    """O que o payload do report carrega (o cliente vê)."""
    if not cfg:
        return {"linked": False}
    return {
        "linked": True,
        "campaigns": list(cfg.get("campaigns") or []),
        "date_from": cfg.get("date_from"),
        "date_to": cfg.get("date_to"),
    }


def sanitize_input(campaigns, date_from, date_to):
    """Valida o POST. Levanta ValueError com a causa. Lista vazia = desconectar."""
    if not isinstance(campaigns, list):
        raise ValueError("campaigns precisa ser uma lista")
    names, seen = [], set()
    for i, n in enumerate(campaigns):
        if not isinstance(n, str) or not n.strip():
            raise ValueError(f"campaigns[{i}] inválido")
        n = n.strip()[:300]
        if n not in seen:
            seen.add(n)
            names.append(n)
    if len(names) > MAX_CAMPAIGNS:
        raise ValueError(f"no máximo {MAX_CAMPAIGNS} campanhas DV por report")
    if not names:
        return [], None, None
    try:
        f = date.fromisoformat(str(date_from))
        t = date.fromisoformat(str(date_to))
    except (TypeError, ValueError):
        raise ValueError("período inválido (use YYYY-MM-DD)")
    if f > t:
        raise ValueError("início do período depois do fim")
    if (t - f).days + 1 > MAX_PERIOD_DAYS:
        raise ValueError(f"período máximo é {MAX_PERIOD_DAYS} dias")
    return names, f, t


def save_config(short_token: str, campaigns, date_from, date_to, linked_by=None) -> dict:
    """Substitui a conexão do token (transação DELETE + INSERT)."""
    if not valid_token(short_token):
        raise ValueError("short_token inválido")
    token = short_token.strip().upper()
    names, f, t = sanitize_input(campaigns, date_from, date_to)
    _ensure_links_table()
    params = [bigquery.ScalarQueryParameter("token", "STRING", token)]
    if names:
        params += [
            bigquery.ArrayQueryParameter("names", "STRING", names),
            bigquery.ScalarQueryParameter("f", "DATE", f),
            bigquery.ScalarQueryParameter("t", "DATE", t),
            bigquery.ScalarQueryParameter("by", "STRING", linked_by),
        ]
        sql = f"""
            BEGIN TRANSACTION;
            DELETE FROM `{links_table_id()}` WHERE short_token = @token;
            INSERT INTO `{links_table_id()}`
                (short_token, dv_campaign_name, position, date_from, date_to, linked_by, linked_at)
            SELECT @token, name, pos, @f, @t, @by, CURRENT_TIMESTAMP()
            FROM UNNEST(@names) AS name WITH OFFSET AS pos;
            COMMIT TRANSACTION;
        """
    else:
        sql = f"DELETE FROM `{links_table_id()}` WHERE short_token = @token"
    _bq().query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    with _lock:
        _links_cache.clear()
    if not names:
        return {"linked": False}
    return {
        "linked": True,
        "campaigns": names,
        "date_from": f.isoformat(),
        "date_to": t.isoformat(),
        "linked_by": linked_by or "",
        "linked_at": datetime.now(timezone.utc).isoformat(),
    }


# ─── Catálogo de campanhas DV (admin) ───────────────────────────────────────
def dv_campaigns(force=False) -> list:
    if not force:
        cached = _cget(_campaigns_cache, "all", CAMPAIGNS_TTL)
        if cached is not None:
            return cached
    names = dv.list_campaign_names()
    _cset(_campaigns_cache, "all", names)
    return names


# ─── Relatório ──────────────────────────────────────────────────────────────
def _effective_window(cfg):
    """Período salvo, cortado em D-1 (a DV fecha o dia uma vez). None se o
    período ainda não começou."""
    f = date.fromisoformat(cfg["date_from"])
    t = date.fromisoformat(cfg["date_to"])
    t_eff = min(t, dv.yesterday_brt())
    if t_eff < f:
        return None
    return f, t_eff


def build_report(cfg, force=False) -> dict:
    """Payload da aba: contagens Campaign × Dia do recorte vinculado."""
    base = public_config(cfg)
    if not cfg or not cfg.get("campaigns") or not cfg.get("date_from") or not cfg.get("date_to"):
        return {**base, "rows": [], "columns": dv.METRIC_KEYS, "campaigns_found": []}
    win = _effective_window(cfg)
    if win is None:
        return {**base, "pending": True, "rows": [], "columns": dv.METRIC_KEYS, "campaigns_found": []}
    f, t = win
    key = (tuple(sorted(cfg["campaigns"])), f.isoformat(), t.isoformat())
    if not force:
        hit = _cget(_report_cache, key, REPORT_TTL)
        if hit is not None:
            return {**base, **hit}
    with _lock:
        flight = _inflight.setdefault(key, threading.Lock())
    with flight:
        if not force:
            hit = _cget(_report_cache, key, REPORT_TTL)
            if hit is not None:
                return {**base, **hit}
        text = dv.run_report(dv.build_campaign_request_body(cfg["campaigns"], f, t))
        parsed = dv.parse_campaign_csv(text, f, t)
        payload = {
            "from": f.isoformat(),
            "to": t.isoformat(),
            "columns": parsed["columns"],
            "campaigns_found": parsed["campaigns"],
            "rows": parsed["rows"],
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
        _cset(_report_cache, key, payload)
    with _lock:
        _inflight.pop(key, None)
    return {**base, **payload}
