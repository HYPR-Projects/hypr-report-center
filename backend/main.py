"""
HYPR Report Center — Cloud Function
Changelog:
  - query_detail: JOIN com unified_daily_performance_metrics para trazer line_name
  - query_totals: adiciona pacing calculado (fórmula igual à planilha)
  - query_daily:  adiciona video_view_100 e vtr por dia
  - query_campaign_info: expõe start_date e end_date para cálculo de pacing no front
  - perf: paralelização das 8 queries de fetch_campaign_data via ThreadPoolExecutor
  - perf: cache em memória (instance-local) com TTL para report e lista admin
  - perf: parâmetro ?refresh=true invalida cache do token alvo
  - perf(admin-list): TTL da lista 60s→300s, single-flight lock evita query
    duplicada quando ?list=true e ?action=list_clients chegam em paralelo,
    SQL consolidado (5 full scans → 3), enrichments owners/overrides/shares
    rodam em paralelo com a query principal, caches dedicados pra overrides
    e shares (TTL 300s), Cache-Control e Server-Timing nos endpoints da lista
  - perf(report): TTL 120s→600s, single-flight POR TOKEN (dois CSs no mesmo
    report = 1 query), query_totals roda perf+checklist em paralelo,
    query_campaign_info dispara junto com auxiliares (não bloqueia mais),
    Cache-Control e Server-Timing no endpoint ?token=
"""

import functions_framework
from flask import jsonify, request
from google.cloud import bigquery
import logging
import os
import re
import json
import time
import hmac
import hashlib
import gzip
import threading
import urllib.request
import urllib.parse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

from auth import (
    JWT_TTL_SECONDS,
    authenticate_admin,
    issue_admin_jwt,
    verify_google_id_token,
)
import owners
import shares
import clients
import merges
import sheets_integration

logger = logging.getLogger(__name__)

bq = bigquery.Client()
# Injeta o client BQ no módulo clients (evita import circular — clients
# precisa do bq pra query_client_timeseries mas não pode importar main).
clients.set_bq_client(bq)

# ─────────────────────────────────────────────────────────────────────────────
# Cache em memória — escopo de instância da Cloud Function.
# Cloud Functions reutiliza instâncias entre requests (warm), então um dict
# global persiste entre invocações da mesma instância. Cold start zera o cache,
# o que é aceitável: a próxima request reidrata e as subsequentes pegam o hit.
#
# TTLs:
#   - report (token):      120s — payload pesado, refresca rápido após upload
#   - campaigns list:       60s — admin abre/fecha o tempo todo
#
# Invalidação manual:
#   - mutações (save_logo, save_loom, save_survey, save_upload,
#     save_report_owner) limpam o cache do token afetado
#   - ?refresh=true força bypass de cache na request atual
# ─────────────────────────────────────────────────────────────────────────────
_REPORT_CACHE_TTL  = 600
# Lista admin: era 60s e estava queimando o usuário em todo cache miss. O menu
# é aberto, fechado e reaberto várias vezes ao longo do dia — um TTL de 5 min
# mantém a UX instantânea sem comprometer frescor (mutações de admin já
# invalidam o cache via _cache_invalidate_token; logo, dado "stale" só ocorre
# se a tabela campaign_results muda externamente, o que acontece a cada
# poucas horas via pipeline).
_LIST_CACHE_TTL    = 300
# View "Por cliente" do menu admin — agregação derivada de query_campaigns_list
# + 1 query temporal pra sparklines. TTL maior porque (a) não muda dramatica-
# mente entre minutos, e (b) a sparkline é informação visual, não operacional.
_CLIENTS_CACHE_TTL = 300

_report_cache    = {}     # short_token -> (timestamp, payload)
_merged_report_cache = {} # merge_id -> (timestamp, payload merged)
_list_cache      = {}     # "all" -> (timestamp, payload)
_clients_cache   = {}     # "all" -> (timestamp, payload)
# Caches dos enrichments paralelos de query_campaigns_list. Compartilham TTL
# da lista — invalidados juntos via _cache_invalidate_token quando ocorre
# mutação que afeta o payload do menu.
_overrides_cache = {}     # "all" -> (timestamp, dict[short_token -> (cp, cs)])
_aliases_cache   = {}     # "all" -> (timestamp, dict[alias_normalized -> canonical_normalized])
_shares_cache    = {}     # "all" -> (timestamp, dict[short_token -> share_id])
_merges_cache    = {}     # "all" -> (timestamp, dict[short_token -> {merge_id, rmnd_mode, pdooh_mode}])
# Cache da listagem de forms do Typeform — evita estourar rate-limit em cada
# abertura do SurveyModal (admin abre o modal várias vezes editando blocos).
# TTL curto (5min) porque o admin pode estar criando um form novo e querendo
# vê-lo no dropdown sem esperar muito.
_typeform_forms_cache = {} # "all" -> (timestamp, list[{id,title,last_updated_at,_links}])
_cache_lock      = threading.Lock()


def _cache_get(store, key, ttl):
    with _cache_lock:
        entry = store.get(key)
        if not entry:
            return None
        ts, value = entry
        if time.time() - ts > ttl:
            store.pop(key, None)
            return None
        return value


def _cache_set(store, key, value):
    with _cache_lock:
        store[key] = (time.time(), value)


def _cache_invalidate_token(short_token):
    """Remove qualquer entrada de cache associada ao token (report + list).
    Também invalida o cache de clientes — qualquer mutação que afete a
    lista de campanhas (logo, loom, owner, survey…) potencialmente muda
    a agregação por cliente (ex: novo owner → top_owners diferente).

    Os caches de overrides/shares também são derrubados: salvar um override
    de owner ou criar um share_id muda o payload da lista, e seria sutil
    demais discriminar quais mutações atingem qual cache.
    """
    with _cache_lock:
        _report_cache.pop(short_token, None)
        _list_cache.pop("all", None)
        _clients_cache.pop("all", None)
        _overrides_cache.pop("all", None)
        _aliases_cache.pop("all", None)
        _shares_cache.pop("all", None)
        _merges_cache.pop("all", None)
        # Merged report cache: drop tudo. Tabela de grupos é pequena, e
        # qualquer mutação que invalida um token pode tornar stale o
        # payload merged que o contém. Reidratação custa N fetches já
        # cacheados em _report_cache (que acabamos de invalidar só do
        # token afetado — os outros membros continuam quentes).
        _merged_report_cache.clear()


# ─────────────────────────────────────────────────────────────────────────────
# Single-flight para query_campaigns_list.
#
# Problema observado: o frontend admin dispara `?list=true` e `?action=list_clients`
# em paralelo (Promise.all em CampaignMenuV2). Ambos chamam query_campaigns_list()
# quando o cache está frio. Sem coordenação, as duas requests fazem o mesmo
# trabalho pesado no BigQuery (≈2× o custo, ≈2× o tempo de wallclock pro user).
#
# Solução: um único lock global. A primeira thread que pega o lock executa a
# query e popula o cache; threads subsequentes esperam o lock, fazem
# double-check do cache, e retornam o valor já calculado. Latência adicional
# do "winner": ~0ms. Latência adicional dos "losers": tempo de espera +
# leitura de dict (microssegundos).
#
# Limitado ao escopo da instância da Cloud Function — duas instâncias podem
# fazer queries paralelas no BQ. Com --concurrency=10 e --min-instances=1,
# isso é aceitável: na prática quase todo tráfego do admin cabe numa instância.
# ─────────────────────────────────────────────────────────────────────────────
_list_inflight_lock = threading.Lock()


def _get_campaigns_list_cached(force_refresh=False):
    """Wrapper single-flight em torno de query_campaigns_list().

    Retorna a lista cacheada se válida; caso contrário executa a query e
    popula o cache. Garante que, se múltiplas threads pedem ao mesmo tempo,
    apenas uma faz o trabalho real. As outras esperam e leem do cache.
    """
    if not force_refresh:
        cached = _cache_get(_list_cache, "all", _LIST_CACHE_TTL)
        if cached is not None:
            return cached, True  # (data, hit)

    with _list_inflight_lock:
        # Double-check: outra thread pode ter acabado de popular o cache
        # enquanto esperávamos o lock.
        if not force_refresh:
            cached = _cache_get(_list_cache, "all", _LIST_CACHE_TTL)
            if cached is not None:
                return cached, True
        data = query_campaigns_list()
        _cache_set(_list_cache, "all", data)
        return data, False  # (data, miss)


# ─────────────────────────────────────────────────────────────────────────────
# Single-flight POR TOKEN para reports.
#
# Cenário: dois CSs olhando o mesmo report ao mesmo tempo (frequente — gerente
# acompanha o que o time abre, ou cliente recebe link e clica antes do CS
# fechar). Sem coordenação, ambos pagam a query inteira.
#
# Diferente do single-flight da lista, aqui usamos um dict de Locks por token
# em vez de um lock global — duas requests em reports DIFERENTES não devem
# bloquear uma à outra. O dict de locks é protegido por _token_lock_dict_lock
# pra evitar race ao criar uma entrada nova.
# ─────────────────────────────────────────────────────────────────────────────
_token_locks = {}  # short_token -> threading.Lock
_token_lock_dict_lock = threading.Lock()


def _get_token_lock(short_token):
    """Devolve o Lock dedicado deste token (cria sob demanda)."""
    with _token_lock_dict_lock:
        lock = _token_locks.get(short_token)
        if lock is None:
            lock = threading.Lock()
            _token_locks[short_token] = lock
        return lock


def _get_report_cached(short_token, force_refresh=False):
    """Wrapper single-flight em torno de fetch_campaign_data().

    Garante que dois requests pro mesmo token resolvem com 1 query.
    Requests pra tokens diferentes não bloqueiam entre si.
    """
    if not force_refresh:
        cached = _cache_get(_report_cache, short_token, _REPORT_CACHE_TTL)
        if cached is not None:
            return cached, True

    lock = _get_token_lock(short_token)
    with lock:
        # Double-check
        if not force_refresh:
            cached = _cache_get(_report_cache, short_token, _REPORT_CACHE_TTL)
            if cached is not None:
                return cached, True
        data = fetch_campaign_data(short_token)
        if data is None:
            return None, False
        _cache_set(_report_cache, short_token, data)
        return data, False


# Pool reutilizado entre invocações da mesma instância para evitar criar/destruir
# threads a cada request. Com `--concurrency=10` na Cloud Function (Gen 2),
# até 10 requests simultâneos podem competir pelo pool. 16 workers cobre o pico
# sem fazer fila significativa: queries BigQuery são I/O-bound (GIL liberado).
_query_pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="bq-fetch")

PROJECT_ID      = os.environ.get("GCP_PROJECT",        "site-hypr")
DATASET_HUB     = os.environ.get("BQ_DATASET_HUB",     "prod_prod_hypr_reporthub")
TABLE           = os.environ.get("BQ_TABLE",            "campaign_results")
DATASET_ASSETS  = "prod_assets"

# ─────────────────────────────────────────────────────────────────────────────
# Expressão SQL que deriva a tática pelo line_name, ignorando tactic_type da
# tabela (que pode estar errado por erro de CS).
# Regra: _O2O_ no meio ou _O2O no final  →  "O2O"
#        _OOH_ no meio ou _OOH no final  →  "OOH"
#        fallback                         →  tactic_type original
# ─────────────────────────────────────────────────────────────────────────────
TACTIC_EXPR = (
    "CASE"
    " WHEN REGEXP_CONTAINS(line_name, r'(?i)_O2O(_|$)') THEN 'O2O'"
    " WHEN REGEXP_CONTAINS(line_name, r'(?i)_OOH(_|$)') THEN 'OOH'"
    " ELSE tactic_type"
    " END"
)

ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5175",
    "https://report.hypr.mobi",
    "https://www.report.hypr.mobi",
]

# Previews do Vercel — cada PR e cada branch geram um subdomínio único.
# Padrões observados em produção:
#   hypr-report-{hash}-hypr-projects.vercel.app
#   hypr-report-hub-git-{branch}-{hash}-hypr-projects.vercel.app
# Hash do Vercel pode conter maiúsculas e minúsculas. Liberamos por regex
# restrito ao prefixo 'hypr-report' + sufixo '-hypr-projects.vercel.app'
# pra não abrir CORS pro mundo. URL de produção (report.hypr.mobi) continua
# na allowlist explícita acima.
_VERCEL_PREVIEW_RE = re.compile(
    r"^https://hypr-report[a-zA-Z0-9-]*-hypr-projects\.vercel\.app$"
)


def _is_origin_allowed(origin: str) -> bool:
    if origin in ALLOWED_ORIGINS:
        return True
    if origin and _VERCEL_PREVIEW_RE.match(origin):
        return True
    return False


def cors_headers(origin, methods="GET, OPTIONS"):
    if _is_origin_allowed(origin):
        return {
            "Access-Control-Allow-Origin":  origin,
            "Access-Control-Allow-Methods": methods,
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
    return {}


def _etag_normalize(value):
    """Extrai a parte opaca de um ETag pra weak comparison.

    `W/"abc"` → `abc`
    `"abc"`   → `abc`
    `abc`     → `abc` (defensivo, alguns proxies removem aspas)
    """
    v = (value or "").strip()
    if v.startswith("W/"):
        v = v[2:].strip()
    return v.strip('"')


def _maybe_gzip(body_str, request, headers):
    """Comprime body via gzip se o cliente aceita (Accept-Encoding).

    Cloud Functions Gen2 / Cloud Run NÃO faz compressão automática —
    é responsabilidade da função. Sem isso, payloads grandes (139KB do
    list=true) trafegam crus pra qualquer cliente.

    Atualiza `headers` in-place com `Content-Encoding: gzip` e adiciona
    `Vary: Accept-Encoding` (pra qualquer CDN saber que respostas variam
    por esse header — sem isso, um cliente sem gzip pegaria a versão
    comprimida do cache).

    compresslevel=6 é o sweet spot da stdlib gzip: ~85% redução em JSON
    com latência de ~5ms num payload de 140KB. Levels 7-9 economizam
    1-2% extra com 2-3x mais tempo de CPU — não vale.

    Retorna bytes (encoded body, gzipped or não).
    """
    body_bytes = body_str.encode("utf-8") if isinstance(body_str, str) else body_str

    accept = (request.headers.get("Accept-Encoding") or "").lower()
    if "gzip" not in accept:
        return body_bytes

    headers["Content-Encoding"] = "gzip"
    existing_vary = headers.get("Vary", "").strip()
    if "accept-encoding" not in existing_vary.lower():
        headers["Vary"] = (existing_vary + ", " + "Accept-Encoding").lstrip(", ")
    return gzip.compress(body_bytes, compresslevel=6)


def _etag_response(payload, request, extra_headers=None):
    """Resposta JSON com suporte a ETag/304.

    Calcula um weak ETag a partir do payload serializado. Se o request
    tem `If-None-Match` que bate, devolve 304 (sem body) economizando
    transferência. Senão, devolve 200 com `ETag` no header pra que o
    browser revalide nas próximas requests.

    Por que weak (`W/`)?
      O ETag não é byte-exact (semantic equivalence basta). Mudanças
      irrelevantes no JSON (ordem de chaves, espaçamento) não devem
      forçar miss.

    Comparação tolerante:
      RFC 7232 §2.3.2 — weak comparison ignora prefixo W/ e considera
      apenas a parte opaca. Implementamos assim porque entre browser e
      Cloud Run pode passar load balancer/proxy que normaliza o header
      (remove W/, troca aspas). Comparação por igualdade estrita falha
      em prod mesmo quando os ETags semanticamente batem.

      Suporta também múltiplos ETags no If-None-Match (RFC permite
      `"a", W/"b"`) e o wildcard `*`.

    Returns: tupla (body_str_or_empty, status, headers) compatível com
    o retorno padrão do Flask/GCF.
    """
    # ETag é hash do CONTEÚDO ESSENCIAL — `_cache` é metadata sobre
    # quem serviu (hit/miss interno do backend), muda entre requests
    # idênticas e contaminaria o hash. Sem esse strip, o ETag nunca
    # bate em revalidação.
    etag_payload = {k: v for k, v in payload.items() if k != "_cache"}
    etag_body = json.dumps(etag_payload, separators=(",", ":"), default=str, ensure_ascii=False)
    digest = hashlib.sha256(etag_body.encode("utf-8")).hexdigest()[:16]
    etag = f'W/"{digest}"'
    etag_opaque = digest

    inm_raw = (request.headers.get("If-None-Match") or "").strip()
    headers = dict(extra_headers or {})
    headers["ETag"] = etag

    matched = False
    if inm_raw == "*":
        matched = True
    elif inm_raw:
        # Aceita lista separada por vírgula. Cada token é normalizado e
        # comparado contra a parte opaca do nosso ETag.
        for token in inm_raw.split(","):
            if _etag_normalize(token) == etag_opaque:
                matched = True
                break

    if matched:
        # Browser tem cópia fresca. 304 vazio + headers — economiza o
        # payload inteiro. ~80% dos hits no warm path do menu admin.
        return ("", 304, headers)

    # Body completo (com `_cache`) só vai no 200. No 304 não tem body.
    body = json.dumps(payload, separators=(",", ":"), default=str, ensure_ascii=False)
    headers["Content-Type"] = "application/json; charset=utf-8"
    body = _maybe_gzip(body, request, headers)
    return (body, 200, headers)


@functions_framework.http
def report_data(request):
    origin  = request.headers.get("Origin", "")
    headers = cors_headers(origin, "GET, POST, OPTIONS")

    if request.method == "OPTIONS":
        return ("", 204, headers)

    # ── Endpoint: emitir JWT admin a partir de um Google id_token ─────────────
    # Front envia `Authorization: Bearer <google_id_token>`. Backend valida
    # via tokeninfo do Google (email verified + domínio @hypr.mobi) e devolve
    # um JWT custom assinado, com TTL de 30 min, que será usado em chamadas
    # admin subsequentes.
    if request.method == "POST" and request.args.get("action") == "issue_admin_token":
        try:
            auth_header = request.headers.get("Authorization", "")
            if not auth_header.startswith("Bearer "):
                return (jsonify({"error": "Authorization header ausente"}), 401, headers)
            google_id_token = auth_header[len("Bearer "):].strip()
            info = verify_google_id_token(google_id_token)
            if not info:
                return (jsonify({"error": "id_token inválido ou domínio não autorizado"}), 401, headers)
            jwt = issue_admin_jwt(info["email"])
            return (jsonify({"token": jwt, "email": info["email"], "ttl": JWT_TTL_SECONDS}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR issue_admin_token] {e}")
            return (jsonify({"error": "Erro ao emitir token"}), 500, headers)

    # ── Endpoint: resolver credenciais do cliente → short_token ──────────────
    # Público (sem auth admin). Recebe `{share_id, password}` e devolve o
    # short_token correspondente se a senha bater. Aceita também
    # short_token legacy no campo `share_id` para manter URLs antigas
    # funcionando durante a transição (ver shares.resolve_share).
    if request.method == "POST" and request.args.get("action") == "resolve_share":
        try:
            body = request.get_json(silent=True) or {}
            share_id = (body.get("share_id") or "").strip()
            password = (body.get("password") or "").strip()
            if not share_id or not password:
                return (jsonify({"error": "share_id e password são obrigatórios"}), 400, headers)
            short_token = shares.resolve_share(share_id, password)
            if not short_token:
                return (jsonify({"error": "Código inválido"}), 401, headers)
            return (jsonify({"short_token": short_token}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR resolve_share] {e}")
            return (jsonify({"error": "Erro ao validar código"}), 500, headers)

    # ── Endpoint: obter share_id de uma campanha (admin) ─────────────────────
    # Cria o share_id se não existir. Usado pelo menu admin para gerar
    # links compartilháveis sem expor a senha na URL.
    if request.method == "GET" and request.args.get("action") == "get_share_id":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            short_token = (request.args.get("token") or "").strip()
            if not short_token:
                return (jsonify({"error": "token obrigatório"}), 400, headers)
            share_id = shares.get_or_create_share_id(short_token)
            return (jsonify({"share_id": share_id, "short_token": short_token}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR get_share_id] {e}")
            return (jsonify({"error": "Erro ao obter share_id"}), 500, headers)

    # ── Endpoint: resolver share_id → short_token sem senha (admin) ──────────
    # Caso de uso: admin loga no menu, copia o "Link Cliente" (URL com
    # share_id) e cola em outra aba/janela. Como ainda está com sessão
    # admin no navegador, o app pula a tela de senha — mas o dashboard
    # precisa do short_token para chamar os endpoints de dados. Este
    # endpoint faz o lookup direto, sem senha, autenticado por JWT admin.
    if request.method == "GET" and request.args.get("action") == "lookup_share":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            share_id = (request.args.get("share_id") or "").strip()
            if not share_id:
                return (jsonify({"error": "share_id obrigatório"}), 400, headers)
            short_token = shares.get_token_for_share_id(share_id)
            if not short_token:
                return (jsonify({"error": "share_id não encontrado"}), 404, headers)
            return (jsonify({"short_token": short_token}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR lookup_share] {e}")
            return (jsonify({"error": "Erro ao buscar share_id"}), 500, headers)

    # ── Endpoint: trocar OAuth code por refresh_token e criar sheet ─────────
    # Frontend abre popup OAuth via Google Identity Services, captura o
    # `code` retornado e chama este endpoint com {short_token, code}.
    # Backend troca o code por tokens (incluindo refresh_token), cria a
    # spreadsheet no Drive do membro autorizador, popula com a base de
    # dados e persiste a integração no BQ.
    if request.method == "POST" and request.args.get("action") == "sheets_create":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        admin_email = admin.get("email") or "unknown"
        try:
            body = request.get_json(silent=True) or {}
            target_type = (body.get("target_type") or "token").strip()
            # Compat: se target_type não veio, usa short_token como token-target.
            target_id   = (body.get("target_id") or body.get("short_token")
                           or body.get("merge_id") or "").strip()
            code        = (body.get("code") or "").strip()
            # ux_mode='popup' do GIS exige redirect_uri='postmessage'.
            # Mantemos como parâmetro pra deixar o backend agnóstico ao
            # modo (caso queiramos suportar redirect mode no futuro).
            redirect_uri = (body.get("redirect_uri") or "postmessage").strip()
            if not target_id or not code:
                return (jsonify({"error": "target_id e code são obrigatórios"}), 400, headers)
            if target_type not in ("token", "merge"):
                return (jsonify({"error": "target_type inválido (use 'token' ou 'merge')"}), 400, headers)

            # 1) Troca code por tokens
            tokens = sheets_integration.exchange_code_for_tokens(code, redirect_uri)
            refresh_token = tokens.get("refresh_token")
            if not refresh_token:
                # Google só retorna refresh_token na PRIMEIRA autorização
                # (subsequentes vêm vazias). Front deve forçar prompt='consent'
                # via initCodeClient pra garantir refresh_token sempre.
                return (
                    jsonify({"error": "refresh_token ausente. Tente novamente — pode ser preciso revogar e reautorizar o app."}),
                    400, headers,
                )

            if target_type == "merge":
                # Carrega membros do grupo + detail/totals de cada um.
                group = merges.get_merge_group(target_id)
                if not group or not (group.get("members") or []):
                    return (jsonify({"error": "Grupo não encontrado ou vazio"}), 404, headers)
                members_payload = []
                client_name_pick = None
                campaign_name_pick = None
                for m in group["members"]:
                    st = m.get("short_token")
                    if not st:
                        continue
                    pl, _ = _get_report_cached(st, force_refresh=False)
                    if not pl:
                        continue
                    camp = pl.get("campaign") or {}
                    if not client_name_pick:
                        client_name_pick = camp.get("client_name")
                    if not campaign_name_pick:
                        campaign_name_pick = camp.get("campaign_name")
                    members_payload.append({
                        "short_token": st,
                        "detail_rows": pl.get("detail") or [],
                        "totals_rows": pl.get("totals") or [],
                        "start_date":  _parse_iso_date_safe(camp.get("start_date")),
                        "end_date":    _parse_iso_date_safe(camp.get("end_date")),
                    })
                if not members_payload:
                    return (jsonify({"error": "Nenhum membro do grupo retornou dados"}), 404, headers)

                result = sheets_integration.create_sheet_for_merge(
                    merge_id=target_id,
                    refresh_token=refresh_token,
                    member_email=admin_email,
                    members=members_payload,
                    client_name=client_name_pick,
                    campaign_name=campaign_name_pick,
                )
                # Invalida cache de TODOS os tokens do grupo + do merged.
                for m in group["members"]:
                    if m.get("short_token"):
                        _cache_invalidate_token(m["short_token"])
                _merged_report_cache.pop(target_id, None)
            else:
                # token-target
                payload, _ = _get_report_cached(target_id, force_refresh=False)
                if not payload:
                    return (jsonify({"error": "Campanha não encontrada"}), 404, headers)
                detail_rows  = payload.get("detail") or []
                totals_rows  = payload.get("totals") or []
                campaign     = payload.get("campaign") or {}
                campaign_name = campaign.get("campaign_name") or target_id
                client_name   = campaign.get("client_name")

                start_date_obj = _parse_iso_date_safe(campaign.get("start_date"))
                end_date_obj   = _parse_iso_date_safe(campaign.get("end_date"))

                result = sheets_integration.create_sheet_for_campaign(
                    short_token=target_id,
                    refresh_token=refresh_token,
                    member_email=admin_email,
                    detail_rows=detail_rows,
                    totals_rows=totals_rows,
                    campaign_name=campaign_name,
                    client_name=client_name,
                    start_date=start_date_obj,
                    end_date=end_date_obj,
                )
                _cache_invalidate_token(target_id)

            return (jsonify({
                "status":          "active",
                "target_type":     target_type,
                "target_id":       target_id,
                "spreadsheet_id":  result["spreadsheet_id"],
                "spreadsheet_url": result["spreadsheet_url"],
            }), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR sheets_create] {e}")
            return (jsonify({"error": f"Erro ao criar sheet: {e}"}), 500, headers)

    # ── Endpoint: status da integração (admin vê tudo) ──────────────────────
    if request.method == "GET" and request.args.get("action") == "sheets_status":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            target_type = (request.args.get("target_type") or "token").strip()
            target_id   = (request.args.get("target_id")
                           or request.args.get("token")
                           or request.args.get("merge_id") or "").strip()
            if not target_id:
                return (jsonify({"error": "target_id obrigatório"}), 400, headers)
            if target_type not in ("token", "merge"):
                return (jsonify({"error": "target_type inválido"}), 400, headers)
            status = sheets_integration.status_for_response(
                target_id, is_admin=True, target_type=target_type,
            )
            return (jsonify({"integration": status}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR sheets_status] {e}")
            return (jsonify({"error": "Erro ao buscar status"}), 500, headers)

    # ── Endpoint: sync manual de uma sheet (admin) ──────────────────────────
    # Útil pra ver o resultado do sync sem esperar o cron diário, e pra
    # casos onde a campanha tem mudanças importantes mid-day.
    if request.method == "POST" and request.args.get("action") == "sheets_sync_now":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            target_type = (body.get("target_type") or "token").strip()
            target_id   = (body.get("target_id") or body.get("short_token")
                           or body.get("merge_id") or "").strip()
            if not target_id:
                return (jsonify({"error": "target_id obrigatório"}), 400, headers)
            if target_type not in ("token", "merge"):
                return (jsonify({"error": "target_type inválido"}), 400, headers)

            if target_type == "merge":
                group = merges.get_merge_group(target_id)
                if not group:
                    return (jsonify({"error": "Grupo não encontrado"}), 404, headers)

                members_payload = []
                for m in (group.get("members") or []):
                    st = m.get("short_token")
                    if not st: continue
                    pl, _ = _get_report_cached(st, force_refresh=True)
                    if not pl: continue
                    camp = pl.get("campaign") or {}
                    members_payload.append({
                        "short_token": st,
                        "detail_rows": pl.get("detail") or [],
                        "totals_rows": pl.get("totals") or [],
                        "start_date":  _parse_iso_date_safe(camp.get("start_date")),
                        "end_date":    _parse_iso_date_safe(camp.get("end_date")),
                    })
                sheets_integration.sync_merge_sheet(target_id, members_payload)
                # Invalida caches afetados
                for m in (group.get("members") or []):
                    if m.get("short_token"):
                        _cache_invalidate_token(m["short_token"])
                _merged_report_cache.pop(target_id, None)
            else:
                payload, _ = _get_report_cached(target_id, force_refresh=True)
                if not payload:
                    return (jsonify({"error": "Campanha não encontrada"}), 404, headers)
                sheets_integration.sync_sheet(
                    target_id,
                    payload.get("detail") or [],
                    payload.get("totals") or [],
                )
                _cache_invalidate_token(target_id)

            status = sheets_integration.status_for_response(
                target_id, is_admin=True, target_type=target_type,
            )
            return (jsonify({"integration": status}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR sheets_sync_now] {e}")
            return (jsonify({"error": f"Erro ao sincronizar: {e}"}), 500, headers)

    # ── Endpoint: sync de TODAS as integrações ativas (cron) ────────────────
    # Invocado pelo Cloud Scheduler diariamente às 06:00 BRT (configurado
    # via setup_sheets_integration.sh). Auth via header X-Cron-Secret
    # comparado com envvar CRON_SECRET — não usa JWT admin porque
    # Scheduler não tem identidade humana.
    if request.method == "POST" and request.args.get("action") == "sheets_sync_all":
        provided  = request.headers.get("X-Cron-Secret", "")
        expected  = os.environ.get("CRON_SECRET", "")
        if not expected or not hmac.compare_digest(provided, expected):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            def _token_loader(short_token):
                # _get_report_cached retorna tupla (data, was_cached).
                payload, _ = _get_report_cached(short_token, force_refresh=True)
                if not payload:
                    return ([], [])
                return (payload.get("detail") or [], payload.get("totals") or [])

            def _merge_loader(merge_id):
                # Carrega grupo + detail/totals de cada membro, anotado com
                # start_date/end_date pra a coluna `Mês` da sheet agregada.
                group = merges.get_merge_group(merge_id)
                if not group: return []
                out = []
                for m in (group.get("members") or []):
                    st = m.get("short_token")
                    if not st: continue
                    pl, _ = _get_report_cached(st, force_refresh=True)
                    if not pl: continue
                    camp = pl.get("campaign") or {}
                    out.append({
                        "short_token": st,
                        "detail_rows": pl.get("detail") or [],
                        "totals_rows": pl.get("totals") or [],
                        "start_date":  _parse_iso_date_safe(camp.get("start_date")),
                        "end_date":    _parse_iso_date_safe(camp.get("end_date")),
                    })
                return out

            summary = sheets_integration.sync_all_due(_token_loader, _merge_loader)
            return (jsonify({"summary": summary}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR sheets_sync_all] {e}")
            return (jsonify({"error": "Erro no sync diário"}), 500, headers)

    # ── Endpoint: deletar integração (admin) ────────────────────────────────
    # Remove o registro do BQ. NÃO deleta a sheet do Drive — fica como
    # registro permanente do que foi entregue ao cliente. Se quiser
    # recriar do zero, é só clicar "Conectar" de novo.
    if request.method == "POST" and request.args.get("action") == "sheets_delete":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            target_type = (body.get("target_type") or "token").strip()
            target_id   = (body.get("target_id") or body.get("short_token")
                           or body.get("merge_id") or "").strip()
            if not target_id:
                return (jsonify({"error": "target_id obrigatório"}), 400, headers)
            if target_type not in ("token", "merge"):
                return (jsonify({"error": "target_type inválido"}), 400, headers)
            # Flag opcional: se True, deleta também o arquivo do Drive.
            delete_sheet = bool(body.get("delete_sheet"))
            result = sheets_integration.delete_integration(
                target_id, delete_sheet=delete_sheet, target_type=target_type,
            )
            # Invalidação de cache:
            #   token  → invalida o token; merge → invalida todos os membros + merged
            if target_type == "merge":
                group = merges.get_merge_group(target_id)
                for m in (group.get("members") or []) if group else []:
                    if m.get("short_token"):
                        _cache_invalidate_token(m["short_token"])
                _merged_report_cache.pop(target_id, None)
            else:
                _cache_invalidate_token(target_id)
            return (jsonify({"status": "deleted", **result}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR sheets_delete] {e}")
            return (jsonify({"error": "Erro ao deletar integração"}), 500, headers)

    # ── Endpoint: salvar logo ─────────────────────────────────────────────────
    if request.method == "POST" and request.args.get("action") == "save_logo":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = body.get("short_token", "").strip()
            logo_base64 = body.get("logo_base64", "").strip()
            if not short_token or not logo_base64:
                return (jsonify({"error": "short_token e logo_base64 são obrigatórios"}), 400, headers)
            save_logo(short_token, logo_base64)
            _cache_invalidate_token(short_token)
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_logo] {e}")
            return (jsonify({"error": "Erro ao salvar logo"}), 500, headers)

    # ── Endpoint: listar logos de outras campanhas do mesmo cliente ───────────
    # Usado pelo LogoModal pra oferecer reaproveitamento. Retorna apenas
    # metadados (sem base64) — o front busca o base64 individualmente via
    # `?action=get_logo` quando o admin clica numa opção.
    if request.method == "GET" and request.args.get("action") == "list_client_logos":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        short_token = request.args.get("short_token", "").strip()
        if not short_token:
            return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
        try:
            items = query_client_logos_meta(short_token)
            return (jsonify({"items": items}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR list_client_logos] {e}")
            return (jsonify({"error": "Erro ao listar logos do cliente"}), 500, headers)

    # ── Endpoint: buscar logo de uma campanha específica ──────────────────────
    # Usado pelo LogoModal no fluxo de reaproveitamento (segundo passo, depois
    # do admin escolher um item da galeria via `list_client_logos`).
    if request.method == "GET" and request.args.get("action") == "get_logo":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        short_token = request.args.get("short_token", "").strip()
        if not short_token:
            return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
        try:
            logo_base64 = query_logo(short_token)
            return (jsonify({"logo_base64": logo_base64}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR get_logo] {e}")
            return (jsonify({"error": "Erro ao buscar logo"}), 500, headers)

    # ── Endpoint: line items de uma campanha (admin) ────────────────────────
    # Usado pelo PerformerDrawer pra mostrar piores LIs dentro de cada
    # campanha do CS. Métricas brutas — frontend calcula CTR/Viewability/
    # VTR/eCPM e ranqueia. Sem cache: chamada sob demanda quando admin
    # expande um card de campanha (poucos por sessão, custo BQ baixo).
    if request.method == "GET" and request.args.get("action") == "get_campaign_lines":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        short_token = request.args.get("short_token", "").strip()
        if not short_token:
            return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
        try:
            lines = query_campaign_lines(short_token)
            return (jsonify({"lines": lines}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR get_campaign_lines] {e}")
            return (jsonify({"error": "Erro ao buscar line items"}), 500, headers)

    # ── Endpoint: ler override de ABS (Brand Safety pre-bid) ────────────────
    # Devolve {has_abs, source} onde source é "auto" (sinal do BQ via
    # query_campaigns_list — se já detectado, override é redundante),
    # "override" (admin marcou explicitamente) ou "none" (não detectado e
    # sem override). Frontend usa pra decidir entre toggle ativo/desabilitado.
    if request.method == "GET" and request.args.get("action") == "get_abs_override":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        short_token = request.args.get("short_token", "").strip()
        if not short_token:
            return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
        try:
            override = query_abs_override(short_token)
            return (jsonify({"override": override}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR get_abs_override] {e}")
            return (jsonify({"error": "Erro ao buscar override de ABS"}), 500, headers)

    # ── Endpoint: salvar override de ABS ────────────────────────────────────
    if request.method == "POST" and request.args.get("action") == "save_abs_override":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            has_abs     = bool(body.get("has_abs"))
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            save_abs_override(short_token, has_abs, updated_by=admin.get("email"))
            # _cache_invalidate_token já derruba _list_cache + _clients_cache —
            # próxima request da lista admin re-lê do BQ com o override aplicado
            # na CTE abs_signals e o badge ABS / score atualiza.
            _cache_invalidate_token(short_token)
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_abs_override] {e}")
            return (jsonify({"error": "Erro ao salvar override de ABS"}), 500, headers)

    # ── Endpoint: salvar link Loom ───────────────────────────────────────────
    if request.method == "POST" and request.args.get("action") == "save_loom":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = body.get("short_token", "").strip()
            loom_url    = body.get("loom_url", "").strip()
            if not short_token or not loom_url:
                return (jsonify({"error": "short_token e loom_url são obrigatórios"}), 400, headers)
            save_loom(short_token, loom_url)
            _cache_invalidate_token(short_token)
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_loom] {e}")
            return (jsonify({"error": "Erro ao salvar loom"}), 500, headers)

    # ── Endpoint: buscar configuração do survey ──────────────────────────────
    # GET admin-only. Devolve o JSON cru salvo via save_survey, ou null se
    # ainda não existe. Usado pelo SurveyModal pra entrar em modo de edição
    # (pré-preenchendo blocos com a config existente).
    if request.method == "GET" and request.args.get("action") == "get_survey":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        short_token = request.args.get("short_token", "").strip()
        if not short_token:
            return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
        try:
            survey_data = query_survey(short_token)
            return (jsonify({"survey_data": survey_data}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR get_survey] {e}")
            return (jsonify({"error": "Erro ao buscar survey"}), 500, headers)

    # ── Endpoint: listar forms do Typeform da pasta "Survey" ─────────────────
    # GET admin-only. Devolve a base inteira de forms do workspace Survey
    # (id, title, last_updated_at), ordenada por last_updated_at desc.
    # Cacheado 5min em memória — várias aberturas do modal não estouram
    # rate-limit do Typeform. Aceita ?refresh=true pra invalidar e re-buscar.
    if request.method == "GET" and request.args.get("action") == "typeform_list_forms":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        TYPEFORM_TOKEN = os.environ.get("TYPEFORM_TOKEN", "")
        if not TYPEFORM_TOKEN:
            return (jsonify({"error": "TYPEFORM_TOKEN não configurado"}), 500, headers)
        force_refresh = request.args.get("refresh", "").lower() == "true"
        if force_refresh:
            with _cache_lock:
                _typeform_forms_cache.pop("all", None)
        cached = _cache_get(_typeform_forms_cache, "all", _TYPEFORM_LIST_TTL)
        if cached is not None:
            return (jsonify(cached), 200, headers)
        try:
            workspace_id = _resolve_survey_workspace_id(TYPEFORM_TOKEN)
            forms = _fetch_typeform_forms(
                TYPEFORM_TOKEN,
                workspace_id=workspace_id,
                days=0,  # base inteira; admin filtra via search no modal
            )
            payload = {
                "forms": forms,
                "workspace_id": workspace_id,
                "scope": "workspace" if workspace_id else "account",
                "count": len(forms),
            }
            _cache_set(_typeform_forms_cache, "all", payload)
            return (jsonify(payload), 200, headers)
        except urllib.error.HTTPError as e:
            logger.error(f"[ERROR typeform_list_forms] HTTP {e.code}: {e.reason}")
            msg = {
                401: "TYPEFORM_TOKEN inválido ou expirado",
                403: "Sem permissão para listar forms",
            }.get(e.code, f"Erro Typeform: HTTP {e.code}")
            return (jsonify({"error": msg}), 502, headers)
        except Exception as e:
            logger.error(f"[ERROR typeform_list_forms] {e}")
            return (jsonify({"error": str(e)}), 502, headers)

    # ── Endpoint: meta de um form Typeform (tipo + linhas se matrix) ─────────
    # GET admin-only. Usado pelo SurveyModal pra pré-popular o dropdown da
    # marca-foco com as linhas reais do matrix (evita o admin digitar errado).
    # Cacheado 10min em memória por form_id — meta muda pouco.
    if request.method == "GET" and request.args.get("action") == "typeform_form_meta":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        TYPEFORM_TOKEN = os.environ.get("TYPEFORM_TOKEN", "")
        if not TYPEFORM_TOKEN:
            return (jsonify({"error": "TYPEFORM_TOKEN não configurado"}), 500, headers)
        form_url = request.args.get("form_url", "").strip()
        form_id_param = request.args.get("form_id", "").strip()
        form_id = (
            _extract_typeform_form_id(form_url)
            if form_url else _extract_typeform_form_id(form_id_param)
        )
        if not form_id:
            return (jsonify({"error": "form_id ou form_url é obrigatório"}), 400, headers)
        force_refresh = request.args.get("refresh", "").lower() == "true"
        if force_refresh:
            with _cache_lock:
                _typeform_meta_cache.pop(form_id, None)
        cached = _cache_get(_typeform_meta_cache, form_id, _TYPEFORM_META_TTL)
        if cached is not None:
            return (jsonify(cached), 200, headers)
        try:
            meta = _fetch_typeform_form_meta(form_id, TYPEFORM_TOKEN)
            logger.info(
                f"[form_meta] form_id={form_id} type={meta.get('type')} "
                f"rows={len(meta.get('rows') or [])}"
            )
            _cache_set(_typeform_meta_cache, form_id, meta)
            return (jsonify(meta), 200, headers)
        except urllib.error.HTTPError as e:
            logger.error(f"[ERROR typeform_form_meta] HTTP {e.code} for {form_id}: {e.reason}")
            msg = {
                401: "TYPEFORM_TOKEN inválido ou expirado",
                403: "Sem permissão para acessar este form",
                404: "Form não encontrado",
            }.get(e.code, f"Erro Typeform: HTTP {e.code}")
            return (jsonify({"error": msg, "form_id": form_id}), 502, headers)
        except Exception as e:
            logger.error(f"[ERROR typeform_form_meta] {e}")
            return (jsonify({"error": str(e), "form_id": form_id}), 502, headers)

    # ── Endpoint: salvar survey ──────────────────────────────────────────────
    if request.method == "POST" and request.args.get("action") == "save_survey":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = body.get("short_token", "").strip()
            survey_data = body.get("survey_data", "").strip()
            if not short_token or not survey_data:
                return (jsonify({"error": "short_token e survey_data são obrigatórios"}), 400, headers)
            save_survey(short_token, survey_data)
            _cache_invalidate_token(short_token)
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_survey] {e}")
            return (jsonify({"error": "Erro ao salvar survey"}), 500, headers)

    # ── Endpoint: proxy Typeform API (evita CORS) ────────────────────────────
    # Aceita `form_url` (URL pública do form, modo preferido) ou `form_id`
    # (legado). Resposta é unificada em dois formatos possíveis:
    #
    #   { "type": "choice", "counts": {label: n}, "total": N }
    #     → Para perguntas choice/choices simples (Sim/Não/Talvez, etc).
    #
    #   { "type": "matrix", "rows": {row: {counts, total}}, "total": N }
    #     → Para perguntas matrix (ex: "avalie cada marca em 1-3").
    #       Cada linha é tratada como uma sub-pergunta independente.
    #
    # `total` em ambos os casos = número de respostas completadas no form.
    if request.args.get("action") == "typeform_proxy":
        form_url = request.args.get("form_url", "").strip()
        form_id_param = request.args.get("form_id", "").strip()
        form_id = _extract_typeform_form_id(form_url) if form_url else _extract_typeform_form_id(form_id_param)
        if not form_id:
            return (jsonify({"error": "URL do Typeform inválida ou form_id ausente"}), 400, headers)

        TYPEFORM_TOKEN = os.environ.get("TYPEFORM_TOKEN", "")
        if not TYPEFORM_TOKEN:
            return (jsonify({"error": "TYPEFORM_TOKEN não configurado"}), 500, headers)

        # Filtro de data opcional (admin-only no front, sem auth aqui — o param
        # apenas restringe o range; não expõe nenhum dado a mais que o caller
        # já não tivesse acesso).
        #
        # Typeform API aceita só dois formatos: timestamp Unix ou ISO 8601 em UTC
        # (com `Z` ou sem timezone). NÃO aceita offset não-UTC tipo `-03:00` —
        # retorna 400 BAD_REQUEST. Por isso convertemos manualmente: o admin
        # digita "01/04" pensando em horário de Brasília (BRT, UTC-03:00, sem
        # horário de verão desde 2019), e enviamos pro Typeform como UTC
        # equivalente (01/04 00:00 BRT = 01/04 03:00 UTC).
        date_from = request.args.get("date_from", "").strip()
        date_to = request.args.get("date_to", "").strip()
        since_param = ""
        until_param = ""
        BRT_OFFSET = timedelta(hours=3)  # BRT = UTC-3 → soma 3h pra UTC
        if re.match(r"^\d{4}-\d{2}-\d{2}$", date_from):
            try:
                d0 = datetime.strptime(date_from, "%Y-%m-%d") + BRT_OFFSET
                since_param = f"&since={d0.strftime('%Y-%m-%dT%H:%M:%SZ')}"
            except ValueError:
                pass
        if re.match(r"^\d{4}-\d{2}-\d{2}$", date_to):
            try:
                # 23:59:59 BRT do dia X = 02:59:59 UTC do dia X+1
                d1 = datetime.strptime(date_to, "%Y-%m-%d") + timedelta(hours=23, minutes=59, seconds=59) + BRT_OFFSET
                until_param = f"&until={d1.strftime('%Y-%m-%dT%H:%M:%SZ')}"
            except ValueError:
                pass

        flat_counts = Counter()
        matrix_rows = {}
        has_matrix = False
        total = 0
        before_token = None
        # Min/max submitted_at (ISO UTC string) — usado pelo modal de setup
        # pra hint "primeira/última resposta em DD/MM" e pra ajudar admin a
        # escolher um período de exibição pro cliente.
        first_at = None
        last_at = None
        try:
            # Busca definição do form uma vez pra mapear field_id → row_label
            # quando há perguntas matrix. Sem isso, respostas de matrix vêm
            # como choices independentes sem indicação da marca.
            field_to_row = _fetch_typeform_form_def(form_id, TYPEFORM_TOKEN)

            while True:
                url = f"https://api.typeform.com/forms/{urllib.parse.quote(form_id)}/responses?page_size=1000&completed=true{since_param}{until_param}"
                if before_token:
                    url += f"&before={before_token}"
                req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TYPEFORM_TOKEN}"})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read().decode())
                items = data.get("items", [])
                total += len(items)

                page_flat, page_matrix, page_has_matrix, _ = _process_typeform_items(items, field_to_row)
                # Acumula
                flat_counts.update(page_flat)
                if page_has_matrix:
                    has_matrix = True
                for row_label, row_counter in page_matrix.items():
                    if row_label not in matrix_rows:
                        matrix_rows[row_label] = Counter()
                    matrix_rows[row_label].update(row_counter)

                # Tracking min/max — submitted_at vem ISO 8601 UTC (ex.
                # "2026-04-15T13:45:00Z"). Comparação lexicográfica funciona
                # como ordenação cronológica nesse formato.
                for it in items:
                    sub = it.get("submitted_at")
                    if not sub:
                        continue
                    if first_at is None or sub < first_at:
                        first_at = sub
                    if last_at is None or sub > last_at:
                        last_at = sub

                if len(items) < 1000:
                    break
                before_token = items[-1].get("token")

            if has_matrix:
                # Serializa o dict de Counters
                rows_out = {
                    row: {"counts": dict(cnt), "total": sum(cnt.values())}
                    for row, cnt in matrix_rows.items()
                }
                return (jsonify({
                    "type": "matrix",
                    "rows": rows_out,
                    "total": total,
                    "form_id": form_id,
                    "first_response_at": first_at,
                    "last_response_at": last_at,
                }), 200, headers)
            return (jsonify({
                "type": "choice",
                "counts": dict(flat_counts),
                "total": total,
                "form_id": form_id,
                "first_response_at": first_at,
                "last_response_at": last_at,
            }), 200, headers)
        except urllib.error.HTTPError as e:
            logger.error(f"[ERROR typeform_proxy] HTTP {e.code} for form {form_id}: {e.reason}")
            msg = {
                401: "TYPEFORM_TOKEN inválido ou expirado",
                403: "Sem permissão para acessar este form",
                404: "Form não encontrado no Typeform",
            }.get(e.code, f"Erro Typeform: HTTP {e.code}")
            return (jsonify({"error": msg, "form_id": form_id}), 502, headers)
        except Exception as e:
            logger.error(f"[ERROR typeform_proxy] {e}")
            return (jsonify({"error": str(e)}), 502, headers)

    # ── Endpoint: salvar comentário ──────────────────────────────────────────
    # Comportamento misto:
    #   - Comentário do cliente (author != "HYPR"): aberto, qualquer um pode
    #     postar. Se um dia isso virar abuso, restringe via short_token+rate-limit.
    #   - Comentário do admin (author == "HYPR"): exige JWT admin. Sem isso,
    #     qualquer pessoa podia se passar pela HYPR no chat do report.
    if request.method == "POST" and request.args.get("action") == "save_comment":
        try:
            body = request.get_json(silent=True) or {}
            short_token = body.get("short_token", "").strip()
            metric_name = body.get("metric_name", "").strip()
            author      = body.get("author", "").strip()
            comment     = body.get("comment", "").strip()
            if not short_token or not metric_name or not author or not comment:
                return (jsonify({"error": "Campos obrigatórios faltando"}), 400, headers)
            if author == "HYPR" and not authenticate_admin(request):
                return (jsonify({"error": "Não autorizado a comentar como HYPR"}), 401, headers)
            save_comment(short_token, metric_name, author, comment)
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_comment] {e}")
            return (jsonify({"error": "Erro ao salvar comentário"}), 500, headers)

    # ── Endpoint: buscar comentários ─────────────────────────────────────────
    if request.method == "GET" and request.args.get("action") == "get_comments":
        try:
            short_token = request.args.get("token", "").strip()
            if not short_token:
                return (jsonify({"error": "token obrigatório"}), 400, headers)
            comments = query_comments(short_token)
            return (jsonify({"comments": comments}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR get_comments] {e}")
            return (jsonify({"error": "Erro ao buscar comentários"}), 500, headers)

    # ── Endpoint: salvar upload RMND/PDOOH ───────────────────────────────────
    if request.method == "POST" and request.args.get("action") == "save_upload":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = body.get("short_token", "").strip()
            upload_type = body.get("type", "").strip().upper()
            data_json   = body.get("data_json", "").strip()
            if not short_token or not upload_type or not data_json:
                return (jsonify({"error": "short_token, type e data_json sao obrigatorios"}), 400, headers)
            if upload_type not in ("RMND", "PDOOH"):
                return (jsonify({"error": "type deve ser RMND ou PDOOH"}), 400, headers)
            save_upload(short_token, upload_type, data_json)
            _cache_invalidate_token(short_token)
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_upload] {e}")
            return (jsonify({"error": "Erro ao salvar upload"}), 500, headers)

    # ── Endpoint: setup da tabela de overrides (admin, idempotente) ──────────
    # Cria a tabela física `report_owners_overrides` se não existir e valida
    # que a planilha de De-Para está acessível via Sheets API.
    #
    # Resposta inclui os nomes das abas detectados (debug) e contagem de
    # linhas — útil pra confirmar que a SA da Cloud Function tem acesso.
    if request.method == "POST" and request.args.get("action") == "setup_owners_schema":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            res = owners.setup_schema()
            return (jsonify({"ok": True, "tables": res}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR setup_owners_schema] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    # ── Endpoint: lista de membros HYPR (admin) ───────────────────────────────
    # Lê a segunda aba da planilha via Sheets API (cache TTL 60s) e devolve
    # os CPs e CSs disponíveis para popular os dropdowns do modal "Gerenciar
    # Owner".
    if request.method == "GET" and request.args.get("action") == "list_team_members":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            data = owners.list_team_members()
            return (jsonify(data), 200, headers)
        except Exception as e:
            # Não é erro fatal — se a Sheets API falhou (quota, perda de
            # acesso da SA), devolvemos listas vazias e logamos. O frontend
            # continua funcionando (chips/filtro/modal vazios).
            logger.warning(f"[WARN list_team_members] {e}")
            return (jsonify({"cps": [], "css": [], "_warning": str(e)}), 200, headers)

    # ── Endpoint: salvar override de owner para um report (admin) ─────────────
    # Body: {short_token, cp_email, cs_email}
    # cp_email/cs_email vazios em ambos = limpar override (volta a usar lookup)
    if request.method == "POST" and request.args.get("action") == "save_report_owner":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = body.get("short_token", "").strip()
            cp_email    = body.get("cp_email", "").strip()
            cs_email    = body.get("cs_email", "").strip()
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            owners.save_owner_override(
                short_token=short_token,
                cp_email=cp_email,
                cs_email=cs_email,
                updated_by=admin.get("email", "unknown"),
            )
            _cache_invalidate_token(short_token)
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_report_owner] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    # ── Endpoint: aliases de cliente (admin) ──────────────────────────────────
    # Ajuda o match automático de owner quando a normalização padrão não
    # basta (ex: "RD" → "Raia Drogasil"). A própria normalização já cobre
    # caixa, acentos, apóstrofos e artigos PT-BR — aliases são o escape
    # hatch pra abreviações e nomes-fantasia que não compartilham raiz
    # textual com o cliente canônico.
    #
    #   GET    ?action=list_aliases                           → array
    #   POST   ?action=save_alias    {alias, canonical}       → row salva
    #   DELETE ?action=delete_alias  {alias}                  → ok
    #
    # Qualquer mutação invalida o cache da lista de campanhas pra que o
    # match novo entre em vigor já no próximo refresh do menu admin.
    if request.method == "GET" and request.args.get("action") == "list_aliases":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            data = owners.list_aliases()
            return (jsonify({"aliases": data}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR list_aliases] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "save_alias":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            alias_raw     = (body.get("alias") or "").strip()
            canonical_raw = (body.get("canonical") or "").strip()
            if not alias_raw or not canonical_raw:
                return (jsonify({"error": "alias e canonical são obrigatórios"}), 400, headers)
            saved = owners.save_alias(
                alias_raw=alias_raw,
                canonical_raw=canonical_raw,
                updated_by=admin.get("email", "unknown"),
            )
            # Invalida caches pra a nova regra valer já no próximo F5.
            with _cache_lock:
                _list_cache.pop("all", None)
                _clients_cache.pop("all", None)
                _aliases_cache.pop("all", None)
            return (jsonify({"ok": True, "alias": saved}), 200, headers)
        except ValueError as e:
            return (jsonify({"error": str(e)}), 400, headers)
        except Exception as e:
            logger.error(f"[ERROR save_alias] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "delete_alias":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            alias_raw = (body.get("alias") or "").strip()
            if not alias_raw:
                return (jsonify({"error": "alias é obrigatório"}), 400, headers)
            owners.delete_alias(alias_raw)
            with _cache_lock:
                _list_cache.pop("all", None)
                _clients_cache.pop("all", None)
                _aliases_cache.pop("all", None)
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR delete_alias] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    # ── Endpoints: Merge Reports (admin) ──────────────────────────────────────
    # Permite unificar múltiplos short_tokens (PIs mensais) do mesmo cliente
    # em uma "campanha agregada". Ações administrativas; leitura do payload
    # merged é feita pelo composer chamado a partir do endpoint público
    # (`?token=<X>` quando X pertence a um grupo).
    #
    #   GET  ?action=list_mergeable_tokens&token=<short_token>     → tokens elegíveis
    #   GET  ?action=get_merge_group&merge_id=<id>                 → estado do grupo
    #   POST ?action=merge_tokens   {tokens: [...], rmnd_mode?, pdooh_mode?} → cria/anexa
    #   POST ?action=unmerge_token  {short_token}                  → remove do grupo
    #   POST ?action=update_merge_settings {merge_id, rmnd_mode?, pdooh_mode?}
    #
    # Qualquer mutação invalida cache de TODOS os tokens do grupo afetado +
    # cache da lista — pra que o admin menu reflita o badge novo no próximo
    # refresh, e qualquer report public-facing dos tokens reflita o estado novo.

    if request.method == "GET" and request.args.get("action") == "list_mergeable_tokens":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            short_token = (request.args.get("token") or "").strip()
            if not short_token:
                return (jsonify({"error": "token é obrigatório"}), 400, headers)
            data = merges.list_mergeable_tokens(short_token)
            return (jsonify({"tokens": data}), 200, headers)
        except merges.MergeError as e:
            return (jsonify({"error": str(e)}), e.code, headers)
        except Exception as e:
            logger.error(f"[ERROR list_mergeable_tokens] {e}")
            return (jsonify({"error": "Erro ao listar tokens elegíveis"}), 500, headers)

    if request.method == "GET" and request.args.get("action") == "get_merge_group":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            merge_id = (request.args.get("merge_id") or "").strip()
            if not merge_id:
                return (jsonify({"error": "merge_id é obrigatório"}), 400, headers)
            group = merges.get_merge_group(merge_id)
            if not group:
                return (jsonify({"error": "Grupo não encontrado"}), 404, headers)
            return (jsonify({"group": group}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR get_merge_group] {e}")
            return (jsonify({"error": "Erro ao buscar grupo"}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "merge_tokens":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            tokens     = body.get("tokens") or []
            rmnd_mode  = body.get("rmnd_mode")
            pdooh_mode = body.get("pdooh_mode")
            if not isinstance(tokens, list):
                return (jsonify({"error": "tokens deve ser array"}), 400, headers)
            group = merges.merge_tokens(
                tokens=tokens,
                admin_email=admin.get("email", "unknown"),
                rmnd_mode=rmnd_mode,
                pdooh_mode=pdooh_mode,
            )
            # Invalida cache de cada membro + caches da lista
            for m in (group.get("members") or []):
                _cache_invalidate_token(m["short_token"])
            return (jsonify({"group": group}), 200, headers)
        except merges.MergeError as e:
            return (jsonify({"error": str(e)}), e.code, headers)
        except Exception as e:
            logger.error(f"[ERROR merge_tokens] {e}")
            return (jsonify({"error": "Erro ao mergear tokens"}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "unmerge_token":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            result = merges.unmerge_token(short_token, admin.get("email", "unknown"))
            # Invalida o token removido + os que sobraram (se houver) +
            # qualquer outro tocado pela dissolução do grupo.
            for t in (result.get("removed") or []):
                _cache_invalidate_token(t)
            # Sempre invalida o token base mesmo se já estava em "removed"
            _cache_invalidate_token(short_token)
            return (jsonify({"ok": True, **result}), 200, headers)
        except merges.MergeError as e:
            return (jsonify({"error": str(e)}), e.code, headers)
        except Exception as e:
            logger.error(f"[ERROR unmerge_token] {e}")
            return (jsonify({"error": "Erro ao desfazer merge"}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "update_merge_settings":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            merge_id   = (body.get("merge_id") or "").strip()
            rmnd_mode  = body.get("rmnd_mode")
            pdooh_mode = body.get("pdooh_mode")
            if not merge_id:
                return (jsonify({"error": "merge_id é obrigatório"}), 400, headers)
            group = merges.update_merge_settings(
                merge_id=merge_id,
                admin_email=admin.get("email", "unknown"),
                rmnd_mode=rmnd_mode,
                pdooh_mode=pdooh_mode,
            )
            for m in (group.get("members") or []):
                _cache_invalidate_token(m["short_token"])
            return (jsonify({"group": group}), 200, headers)
        except merges.MergeError as e:
            return (jsonify({"error": str(e)}), e.code, headers)
        except Exception as e:
            logger.error(f"[ERROR update_merge_settings] {e}")
            return (jsonify({"error": "Erro ao atualizar settings"}), 500, headers)

    # ── Endpoint: lista de clientes agregada (admin) ─────────────────────────
    # View "Por cliente" do menu admin V2. Agrega campanhas em memória pelo
    # client_name normalizado (LOWER + TRIM + slug-safe) e enriquece cada
    # cliente com:
    #   - métricas médias (pacing/CTR/VTR) das campanhas ATIVAS
    #   - top 2 CPs e CSs por frequência
    #   - série temporal semanal de viewable_impressions (12 semanas)
    #   - trend % comparando últimas 4 semanas vs 4 anteriores
    #   - health derivada de pacing das ativas
    #
    # Plus: worklist com 4 buckets de campanhas que precisam de atenção
    # (pacing crítico, sem owner, encerrando em 7d, reports não vistos).
    #
    # Reusa o cache de query_campaigns_list quando válido — sem custo BQ
    # extra além da query de sparkline (1x por hit).
    if request.args.get("action") == "list_clients":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            t0 = time.time()
            force_refresh = request.args.get("refresh") == "true"
            cached = None if force_refresh else _cache_get(_clients_cache, "all", _CLIENTS_CACHE_TTL)
            if cached is not None:
                resp_headers = {**headers, "Cache-Control": "private, max-age=30"}
                resp_headers["Server-Timing"] = f"total;dur={int((time.time()-t0)*1000)};desc=\"hit\""
                return _etag_response({**cached, "_cache": "hit"}, request, resp_headers)

            # Reusa o cache de campanhas via single-flight (evita query duplicada
            # quando esta request chega em paralelo com ?list=true).
            t_list = time.time()
            campaigns, list_hit = _get_campaigns_list_cached(force_refresh=force_refresh)
            list_ms = int((time.time() - t_list) * 1000)

            t_agg = time.time()
            agg = clients.aggregate_clients_from_campaigns(campaigns)
            worklist = clients.compute_worklist(campaigns)
            agg_ms = int((time.time() - t_agg) * 1000)

            # Sparklines + trend (única query BQ extra do endpoint).
            t_ts = time.time()
            timeseries = clients.query_client_timeseries(weeks=12)
            for c in agg:
                series = timeseries.get(c["slug"], [])
                if series:
                    c["sparkline"] = series
                    trend = clients.compute_trend(series, half=4)
                    if trend:
                        c["trend"] = trend
            ts_ms = int((time.time() - t_ts) * 1000)

            payload = {"clients": agg, "worklist": worklist}
            _cache_set(_clients_cache, "all", payload)
            total_ms = int((time.time() - t0) * 1000)
            resp_headers = {
                **headers,
                "Cache-Control": "private, max-age=30",
                "Server-Timing": (
                    f"list;dur={list_ms};desc=\"{'hit' if list_hit else 'miss'}\","
                    f"agg;dur={agg_ms},timeseries;dur={ts_ms},total;dur={total_ms}"
                ),
            }
            return _etag_response({**payload, "_cache": "miss"}, request, resp_headers)
        except Exception as e:
            logger.error(f"[ERROR list_clients] {e}")
            return (jsonify({"error": "Erro ao listar clientes"}), 500, headers)

    if request.args.get("list") == "true":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            t0 = time.time()
            force_refresh = request.args.get("refresh") == "true"
            campaigns, hit = _get_campaigns_list_cached(force_refresh=force_refresh)
            total_ms = int((time.time() - t0) * 1000)
            resp_headers = {
                **headers,
                # Browser/CDN cacheiam refresh por 30s. F5 do admin não vira request
                # a menos que o cache local expire. max-age curto pra não estourar
                # janela de invalidação por mutação (já tratada em backend).
                "Cache-Control": "private, max-age=30",
                "Server-Timing": f"list;dur={total_ms};desc=\"{'hit' if hit else 'miss'}\"",
            }
            # ETag/304: depois do max-age expirar, browser revalida. Se o
            # payload não mudou (caso comum dado TTL backend de 5min), ETag
            # bate e devolvemos 304 vazio em vez de 139KB.
            return _etag_response(
                {"campaigns": campaigns, "_cache": "hit" if hit else "miss"},
                request,
                resp_headers,
            )
        except Exception as e:
            logger.error(f"[ERROR] {e}")
            return (jsonify({"error": "Erro ao listar campanhas"}), 500, headers)

    short_token = request.args.get("token")
    if not short_token:
        return (jsonify({"error": "Parâmetro 'token' é obrigatório"}), 400, headers)

    try:
        t0 = time.time()
        force_refresh = request.args.get("refresh") == "true"
        if force_refresh:
            _cache_invalidate_token(short_token)

        # Detecta merge group e resolve a visão pedida.
        #
        # Convenção de URLs (mudou em 2026-05):
        #   ?view=aggregated    → visão agregada explícita
        #   ?view=<short_token> → drill-down em um membro específico
        #   (sem ?view=)        → DEFAULT pra token merged: active_token
        #                         (mês mais recente). Pra token não-merged:
        #                         comportamento normal single-token.
        #
        # O default mudou de "agregada" pra "active_token" porque na maioria
        # dos casos o cliente quer ver primeiro o resultado mais atual; a
        # visão agregada é mais útil pra análise comparativa, e fica como
        # último item nos pills do switcher.
        view_param = (request.args.get("view") or "").strip()
        view_is_aggregated = view_param.lower() in ("aggregated", "all")
        merges_lookup = _safe_get_merges()
        merge_info = (
            merges_lookup.get(short_token)
            or merges_lookup.get(short_token.upper())
        )
        if merge_info and view_is_aggregated:
            merge_id = merge_info["merge_id"]
            data, hit = _get_merged_report_cached(merge_id, force_refresh=force_refresh)
            if data is None:
                return (jsonify({"error": "Grupo merged sem dados"}), 404, headers)
            total_ms = int((time.time() - t0) * 1000)
            resp_headers = {
                **headers,
                "Cache-Control": "private, max-age=60",
                "Server-Timing": f"merged;dur={total_ms};desc=\"{'hit' if hit else 'miss'}\"",
            }
            return (
                jsonify({**data, "_cache": "hit" if hit else "miss"}),
                200,
                resp_headers,
            )

        # Caminho single-token. Resolve target_token na seguinte prioridade:
        #   1. ?view=<token> que bate com algum membro do grupo OU o próprio
        #      short_token base → usa view_param.
        #   2. Sem ?view= e token pertence a grupo → usa active_token (mais
        #      recente) via _get_merge_meta_only.
        #   3. Fallback: short_token base (caso não-merged).
        target_token = short_token
        if view_param and not view_is_aggregated and merge_info:
            members_set = {short_token.upper()}
            try:
                group = merges.get_merge_group(merge_info["merge_id"])
                if group:
                    for m in group.get("members") or []:
                        if m.get("short_token"):
                            members_set.add(m["short_token"].upper())
            except Exception as e:
                logger.warning(f"[WARN view-resolve get_merge_group] {e}")
            if view_param.upper() in members_set:
                target_token = view_param
        elif merge_info and not view_param:
            # Default novo: active_token. _get_merge_meta_only é cacheado
            # via _get_report_cached por membro — warm na maioria dos hits.
            try:
                meta_only = _get_merge_meta_only(merge_info["merge_id"])
                if meta_only and meta_only.get("active_token"):
                    target_token = meta_only["active_token"]
            except Exception as e:
                logger.warning(f"[WARN default-active-token resolve] {e}")

        data, hit = _get_report_cached(target_token, force_refresh=force_refresh)
        if data is None:
            return (jsonify({"error": "Campanha não encontrada"}), 404, headers)

        # Quando o token base pertence a um grupo, SEMPRE anexamos merge_meta
        # no payload single-token — senão o frontend perde os pills do
        # switcher e o usuário fica "preso" na visão por mês. Inclui o caso
        # default (sem ?view=, target = active_token).
        if merge_info:
            try:
                meta = _get_merge_meta_only(merge_info["merge_id"])
                if meta:
                    data = {**data, "merge_meta": meta}
            except Exception as e:
                logger.warning(f"[WARN attach merge_meta to single-token view] {e}")

        total_ms = int((time.time() - t0) * 1000)
        resp_headers = {
            **headers,
            # Cache no browser por 60s. Reports não mudam intra-sessão (pipeline
            # roda algumas vezes ao dia), e mutações no admin já invalidam.
            "Cache-Control": "private, max-age=60",
            "Server-Timing": f"report;dur={total_ms};desc=\"{'hit' if hit else 'miss'}\"",
        }
        return (
            jsonify({**data, "_cache": "hit" if hit else "miss"}),
            200,
            resp_headers,
        )
    except Exception as e:
        logger.error(f"[ERROR] {e}")
        return (jsonify({"error": "Erro interno ao buscar dados"}), 500, headers)


def fetch_campaign_data(short_token):
    """
    Busca todos os dados de um report.

    Estratégia:
      Apenas `query_totals` depende de `campaign_info` (precisa de start_date/end_date
      pra cálculo de pacing). Todas as outras queries só precisam do short_token.
      Então:
        1) Disparamos campaign_info + 7 queries auxiliares em paralelo.
        2) Quando campaign_info volta, disparamos totals (que depende dela).
        3) Esperamos o resto.

      Antes (campaign_info bloqueante): campaign_info → max(8 queries) ≈ 1s + 2s = 3s
      Depois: max(campaign_info + totals, max(7 outras)) ≈ max(3s, 1.5s) = 3s

      O ganho real em wallclock é o tempo de campaign_info (~0.5-1s) que era pago
      duas vezes — uma como bloqueante e outra dentro de totals. As queries auxiliares
      (logo, loom, rmnd, pdooh, survey) são mais leves e terminam antes de totals.

      Se campaign_info retornar None (campanha não existe), cancelamos as auxiliares
      e retornamos None — auxiliares são fire-and-forget; o ThreadPool continua
      executando-as mas o resultado é descartado, sem custo perceptível.
    """
    # Dispara campaign_info + auxiliares simultaneamente
    fut_campaign = _query_pool.submit(query_campaign_info, short_token)
    aux_tasks = {
        "daily":  _query_pool.submit(query_daily,  short_token),
        "detail": _query_pool.submit(query_detail, short_token),
        "logo":   _query_pool.submit(query_logo,   short_token),
        "loom":   _query_pool.submit(query_loom,   short_token),
        "rmnd":   _query_pool.submit(query_upload, short_token, "RMND"),
        "pdooh":  _query_pool.submit(query_upload, short_token, "PDOOH"),
        "survey": _query_pool.submit(query_survey, short_token),
        # Status da integração com Google Sheets, se existir. Aqui sempre
        # passamos is_admin=False — o filtro de admin acontece no endpoint
        # report_data, que enriquece o payload depois de saber se a request
        # tem JWT admin válido. Esse campo é apenas a "view pública mínima"
        # (url + status), suficiente pra renderizar o link no client.
        "sheets_integration": _query_pool.submit(_safe_sheets_status_public, short_token),
    }

    campaign_info = fut_campaign.result()
    if not campaign_info:
        # Auxiliares já em voo; resultado é descartado naturalmente quando os
        # futures saem de escopo. Custo desprezível pra um caso raro.
        return None

    # totals é o único que depende de campaign_info — dispara agora
    fut_totals = _query_pool.submit(query_totals, short_token, campaign_info)

    result = {"campaign": campaign_info}
    result["totals"] = _safe_future_result(fut_totals, "totals", default=[])
    for key, future in aux_tasks.items():
        # Falha em uma query auxiliar não deve derrubar o report inteiro.
        # Front sabe lidar com chaves nulas (logo, loom, survey, rmnd, pdooh).
        # Para daily/detail logamos e retornamos vazio para que a UI mostre
        # "sem dados" em vez de erro 500.
        nullable = key in ("logo", "loom", "rmnd", "pdooh", "survey", "sheets_integration")
        result[key] = _safe_future_result(future, key, default=None if nullable else [])
    return result


def _safe_sheets_status_public(short_token: str):
    """Wrapper que isola erros do módulo sheets — campanha não pode quebrar
    se KMS/BQ tabela ainda não existe (primeira execução pré-setup)."""
    try:
        return sheets_integration.status_for_response(short_token, is_admin=False)
    except Exception as e:
        logger.warning(f"[WARN sheets_integration.status {short_token}] {e}")
        return None


def _safe_future_result(future, label, default):
    """Resolve um future logando exceções em vez de propagá-las."""
    try:
        return future.result()
    except Exception as e:
        logger.warning(f"[WARN fetch_campaign_data {label}] {e}")
        return default


# ─────────────────────────────────────────────────────────────────────────────
# Merged Report Composer
# ─────────────────────────────────────────────────────────────────────────────
# Quando um short_token pertence a um grupo (registrado em
# campaign_merge_groups), o endpoint público `?token=X` delega ao composer.
# `fetch_campaign_data` continua intocado — composer chama N vezes em
# paralelo (1 por membro do grupo, cada um já cacheado individualmente)
# e combina o payload pra que o frontend renderize com os mesmos componentes.
#
# Regras de agregação (alinhadas com a especificação do usuário):
#
#   - Períodos:        start = min(starts), end = max(ends)
#   - Budget:          SUM(budget_contracted) entre tokens
#   - Counts/Cost:     SUM (impressões, viewable, clicks, completions, custos)
#   - Pacing/Over:     valores DO TOKEN ATIVO, sem recalcular
#                      (rationale: pacing = entrega vs esperado; em campanha
#                      mergeada, "esperado" só faz sentido pro mês corrente)
#   - CPM/CPCV efetivo: valores do token ativo (idem)
#   - Rentabilidade:   token ativo
#   - daily/detail:    concat (PIs mensais não sobrepõem datas em prática)
#   - Logo/Loom:       prefere token ativo; fallback pro mais recente não-nulo
#   - Survey:          omitido em merged
#   - RMND/PDOOH:      por config do grupo — 'merge' (concat JSON arrays)
#                      ou 'latest' (token mais recente apenas)
#   - merge_meta:      novo campo no payload pro frontend renderizar filtro
# ─────────────────────────────────────────────────────────────────────────────

_MERGED_REPORT_CACHE_TTL = _REPORT_CACHE_TTL  # mesmo TTL do single-token


_MONTHS_PT = [
    "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
    "Jul", "Ago", "Set", "Out", "Nov", "Dez",
]


def _format_period_pt_br(start, end):
    """Label curto pra header de seção em payloads merged.

    Mesmo mês/ano  → "Mar 2026"
    Mesmo ano      → "Mar–Abr 2026"
    Anos diferent. → "Dez 2025–Jan 2026"
    Só um lado     → o que existir
    Ambos None     → ""
    """
    if not start and not end:
        return ""
    if start and not end:
        return f"{_MONTHS_PT[start.month-1]} {start.year}"
    if end and not start:
        return f"{_MONTHS_PT[end.month-1]} {end.year}"
    if start.year == end.year and start.month == end.month:
        return f"{_MONTHS_PT[start.month-1]} {start.year}"
    if start.year == end.year:
        return f"{_MONTHS_PT[start.month-1]}–{_MONTHS_PT[end.month-1]} {start.year}"
    return f"{_MONTHS_PT[start.month-1]} {start.year}–{_MONTHS_PT[end.month-1]} {end.year}"


def _parse_iso_date_safe(v):
    """Converte string ISO ou date/datetime → date. None se inválido."""
    if v is None:
        return None
    if hasattr(v, "date") and not isinstance(v, date):
        try:
            return v.date()
        except Exception:
            pass
    if isinstance(v, date):
        return v
    if isinstance(v, str):
        try:
            return date.fromisoformat(v.split("T")[0][:10])
        except Exception:
            return None
    return None


def _pick_active_token(per_token):
    """Decide qual token é o "ativo" no momento.

    Regra (nessa ordem de prioridade):
      1. Algum membro com start ≤ hoje ≤ end → escolhe o de maior `start`.
      2. Algum membro com start futuro → o de menor `start` (próximo a vir).
      3. Todos passados → o de maior `end`.
      4. Fallback: primeiro membro do dict.

    Retorna a string short_token. Sempre devolve um valor válido se per_token
    não estiver vazio.
    """
    today = date.today()
    in_window = []
    future = []
    past = []
    for token, data in per_token.items():
        camp = (data or {}).get("campaign") or {}
        sd = _parse_iso_date_safe(camp.get("start_date"))
        ed = _parse_iso_date_safe(camp.get("end_date"))
        if sd and ed and sd <= today <= ed:
            in_window.append((token, sd, ed))
        elif sd and sd > today:
            future.append((token, sd, ed))
        else:
            past.append((token, sd, ed))

    if in_window:
        return max(in_window, key=lambda x: x[1])[0]
    if future:
        return min(future, key=lambda x: x[1])[0]
    if past:
        # `ed` pode ser None — usa date.min como sentinela
        return max(past, key=lambda x: x[2] or date.min)[0]
    return next(iter(per_token.keys()))


def _compose_totals(per_token, active_token):
    """Combina linhas de `totals` por (tactic_type, media_type).

    Counts/cost/contracted/bonus → SOMA entre tokens.
    Pacing/CPM-efetivo/over/rentabilidade/actual_start_date/days_with_delivery
      → herdados do token ativo (single source of truth para o mês corrente).
    CTR/VTR/CPC → recalculados a partir das somas.
    """
    SUM_FIELDS = (
        "total_invested",
        "impressions", "viewable_impressions", "clicks", "completions",
        "effective_total_cost", "effective_cost_with_over",
        "o2o_display_budget", "ooh_display_budget",
        "o2o_video_budget", "ooh_video_budget",
        "contracted_o2o_display_impressions", "contracted_ooh_display_impressions",
        "contracted_o2o_video_completions", "contracted_ooh_video_completions",
        "bonus_o2o_display_impressions", "bonus_ooh_display_impressions",
        "bonus_o2o_video_completions", "bonus_ooh_video_completions",
        "viewable_video_view_100_complete",
    )
    ACTIVE_FIELDS = (
        "deal_cpm_amount", "deal_cpcv_amount",
        "effective_cpm_amount", "effective_cpcv_amount",
        "pacing", "rentabilidade",
        "actual_start_date", "days_with_delivery",
    )

    by_key = {}
    for token, data in per_token.items():
        for row in (data.get("totals") or []):
            key = (row.get("tactic_type"), row.get("media_type"))
            if key not in by_key:
                by_key[key] = {
                    "tactic_type": row.get("tactic_type"),
                    "media_type":  row.get("media_type"),
                    **{f: 0.0 for f in SUM_FIELDS},
                    **{f: None for f in ACTIVE_FIELDS},
                }
            for f in SUM_FIELDS:
                v = row.get(f)
                if v is not None:
                    try:
                        by_key[key][f] += float(v)
                    except (TypeError, ValueError):
                        pass

    active_data = per_token.get(active_token) or {}
    active_by_key = {
        (r.get("tactic_type"), r.get("media_type")): r
        for r in (active_data.get("totals") or [])
    }

    INTEGER_FIELDS = ("impressions", "viewable_impressions", "clicks",
                      "completions", "viewable_video_view_100_complete",
                      "contracted_o2o_display_impressions", "contracted_ooh_display_impressions",
                      "contracted_o2o_video_completions",   "contracted_ooh_video_completions",
                      "bonus_o2o_display_impressions", "bonus_ooh_display_impressions",
                      "bonus_o2o_video_completions", "bonus_ooh_video_completions")
    MONEY_FIELDS = ("total_invested", "effective_total_cost", "effective_cost_with_over",
                    "o2o_display_budget", "ooh_display_budget",
                    "o2o_video_budget", "ooh_video_budget")

    result = []
    for key, agg in by_key.items():
        active_row = active_by_key.get(key) or {}
        for f in ACTIVE_FIELDS:
            agg[f] = active_row.get(f)

        viewable    = agg["viewable_impressions"] or 0
        clicks      = agg["clicks"]               or 0
        completions = agg["completions"]          or 0
        cost        = agg["effective_total_cost"] or 0

        agg["ctr"] = round((clicks      / viewable * 100), 4) if viewable else 0.0
        agg["vtr"] = round((completions / viewable * 100), 4) if viewable else 0.0
        agg["cpc"] = round((cost        / clicks),         4) if clicks   else 0.0

        for f in INTEGER_FIELDS:
            agg[f] = int(round(agg[f] or 0))
        for f in MONEY_FIELDS:
            agg[f] = round(agg[f] or 0, 2)

        result.append(agg)
    return result


def _compose_asset_payload(per_token, active_token, mode, key, members_sorted):
    """Combina data.rmnd ou data.pdooh.

    `mode='latest'` → retorna o payload do MEMBRO MAIS RECENTE (por start_date)
                      que tenha valor não-nulo. Fallback ativo, depois ordenado.
    `mode='merge'`  → tenta parsear cada payload como JSON array e concatena.
                      Se algum membro não parseia, faz log e cai pra latest.

    Retorna a string final (já JSON-encoded) ou None.
    """
    raw_by_token = {t: per_token[t].get(key) for t in per_token}

    def latest_non_null():
        # Active primeiro; depois itera do mais RECENTE pro mais antigo
        # (members_sorted é asc por start_date, então reversed = desc).
        if raw_by_token.get(active_token):
            return raw_by_token[active_token]
        for t in reversed(members_sorted):
            if raw_by_token.get(t):
                return raw_by_token[t]
        return None

    if mode == "latest":
        return latest_non_null()

    # mode == 'merge': concatena arrays JSON
    accumulated = []
    for t in members_sorted:
        raw = raw_by_token.get(t)
        if not raw:
            continue
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(parsed, list):
                accumulated.extend(parsed)
            else:
                # Não é array — não dá pra concat semanticamente.
                logger.warning(f"[WARN _compose_asset_payload {key}] token={t} payload não é array, mode=merge cai pra latest")
                return latest_non_null()
        except Exception as e:
            logger.warning(f"[WARN _compose_asset_payload {key}] token={t} parse falhou: {e}; mode=merge cai pra latest")
            return latest_non_null()

    if not accumulated:
        return None
    return json.dumps(accumulated)


def compose_merged_report(group, force_refresh=False):
    """Compõe o payload merged a partir do dict de grupo (vide merges.get_merge_group).

    `force_refresh=True` propaga pra cada `_get_report_cached(token)` por
    membro — necessário quando o admin pede ?refresh=true num report
    merged: sem propagação, só o token base seria refrescado e os outros
    entrariam stale no payload composto.

    Retorna None se nenhum membro do grupo tem dado válido (caso patológico:
    todos os tokens foram removidos da hub depois do merge).
    """
    members = group.get("members") or []
    if not members:
        return None
    tokens = [m["short_token"] for m in members if m.get("short_token")]
    if not tokens:
        return None

    # Fetch paralelo — cada um já passa por _get_report_cached (cache warm
    # entre membros). Usamos _query_pool existente pra não criar pool novo.
    futures = {
        t: _query_pool.submit(_get_report_cached, t, force_refresh)
        for t in tokens
    }
    per_token = {}
    for t in tokens:
        try:
            data, _hit = futures[t].result()
        except Exception as e:
            logger.warning(f"[WARN compose_merged_report] fetch token={t} falhou: {e}")
            continue
        if data is not None:
            per_token[t] = data

    if not per_token:
        return None

    active_token = _pick_active_token(per_token)
    active_data  = per_token[active_token]

    # Ordena membros por start_date asc — usado em concat e no merge_meta
    members_sorted = sorted(
        per_token.keys(),
        key=lambda t: _parse_iso_date_safe(
            (per_token[t].get("campaign") or {}).get("start_date")
        ) or date.min,
    )

    # Período + budget agregado
    starts = [
        _parse_iso_date_safe((d.get("campaign") or {}).get("start_date"))
        for d in per_token.values()
    ]
    ends = [
        _parse_iso_date_safe((d.get("campaign") or {}).get("end_date"))
        for d in per_token.values()
    ]
    earliest_start = min((s for s in starts if s), default=None)
    latest_end     = max((e for e in ends   if e), default=None)
    summed_budget  = sum(
        float((d.get("campaign") or {}).get("budget_contracted") or 0)
        for d in per_token.values()
    )

    active_camp = active_data.get("campaign") or {}
    composed_campaign = {
        # Mantém o short_token do ativo — comments/loom/logo apontam pra ele
        "short_token":       active_camp.get("short_token") or active_token,
        "client_name":       active_camp.get("client_name"),
        "campaign_name":     active_camp.get("campaign_name"),
        "start_date":        earliest_start.isoformat() if earliest_start else active_camp.get("start_date"),
        "end_date":          latest_end.isoformat()     if latest_end     else active_camp.get("end_date"),
        "budget_contracted": round(summed_budget, 2),
        "cpm_negociado":     active_camp.get("cpm_negociado",  0),
        "cpcv_negociado":    active_camp.get("cpcv_negociado", 0),
        "updated_at":        max(
            ((d.get("campaign") or {}).get("updated_at") or "") for d in per_token.values()
        ) or active_camp.get("updated_at"),
    }

    # Concat daily + detail (PIs sequenciais → datas não sobrepõem em prática;
    # se sobrepuserem, o frontend agrupa por data e media_type via aggregations.js)
    composed_daily  = []
    composed_detail = []
    for t in members_sorted:
        composed_daily.extend(per_token[t].get("daily")  or [])
        composed_detail.extend(per_token[t].get("detail") or [])

    composed_totals = _compose_totals(per_token, active_token)

    # Logo/Loom — prefere ativo; fallback ordem reversa (mais recente primeiro)
    def first_non_null(field):
        if active_data.get(field):
            return active_data[field]
        for t in reversed(members_sorted):
            v = per_token[t].get(field)
            if v:
                return v
        return None

    logo = first_non_null("logo")
    loom = first_non_null("loom")

    rmnd_mode  = group.get("rmnd_mode")  or merges.DEFAULT_ASSET_MODE
    pdooh_mode = group.get("pdooh_mode") or merges.DEFAULT_ASSET_MODE
    rmnd  = _compose_asset_payload(per_token, active_token, rmnd_mode,  "rmnd",  members_sorted)
    pdooh = _compose_asset_payload(per_token, active_token, pdooh_mode, "pdooh", members_sorted)

    # Sheets integration na visão agregada: prioriza a integração do
    # MERGE (1 sheet com a base unificada). Se não existe, fallback pro
    # token ativo (comportamento legado).
    sheets = None
    try:
        sheets = sheets_integration.status_for_response(
            group["merge_id"], is_admin=False, target_type="merge",
        )
    except Exception as e:
        logger.warning(f"[WARN compose_merged_report sheets_integration merge] {e}")
    if not sheets:
        sheets = active_data.get("sheets_integration")

    # `totals` por membro vai junto pra o frontend conseguir recompor o
    # custo efetivo correto quando o usuário aplica filtro de período na
    # visão agregada. Sem isso, a fórmula proporcional acaba aplicando o
    # CPM médio do grupo sobre as impressões de um único membro — o que
    # diverge do drill-down do mesmo membro com o mesmo filtro. Cada
    # `members[i].totals` é o totals single-token (já calculado em
    # per_token[t]) — não soma, não é compose.
    merge_meta = {
        "merge_id":     group["merge_id"],
        "active_token": active_token,
        "rmnd_mode":    rmnd_mode,
        "pdooh_mode":   pdooh_mode,
        "members": [
            {
                "short_token":   t,
                "campaign_name": (per_token[t].get("campaign") or {}).get("campaign_name"),
                "start_date":    (per_token[t].get("campaign") or {}).get("start_date"),
                "end_date":      (per_token[t].get("campaign") or {}).get("end_date"),
                "is_active":     t == active_token,
                "totals":        per_token[t].get("totals") or [],
            }
            for t in members_sorted
        ],
    }

    # Survey: se 1+ membros do grupo têm survey, expõe como shape merged
    # `{merged: true, items: [{short_token, label, survey: "<json>"}]}`.
    # O frontend renderiza por seção (1 por mês). Mesmo com tokens que têm
    # exatamente o MESMO JSON, mantemos um item por token — os Typeforms são
    # filtrados por período em cada token, então os dados respondidos diferem.
    survey_items = []
    for t in members_sorted:
        sv = per_token[t].get("survey")
        if not sv:
            continue
        camp_t = per_token[t].get("campaign") or {}
        s_d = _parse_iso_date_safe(camp_t.get("start_date"))
        e_d = _parse_iso_date_safe(camp_t.get("end_date"))
        survey_items.append({
            "short_token": t,
            "label":       _format_period_pt_br(s_d, e_d) or t,
            "survey":      sv,
        })
    survey_payload = (
        {"merged": True, "items": survey_items} if survey_items else None
    )

    return {
        "campaign":           composed_campaign,
        "totals":             composed_totals,
        "daily":              composed_daily,
        "detail":             composed_detail,
        "logo":               logo,
        "loom":               loom,
        "rmnd":               rmnd,
        "pdooh":              pdooh,
        "survey":             survey_payload,
        "sheets_integration": sheets,
        "merge_meta":         merge_meta,
    }


def _get_merge_meta_only(merge_id):
    """Constrói APENAS o merge_meta sem rodar a composição completa.

    Usado quando o caller pediu ?view=<token> num token que pertence a um
    grupo: o backend devolve o payload single-token, mas ainda precisamos
    anexar merge_meta pra que o frontend renderize os pills do switcher
    (Visão agregada / Jan / Fev). Sem isso, o usuário fica "preso" na
    visão por mês sem conseguir voltar.

    Reaproveita _get_report_cached por membro (cache warm na maioria dos
    casos — o usuário acabou de vir da visão agregada). Não precisa rodar
    _compose_totals nem outras agregações pesadas.
    """
    group = merges.get_merge_group(merge_id)
    if not group:
        return None
    members = group.get("members") or []
    tokens = [m["short_token"] for m in members if m.get("short_token")]
    if not tokens:
        return None

    futures = {t: _query_pool.submit(_get_report_cached, t) for t in tokens}
    per_token = {}
    for t in tokens:
        try:
            data, _hit = futures[t].result()
        except Exception as e:
            logger.warning(f"[WARN _get_merge_meta_only] fetch token={t} falhou: {e}")
            continue
        if data is not None:
            per_token[t] = data
    if not per_token:
        return None

    active_token = _pick_active_token(per_token)
    members_sorted = sorted(
        per_token.keys(),
        key=lambda t: _parse_iso_date_safe(
            (per_token[t].get("campaign") or {}).get("start_date")
        ) or date.min,
    )
    return {
        "merge_id":     group["merge_id"],
        "active_token": active_token,
        "rmnd_mode":    group.get("rmnd_mode")  or merges.DEFAULT_ASSET_MODE,
        "pdooh_mode":   group.get("pdooh_mode") or merges.DEFAULT_ASSET_MODE,
        "members": [
            {
                "short_token":   t,
                "campaign_name": (per_token[t].get("campaign") or {}).get("campaign_name"),
                "start_date":    (per_token[t].get("campaign") or {}).get("start_date"),
                "end_date":      (per_token[t].get("campaign") or {}).get("end_date"),
                "is_active":     t == active_token,
                "totals":        per_token[t].get("totals") or [],
            }
            for t in members_sorted
        ],
    }


def _get_merged_report_cached(merge_id, force_refresh=False):
    """Wrapper de cache + single-flight em torno de compose_merged_report.

    Reusa o dict de locks por token (vivo em _token_locks) sob a chave do
    merge_id — N admins abrindo o mesmo report merged não disparam N composições.
    """
    if not force_refresh:
        cached = _cache_get(_merged_report_cache, merge_id, _MERGED_REPORT_CACHE_TTL)
        if cached is not None:
            return cached, True

    lock = _get_token_lock(f"__merged__:{merge_id}")
    with lock:
        if not force_refresh:
            cached = _cache_get(_merged_report_cache, merge_id, _MERGED_REPORT_CACHE_TTL)
            if cached is not None:
                return cached, True

        group = merges.get_merge_group(merge_id)
        if not group:
            return None, False
        data = compose_merged_report(group, force_refresh=force_refresh)
        if data is None:
            return None, False
        _cache_set(_merged_report_cache, merge_id, data)
        return data, False


def table_ref():
    return f"`{PROJECT_ID}.{DATASET_HUB}.{TABLE}`"


# ─────────────────────────────────────────────────────────────────────────────
# Logo — salvar e buscar
# ─────────────────────────────────────────────────────────────────────────────
def save_logo(short_token: str, logo_base64: str):
    """Faz UPSERT do logo na tabela client_logos (atômico via MERGE)."""
    table_id = f"{PROJECT_ID}.{DATASET_ASSETS}.client_logos"
    sql = f"""
        MERGE `{table_id}` T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
            UPDATE SET logo_base64 = @logo, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN
            INSERT (short_token, logo_base64, updated_at)
            VALUES (@token, @logo, CURRENT_TIMESTAMP())
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", short_token),
            bigquery.ScalarQueryParameter("logo",  "STRING", logo_base64),
        ]
    )
    bq.query(sql, job_config=job_config).result()


def query_logo(short_token: str):
    """Retorna o logo_base64 do token, ou None se não existir."""
    sql = f"""
        SELECT logo_base64
        FROM `{PROJECT_ID}.{DATASET_ASSETS}.client_logos`
        WHERE short_token = @token
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    try:
        rows = list(bq.query(sql, job_config=job_config).result())
        if rows:
            return rows[0]["logo_base64"]
    except Exception as e:
        logger.warning(f"[WARN query_logo] {e}")
    return None


def query_client_logos_meta(short_token: str):
    """Lista metadados (sem base64) dos logos de outras campanhas do mesmo
    cliente do `short_token` informado. Usado pelo LogoModal pra oferecer
    reaproveitamento de logos já cadastrados.

    Não inclui o próprio token na resposta. Retorna ordenado por
    updated_at DESC (mais recente primeiro).

    Returns: list de {short_token, campaign_name, updated_at}
    """
    sql = f"""
        WITH src AS (
            SELECT client_name FROM {table_ref()}
            WHERE short_token = @token
            LIMIT 1
        )
        SELECT
            cl.short_token                  AS short_token,
            ANY_VALUE(c.campaign_name)      AS campaign_name,
            MAX(cl.updated_at)              AS updated_at
        FROM `{PROJECT_ID}.{DATASET_ASSETS}.client_logos` cl
        JOIN {table_ref()} c USING (short_token)
        WHERE c.client_name = (SELECT client_name FROM src)
          AND cl.short_token != @token
        GROUP BY cl.short_token
        ORDER BY MAX(cl.updated_at) DESC
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    try:
        rows = list(bq.query(sql, job_config=job_config).result())
        return [
            {
                "short_token":   r["short_token"],
                "campaign_name": r["campaign_name"],
                "updated_at":    r["updated_at"].isoformat() if r["updated_at"] else None,
            }
            for r in rows
        ]
    except Exception as e:
        logger.warning(f"[WARN query_client_logos_meta] {e}")
        return []


# ─────────────────────────────────────────────────────────────────────────────
# Loom — salvar e buscar
# ─────────────────────────────────────────────────────────────────────────────
def save_loom(short_token: str, loom_url: str):
    """Faz UPSERT do link Loom na tabela campaign_looms (atômico via MERGE)."""
    table_id = f"{PROJECT_ID}.{DATASET_ASSETS}.campaign_looms"
    sql = f"""
        MERGE `{table_id}` T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
            UPDATE SET loom_url = @loom_url, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN
            INSERT (short_token, loom_url, updated_at)
            VALUES (@token, @loom_url, CURRENT_TIMESTAMP())
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token",    "STRING", short_token),
            bigquery.ScalarQueryParameter("loom_url", "STRING", loom_url),
        ]
    )
    bq.query(sql, job_config=job_config).result()


def query_loom(short_token: str):
    """Retorna o loom_url do token, ou None se não existir."""
    sql = f"""
        SELECT loom_url
        FROM `{PROJECT_ID}.{DATASET_ASSETS}.campaign_looms`
        WHERE short_token = @token
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    try:
        rows = list(bq.query(sql, job_config=job_config).result())
        if rows:
            return rows[0]["loom_url"]
    except Exception as e:
        logger.warning(f"[WARN query_loom] {e}")
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Brand Safety pre-bid (ABS) override — admin marca quando o sinal automático
# do BQ não detecta. Tabela `campaign_abs_overrides` é OR-merged com os sinais
# automáticos (DV360 doubleverify_pre_bid_fee + Xandr data_provider DV/IAS) na
# CTE `abs_signals` de query_campaigns_list. Granularidade: por short_token,
# binária (cobre Display e Video juntos — DV ABS / IAS aplicam por campanha
# inteira na prática).
# ─────────────────────────────────────────────────────────────────────────────
def save_abs_override(short_token: str, has_abs: bool, updated_by: str | None = None):
    """UPSERT do override de ABS na tabela campaign_abs_overrides (atômico via MERGE)."""
    table_id = f"{PROJECT_ID}.{DATASET_ASSETS}.campaign_abs_overrides"
    sql = f"""
        MERGE `{table_id}` T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
            UPDATE SET has_abs = @has_abs, updated_at = CURRENT_TIMESTAMP(), updated_by = @updated_by
        WHEN NOT MATCHED THEN
            INSERT (short_token, has_abs, updated_at, updated_by)
            VALUES (@token, @has_abs, CURRENT_TIMESTAMP(), @updated_by)
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token",      "STRING", short_token),
            bigquery.ScalarQueryParameter("has_abs",    "BOOL",   has_abs),
            bigquery.ScalarQueryParameter("updated_by", "STRING", updated_by),
        ]
    )
    bq.query(sql, job_config=job_config).result()


def query_abs_override(short_token: str):
    """Retorna {has_abs, updated_by} do override do token, ou None se não existe."""
    sql = f"""
        SELECT has_abs, updated_by
        FROM `{PROJECT_ID}.{DATASET_ASSETS}.campaign_abs_overrides`
        WHERE short_token = @token
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    try:
        rows = list(bq.query(sql, job_config=job_config).result())
        if rows:
            return {"has_abs": bool(rows[0]["has_abs"]), "updated_by": rows[0]["updated_by"]}
    except Exception as e:
        logger.warning(f"[WARN query_abs_override] {e}")
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Survey — salvar e buscar
# ─────────────────────────────────────────────────────────────────────────────
def save_survey(short_token: str, survey_data: str):
    """Faz UPSERT dos dados do survey na tabela campaign_surveys (atômico via MERGE)."""
    table_id = f"{PROJECT_ID}.{DATASET_ASSETS}.campaign_surveys"
    sql = f"""
        MERGE `{table_id}` T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
            UPDATE SET survey_data = @survey_data, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN
            INSERT (short_token, survey_data, updated_at)
            VALUES (@token, @survey_data, CURRENT_TIMESTAMP())
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token",       "STRING", short_token),
            bigquery.ScalarQueryParameter("survey_data", "STRING", survey_data),
        ]
    )
    bq.query(sql, job_config=job_config).result()


def query_survey(short_token: str):
    """Retorna o survey_data do token, ou None se não existir."""
    sql = f"""
        SELECT survey_data
        FROM `{PROJECT_ID}.{DATASET_ASSETS}.campaign_surveys`
        WHERE short_token = @token
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    try:
        rows = list(bq.query(sql, job_config=job_config).result())
        if rows:
            return rows[0]["survey_data"]
    except Exception as e:
        logger.warning(f"[WARN query_survey] {e}")
    return None

# ─────────────────────────────────────────────────────────────────────────────
# Comments — salvar e buscar
# ─────────────────────────────────────────────────────────────────────────────
def save_comment(short_token: str, metric_name: str, author: str, comment: str):
    """Insere um comentário na tabela campaign_comments."""
    table_id = f"{PROJECT_ID}.{DATASET_ASSETS}.campaign_comments"
    now = datetime.utcnow().isoformat()
    insert_sql = f"""
        INSERT INTO `{table_id}` (short_token, metric_name, author, comment, created_at)
        VALUES (@token, @metric_name, @author, @comment, @created_at)
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token",       "STRING",    short_token),
            bigquery.ScalarQueryParameter("metric_name", "STRING",    metric_name),
            bigquery.ScalarQueryParameter("author",      "STRING",    author),
            bigquery.ScalarQueryParameter("comment",     "STRING",    comment),
            bigquery.ScalarQueryParameter("created_at",  "TIMESTAMP", now),
        ]
    )
    bq.query(insert_sql, job_config=job_config).result()


def query_comments(short_token: str):
    """Retorna todos os comentários de uma campanha."""
    sql = f"""
        SELECT metric_name, author, comment, created_at
        FROM `{PROJECT_ID}.{DATASET_ASSETS}.campaign_comments`
        WHERE short_token = @token
        ORDER BY created_at ASC
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    try:
        rows = list(bq.query(sql, job_config=job_config).result())
        return [{"metric_name": r["metric_name"], "author": r["author"],
                 "comment": r["comment"], "created_at": str(r["created_at"])} for r in rows]
    except Exception as e:
        logger.warning(f"[WARN query_comments] {e}")
    return []

# ─────────────────────────────────────────────────────────────────────────────
# Pacing — mesma fórmula da planilha:
#   Se end_date < hoje  → custo_entregue / impressoes_negociadas
#   Se ainda em curso   → custo_entregue / (impressoes_negociadas / total_dias * dias_passados)
# Adaptado para o dashboard: usa effective_total_cost vs total_invested
# ─────────────────────────────────────────────────────────────────────────────
def calc_pacing(cost: float, budget: float, start_date, end_date) -> float:
    if budget <= 0:
        return 0.0
    today = date.today()
    # garante objetos date
    if hasattr(start_date, "date"):
        start_date = start_date.date()
    if hasattr(end_date, "date"):
        end_date = end_date.date()

    if end_date < today:
        # campanha já encerrada
        pacing = cost / budget
    else:
        total_days   = (end_date - start_date).days + 1
        elapsed_days = (today - start_date).days
        if elapsed_days <= 0 or total_days <= 0:
            return 0.0
        expected_cost = budget / total_days * elapsed_days
        pacing = cost / expected_cost if expected_cost > 0 else 0.0

    return round(pacing * 100, 4)   # retorna em %


# ─────────────────────────────────────────────────────────────────────────────
def query_campaign_info(token):
    sql = f"""
        SELECT
            short_token,
            client_name,
            campaign_name,
            MAX(start_date)       AS start_date,
            MAX(end_date)         AS end_date,
            MAX(total_invested)   AS budget_contracted,
            AVG(deal_cpm_amount)  AS cpm_negociado,
            AVG(deal_cpcv_amount) AS cpcv_negociado,
            MAX(updated_at)       AS updated_at
        FROM {table_ref()}
        WHERE short_token = @token
        GROUP BY short_token, client_name, campaign_name
        LIMIT 1
    """
    rows = run_query(sql, token)
    if not rows:
        return None
    r = rows[0]
    return {
        "short_token":       r["short_token"],
        "client_name":       r["client_name"],
        "campaign_name":     r["campaign_name"],
        "start_date":        str(r["start_date"]),
        "end_date":          str(r["end_date"]),
        "budget_contracted": float(r["budget_contracted"] or 0),
        "cpm_negociado":     float(r["cpm_negociado"]     or 0),
        "cpcv_negociado":    float(r["cpcv_negociado"]    or 0),
        "updated_at":        str(r["updated_at"]),
        # datas brutas para cálculo interno
        "_start_date_raw":   r["start_date"],
        "_end_date_raw":     r["end_date"],
    }


def query_totals(token, campaign_info):
    """
    Fonte de métricas: unified_daily_performance_metrics (incremental, região US)
    Fonte de contratos: checklist_info (prod_assets, região US)
    Todos os cálculos de CPM/CPCV efetivo, rentabilidade e pacing feitos em Python.
    """
    UNIFIED = "`site-hypr.prod_assets.unified_daily_performance_metrics`"
    CHECKLIST = "`site-hypr.prod_assets.checklist_info`"

    sql_perf = f"""
        WITH base AS (
            SELECT
                CASE
                    WHEN REGEXP_CONTAINS(line_name, r'(?i)_O2O(_|$)') THEN 'O2O'
                    WHEN REGEXP_CONTAINS(line_name, r'(?i)_OOH(_|$)') THEN 'OOH'
                    ELSE 'O2O'
                END AS tactic_type,
                media_type,
                date,
                impressions,
                viewable_impressions,
                clicks,
                total_cost,
                -- Viewable completions: calculado por linha antes de somar
                -- video_view_100_complete × (viewable_impressions / impressions)
                CASE
                    WHEN impressions > 0 AND media_type = 'VIDEO'
                    THEN video_view_100_complete * (viewable_impressions / impressions)
                    ELSE 0
                END AS viewable_completions
            FROM {UNIFIED}
            WHERE short_token = @token
              AND UPPER(line_name) NOT LIKE '%SURVEY%'
        )
        SELECT
            tactic_type,
            media_type,
            MIN(date)                   AS actual_start_date,
            COUNT(DISTINCT date)        AS days_with_delivery,
            SUM(impressions)            AS impressions,
            SUM(viewable_impressions)   AS viewable_impressions,
            SUM(clicks)                 AS clicks,
            SUM(viewable_completions)   AS completions,
            SUM(total_cost)             AS effective_total_cost
        FROM base
        GROUP BY 1, 2
    """

    sql_checklist = f"""
        SELECT
            MAX(cpm_amount)                             AS cpm_amount,
            MAX(cpcv_amount)                            AS cpcv_amount,
            MAX(contracted_o2o_display_impressions)     AS contracted_o2o_display_impressions,
            MAX(contracted_ooh_display_impressions)     AS contracted_ooh_display_impressions,
            MAX(contracted_o2o_video_completions)       AS contracted_o2o_video_completions,
            MAX(contracted_ooh_video_completions)       AS contracted_ooh_video_completions,
            MAX(bonus_o2o_display_impressions)          AS bonus_o2o_display_impressions,
            MAX(bonus_ooh_display_impressions)          AS bonus_ooh_display_impressions,
            MAX(bonus_o2o_video_completions)            AS bonus_o2o_video_completions,
            MAX(bonus_ooh_video_completions)            AS bonus_ooh_video_completions
        FROM {CHECKLIST}
        WHERE short_token = @token
    """

    # unified_daily_performance_metrics está na região US — passar location explícito.
    # As 2 queries (perf + checklist) são independentes e tocam tabelas diferentes —
    # rodar em paralelo via _query_pool corta a latência pela metade no caminho
    # crítico do report (essa função é a query mais pesada de fetch_campaign_data).
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", token)
    ])

    fut_perf  = _query_pool.submit(
        lambda: list(bq.query(sql_perf, job_config=job_config, location="US").result())
    )
    fut_check = _query_pool.submit(
        lambda: list(bq.query(sql_checklist, job_config=job_config, location="US").result())
    )
    perf_rows  = fut_perf.result()
    check_rows = fut_check.result()

    if not check_rows:
        return []
    c = check_rows[0]

    # Dados do checklist
    cpm_neg   = float(c["cpm_amount"]  or 0)
    cpcv_neg  = float(c["cpcv_amount"] or 0)
    contracted_o2o_display = float(c["contracted_o2o_display_impressions"] or 0)
    contracted_ooh_display = float(c["contracted_ooh_display_impressions"] or 0)
    contracted_o2o_video   = float(c["contracted_o2o_video_completions"]   or 0)
    contracted_ooh_video   = float(c["contracted_ooh_video_completions"]   or 0)
    bonus_o2o_display      = float(c["bonus_o2o_display_impressions"]      or 0)
    bonus_ooh_display      = float(c["bonus_ooh_display_impressions"]      or 0)
    bonus_o2o_video        = float(c["bonus_o2o_video_completions"]        or 0)
    bonus_ooh_video        = float(c["bonus_ooh_video_completions"]        or 0)

    # Datas da campanha
    start = campaign_info.get("_start_date_raw")
    end   = campaign_info.get("_end_date_raw")

    today = date.today()
    if hasattr(start, "date"): start = start.date()
    if hasattr(end,   "date"): end   = end.date()

    total_days   = (end - start).days + 1 if start and end else 1
    elapsed_days = max(0, (today - start).days) if start else 0
    is_ended     = end < today if end else False

    # Budgets contratados por tática (sem bonus — bonus não entra no faturamento)
    o2o_display_budget = contracted_o2o_display * cpm_neg  / 1000
    ooh_display_budget = contracted_ooh_display * cpm_neg  / 1000
    o2o_video_budget   = contracted_o2o_video   * cpcv_neg
    ooh_video_budget   = contracted_ooh_video   * cpcv_neg

    # Impressões/views negociadas (contratado + bonus)
    neg_o2o_display = contracted_o2o_display + bonus_o2o_display
    neg_ooh_display = contracted_ooh_display + bonus_ooh_display
    neg_o2o_video   = contracted_o2o_video   + bonus_o2o_video
    neg_ooh_video   = contracted_ooh_video   + bonus_ooh_video

    result = []
    for r in perf_rows:
        tactic    = r["tactic_type"]
        media     = r["media_type"]
        is_video  = media == "VIDEO"
        is_o2o    = tactic == "O2O"

        impressions        = float(r["impressions"]          or 0)
        viewable           = float(r["viewable_impressions"] or 0)
        clicks             = float(r["clicks"]               or 0)
        completions        = float(r["completions"]          or 0)
        cost               = float(r["effective_total_cost"] or 0)
        days_with_delivery = int(r["days_with_delivery"]     or 0)

        # Data de início real da frente (pode ser diferente do início da campanha)
        actual_start = r["actual_start_date"]
        # BigQuery retorna DATE como datetime.date — normalizar
        if actual_start is not None:
            if hasattr(actual_start, "date"):        # datetime → date
                actual_start = actual_start.date()
            elif isinstance(actual_start, str):      # string "YYYY-MM-DD" → date
                from datetime import date as _date
                actual_start = _date.fromisoformat(actual_start)
            # agora é datetime.date — usar como row_start
            row_start = actual_start
        else:
            row_start = start
        row_total_days   = (end - row_start).days + 1 if row_start and end else total_days
        row_elapsed_days = max(0, (today - row_start).days) if row_start else elapsed_days
        row_is_ended     = end < today if end else False


        # Budget e negociado por tática/mídia
        if is_video:
            budget   = o2o_video_budget if is_o2o else ooh_video_budget
            neg      = neg_o2o_video    if is_o2o else neg_ooh_video
        else:
            budget   = o2o_display_budget if is_o2o else ooh_display_budget
            neg      = neg_o2o_display    if is_o2o else neg_ooh_display

        # Budget proporcional:
        # - Video: usa days_with_delivery (dias reais de entrega da frente)
        # - Display: usa elapsed_days da campanha geral
        if row_is_ended:
            budget_prop = budget
        elif is_video:
            budget_prop = (budget / row_total_days * days_with_delivery) if (row_total_days > 0 and days_with_delivery > 0) else 0.0
        elif total_days > 0 and elapsed_days > 0:
            budget_prop = budget / total_days * elapsed_days
        else:
            budget_prop = 0.0

        # Entrega esperada para PACING (over-detection / CPM efetivo): preserva
        # `days_with_delivery` no denominador. Esta variável alimenta o cálculo
        # de `over` (linhas 1248/1259) e `effective_total_cost` (CPM/CPCV
        # efetivo via `budget_prop`). Mexer aqui afeta rentabilidade e
        # faturamento — tratado em PR separado.
        expected_for_pacing = (neg / row_total_days * days_with_delivery) if (row_total_days > 0 and days_with_delivery > 0) else 0
        # Entrega esperada para OVER/CPM (display): dias decorridos da campanha geral
        expected_delivered = (neg / total_days * elapsed_days) if (total_days > 0 and elapsed_days > 0) else 0

        # Entrega esperada pelo PACING canônico HYPR (calendar-elapsed, com
        # cap em row_total_days). Usa `actual_start_date` da frente em vez
        # de campaign.start_date — frente que entra depois (ex: O2O começa
        # 4 dias após Video) é medida vs seu próprio período, não punida
        # pelos dias em que ainda nem tinha rodado. Espelha exatamente:
        #   - frontend `computeMediaPacing` (shared/aggregations.js)
        #   - backend `pacing_calc_calendar` no `?list=true`
        # Resultado: a coluna Pacing do Detalhamento e o Resumo por mídia
        # mostram o MESMO número que a barra Pacing da Visão Geral.
        pacing_capped_elapsed = min(row_elapsed_days, row_total_days) if row_total_days > 0 else 0
        pacing_expected = (neg / row_total_days * pacing_capped_elapsed) if (row_total_days > 0 and pacing_capped_elapsed > 0) else 0

        # Pacing: entregue vs esperado (fórmula canônica calendar-elapsed)
        # Video usa completions (viewable views 100%), Display usa viewable_impressions
        delivered_for_pacing = completions if is_video else viewable
        pacing = (delivered_for_pacing / pacing_expected * 100) if pacing_expected > 0 else 0.0

        # CPM/CPCV Efetivo e Rentabilidade
        # Regra: se entregou MAIS que o esperado → CPM cai (rentabilidade positiva)
        #        se entregou MENOS → CPM estático no negociado (rentabilidade = 0)
        if is_video:
            # Over: compara com entrega esperada baseada em dias reais de entrega
            views_esperadas = expected_for_pacing if not is_ended else neg
            over = completions > views_esperadas
            if over and completions > 0:
                cpcv_ef    = budget_prop / completions
                rentab     = (cpcv_neg - cpcv_ef) / cpcv_neg * 100 if cpcv_neg > 0 else 0.0
            else:
                cpcv_ef    = cpcv_neg
                rentab     = 0.0
            cpm_ef         = 0.0
            cost_with_over = completions * cpcv_neg  # valor a faturar
        else:
            impr_esperadas = expected_delivered if not is_ended else neg
            over = viewable > impr_esperadas
            if over and viewable > 0:
                cpm_ef  = budget_prop / viewable * 1000
                rentab  = (cpm_neg - cpm_ef) / cpm_neg * 100 if cpm_neg > 0 else 0.0
            else:
                cpm_ef  = cpm_neg
                rentab  = 0.0
            cpcv_ef        = 0.0
            cost_with_over = viewable / 1000 * cpm_neg  # valor a faturar

        ctr = (clicks      / viewable    * 100) if viewable    > 0 else 0.0
        cpc = (cost        / clicks)             if clicks      > 0 else 0.0
        vtr = (completions / viewable    * 100)  if viewable    > 0 else 0.0

        result.append({
            "tactic_type":              tactic,
            "media_type":               media,
            "total_invested":           budget,
            "deal_cpm_amount":          cpm_neg  if not is_video else 0.0,
            "deal_cpcv_amount":         cpcv_neg if is_video     else 0.0,
            "effective_cpm_amount":     round(cpm_ef,  4),
            "effective_cpcv_amount":    round(cpcv_ef, 4),
            "impressions":              impressions,
            "viewable_impressions":     viewable,
            "clicks":                   clicks,
            "completions":              completions,
            # effective_total_cost = custo calculado (CPM/CPCV efetivo * entrega)
            # Para display: CPM_efetivo * viewable / 1000
            # Para video: CPCV_efetivo * completions
            # effective_cost_with_over = valor a faturar (CPM_neg * entrega / 1000)
            "effective_total_cost":     round(cpm_ef * viewable / 1000 if not is_video else cpcv_ef * completions, 2),
            "effective_cost_with_over": round(cost_with_over, 2),
            "ctr":           round(ctr,   4),
            "cpc":           round(cpc,   4),
            "vtr":           round(vtr,   4),
            "pacing":        round(pacing, 4),
            "rentabilidade": round(rentab, 4),
            # Frente-level (para frontend recompor pacing agregado da Visão
            # Geral usando actual_start por linha em vez de campanha-wide).
            # `actual_start_date` é ISO yyyy-mm-dd ou None se a frente ainda
            # não entregou nada.
            "actual_start_date":   actual_start.isoformat() if actual_start else None,
            "days_with_delivery":  days_with_delivery,
            "o2o_display_budget":                  round(o2o_display_budget, 4),
            "ooh_display_budget":                  round(ooh_display_budget, 4),
            "o2o_video_budget":                    round(o2o_video_budget,   4),
            "ooh_video_budget":                    round(ooh_video_budget,   4),
            "contracted_o2o_display_impressions":  contracted_o2o_display,
            "contracted_ooh_display_impressions":  contracted_ooh_display,
            "contracted_o2o_video_completions":    contracted_o2o_video,
            "contracted_ooh_video_completions":    contracted_ooh_video,
            "bonus_o2o_display_impressions":       bonus_o2o_display,
            "bonus_ooh_display_impressions":       bonus_ooh_display,
            "bonus_o2o_video_completions":         bonus_o2o_video,
            "bonus_ooh_video_completions":         bonus_ooh_video,
            "viewable_video_view_100_complete":    completions,
        })
    return result

def query_daily(token):
    """Daily aggregated by date + media_type + tactic_type for charts."""
    sql = f"""
        SELECT
            date,
            media_type,
            CASE WHEN REGEXP_CONTAINS(line_name, r'(?i)_O2O(_|$)') THEN 'O2O' WHEN REGEXP_CONTAINS(line_name, r'(?i)_OOH(_|$)') THEN 'OOH' ELSE tactic_type END AS tactic_type,
            SUM(impressions)                        AS impressions,
            SUM(viewable_impressions)               AS viewable_impressions,
            SUM(clicks)                             AS clicks,
            SUM(viewable_video_starts)              AS video_starts,
            SUM(viewable_video_view_100_complete)   AS video_view_100,
            -- effective_total_cost é acumulado: usar MAX por (date, line) para evitar inflação
            -- Aqui já agrupamos por date+line_name, então MAX = valor daquele dia para aquela linha
            MAX(effective_total_cost)               AS effective_total_cost
        FROM {table_ref()}
        WHERE short_token = @token
          AND UPPER(line_name) NOT LIKE '%SURVEY%'
        GROUP BY date, media_type, 3
        ORDER BY date ASC
    """
    rows = run_query(sql, token)
    result = []
    for r in rows:
        viewable       = float(r["viewable_impressions"] or 0)
        clicks         = float(r["clicks"]               or 0)
        video_view_100 = float(r["video_view_100"]       or 0)
        ctr = (clicks         / viewable * 100) if viewable > 0 else 0
        vtr = (video_view_100 / viewable * 100) if viewable > 0 else 0
        result.append({
            "date":                 str(r["date"]),
            "media_type":           r["media_type"],
            "tactic_type":          r["tactic_type"],
            "impressions":          float(r["impressions"]          or 0),
            "viewable_impressions": viewable,
            "clicks":               clicks,
            "video_starts":         float(r["video_starts"]         or 0),
            "video_view_100":       video_view_100,
            "effective_total_cost": float(r["effective_total_cost"] or 0),
            "ctr": round(ctr, 4),
            "vtr": round(vtr, 4),
        })
    return result


def query_campaign_lines(token):
    """Retorna lista de line items agregados ao período inteiro da campanha
    com métricas brutas pro frontend calcular CTR/Viewability/VTR/eCPM e
    decidir as "piores". Granularidade: 1 row por (line_name, media_type) —
    raro uma mesma line cobrir os dois media_types, mas se cobre, mantém
    separado (thresholds são diferentes por mídia).

    Usado pelo PerformerDrawer admin pra mostrar piores LIs dentro de cada
    campanha do CS.

    `effective_total_cost` é acumulado em campaign_results por (date, line,
    creative) — somar direto inflaria. A subquery interna pega MAX por
    (date, line, creative) e o externo soma esses MAXes.
    """
    sql = f"""
        WITH dedup AS (
            SELECT
                date, line_name, creative_name, media_type,
                SUM(impressions)                        AS impressions,
                SUM(viewable_impressions)               AS viewable_impressions,
                SUM(clicks)                             AS clicks,
                SUM(viewable_video_starts)              AS video_starts,
                SUM(viewable_video_view_100_complete)   AS video_view_100,
                MAX(effective_total_cost)               AS line_creative_day_cost
            FROM {table_ref()}
            WHERE short_token = @token
              AND media_type IN ('DISPLAY', 'VIDEO')
              AND UPPER(line_name) NOT LIKE '%SURVEY%'
            GROUP BY date, line_name, creative_name, media_type
        )
        SELECT
            line_name,
            media_type,
            SUM(impressions)                AS impressions,
            SUM(viewable_impressions)       AS viewable_impressions,
            SUM(clicks)                     AS clicks,
            SUM(video_starts)               AS video_starts,
            SUM(video_view_100)             AS video_view_100,
            SUM(line_creative_day_cost)     AS total_cost
        FROM dedup
        GROUP BY line_name, media_type
        ORDER BY impressions DESC
    """
    rows = run_query(sql, token)
    result = []
    for r in rows:
        result.append({
            "line_name":            r["line_name"]            or "",
            "media_type":           r["media_type"]           or "",
            "impressions":          int(r["impressions"]          or 0),
            "viewable_impressions": int(r["viewable_impressions"] or 0),
            "clicks":               int(r["clicks"]               or 0),
            "video_starts":         int(r["video_starts"]         or 0),
            "video_view_100":       int(r["video_view_100"]       or 0),
            "total_cost":           float(r["total_cost"]         or 0),
        })
    return result


def query_detail(token):
    sql = f"""
        SELECT
            date,
            campaign_name,
            line_name,
            creative_name,
            creative_size,
            media_type,
            CASE WHEN REGEXP_CONTAINS(line_name, r'(?i)_O2O(_|$)') THEN 'O2O' WHEN REGEXP_CONTAINS(line_name, r'(?i)_OOH(_|$)') THEN 'OOH' ELSE tactic_type END AS tactic_type,
            SUM(impressions)                        AS impressions,
            SUM(viewable_impressions)               AS viewable_impressions,
            SUM(clicks)                             AS clicks,
            SUM(viewable_video_starts)              AS video_starts,
            SUM(viewable_video_view_25_complete)    AS video_view_25,
            SUM(viewable_video_view_50_complete)    AS video_view_50,
            SUM(viewable_video_view_75_complete)    AS video_view_75,
            SUM(viewable_video_view_100_complete)   AS video_view_100,
            AVG(effective_cpm_amount)               AS effective_cpm_amount,
            -- effective_total_cost é acumulado: MAX por (date, line, creative) = custo real do dia
            MAX(effective_total_cost)               AS effective_total_cost
        FROM {table_ref()}
        WHERE short_token = @token
          AND UPPER(line_name) NOT LIKE '%SURVEY%'
        GROUP BY
            date, campaign_name, line_name,
            creative_name, creative_size, media_type, 7
        ORDER BY date ASC, media_type, creative_name
    """
    rows = run_query(sql, token)
    result = []
    for r in rows:
        vi    = float(r["viewable_impressions"] or 0)
        clicks = float(r["clicks"] or 0)
        ctr   = (clicks / vi * 100) if vi > 0 else 0
        result.append({
            "date":                 str(r["date"]),
            "campaign_name":        r["campaign_name"]        or "",
            "line_name":            r["line_name"]            or "",
            "creative_name":        r["creative_name"]        or "",
            "creative_size":        r["creative_size"]        or "",
            "media_type":           r["media_type"]           or "",
            "tactic_type":          r["tactic_type"]          or "",
            "impressions":          float(r["impressions"]          or 0),
            "viewable_impressions": vi,
            "clicks":               clicks,
            "video_starts":         float(r["video_starts"]         or 0),
            "video_view_25":        float(r["video_view_25"]        or 0),
            "video_view_50":        float(r["video_view_50"]        or 0),
            "video_view_75":        float(r["video_view_75"]        or 0),
            "video_view_100":       float(r["video_view_100"]       or 0),
            "effective_cpm_amount": float(r["effective_cpm_amount"] or 0),
            "effective_total_cost": float(r["effective_total_cost"] or 0),
            "ctr":                  round(ctr, 4),
        })
    return result


def run_query(sql, token):
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", token)
        ]
    )
    job  = bq.query(sql, job_config=job_config)
    rows = list(job.result())
    return [dict(r) for r in rows]


def query_campaigns_list():
    # Query principal: agregações de delivery por short_token. Owners NÃO
    # participam dessa query — o enrichment é feito em Python depois,
    # lendo a planilha de De-Para via Sheets API + tabela de overrides.
    # Decisão arquitetural: ~280 entries no lookup cabem em memória e o
    # merge Python é mais rápido e robusto que JOIN com external table
    # (que dependia de nome exato da aba e quebrava em runtime).
    #
    # Consolidação de CTEs (perf):
    #   • `dedup` substitui display_dedup + video_dedup — uma única passada
    #     sobre campaign_results, mantendo media_type pra agregação
    #     condicional posterior. Reduz 2 full scans → 1.
    #   • `agg` substitui display + video — agregação condicional no mesmo
    #     CTE. Custo desprezível porque dedup já reduziu o volume.
    #   • `unified` substitui display_unified + video_unified — uma passada
    #     em unified_daily_performance_metrics. Reduz 2 full scans → 1.
    # Total: 5 full scans → 3. Sem mudança semântica (testado por equivalência
    # algébrica: SUM/COUNT DISTINCT/MIN ignoram NULLs, então
    # `SUM(IF(t='X', v, 0))` ≡ `SUM(v) WHERE t='X'`).
    sql = f"""
        WITH checklist AS (
            SELECT
                short_token,
                MAX(cpm_amount)                             AS cpm_amount,
                MAX(cpcv_amount)                            AS cpcv_amount,
                MAX(contracted_o2o_display_impressions)     AS contracted_o2o_display,
                MAX(contracted_ooh_display_impressions)     AS contracted_ooh_display,
                MAX(contracted_o2o_video_completions)       AS contracted_o2o_video,
                MAX(contracted_ooh_video_completions)       AS contracted_ooh_video,
                MAX(bonus_o2o_display_impressions)          AS bonus_o2o_display,
                MAX(bonus_ooh_display_impressions)          AS bonus_ooh_display,
                MAX(bonus_o2o_video_completions)            AS bonus_o2o_video,
                MAX(bonus_ooh_video_completions)            AS bonus_ooh_video
            FROM `site-hypr.prod_assets.checklist_info`
            GROUP BY short_token
        ),
        base AS (
            SELECT
                short_token,
                client_name,
                campaign_name,
                MAX(start_date) AS start_date,
                MAX(end_date)   AS end_date,
                MAX(updated_at) AS updated_at
            FROM {table_ref()}
            GROUP BY short_token, client_name, campaign_name
        ),
        -- Dedup por (date, line_name, creative_name) preservando media_type.
        -- effective_total_cost / effective_cost_with_over são acumulados no
        -- campaign_results; MAX pega o último valor por linha (last-write-wins).
        dedup AS (
            SELECT
                short_token, media_type,
                date, line_name, creative_name,
                MAX(viewable_impressions)             AS vi,
                MAX(clicks)                           AS clicks,
                MAX(effective_total_cost)             AS effective_total_cost,
                MAX(viewable_video_view_100_complete) AS v100_complete,
                MAX(effective_cost_with_over)         AS effective_cost_with_over
            FROM {table_ref()}
            WHERE media_type IN ('DISPLAY', 'VIDEO')
              AND UPPER(line_name) NOT LIKE '%SURVEY%'
            GROUP BY short_token, media_type, date, line_name, creative_name
        ),
        agg AS (
            SELECT
                short_token,
                SUM(IF(media_type='DISPLAY', vi,                       0)) AS d_vi,
                SUM(IF(media_type='DISPLAY', clicks,                   0)) AS d_clicks,
                SUM(IF(media_type='DISPLAY', effective_total_cost,     0)) AS d_cost,
                SUM(IF(media_type='VIDEO',   vi,                       0)) AS v_vi,
                SUM(IF(media_type='VIDEO',   clicks,                   0)) AS v_clicks,
                SUM(IF(media_type='VIDEO',   v100_complete,            0)) AS v_completions,
                SUM(IF(media_type='VIDEO',   effective_cost_with_over, 0)) AS v_cost
            FROM dedup
            GROUP BY short_token
        ),
        -- Cálculos de pacing: usa unified_daily como source-of-truth pra
        -- viewable_impressions e days_with_delivery, igual o legacy fazia
        -- em CTEs separadas. Agora numa única varredura.
        unified AS (
            SELECT
                short_token,
                MIN(IF(media_type='VIDEO', date, NULL))            AS v_actual_start_date,
                COUNT(DISTINCT IF(media_type='VIDEO', date, NULL)) AS v_days_with_delivery,
                SUM(IF(media_type='VIDEO' AND impressions > 0,
                        video_view_100_complete * (viewable_impressions / impressions),
                        0))                                        AS v_viewable_completions,
                SUM(IF(media_type='VIDEO', viewable_impressions, 0)) AS v_viewable_impressions,
                COUNT(DISTINCT IF(media_type='DISPLAY', date, NULL)) AS d_days_with_delivery,
                SUM(IF(media_type='DISPLAY', viewable_impressions, 0)) AS d_viewable_impressions,
                -- ADMIN-ONLY: custo cru do DSP (sem margem/over) + impressions
                -- gross. Usados pra calcular eCPM real (= cost/impressions*1000)
                -- na view "Por cliente". NÃO BUBBLE para client-facing endpoints.
                -- Mesma varredura — custo BQ zero adicional.
                SUM(total_cost)  AS admin_total_cost,
                SUM(impressions) AS admin_impressions,
                -- Splits por mídia pra calcular display_ecpm/video_ecpm
                -- separadamente. Usados pelo Top Performers que avalia score
                -- por formato (Display e Video têm benchmarks diferentes).
                SUM(IF(media_type='DISPLAY', total_cost,  0)) AS d_admin_total_cost,
                SUM(IF(media_type='DISPLAY', impressions, 0)) AS d_admin_impressions,
                SUM(IF(media_type='VIDEO',   total_cost,  0)) AS v_admin_total_cost,
                SUM(IF(media_type='VIDEO',   impressions, 0)) AS v_admin_impressions
            FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
            WHERE media_type IN ('DISPLAY', 'VIDEO')
              AND UPPER(line_name) NOT LIKE '%SURVEY%'
            GROUP BY short_token
        ),
        -- Brand Safety pre-bid (ABS) detection por mídia, cobrindo DV360, Xandr
        -- e override manual. Critério "qualquer linha" — uma campanha pode
        -- misturar linhas com e sem ABS, e cada mídia (Display/Video) é
        -- avaliada independente.
        --
        -- DV360: `doubleverify_pre_bid_fee_advertiser_currency` > 0 quando a
        --   line item passou por filtro pre-bid da DV (Authentic Brand
        --   Suitability é a feature pre-bid).
        -- Xandr: `xandr_daily_costs.data_provider_name` IN (DV, IAS) quando
        --   o trafficking contratou um vendor de pre-bid pra aquela line.
        --   Cobre só ~11% das LIs Xandr (xandr_daily_costs é tabela parcial
        --   de fees externos — Xandr Curate em open exchange / RON não
        --   aparece). O override manual cobre o restante.
        -- Override manual (campaign_abs_overrides): admin marca via UI no
        --   CampaignDrawer quando sabe que a campanha tem ABS mas o sinal
        --   automático não detectou. Granularidade por short_token (cobre
        --   Display + Video da campanha inteira). Editado pelo endpoint
        --   `?action=save_abs_override`.
        --
        -- Mapping line_item_id → short_token vem de unified_daily_performance_metrics
        -- (que tem ambos nativamente, pra DV360 e Xandr).
        abs_signals AS (
            SELECT m.short_token, d.media_type
            FROM `site-hypr.prod_assets.dv360_daily_costs` d
            JOIN (
                SELECT DISTINCT short_token, line_item_id
                FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
                WHERE line_item_id IS NOT NULL
            ) m USING (line_item_id)
            WHERE d.doubleverify_pre_bid_fee_advertiser_currency > 0
            GROUP BY m.short_token, d.media_type

            UNION ALL

            -- xandr_daily_costs.line_item_id é STRING; xandr_daily_performance_metrics
            -- é FLOAT64. CAST AS STRING pra normalizar o JOIN.
            SELECT m.short_token, p.media_type
            FROM `site-hypr.prod_assets.xandr_daily_costs` c
            JOIN `site-hypr.prod_assets.xandr_daily_performance_metrics` p
              ON CAST(c.line_item_id AS STRING) = CAST(p.line_item_id AS STRING)
            JOIN (
                SELECT DISTINCT short_token, line_item_id
                FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
                WHERE source = 'XANDR' AND line_item_id IS NOT NULL
            ) m ON CAST(c.line_item_id AS STRING) = m.line_item_id
            WHERE c.data_provider_name IN ('DOUBLEVERIFY', 'INTEGRAL AD SCIENCE - WEB')
            GROUP BY m.short_token, p.media_type

            UNION ALL

            -- Override manual: gera 1 row pra DISPLAY e 1 pra VIDEO quando o
            -- admin marcou has_abs=TRUE, garantindo que ambas as flags por
            -- mídia (display_has_abs / video_has_abs) virem TRUE depois do
            -- agregado em campaign_abs.
            SELECT short_token, m AS media_type
            FROM `site-hypr.prod_assets.campaign_abs_overrides`,
                 UNNEST(['DISPLAY', 'VIDEO']) AS m
            WHERE has_abs = TRUE
        ),
        campaign_abs AS (
            SELECT
                short_token,
                MAX(IF(media_type = 'DISPLAY', TRUE, FALSE)) AS display_has_abs,
                MAX(IF(media_type = 'VIDEO',   TRUE, FALSE)) AS video_has_abs
            FROM abs_signals
            GROUP BY short_token
        )
        SELECT
            b.short_token, b.client_name, b.campaign_name,
            b.start_date, b.end_date, b.updated_at,
            a.d_vi, a.d_clicks, a.d_cost,
            a.v_vi, a.v_clicks, a.v_completions, a.v_cost,
            c.cpm_amount, c.cpcv_amount,
            c.contracted_o2o_display, c.contracted_ooh_display,
            c.contracted_o2o_video,   c.contracted_ooh_video,
            c.bonus_o2o_display,      c.bonus_ooh_display,
            c.bonus_o2o_video,        c.bonus_ooh_video,
            u.v_actual_start_date,    u.v_days_with_delivery,  u.v_viewable_completions,
            u.v_viewable_impressions,
            u.d_days_with_delivery,   u.d_viewable_impressions,
            u.admin_total_cost,       u.admin_impressions,
            u.d_admin_total_cost,     u.d_admin_impressions,
            u.v_admin_total_cost,     u.v_admin_impressions,
            ab.display_has_abs,       ab.video_has_abs
        FROM base b
        LEFT JOIN agg          a USING (short_token)
        LEFT JOIN checklist    c USING (short_token)
        LEFT JOIN unified      u USING (short_token)
        LEFT JOIN campaign_abs ab USING (short_token)
        ORDER BY b.start_date DESC
    """

    # ── Paralelização dos enrichments ─────────────────────────────────────────
    # Owners (Sheets + BQ overrides) e share_ids (BQ) não dependem do resultado
    # da query principal — Sheets é tabela inteira, overrides é tabela inteira,
    # shares pequena o suficiente pra ler tudo. Disparamos os 3 em paralelo
    # com a query SQL e fazemos o merge em Python.
    #
    # Antes: query (≈4-6s) → owners (≈0.5-2s) → shares (≈1-2s) = 6-10s serial
    # Depois: max(query, owners, shares) ≈ query ≈ 4-6s
    fut_query    = _query_pool.submit(lambda: list(bq.query(sql).result()))
    fut_owners   = _query_pool.submit(_safe_get_owners_lookup)
    fut_overrides= _query_pool.submit(_safe_get_overrides)
    fut_aliases  = _query_pool.submit(_safe_get_aliases)
    fut_shares   = _query_pool.submit(_safe_get_all_share_ids)
    fut_merges   = _query_pool.submit(_safe_get_merges)

    rows           = fut_query.result()
    lookup_owners  = fut_owners.result()
    overrides_map  = fut_overrides.result()
    aliases_map    = fut_aliases.result()
    share_ids_map  = fut_shares.result()
    merges_map     = fut_merges.result()

    result = []
    for r in rows:
        start_date = r["start_date"]
        end_date   = r["end_date"]

        d_vi   = float(r["d_vi"]          or 0)
        d_cost = float(r["d_cost"]        or 0)
        v_vi              = float(r["v_vi"]                  or 0)
        v_comp            = float(r["v_completions"]          or 0)
        v_cost            = float(r["v_cost"]                 or 0)
        v_days_delivery   = int(r["v_days_with_delivery"]     or 0)
        v_viewable_comp   = float(r["v_viewable_completions"] or 0)
        v_viewable_impr   = float(r["v_viewable_impressions"] or 0)
        v_actual_start    = r["v_actual_start_date"]
        if v_actual_start and hasattr(v_actual_start, "date"):
            v_actual_start = v_actual_start.date()
        d_days_delivery   = int(r["d_days_with_delivery"]     or 0)
        d_viewable_impr   = float(r["d_viewable_impressions"] or 0)

        cpm_amount  = float(r["cpm_amount"]  or 0)
        cpcv_amount = float(r["cpcv_amount"] or 0)

        d_neg = (
            float(r["contracted_o2o_display"] or 0) +
            float(r["contracted_ooh_display"] or 0) +
            float(r["bonus_o2o_display"]      or 0) +
            float(r["bonus_ooh_display"]      or 0)
        )
        v_neg = (
            float(r["contracted_o2o_video"] or 0) +
            float(r["contracted_ooh_video"] or 0) +
            float(r["bonus_o2o_video"]      or 0) +
            float(r["bonus_ooh_video"]      or 0)
        )

        # Pacing canônico HYPR: "baseado na média diária de entrega,
        # qual % do contrato a campanha vai entregar até o final".
        # Equivale a: delivered / (negotiated × elapsed_calendar / total_days)
        #
        # Espelhado no front em `shared/aggregations.js#computeMediaPacing`.
        # List view e report mostram exatamente o mesmo número.
        #
        # ANTES: usávamos `days_with_delivery` no denominador, o que
        # inflava artificialmente o pacing de campanhas que entregaram
        # tudo concentradamente em poucos dias (ex.: Diageo entregou
        # tudo em 1 dia de 9 → expected minúsculo → pacing 230%).
        #
        # NÃO alinhei aqui o per-row pacing (campo `pacing` em totals),
        # que é consumido pelo Resumo por mídia + Detalhamento e ainda
        # usa days_with_delivery. Próximo PR.
        # Retorna o "esperado até hoje" segundo o pacing canônico calendar-based.
        # delivered/expected × 100 dá a % de pacing — exposta como métrica
        # calculada no payload. expected também vai cru pro front pra permitir
        # agregação correta (Σdelivered / Σexpected) por owner/cliente em vez
        # de média de razões (que distorce por amostra pequena).
        def pacing_expected_to_date(negotiated, sd, ed):
            if negotiated <= 0 or not sd or not ed:
                return None
            s = sd.date() if hasattr(sd, "date") else sd
            e = ed.date() if hasattr(ed, "date") else ed
            today = date.today()
            total_days = (e - s).days + 1
            if total_days <= 0:
                return None
            elapsed_days = min(max(0, (today - s).days), total_days)
            if elapsed_days <= 0:
                return None
            return negotiated / total_days * elapsed_days

        d_clicks = float(r["d_clicks"] or 0)
        v_clicks = float(r["v_clicks"] or 0)
        d_expected = pacing_expected_to_date(d_neg, start_date, end_date)
        v_expected = pacing_expected_to_date(v_neg, start_date, end_date)

        display_pacing = round(d_viewable_impr / d_expected     * 100, 1) if d_expected and d_expected > 0 else None
        video_pacing   = round(v_viewable_comp  / v_expected    * 100, 1) if v_expected and v_expected > 0 else None
        display_ctr    = round(d_clicks         / d_vi          * 100, 2) if d_vi             > 0       else None
        # video_ctr: cliques de vídeo são raros (geralmente skip-button ou
        # clickthrough do creative). Quando existem, o threshold do score
        # é mais brando que Display (>0,3% vs >0,6%) — formatos diferentes.
        video_ctr      = round(v_clicks         / v_vi          * 100, 2) if v_vi             > 0       else None
        # VTR: viewable_completions / viewable_impressions (mesma fonte —
        # CTE `unified`). ANTES o denominador era v_vi (total impressions
        # vindo da CTE `agg`/dedup), o que descasava com o numerador e dava
        # VTR > 100% pra campanhas com alta diferença entre as duas fontes.
        video_vtr      = round(v_viewable_comp  / v_viewable_impr * 100, 2) if v_viewable_impr > 0       else None

        entry = {
            "short_token":   r["short_token"],
            "client_name":   r["client_name"],
            "campaign_name": r["campaign_name"],
            "start_date":    str(start_date),
            "end_date":      str(end_date),
            "updated_at":    str(r["updated_at"]),
        }
        if display_pacing is not None: entry["display_pacing"] = display_pacing
        if video_pacing   is not None: entry["video_pacing"]   = video_pacing
        if display_ctr    is not None: entry["display_ctr"]    = display_ctr
        if video_ctr      is not None: entry["video_ctr"]      = video_ctr
        if video_vtr      is not None: entry["video_vtr"]      = video_vtr

        # Campos brutos pra agregação correta no frontend. CTR/VTR/Pacing
        # são razões — agregar via "média de razões por campanha" infla VTR
        # > 100% e distorce KPIs com campanhas pequenas. Frontend deve
        # sempre fazer Σ numerador / Σ denominador. Esses campos são
        # admin-gated junto com o resto do payload.
        if d_vi              > 0: entry["display_impressions"]            = int(d_vi)
        if d_clicks          > 0: entry["display_clicks"]                 = int(d_clicks)
        if d_viewable_impr   > 0: entry["display_viewable_impressions"]   = int(d_viewable_impr)
        if d_expected and d_expected > 0: entry["display_expected_impressions"] = int(d_expected)
        # Pra VTR usamos viewable/viewable (não total). v_viewable_impr é o
        # denominador correto vindo da mesma fonte do numerador (v_viewable_comp).
        if v_vi              > 0: entry["video_impressions"]               = int(v_vi)
        if v_clicks          > 0: entry["video_clicks"]                    = int(v_clicks)
        if v_viewable_impr   > 0: entry["video_viewable_impressions"]     = int(v_viewable_impr)
        if v_viewable_comp   > 0: entry["video_viewable_completions"]     = int(v_viewable_comp)
        if v_expected and v_expected > 0: entry["video_expected_completions"]  = int(v_expected)

        # ADMIN-ONLY: campos com prefixo `admin_` carregam dado confidencial
        # (custo cru do DSP, antes da margem/over que vai pro cliente).
        # Estes campos circulam APENAS pelos endpoints admin-gated:
        #   /api/admin/campaigns?list=true        (CampaignMenuV2)
        #   /api/admin/campaigns?action=list_clients (ClientCard)
        # Nunca devem aparecer em endpoints client-facing como get_campaign_data.
        # O prefixo deixa explícito no payload — qualquer dev fazendo grep
        # por "admin_" deve checar autorização antes de retornar.
        admin_total_cost   = float(r["admin_total_cost"]   or 0)
        admin_impressions  = int(r["admin_impressions"]    or 0)
        if admin_impressions > 0 and admin_total_cost > 0:
            entry["admin_total_cost"] = round(admin_total_cost, 2)
            entry["admin_impressions"] = admin_impressions
            entry["admin_ecpm"] = round(admin_total_cost / admin_impressions * 1000, 2)

        # eCPM por mídia (admin-only, mesmo conceito do admin_ecpm — custo cru
        # do DSP / impressions gross). Usado pelo Top Performers que avalia
        # com thresholds diferentes por formato (Display < R$ 0,70; Video < R$ 2,00).
        d_admin_cost = float(r["d_admin_total_cost"] or 0)
        d_admin_impr = int(r["d_admin_impressions"] or 0)
        v_admin_cost = float(r["v_admin_total_cost"] or 0)
        v_admin_impr = int(r["v_admin_impressions"] or 0)
        if d_admin_impr > 0 and d_admin_cost > 0:
            entry["display_ecpm"] = round(d_admin_cost / d_admin_impr * 1000, 2)
        if v_admin_impr > 0 and v_admin_cost > 0:
            entry["video_ecpm"] = round(v_admin_cost / v_admin_impr * 1000, 2)

        # Brand Safety pre-bid (ABS) por mídia, agregando DV360 + Xandr. Quando
        # a flag é TRUE, scoreCampaignDetailed no frontend usa thresholds mais
        # permissivos pra eCPM e CTR daquela mídia (inventário com pre-bid é
        # estruturalmente mais caro). Só emite no payload se TRUE — economiza
        # bytes e deixa o frontend usar `if (c.display_has_abs)` direto.
        if r["display_has_abs"]:
            entry["display_has_abs"] = True
        if r["video_has_abs"]:
            entry["video_has_abs"] = True

        result.append(entry)

    # Merge owners (lookup planilha + overrides BQ + aliases BQ) em Python.
    # Pipeline: override por short_token vence; senão normaliza client_name,
    # resolve alias se houver, busca no lookup. Sem match → None (UI mostra "—").
    for c in result:
        token = c.get("short_token")
        ov_cp, ov_cs = overrides_map.get(token, (None, None))
        lk_cp, lk_cs = owners.resolve_owner_for_client(
            c.get("client_name"), lookup_owners, aliases_map
        )
        c["cp_email"] = ov_cp or lk_cp
        c["cs_email"] = ov_cs or lk_cs

    # Merge share_ids
    for c in result:
        sid = share_ids_map.get(c["short_token"])
        if sid:
            c["share_id"] = sid

    # Merge groups (Merge Reports). Token sem grupo fica sem campos extra —
    # frontend faz `if (campaign.merge_id)` pra renderizar badge "merged".
    for c in result:
        info = merges_map.get(c["short_token"])
        if info:
            c["merge_id"]   = info["merge_id"]
            c["rmnd_mode"]  = info["rmnd_mode"]
            c["pdooh_mode"] = info["pdooh_mode"]

    return result


def _safe_get_owners_lookup():
    """Wrapper resiliente pro lookup de owners via Sheets.

    Falha graciosamente: erro na Sheets API (auth, rate limit, planilha
    inacessível) não derruba a listagem inteira — só perde a auto-atribuição
    de owners. Frontend já trata cp_email/cs_email = None.
    """
    try:
        return owners.get_owners_lookup_dict()
    except Exception as e:
        logger.warning(f"[WARN _safe_get_owners_lookup] {e}")
        return {}


def _safe_get_overrides():
    """Wrapper resiliente + cacheado pro lookup de overrides BQ.

    A função em owners.py NÃO tem cache próprio — era consultada a cada
    cache miss da lista, custando 1-2s por chamada. Adicionamos cache
    aqui (TTL = TTL da lista, já que ambos estão acoplados ao admin menu).
    """
    cached = _cache_get(_overrides_cache, "all", _LIST_CACHE_TTL)
    if cached is not None:
        return cached
    try:
        data = owners.get_overrides_dict()
    except Exception as e:
        logger.warning(f"[WARN _safe_get_overrides] {e}")
        data = {}
    _cache_set(_overrides_cache, "all", data)
    return data


def _safe_get_aliases():
    """Wrapper resiliente + cacheado pro dict de aliases de cliente.

    Mesmo padrão de `_safe_get_overrides`: BQ scan rápido (tabela com
    poucos rows), cache atrelado ao TTL da lista. Falha em dict vazio —
    o pipeline de match degrada graciosamente pra normalização pura.
    """
    cached = _cache_get(_aliases_cache, "all", _LIST_CACHE_TTL)
    if cached is not None:
        return cached
    try:
        data = owners.get_aliases_dict()
    except Exception as e:
        logger.warning(f"[WARN _safe_get_aliases] {e}")
        data = {}
    _cache_set(_aliases_cache, "all", data)
    return data


def _safe_get_all_share_ids():
    """Wrapper resiliente + cacheado pra todos os share_ids.

    A tabela campaign_share_ids é pequena (~300 rows). Ler tudo de uma vez
    e cachear vale mais que filtrar por tokens da request, especialmente
    porque agora rodamos em paralelo com a query principal (não temos a
    lista de tokens ainda).
    """
    cached = _cache_get(_shares_cache, "all", _LIST_CACHE_TTL)
    if cached is not None:
        return cached
    try:
        data = shares.get_all_share_ids()
    except Exception as e:
        logger.warning(f"[WARN _safe_get_all_share_ids] {e}")
        data = {}
    _cache_set(_shares_cache, "all", data)
    return data


def _safe_get_merges():
    """Wrapper resiliente + cacheado pro lookup de grupos de merge.

    Tabela `campaign_merge_groups` é pequena (poucos grupos × poucos tokens).
    Mesmo padrão de overrides/shares: full scan + cache atrelado ao TTL da
    lista. Falha em dict vazio — campanhas continuam aparecendo, só não
    enriquecidas com merge_id.
    """
    cached = _cache_get(_merges_cache, "all", _LIST_CACHE_TTL)
    if cached is not None:
        return cached
    try:
        data = merges.get_all_merge_groups_lookup()
    except Exception as e:
        logger.warning(f"[WARN _safe_get_merges] {e}")
        data = {}
    _cache_set(_merges_cache, "all", data)
    return data


def query_upload(short_token, upload_type):
    from google.cloud import bigquery as bq2
    table_name = "rmnd_data" if upload_type == "RMND" else "pdooh_data"
    sql = f"SELECT data_json FROM `site-hypr.dev_assets.{table_name}` WHERE short_token = @token LIMIT 1"
    client = bq2.Client()
    jc = bq2.QueryJobConfig(query_parameters=[bq2.ScalarQueryParameter("token","STRING",short_token)])
    try:
        rows = list(client.query(sql, job_config=jc).result())
        if rows: return rows[0]["data_json"]
    except Exception as e:
        logger.warning(f"[WARN query_upload {upload_type}] {e}")
    return None

def save_upload(short_token, upload_type, data_json):
    from google.cloud import bigquery as bq2
    table_name = "rmnd_data" if upload_type == "RMND" else "pdooh_data"
    sql = f"""
        MERGE `site-hypr.dev_assets.{table_name}` T
        USING (SELECT @short_token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
            UPDATE SET data_json = @data_json, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN
            INSERT (short_token, data_json, updated_at)
            VALUES (@short_token, @data_json, CURRENT_TIMESTAMP())
    """
    client = bq2.Client()
    jc = bq2.QueryJobConfig(query_parameters=[
        bq2.ScalarQueryParameter("short_token", "STRING", short_token),
        bq2.ScalarQueryParameter("data_json",   "STRING", data_json),
    ])
    client.query(sql, job_config=jc).result()


# ─────────────────────────────────────────────────────────────────────────────
# Typeform helpers
# ─────────────────────────────────────────────────────────────────────────────
# Match para URLs públicas do Typeform — cobre subdomínios de workspace
# (ex: hypr-mobi.typeform.com/to/ABC123) e o formato canônico (form.typeform.com).
# O ID em si é alfanumérico, normalmente 6-12 chars, mas o Typeform não promete
# tamanho fixo, então aceitamos qualquer alfanumérico depois de "/to/".
_TYPEFORM_URL_RE = re.compile(r"typeform\.com/to/([A-Za-z0-9]+)", re.IGNORECASE)
_TYPEFORM_BARE_ID_RE = re.compile(r"^[A-Za-z0-9]{4,32}$")


def _extract_typeform_form_id(value: str) -> str:
    """Aceita URL pública do Typeform OU form_id puro e devolve o form_id.

    Vazio se o input não for nada reconhecível como Typeform — chamador
    deve tratar como erro de validação.
    """
    if not value:
        return ""
    s = value.strip()
    m = _TYPEFORM_URL_RE.search(s)
    if m:
        return m.group(1)
    if _TYPEFORM_BARE_ID_RE.match(s):
        return s
    return ""


# ─────────────────────────────────────────────────────────────────────────────
# Processamento de respostas Typeform — detecta tipo (choice / matrix)
# ─────────────────────────────────────────────────────────────────────────────
def _fetch_typeform_form_def(form_id, token):
    """Busca definição do form e devolve mapping field_id → row_label
    para fields que são children de um matrix.

    No Typeform, uma pergunta matrix vem assim na definição:
      { type: "matrix", properties: { fields: [
          {id: "abc", type: "multiple_choice", title: "Heineken"},
          {id: "def", type: "multiple_choice", title: "Corona"},
          ...
      ]}}

    E nas respostas, cada child vira uma answer separada do tipo "choice"
    referenciando apenas field.id — sem indicação de que é matrix. Esse
    mapping é a única forma de reconstruir qual answer é qual marca.
    """
    url = f"https://api.typeform.com/forms/{urllib.parse.quote(form_id)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())

    field_to_row = {}

    def walk(fields):
        for f in fields:
            ftype = f.get("type")
            children = (f.get("properties") or {}).get("fields") or []
            if ftype == "matrix":
                for child in children:
                    cid = child.get("id")
                    label = child.get("title")
                    if cid and label:
                        field_to_row[cid] = label
            else:
                # Recursão pra outros tipos com children (groups, statements)
                if children:
                    walk(children)

    walk(data.get("fields") or [])
    return field_to_row


# ─────────────────────────────────────────────────────────────────────────────
# Typeform — listagem de forms do workspace "Surveys"
#
# A API do Typeform expõe `GET /forms?workspace_id=...` paginado. Não há
# filtro server-side por data, então fazemos client-side por last_updated_at.
#
# Resolução do workspace alvo:
#   1. Se TYPEFORM_SURVEYS_WORKSPACE_ID estiver setado, usa direto.
#   2. Senão, lista todos workspaces e procura um chamado "Survey" / "Surveys"
#      (case-insensitive). Cobre 95% dos casos sem precisar de config extra.
#   3. Senão, devolve forms de todos os workspaces (degradação graceful — admin
#      pode buscar pelo título via input do modal).
# ─────────────────────────────────────────────────────────────────────────────
_TYPEFORM_LIST_TTL = 300  # 5 min — listagem muda pouco no horizonte de uma sessão
_TYPEFORM_META_TTL = 600  # 10 min — definição de form muda menos ainda
_typeform_meta_cache = {}  # form_id -> (timestamp, payload)


def _fetch_typeform_form_meta(form_id, token):
    """Busca a definição do form + 1 página de respostas e devolve as
    rows reais que o report vai renderizar.

    {
      "form_id": "abc123",
      "type": "matrix" | "choice" | "other",
      "rows": ["Heineken", "Corona", ...]
    }

    Estratégia: extrai labels dos COUNTS reais das respostas (mesma lógica
    do typeform_proxy). Esses labels são exatamente o que o frontend
    renderiza, então qualquer focusRow escolhido aqui vai bater 100%.
    Fallback pra definição do form quando ainda não há respostas.
    """
    # 1. Definição do form — pra classificar o tipo e ter o field_to_row
    #    do matrix (necessário pro processamento de respostas)
    url_def = f"https://api.typeform.com/forms/{urllib.parse.quote(form_id)}"
    req = urllib.request.Request(url_def, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        form_data = json.loads(resp.read().decode())

    # Classificação do tipo (só pra metadata; rows não dependem disso)
    has_matrix = False
    has_choice = False
    field_to_row = {}

    def classify(fields):
        nonlocal has_matrix, has_choice
        for f in fields:
            ftype = f.get("type")
            properties = f.get("properties") or {}
            children = properties.get("fields") or []
            if ftype == "matrix":
                has_matrix = True
                for child in children:
                    cid = child.get("id")
                    label = child.get("title")
                    if cid and label:
                        field_to_row[cid] = label
            elif ftype in (
                "multiple_choice", "picture_choice", "dropdown",
                "yes_no", "rating", "opinion_scale", "nps", "legal"
            ):
                has_choice = True
            if children and ftype != "matrix":
                classify(children)

    classify(form_data.get("fields") or [])

    if has_matrix:
        kind = "matrix"
    elif has_choice:
        kind = "choice"
    else:
        kind = "other"

    # 2. 1 página de respostas — extrai os labels REAIS via mesma lógica
    #    do typeform_proxy. É O QUE O REPORT VAI RENDERIZAR.
    rows = []
    seen = set()
    try:
        url_resp = (
            f"https://api.typeform.com/forms/{urllib.parse.quote(form_id)}"
            f"/responses?page_size=200&completed=true"
        )
        req = urllib.request.Request(url_resp, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp_data = json.loads(resp.read().decode())
        items = resp_data.get("items", [])
        flat_counts, matrix_rows, _, _ = _process_typeform_items(items, field_to_row)
        # Matrix rows primeiro (mais comum em Adrecall), depois flat counts
        for label in matrix_rows.keys():
            s = str(label).strip()
            if s and s not in seen:
                seen.add(s); rows.append(s)
        for label in flat_counts.keys():
            s = str(label).strip()
            if s and s not in seen:
                seen.add(s); rows.append(s)
    except Exception as e:
        logger.warning(f"[WARN form_meta responses for {form_id}] {e}")

    # 3. Fallback: se a chamada de respostas falhou OU o form ainda não tem
    #    respostas, tenta extrair labels da própria definição (choices/yes_no
    #    /matrix children/scale steps).
    if not rows:
        def add_row(label):
            s = str(label).strip() if label is not None else ""
            if s and s not in seen:
                seen.add(s); rows.append(s)

        def walk_def(fields):
            for f in fields:
                ftype = f.get("type")
                properties = f.get("properties") or {}
                children = properties.get("fields") or []
                choices = properties.get("choices") or []

                if ftype == "matrix":
                    for child in children:
                        add_row(child.get("title"))
                elif ftype in ("multiple_choice", "picture_choice", "dropdown"):
                    for c in choices:
                        add_row(c.get("label"))
                elif ftype == "yes_no":
                    add_row("Sim"); add_row("Não")
                elif ftype == "legal":
                    add_row("Sim"); add_row("Não")
                elif ftype in ("rating", "opinion_scale"):
                    steps = int(properties.get("steps") or 5)
                    start = 1 if properties.get("start_at_one") else 0
                    for i in range(start, start + steps):
                        add_row(str(i))
                elif ftype == "nps":
                    for i in range(0, 11):
                        add_row(str(i))

                if children and ftype != "matrix":
                    walk_def(children)

        walk_def(form_data.get("fields") or [])

    return {"form_id": form_id, "type": kind, "rows": rows}



def _fetch_typeform_workspaces(token):
    """Lista todos os workspaces da conta. Pagina internamente."""
    out = []
    page = 1
    while True:
        url = f"https://api.typeform.com/workspaces?page={page}&page_size=200"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        items = data.get("items", [])
        out.extend(items)
        if len(items) < 200 or page >= int(data.get("page_count", 1)):
            break
        page += 1
    return out


def _resolve_survey_workspace_id(token):
    """Devolve workspace_id alvo, ou string vazia se não conseguir resolver."""
    explicit = os.environ.get("TYPEFORM_SURVEYS_WORKSPACE_ID", "").strip()
    if explicit:
        return explicit
    try:
        for ws in _fetch_typeform_workspaces(token):
            name = (ws.get("name") or "").strip().lower()
            if name in ("survey", "surveys", "pasta survey"):
                return ws.get("id", "")
    except Exception as e:
        logger.warning(f"[WARN _resolve_survey_workspace_id] {e}")
    return ""


def _parse_typeform_ts(raw):
    """Parse ISO 8601 com 'Z' (Typeform retorna assim). Devolve datetime
    naive em UTC, ou None se não der parse. Python 3.11+ aceita Z, mas
    normalizamos pra +00:00 por segurança."""
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        return None


def _fetch_typeform_forms_page(token, workspace_id, page, page_size=200):
    """Busca uma página única do endpoint /forms. Devolve o JSON decodificado."""
    params = f"page={page}&page_size={page_size}"
    if workspace_id:
        params += f"&workspace_id={urllib.parse.quote(workspace_id)}"
    url = f"https://api.typeform.com/forms?{params}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def _fetch_typeform_forms(token, workspace_id="", days=0, hard_cap=5000):
    """Lista forms do workspace inteiro, ordenados por last_updated_at desc.

    `days=0` (default) devolve TUDO — admin tem 1900+ forms históricos e
    quer poder buscar qualquer um pelo nome. `days>0` filtra por janela
    móvel (caso queiramos reativar a poda no futuro sem mexer no caller).

    Estratégia de fetch
    -------------------
    A API do Typeform `/forms` é paginada (page_size=200) e NÃO garante
    ordenação. Workspaces grandes (10+ páginas) seriam 10s+ sequenciais.

    1. Página 1 sequencial (precisamos do page_count).
    2. Páginas 2..N em paralelo (ThreadPoolExecutor, 8 workers).
    3. Sort client-side por last_updated_at desc.

    Cache de 5min absorve o custo: 1 fetch completo a cada 5 min de uso.
    """
    cutoff = datetime.utcnow() - timedelta(days=days) if days and days > 0 else None

    first = _fetch_typeform_forms_page(token, workspace_id, page=1)
    items_all = list(first.get("items") or [])
    page_count = int(first.get("page_count", 1) or 1)

    if page_count > 1:
        with ThreadPoolExecutor(max_workers=8) as ex:
            futures = [
                ex.submit(_fetch_typeform_forms_page, token, workspace_id, p)
                for p in range(2, page_count + 1)
            ]
            for fut in futures:
                try:
                    data = fut.result()
                    items_all.extend(data.get("items") or [])
                except Exception as e:
                    # Página individual falhou — loga e segue. Melhor lista
                    # parcial do que erro pro admin.
                    logger.warning(f"[WARN typeform_forms_page] {e}")

    out = []  # [(ts, payload)]
    for f in items_all:
        if not f.get("id"):
            continue
        ts = _parse_typeform_ts(f.get("last_updated_at") or f.get("created_at"))
        if cutoff and (not ts or ts < cutoff):
            continue
        out.append((ts or datetime.min, {
            "id": f.get("id"),
            "title": f.get("title") or "(sem título)",
            "last_updated_at": f.get("last_updated_at") or f.get("created_at"),
            "display_url": (f.get("_links") or {}).get("display") or "",
        }))
        if len(out) >= hard_cap:
            break

    out.sort(key=lambda x: x[0], reverse=True)
    return [x[1] for x in out]


def _process_typeform_items(items, field_to_row=None):
    """Agrega respostas de uma página de items do Typeform num formato unificado.

    field_to_row é o mapping {field_id: row_label} para fields que pertencem
    a uma pergunta matrix (vide _fetch_typeform_form_def). Se vazio, todas
    as respostas são tratadas como choice/choices simples.

    Devolve quatro valores: (flat_counts, matrix_rows, has_matrix, has_flat)
    O caller usa has_matrix pra decidir o formato final de output.
    """
    field_to_row = field_to_row or {}
    flat_counts = Counter()
    matrix_rows = {}  # row_label → Counter[col_label]
    has_matrix = False
    has_flat = False

    for item in items:
        for ans in item.get("answers", []) or []:
            atype = ans.get("type")
            field_id = (ans.get("field") or {}).get("id", "")

            # Caso 1: answer é child de um matrix (mapping bate)
            if field_id and field_id in field_to_row:
                row_label = field_to_row[field_id]
                if atype == "choice":
                    label = (ans.get("choice") or {}).get("label")
                    if label:
                        if row_label not in matrix_rows:
                            matrix_rows[row_label] = Counter()
                        matrix_rows[row_label][label] += 1
                        has_matrix = True
                elif atype == "choices":
                    # Matrix com múltipla seleção por linha
                    for label in ((ans.get("choices") or {}).get("labels") or []):
                        if label:
                            if row_label not in matrix_rows:
                                matrix_rows[row_label] = Counter()
                            matrix_rows[row_label][label] += 1
                            has_matrix = True
                continue

            # Caso 2: payload de matrix nativo (formato alternativo, fallback
            # defensivo caso o Typeform mude a API um dia)
            if atype == "matrix" or ans.get("matrix"):
                has_matrix = True
                matrix = ans.get("matrix") or {}
                for row in (matrix.get("rows") or []):
                    row_label = ((row.get("row") or {}).get("label")
                                 or (row.get("field") or {}).get("title"))
                    choice_label = (row.get("choice") or {}).get("label")
                    if row_label and choice_label:
                        if row_label not in matrix_rows:
                            matrix_rows[row_label] = Counter()
                        matrix_rows[row_label][choice_label] += 1
                    for c_label in ((row.get("choices") or {}).get("labels") or []):
                        if row_label and c_label:
                            if row_label not in matrix_rows:
                                matrix_rows[row_label] = Counter()
                            matrix_rows[row_label][c_label] += 1
                continue

            # Caso 3: choice/choices simples (não-matrix)
            if atype == "choice":
                label = (ans.get("choice") or {}).get("label")
                if label:
                    flat_counts[label] += 1
                    has_flat = True
            elif atype == "choices":
                for label in ((ans.get("choices") or {}).get("labels") or []):
                    if label:
                        flat_counts[label] += 1
                        has_flat = True

    return flat_counts, matrix_rows, has_matrix, has_flat
