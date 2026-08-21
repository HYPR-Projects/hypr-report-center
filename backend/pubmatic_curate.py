"""
PubMatic Data Provider Analytics — 2ª fonte de curadoria do PMP Deals.

Espelha o `xandr_curate.py`, mas para os Auction Package deals que a HYPR
opera como CURADORA (data provider) na PubMatic. Popula
`pmp_line_delivery_daily` e `pmp_line_items` com `source='pubmatic'`.

Descoberta e validação da API (2026-08-04, ver project_pubmatic_integracao
na memória) — tudo abaixo foi confirmado ao vivo contra a conta HYPR (74689):

Autenticação (2 passos, host api.pubmatic.com)
----------------------------------------------
  POST /v1/developer-integrations/developer/token
    body {"apiProduct":"PUBLISHER","userName","password"} → Bearer (accessToken).

  CHAIN DE CREDENCIAIS (desde 21/08/2026) — a credencial primária começou a
  devolver 401 AUTH_FAILED em 19/08 sem nenhuma mudança do nosso lado (acesso
  de API do usuário no seat da PubMatic). O sync ficou 3 dias parado em
  silêncio: o `except` do pmp_sync_v2 é best-effort (não pode derrubar o Xandr)
  e o painel de frescor lia o `synced_at` das linhas de entrega, que não muda
  quando o sync nem chega a rodar. Duas defesas nasceram daí:
    1. `CREDENTIAL_SETS` — tenta o par ALT quando o primário falha na auth;
    2. `pmp_sync_runs` — ledger de execuções que o painel passa a ler.
  A chain compra tempo; ela NÃO substitui consertar a credencial primária (o
  painel avisa em amarelo quando o fallback assume).
  O Bearer vale 60 dias; a doc recomenda refresh via PUT /refreshToken a cada
  55d. Aqui NÃO gerenciamos o refresh token: geramos o Bearer a partir das
  credenciais e CACHEAMOS em memória do processo (igual xandr_curate.get_token).
  O limite perigoso é 200 gerações de token em 20min → conta desabilitada;
  por isso o cache é obrigatório, não conveniência.

Reporting (host api.pubmatic.com)
---------------------------------
  GET /v1/analytics/data/dataprovider/{accountId}
      ?dimensions=dealMetaId,date
      &metrics=paidImpressions,spend,transactionRevenue,dataRevenue,clicks
      &fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&dateUnit=date
      header authorization: Bearer <token>
  • `dateUnit=date` + a dimensão `date` = 1 linha por dia (a ÚNICA combinação
    que devolve granularidade diária; `dateUnit=day/days` dá 400).
  • Moeda BRL NATIVA (currency:BRL). Sem conversão FX, sem timezone hell —
    diferente do Xandr.
  • `dealMetaId` (numérico, ex 735537) vira nosso `line_id`. O deal id textual
    (publisherDealId, ex PM-QUHQ-3967) vem junto e guardamos em external_deal_id.

Mapeamento de métricas → colunas curator_* (líquido confirmado pelo João)
------------------------------------------------------------------------
  spend               → curator_revenue   (bruto pago pelo comprador)
  transactionRevenue  → curator_margin    (RECEITA LÍQUIDA HYPR = 85% do spend,
                                            a margem configurada no setup do deal;
                                            é o que alimenta pct_a_receber)
  dataRevenue         → data_revenue       (receita de dados; 0 em deal sem
                                            componente de audiência — só auditoria)
  paidImpressions     → imps
  clicks              → clicks
  (sem custo separado: transactionRevenue já é o líquido; curator_net_media_cost
   /tech_fees/total_cost ficam NULL, billing_exchange_rate = 1.0 pois já é BRL)
"""

import csv  # noqa: F401 — simetria com xandr_curate; parsing aqui é JSON
import json
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional

from google.cloud import bigquery as _bq

import bq_client

logger = logging.getLogger(__name__)

# ── Constantes de API ─────────────────────────────────────────────────────────
BASE_URL = "https://api.pubmatic.com"
TOKEN_PATH = "/v1/developer-integrations/developer/token"
# accountId = seat da HYPR na PubMatic (o mesmo que aparece na Media Console).
ACCOUNT_ID = os.environ.get("PUBMATIC_ACCOUNT_ID", "74689")

SOURCE = "pubmatic"

# Dimensões e métricas validadas contra a conta HYPR. A ordem de `dimensions`
# não importa pro resultado (testado date,dealMetaId ⇔ dealMetaId,date).
REPORT_DIMENSIONS = "dealMetaId,date"
REPORT_METRICS = "paidImpressions,spend,transactionRevenue,dataRevenue,clicks"

# ── Credenciais (chain) ───────────────────────────────────────────────────────
# Ordem de tentativa. O 2º conjunto não é redundância decorativa: em 19/08/2026
# a credencial primária começou a devolver 401 AUTH_FAILED no /developer/token
# (usuário sem acesso de API no seat — não é senha errada nossa, é mudança do
# lado da PubMatic) e o sync ficou 3 dias parado em silêncio, com um deal novo
# entregando fora do hub. Com a chain, uma credencial revogada custa um WARNING
# no ledger em vez de dias de base congelada.
CREDENTIAL_SETS = [
    ("primary", "PUBMATIC_USER",     "PUBMATIC_PASS"),
    ("alt",     "PUBMATIC_USER_ALT", "PUBMATIC_PASS_ALT"),
]

# ── Cache de token (process-local, igual xandr_curate) ─────────────────────────
_cached_token: Optional[str] = None
_cached_token_exp_ms: float = 0.0
# Rótulo do conjunto de credenciais que autenticou por último — vai pro ledger
# (`pmp_sync_runs.credential`) pra o operador ver quando o fallback assumiu.
_cached_cred_label: Optional[str] = None
# Bearer vale 60d; renovamos MUITO antes (6h) — o custo de re-gerar é baixo e
# nos protege de servir um token perto do vencimento numa instância antiga.
# O que importa é NUNCA gerar por request (limite 200/20min desabilita a conta).
_TOKEN_TTL_MS = 6 * 60 * 60 * 1000

# ── BQ ─────────────────────────────────────────────────────────────────────────
# Client compartilhado (timeout obrigatório + pool dimensionado) — ver bq_client.py.
_bq_client = bq_client.get_client()
_PROJECT = os.environ.get("GCP_PROJECT", "site-hypr")
_DATASET = "prod_assets"


class PubMaticError(RuntimeError):
    """Erros específicos da integração PubMatic (auth, report, parsing)."""
    pass


def available_credentials() -> list:
    """Conjuntos de credenciais efetivamente configurados, na ordem da chain."""
    out = []
    for label, user_env, pass_env in CREDENTIAL_SETS:
        user, pwd = os.environ.get(user_env), os.environ.get(pass_env)
        if user and pwd:
            out.append((label, user, pwd))
    return out


def is_configured() -> bool:
    """True se ao menos um conjunto de credenciais está no ambiente."""
    return bool(available_credentials())


def credential_label() -> Optional[str]:
    """Qual conjunto autenticou por último (None se ainda não autenticou)."""
    return _cached_cred_label


# ── Auth ────────────────────────────────────────────────────────────────────────
def _request_token(user: str, password: str) -> str:
    """Uma tentativa de emissão de Bearer. Levanta PubMaticError com o corpo
    da resposta (o AUTH_FAILED da PubMatic só é diagnosticável pelo corpo)."""
    body = json.dumps({
        "apiProduct": "PUBLISHER",
        "userName": user,
        "password": password,
    }).encode("utf-8")
    req = urllib.request.Request(BASE_URL + TOKEN_PATH, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            payload = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise PubMaticError(f"HTTP {e.code} POST {TOKEN_PATH}: "
                            f"{e.read().decode('utf-8','ignore')[:300]}")
    except urllib.error.URLError as e:
        raise PubMaticError(f"Falha de rede POST {TOKEN_PATH}: {e}")

    token = payload.get("accessToken")
    if not token:
        raise PubMaticError(f"Auth sem accessToken na resposta: {list(payload)}")
    return token


def get_token(force_refresh: bool = False) -> str:
    """Retorna um Bearer válido, percorrendo a chain de credenciais.

    Cache em memória do processo (sobrevive entre requests da mesma instância
    da Cloud Function). NUNCA chamar por request — ver limite de 200/20min.
    Se a primeira credencial falhar na AUTENTICAÇÃO, tenta a próxima e loga
    qual assumiu; se todas falharem, levanta com o erro de cada uma (senão o
    operador vê só a última e acha que só existe uma credencial).
    """
    global _cached_token, _cached_token_exp_ms, _cached_cred_label
    now_ms = time.time() * 1000
    if not force_refresh and _cached_token and now_ms < _cached_token_exp_ms:
        return _cached_token

    creds = available_credentials()
    if not creds:
        raise PubMaticError(
            "Nenhuma credencial PubMatic configurada (PUBMATIC_USER/PASS ou "
            "PUBMATIC_USER_ALT/PASS_ALT). Configure no Secret Manager e "
            "re-deploye a Cloud Function (ver deploy.sh)."
        )

    failures = []
    for label, user, pwd in creds:
        try:
            token = _request_token(user, pwd)
        except PubMaticError as e:
            failures.append(f"{label}({user}): {e}")
            logger.warning("[pubmatic] credencial '%s' falhou na auth: %s", label, e)
            continue
        _cached_token = token
        _cached_token_exp_ms = now_ms + _TOKEN_TTL_MS
        _cached_cred_label = label
        if failures:
            logger.warning("[pubmatic] autenticado com a credencial de fallback "
                           "'%s' — a(s) anterior(es) precisam de conserto no seat", label)
        logger.info("[pubmatic] novo Bearer emitido via '%s' (cache TTL %dh)",
                    label, _TOKEN_TTL_MS // 3_600_000)
        return token

    raise PubMaticError("Todas as credenciais PubMatic falharam na auth → "
                        + " | ".join(failures))


# ── HTTP GET (reporting) ──────────────────────────────────────────────────────
def _report_get(params: dict, timeout: int = 90) -> dict:
    """GET no Data Provider Analytics API. Devolve o JSON parsed.

    Levanta PubMaticError em HTTP != 2xx (inclui o 400 de combinação inválida
    de dimensions/metrics, útil pra debug).
    """
    url = (f"{BASE_URL}/v1/analytics/data/dataprovider/{ACCOUNT_ID}"
           f"?{urllib.parse.urlencode(params)}")
    req = urllib.request.Request(url, method="GET")
    req.add_header("accept", "application/json")
    req.add_header("authorization", f"Bearer {get_token()}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        # 401 pode ser token expirado numa instância antiga — 1 retry com refresh.
        raw = e.read().decode("utf-8", "ignore")
        if e.code == 401:
            logger.warning("[pubmatic] 401 no report; refresh de token e 1 retry")
            req2 = urllib.request.Request(url, method="GET")
            req2.add_header("accept", "application/json")
            req2.add_header("authorization", f"Bearer {get_token(force_refresh=True)}")
            with urllib.request.urlopen(req2, timeout=timeout) as r:
                return json.loads(r.read())
        raise PubMaticError(f"HTTP {e.code} GET dataprovider: {raw[:400]}")
    except urllib.error.URLError as e:
        raise PubMaticError(f"Falha de rede GET dataprovider: {e}")


# ── Parsing do nome do deal → cliente ─────────────────────────────────────────
# Nomes de deal seguem a convenção HYPR, ex:
#   HYPR_NESTLE_AMAZON-DSP_WPP_KITKAT-F1_FIXED-BID_DEAL_DISPLAY_PUBMATIC_JUN-26
# Reaproveitamos a mesma heurística do Xandr: tokens de ruído (HYPR, PMP, DSP,
# nome da DSP, PUBMATIC, etc.) são pulados; o primeiro token útil é o cliente.
_SKIP_TOKENS = {"HYPR", "PMP", "PUBMATIC", "XANDR", "CURATED", "CURATE", "IO",
                "DEAL", "DISPLAY", "VIDEO", "OLV", "CTV",
                "FIXED-BID", "FLEX-BID", "FIXED", "FLEX", "BID",
                "FY24", "FY25", "FY26", "FY27", "FY"}
_DSP_TOKENS = {"DV360", "DSP", "AMAZON-DSP", "AMAZONDSP", "TRADEDESK",
               "STACKADAPT", "AMAZON-ADS", "AMAZONADS", "TTD"}
_MONTH_RE = re.compile(r"^(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)-?\d{0,2}$",
                       re.IGNORECASE)
_FY_SUFFIX_RE = re.compile(r"FY\d{2}$", re.IGNORECASE)


def _customer_from_deal_name(deal_name: str) -> Optional[str]:
    """Best-effort: extrai o cliente do nome do deal PubMatic.

    Ex: HYPR_NESTLE_AMAZON-DSP_..._JUN-26 → "Nestle". Normaliza via
    pmp_deals.CUSTOMER_DISPLAY quando disponível (import lazy pra evitar ciclo).
    Retorna None se nenhum token útil sobrar (admin/link manual resolve).
    """
    if not deal_name:
        return None
    tokens = [t for t in deal_name.split("_") if t]
    for t in tokens:
        up = t.upper()
        if up in _SKIP_TOKENS or up in _DSP_TOKENS:
            continue
        if _FY_SUFFIX_RE.match(up) or _MONTH_RE.match(up):
            continue
        key = up.replace("-", "")
        try:
            import pmp_deals
            if key in pmp_deals.CUSTOMER_DISPLAY:
                return pmp_deals.CUSTOMER_DISPLAY[key]
        except Exception:
            pass
        return t.replace("-", " ").title()
    return None


# ── Fetch + parse do report diário ────────────────────────────────────────────
def _num(v) -> float:
    try:
        return float(v) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


def _int(v) -> int:
    try:
        return int(float(v)) if v not in (None, "") else 0
    except (TypeError, ValueError):
        return 0


# A API às vezes devolve um placeholder no lugar do publisherDealId
# (ex: "Name is not available (735537)"), tipicamente em deal recém-criado.
# Gravar isso polui o external_deal_id e some com o id legível de verdade —
# melhor devolver None e deixar o COALESCE do MERGE preservar o que já existe.
_DEAL_ID_RE = re.compile(r"^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$", re.IGNORECASE)


def _clean_deal_id(v) -> Optional[str]:
    txt = str(v).strip() if v not in (None, "") else ""
    if not txt or not _DEAL_ID_RE.match(txt):
        return None
    return txt


def fetch_delivery_rows(start_date: date, end_date: date) -> tuple[list, dict]:
    """Puxa o report diário por deal no intervalo [start, end].

    Retorna (rows, deal_meta) onde:
      rows: lista de dicts prontos pro upsert em pmp_line_delivery_daily
      deal_meta: {line_id(dealMetaId): {"external_deal_id","deal_name"}} pros masters

    POLÍTICA D-1 (igual Xandr): descarta o dia corrente (BRT), que é parcial.
    """
    params = {
        "dimensions": REPORT_DIMENSIONS,
        "metrics": REPORT_METRICS,
        "fromDate": start_date.isoformat(),
        "toDate": end_date.isoformat(),
        "dateUnit": "date",
    }
    payload = _report_get(params)

    cols = payload.get("columns") or []
    idx = {c: i for i, c in enumerate(cols)}
    required = {"dealMetaId", "date", "paidImpressions", "spend", "transactionRevenue"}
    missing = required - set(idx)
    if missing:
        raise PubMaticError(
            f"Report sem colunas esperadas: {sorted(missing)} (veio: {cols})"
        )
    # publisherDealId vem automático junto de dealMetaId, mas defensivo:
    has_pub_deal = "publisherDealId" in idx
    has_data_rev = "dataRevenue" in idx
    has_clicks = "clicks" in idx

    # displayValue.dealMetaId mapeia dealMetaId → nome do deal.
    name_map = ((payload.get("displayValue") or {}).get("dealMetaId")) or {}

    today_brt = date.today()
    rows: List[dict] = []
    deal_meta: dict = {}
    skipped_today = 0
    skipped_empty = 0

    for r in payload.get("rows") or []:
        deal_meta_id = r[idx["dealMetaId"]]
        day_raw = str(r[idx["date"]])[:10]
        try:
            line_id = int(deal_meta_id)
        except (TypeError, ValueError):
            logger.warning("[pubmatic] dealMetaId não-numérico, pulando: %r", deal_meta_id)
            continue
        try:
            day_iso = datetime.strptime(day_raw, "%Y-%m-%d").date()
        except ValueError:
            continue
        if day_iso >= today_brt:   # D-1: ignora dia corrente (parcial)
            skipped_today += 1
            continue

        imps = _int(r[idx["paidImpressions"]])
        spend = _num(r[idx["spend"]])
        transaction_rev = _num(r[idx["transactionRevenue"]])

        # A API preenche o range de datas com dias ZERADOS (sem entrega). Gravar
        # esses 0-rows criaria "dias de entrega" falsos — o último dia (mesmo
        # zerado) viraria last_delivery_day e o deal apareceria "live/ontem"
        # sem ter entregue nada. Também há lag de reporting (~1-2d) da PubMatic,
        # então o dia mais recente costuma vir 0 até a base fechar. Pulamos.
        if imps == 0 and spend == 0 and transaction_rev == 0:
            skipped_empty += 1
            continue

        rows.append({
            "line_id":                line_id,
            "source":                 SOURCE,
            "day":                    day_iso,
            "imps":                   imps,
            "viewable_imps":          0,      # viewability é % na API; não temos contagem
            "clicks":                 _int(r[idx["clicks"]]) if has_clicks else 0,
            # Sem custo separado — transactionRevenue já é o líquido HYPR.
            "curator_net_media_cost": None,
            "curator_tech_fees":      None,
            "curator_total_cost":     None,
            "curator_revenue":        spend,             # bruto do comprador
            "curator_margin":         transaction_rev,   # LÍQUIDO HYPR (pct_a_receber)
            "data_revenue":           _num(r[idx["dataRevenue"]]) if has_data_rev else 0.0,
            "billing_exchange_rate":  1.0,               # já é BRL
        })
        # Acumula por deal: 1º dia de entrega (start proxy) + somas p/ derivar a
        # margem configurada (transactionRevenue/spend ~ 85%). O Xandr pega
        # curator_margin_pct da API; no PubMatic derivamos da própria entrega.
        dm = deal_meta.get(line_id)
        if dm is None:
            ext = _clean_deal_id(r[idx["publisherDealId"]]) if has_pub_deal else None
            dm = {
                "external_deal_id": ext,
                "deal_name": name_map.get(str(deal_meta_id)) or name_map.get(deal_meta_id),
                "first_day": day_iso, "_sum_rev": 0.0, "_sum_margin": 0.0,
            }
            deal_meta[line_id] = dm
        if day_iso < dm["first_day"]:
            dm["first_day"] = day_iso
        dm["_sum_rev"]    += spend
        dm["_sum_margin"] += transaction_rev

    # Deriva a margem configurada (%) por deal a partir das somas.
    for dm in deal_meta.values():
        sr = dm.pop("_sum_rev", 0.0)
        sm = dm.pop("_sum_margin", 0.0)
        dm["margin_pct"] = round(sm / sr * 100, 2) if sr > 0 else None

    if skipped_today:
        logger.info("[pubmatic] descartadas %d linhas do dia corrente (D-1)", skipped_today)
    if skipped_empty:
        logger.info("[pubmatic] descartadas %d linhas de dias zerados", skipped_empty)
    return rows, deal_meta


# ── Upsert (load → staging → MERGE), com `source` na chave ────────────────────
def _upsert_via_staging(target_table: str, rows: list, key_columns: list,
                        schema: list, update_cols: list,
                        timestamp_col: Optional[str] = None,
                        update_exprs: Optional[dict] = None) -> dict:
    """Idêntico em espírito ao xandr_curate._upsert_via_staging, mas a chave do
    MERGE inclui `source` (composta (source, line_id[, day])).

    Preserva colunas manuais do alvo (só sobrescreve update_cols).

    `update_exprs` sobrescreve a expressão do UPDATE de uma coluna específica
    (o INSERT continua usando S.<col>). Serve pras colunas em que "o que veio
    agora" NÃO é a verdade completa — ex.: `start_date`, que é o 1º dia de
    entrega DENTRO DA JANELA sincronizada; sem LEAST contra o valor já gravado,
    a data de início do deal andava pra frente a cada sync conforme a janela
    deslizava (o deal 735537 tinha start_date=03/08 com entrega desde 31/07).
    """
    import uuid
    staging_name = f"_pmp_pm_staging_{uuid.uuid4().hex[:8]}"
    staging_ref = _bq.TableReference.from_string(f"{_PROJECT}.{_DATASET}.{staging_name}")
    table = _bq.Table(staging_ref, schema=schema)
    table.expires = datetime.now(timezone.utc) + timedelta(hours=1)
    _bq_client.create_table(table)
    try:
        rows_json = []
        for r in rows:
            out = {}
            for f in schema:
                v = r.get(f.name)
                if v is None:
                    out[f.name] = None
                elif f.field_type == "NUMERIC":
                    try:
                        out[f.name] = str(round(float(v), 4))
                    except (TypeError, ValueError):
                        out[f.name] = str(v)
                elif f.field_type == "DATE":
                    out[f.name] = str(v)
                elif f.field_type == "TIMESTAMP":
                    out[f.name] = str(v) if v else None
                elif f.mode == "REPEATED":
                    out[f.name] = list(v) if v else []
                else:
                    out[f.name] = v
            rows_json.append(out)
        errors = _bq_client.insert_rows_json(table, rows_json)
        if errors:
            raise PubMaticError(f"staging insert errors em {target_table}: {errors[:3]}")

        on_clauses = " AND ".join(f"T.{c} = S.{c}" for c in key_columns)
        exprs = update_exprs or {}
        upd_set = ", ".join(f"{c} = {exprs.get(c, f'S.{c}')}" for c in update_cols)
        if timestamp_col:
            upd_set += f", {timestamp_col} = CURRENT_TIMESTAMP()"
        insert_cols = key_columns + update_cols + ([timestamp_col] if timestamp_col else [])
        insert_vals = [f"S.{c}" for c in (key_columns + update_cols)]
        if timestamp_col:
            insert_vals += ["CURRENT_TIMESTAMP()"]
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
            logger.warning("[pubmatic] falhou deletando staging %s: %s", staging_name, e)
    return {"merged": len(rows)}


def _ensure_masters(deal_meta: dict) -> int:
    """Garante 1 linha em pmp_line_items por deal PubMatic (source='pubmatic').

    Só cria/atualiza os campos vindos da fonte; campos manuais (status, notes,
    overrides, short_token/link com Command) NUNCA são tocados pelo sync.
    O customer é parseado do nome do deal e gravado em customer_override
    (PubMatic não tem insertion order de onde herdar cliente).
    """
    if not deal_meta:
        return 0
    rows = []
    for line_id, m in deal_meta.items():
        rows.append({
            "line_id":            int(line_id),
            "source":             SOURCE,
            "line_name":          m.get("deal_name"),
            "external_deal_id":   m.get("external_deal_id"),
            "customer_override":  _customer_from_deal_name(m.get("deal_name") or ""),
            "state":              "active",   # aparece no report ⇒ ativa
            # start_date = 1º dia de entrega (proxy do início do flight; o
            # relatório não traz datas de flight). end_date fica NULL — vem do
            # checklist do Command quando o deal é vinculado (COALESCE no enriched).
            "start_date":         m.get("first_day").isoformat() if m.get("first_day") else None,
            # Margem configurada derivada da entrega (transactionRevenue/spend).
            # Alimenta o badge "+/− R$" da coluna Margem (igual ao Xandr).
            "curator_margin_pct": m.get("margin_pct"),
        })
    _upsert_via_staging(
        target_table="pmp_line_items",
        rows=rows,
        key_columns=["source", "line_id"],
        schema=[
            _bq.SchemaField("source", "STRING"),
            _bq.SchemaField("line_id", "INT64"),
            _bq.SchemaField("line_name", "STRING"),
            _bq.SchemaField("external_deal_id", "STRING"),
            _bq.SchemaField("customer_override", "STRING"),
            _bq.SchemaField("state", "STRING"),
            _bq.SchemaField("start_date", "DATE"),
            _bq.SchemaField("curator_margin_pct", "NUMERIC"),
        ],
        # customer_override entra aqui (e não fora do MERGE) porque o
        # `_upsert_via_staging` só escreve o que está em update_cols — inclusive
        # no INSERT. Ficando de fora, ele nunca era gravado e todo deal PubMatic
        # nascia sem cliente (753376/686804 estavam assim). Com o COALESCE
        # abaixo ele é SEMENTE: preenche o vazio, nunca sobrescreve edição manual.
        update_cols=["line_name", "external_deal_id", "customer_override",
                     "state", "start_date", "curator_margin_pct"],
        # O que a janela sincronizada NÃO enxerga não pode apagar o que já está
        # gravado: start_date é o 1º dia de entrega DA JANELA (LEAST preserva o
        # início real do deal), e line_name/external_deal_id/margin_pct vêm
        # vazios quando a API não devolve o displayValue ou o deal ainda não
        # somou receita no recorte.
        update_exprs={
            "start_date":         "LEAST(COALESCE(T.start_date, S.start_date), S.start_date)",
            "line_name":          "COALESCE(S.line_name, T.line_name)",
            "external_deal_id":   "COALESCE(S.external_deal_id, T.external_deal_id)",
            "curator_margin_pct": "COALESCE(S.curator_margin_pct, T.curator_margin_pct)",
            "customer_override":  "COALESCE(T.customer_override, S.customer_override)",
        },
        timestamp_col="last_synced_at",
    )
    return len(rows)


def sync_delivery(start_date: Optional[date] = None,
                  end_date: Optional[date] = None,
                  lookback_days: int = 7) -> dict:
    """Orquestra o sync PubMatic: fetch → upsert masters → upsert delivery.

    Sem datas explícitas, usa janela [hoje-lookback, hoje] (o fetch descarta
    o dia corrente por D-1). Não recria tabelas; assume migração 001 aplicada.
    """
    t0 = time.time()
    if not end_date:
        end_date = date.today()
    if not start_date:
        start_date = end_date - timedelta(days=lookback_days)
    window = f"{start_date.isoformat()} → {end_date.isoformat()}"
    logger.info("[pubmatic] sync delivery iniciado (window=%s)", window)

    rows, deal_meta = fetch_delivery_rows(start_date, end_date)
    logger.info("[pubmatic] %d linhas diárias, %d deals", len(rows), len(deal_meta))

    masters = _ensure_masters(deal_meta)

    if rows:
        _upsert_via_staging(
            target_table="pmp_line_delivery_daily",
            rows=rows,
            key_columns=["source", "line_id", "day"],
            schema=[
                _bq.SchemaField("source", "STRING"),
                _bq.SchemaField("line_id", "INT64"),
                _bq.SchemaField("day", "DATE"),
                _bq.SchemaField("imps", "INT64"),
                _bq.SchemaField("viewable_imps", "INT64"),
                _bq.SchemaField("clicks", "INT64"),
                _bq.SchemaField("curator_net_media_cost", "NUMERIC"),
                _bq.SchemaField("curator_tech_fees", "NUMERIC"),
                _bq.SchemaField("curator_total_cost", "NUMERIC"),
                _bq.SchemaField("curator_revenue", "NUMERIC"),
                _bq.SchemaField("curator_margin", "NUMERIC"),
                _bq.SchemaField("data_revenue", "NUMERIC"),
                _bq.SchemaField("billing_exchange_rate", "NUMERIC"),
            ],
            update_cols=["imps", "viewable_imps", "clicks",
                         "curator_net_media_cost", "curator_tech_fees",
                         "curator_total_cost", "curator_revenue", "curator_margin",
                         "data_revenue", "billing_exchange_rate"],
            timestamp_col="synced_at",
        )

    return {
        "source":         SOURCE,
        "rows_processed": len(rows),
        "deals_touched":  len(deal_meta),
        "masters_upserted": masters,
        "duration_sec":   round(time.time() - t0, 2),
        "window":         window,
        # Qual credencial da chain autenticou — o ledger guarda pra o operador
        # ver quando o fallback assumiu (sinal de credencial pra consertar).
        "credential":     credential_label(),
        "synced_at":      datetime.now(timezone.utc).isoformat(),
    }
