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
"""

import functions_framework
from flask import jsonify, request
from google.cloud import bigquery
import os
import re
import json
import time
import threading
import urllib.request
import urllib.parse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime

from auth import (
    authenticate_admin,
    issue_admin_jwt,
    verify_google_id_token,
)
import owners
import shares
import clients

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
_REPORT_CACHE_TTL  = 120
_LIST_CACHE_TTL    = 60
# View "Por cliente" do menu admin — agregação derivada de query_campaigns_list
# + 1 query temporal pra sparklines. TTL maior porque (a) não muda dramatica-
# mente entre minutos, e (b) a sparkline é informação visual, não operacional.
_CLIENTS_CACHE_TTL = 300

_report_cache    = {}     # short_token -> (timestamp, payload)
_list_cache      = {}     # "all" -> (timestamp, payload)
_clients_cache   = {}     # "all" -> (timestamp, payload)
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
    """
    with _cache_lock:
        _report_cache.pop(short_token, None)
        _list_cache.pop("all", None)
        _clients_cache.pop("all", None)


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


@functions_framework.http
def report_data(request):
    origin  = request.headers.get("Origin", "")
    headers = cors_headers(origin, "GET, POST, OPTIONS")

    if request.method == "OPTIONS":
        return ("", 204, headers)

    # ── Endpoint: emitir JWT admin a partir de um Google id_token ─────────────
    # Front envia `Authorization: Bearer <google_id_token>`. Backend valida
    # via tokeninfo do Google (email verified + domínio @hypr.mobi) e devolve
    # um JWT custom assinado, com TTL de 5 min, que será usado em chamadas
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
            return (jsonify({"token": jwt, "email": info["email"], "ttl": 300}), 200, headers)
        except Exception as e:
            print(f"[ERROR issue_admin_token] {e}")
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
            print(f"[ERROR resolve_share] {e}")
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
            print(f"[ERROR get_share_id] {e}")
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
            print(f"[ERROR lookup_share] {e}")
            return (jsonify({"error": "Erro ao buscar share_id"}), 500, headers)

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
            print(f"[ERROR save_logo] {e}")
            return (jsonify({"error": "Erro ao salvar logo"}), 500, headers)

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
            print(f"[ERROR save_loom] {e}")
            return (jsonify({"error": "Erro ao salvar loom"}), 500, headers)

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
            print(f"[ERROR save_survey] {e}")
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

        flat_counts = Counter()
        matrix_rows = {}
        has_matrix = False
        total = 0
        before_token = None
        try:
            # Busca definição do form uma vez pra mapear field_id → row_label
            # quando há perguntas matrix. Sem isso, respostas de matrix vêm
            # como choices independentes sem indicação da marca.
            field_to_row = _fetch_typeform_form_def(form_id, TYPEFORM_TOKEN)

            while True:
                url = f"https://api.typeform.com/forms/{urllib.parse.quote(form_id)}/responses?page_size=1000&completed=true"
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
                }), 200, headers)
            return (jsonify({
                "type": "choice",
                "counts": dict(flat_counts),
                "total": total,
                "form_id": form_id,
            }), 200, headers)
        except urllib.error.HTTPError as e:
            print(f"[ERROR typeform_proxy] HTTP {e.code} for form {form_id}: {e.reason}")
            msg = {
                401: "TYPEFORM_TOKEN inválido ou expirado",
                403: "Sem permissão para acessar este form",
                404: "Form não encontrado no Typeform",
            }.get(e.code, f"Erro Typeform: HTTP {e.code}")
            return (jsonify({"error": msg, "form_id": form_id}), 502, headers)
        except Exception as e:
            print(f"[ERROR typeform_proxy] {e}")
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
            print(f"[ERROR save_comment] {e}")
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
            print(f"[ERROR get_comments] {e}")
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
            print(f"[ERROR save_upload] {e}")
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
            print(f"[ERROR setup_owners_schema] {e}")
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
            print(f"[WARN list_team_members] {e}")
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
            print(f"[ERROR save_report_owner] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

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
            force_refresh = request.args.get("refresh") == "true"
            cached = None if force_refresh else _cache_get(_clients_cache, "all", _CLIENTS_CACHE_TTL)
            if cached is not None:
                return (jsonify({**cached, "_cache": "hit"}), 200, headers)

            # Reusa a lista de campanhas cacheada se houver, senão busca.
            campaigns = None if force_refresh else _cache_get(_list_cache, "all", _LIST_CACHE_TTL)
            if campaigns is None:
                campaigns = query_campaigns_list()
                _cache_set(_list_cache, "all", campaigns)

            agg = clients.aggregate_clients_from_campaigns(campaigns)
            worklist = clients.compute_worklist(campaigns)

            # Sparklines + trend (única query BQ extra do endpoint).
            timeseries = clients.query_client_timeseries(weeks=12)
            for c in agg:
                series = timeseries.get(c["slug"], [])
                if series:
                    c["sparkline"] = series
                    trend = clients.compute_trend(series, half=4)
                    if trend:
                        c["trend"] = trend

            payload = {"clients": agg, "worklist": worklist}
            _cache_set(_clients_cache, "all", payload)
            return (jsonify({**payload, "_cache": "miss"}), 200, headers)
        except Exception as e:
            print(f"[ERROR list_clients] {e}")
            return (jsonify({"error": "Erro ao listar clientes"}), 500, headers)

    if request.args.get("list") == "true":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            force_refresh = request.args.get("refresh") == "true"
            cached = None if force_refresh else _cache_get(_list_cache, "all", _LIST_CACHE_TTL)
            if cached is not None:
                return (jsonify({"campaigns": cached, "_cache": "hit"}), 200, headers)
            campaigns = query_campaigns_list()
            _cache_set(_list_cache, "all", campaigns)
            return (jsonify({"campaigns": campaigns, "_cache": "miss"}), 200, headers)
        except Exception as e:
            print(f"[ERROR] {e}")
            return (jsonify({"error": "Erro ao listar campanhas"}), 500, headers)

    short_token = request.args.get("token")
    if not short_token:
        return (jsonify({"error": "Parâmetro 'token' é obrigatório"}), 400, headers)

    try:
        force_refresh = request.args.get("refresh") == "true"
        if force_refresh:
            _cache_invalidate_token(short_token)
        cached = _cache_get(_report_cache, short_token, _REPORT_CACHE_TTL)
        if cached is not None:
            return (jsonify({**cached, "_cache": "hit"}), 200, headers)
        data = fetch_campaign_data(short_token)
        if not data:
            return (jsonify({"error": "Campanha não encontrada"}), 404, headers)
        _cache_set(_report_cache, short_token, data)
        return (jsonify({**data, "_cache": "miss"}), 200, headers)
    except Exception as e:
        print(f"[ERROR] {e}")
        return (jsonify({"error": "Erro interno ao buscar dados"}), 500, headers)


def fetch_campaign_data(short_token):
    """
    Busca todos os dados de um report.

    Estratégia:
      1) query_campaign_info bloqueante (precisa de start_date/end_date para
         alimentar query_totals).
      2) Se não houver campaign_info, retorna None imediatamente.
      3) Roda as 8 queries restantes em paralelo (ThreadPoolExecutor).
         BigQuery client libera GIL no I/O, então threads escalam bem.

    Antes (serial): ~6-10s típico.
    Depois (paralelo): tempo do pior caso (~1.5-3s, geralmente query_totals).
    """
    campaign_info = query_campaign_info(short_token)
    if not campaign_info:
        return None

    tasks = {
        "totals": _query_pool.submit(query_totals, short_token, campaign_info),
        "daily":  _query_pool.submit(query_daily,  short_token),
        "detail": _query_pool.submit(query_detail, short_token),
        "logo":   _query_pool.submit(query_logo,   short_token),
        "loom":   _query_pool.submit(query_loom,   short_token),
        "rmnd":   _query_pool.submit(query_upload, short_token, "RMND"),
        "pdooh":  _query_pool.submit(query_upload, short_token, "PDOOH"),
        "survey": _query_pool.submit(query_survey, short_token),
    }

    result = {"campaign": campaign_info}
    for key, future in tasks.items():
        try:
            result[key] = future.result()
        except Exception as e:
            # Falha em uma query auxiliar não deve derrubar o report inteiro.
            # Front sabe lidar com chaves nulas (logo, loom, survey, rmnd, pdooh).
            # Para totals/daily/detail logamos e retornamos vazio para que a UI
            # mostre "sem dados" em vez de erro 500.
            print(f"[WARN fetch_campaign_data {key}] {e}")
            result[key] = None if key in ("logo", "loom", "rmnd", "pdooh", "survey") else []
    return result


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
        print(f"[WARN query_logo] {e}")
    return None


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
        print(f"[WARN query_loom] {e}")
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
        print(f"[WARN query_survey] {e}")
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
        print(f"[WARN query_comments] {e}")
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

    # unified_daily_performance_metrics está na região US — passar location explícito
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", token)
    ])

    perf_rows  = list(bq.query(sql_perf,      job_config=job_config, location="US").result())
    check_rows = list(bq.query(sql_checklist, job_config=job_config, location="US").result())

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

        # Entrega esperada para PACING: dias com entrega real
        expected_for_pacing = (neg / row_total_days * days_with_delivery) if (row_total_days > 0 and days_with_delivery > 0) else 0
        # Entrega esperada para OVER/CPM: dias decorridos da campanha geral
        expected_delivered = (neg / total_days * elapsed_days) if (total_days > 0 and elapsed_days > 0) else 0

        # Pacing: entregue vs esperado
        # Video usa completions (viewable views 100%), Display usa viewable_impressions
        delivered_for_pacing = completions if is_video else viewable
        if row_is_ended:
            pacing = (delivered_for_pacing / neg * 100) if neg > 0 else 0.0
        else:
            pacing = (delivered_for_pacing / expected_for_pacing * 100) if expected_for_pacing > 0 else 0.0

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
            "video_view_100":       video_view_100,
            "effective_total_cost": float(r["effective_total_cost"] or 0),
            "ctr": round(ctr, 4),
            "vtr": round(vtr, 4),
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
        -- Dedup por (date, line_name, creative_name) antes de agregar por short_token
        -- effective_total_cost é acumulado no campaign_results; MAX pega o último valor por linha
        display_dedup AS (
            SELECT
                short_token,
                date, line_name, creative_name,
                MAX(viewable_impressions)   AS viewable_impressions,
                MAX(clicks)                 AS clicks,
                MAX(effective_total_cost)   AS effective_total_cost
            FROM {table_ref()}
            WHERE media_type = 'DISPLAY'
              AND UPPER(line_name) NOT LIKE '%SURVEY%'
            GROUP BY short_token, date, line_name, creative_name
        ),
        display AS (
            SELECT
                short_token,
                SUM(viewable_impressions)   AS d_vi,
                SUM(clicks)                 AS d_clicks,
                SUM(effective_total_cost)   AS d_cost
            FROM display_dedup
            GROUP BY short_token
        ),
        video_dedup AS (
            SELECT
                short_token,
                date, line_name, creative_name,
                MAX(viewable_impressions)             AS viewable_impressions,
                MAX(viewable_video_view_100_complete) AS viewable_video_view_100_complete,
                MAX(effective_cost_with_over)         AS effective_cost_with_over
            FROM {table_ref()}
            WHERE media_type = 'VIDEO'
              AND UPPER(line_name) NOT LIKE '%SURVEY%'
            GROUP BY short_token, date, line_name, creative_name
        ),
        video AS (
            SELECT
                short_token,
                SUM(viewable_impressions)             AS v_vi,
                SUM(viewable_video_view_100_complete) AS v_completions,
                SUM(effective_cost_with_over)         AS v_cost
            FROM video_dedup
            GROUP BY short_token
        ),
        -- Viewable completions e days_with_delivery do unified (cálculo correto de pacing vídeo)
        video_unified AS (
            SELECT
                short_token,
                MIN(date)             AS v_actual_start_date,
                COUNT(DISTINCT date)  AS v_days_with_delivery,
                SUM(CASE WHEN impressions > 0
                    THEN video_view_100_complete * (viewable_impressions / impressions)
                    ELSE 0 END)       AS v_viewable_completions
            FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
            WHERE media_type = 'VIDEO'
              AND UPPER(line_name) NOT LIKE '%SURVEY%'
            GROUP BY short_token
        ),
        -- Viewable impressions e days_with_delivery do unified (cálculo correto de pacing display)
        display_unified AS (
            SELECT
                short_token,
                COUNT(DISTINCT date)       AS d_days_with_delivery,
                SUM(viewable_impressions)  AS d_viewable_impressions
            FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
            WHERE media_type = 'DISPLAY'
              AND UPPER(line_name) NOT LIKE '%SURVEY%'
            GROUP BY short_token
        )
        SELECT
            b.short_token, b.client_name, b.campaign_name,
            b.start_date, b.end_date, b.updated_at,
            d.d_vi, d.d_clicks, d.d_cost,
            v.v_vi, v.v_completions, v.v_cost,
            c.cpm_amount, c.cpcv_amount,
            c.contracted_o2o_display, c.contracted_ooh_display,
            c.contracted_o2o_video,   c.contracted_ooh_video,
            c.bonus_o2o_display,      c.bonus_ooh_display,
            c.bonus_o2o_video,        c.bonus_ooh_video,
            vu.v_actual_start_date,   vu.v_days_with_delivery,  vu.v_viewable_completions,
            du.d_days_with_delivery,  du.d_viewable_impressions
        FROM base b
        LEFT JOIN display         d  USING (short_token)
        LEFT JOIN video           v  USING (short_token)
        LEFT JOIN checklist       c  USING (short_token)
        LEFT JOIN video_unified   vu USING (short_token)
        LEFT JOIN display_unified du USING (short_token)
        ORDER BY b.start_date DESC
    """

    job_config = bigquery.QueryJobConfig()
    rows = list(bq.query(sql, job_config=job_config).result())

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

        def pacing_calc(delivered, negotiated, sd, ed):
            if negotiated <= 0 or not sd or not ed:
                return None
            s = sd.date() if hasattr(sd, "date") else sd
            e = ed.date() if hasattr(ed, "date") else ed
            today = date.today()
            if e < today:
                return round(delivered / negotiated * 100, 1)
            total_days   = (e - s).days + 1
            elapsed_days = (today - s).days
            if elapsed_days <= 0 or total_days <= 0:
                return None
            expected = negotiated / total_days * elapsed_days
            return round(delivered / expected * 100, 1) if expected > 0 else None

        # Display pacing: usa viewable_impressions e days_with_delivery do unified
        def display_pacing_calc(viewable, negotiated, days_delivery, sd, ed):
            if negotiated <= 0 or not sd or not ed or days_delivery <= 0:
                return None
            e = ed.date() if hasattr(ed, "date") else ed
            s = sd.date() if hasattr(sd, "date") else sd
            today = date.today()
            total_days = (e - s).days + 1
            if total_days <= 0:
                return None
            if e < today:
                return round(viewable / negotiated * 100, 1)
            expected = negotiated / total_days * days_delivery
            return round(viewable / expected * 100, 1) if expected > 0 else None
        display_pacing = display_pacing_calc(d_viewable_impr, d_neg, d_days_delivery, start_date, end_date)
        # Video pacing: usa viewable completions e days_with_delivery (igual ao query_totals)
        def video_pacing_calc(completions, negotiated, days_delivery, sd, ed):
            if negotiated <= 0 or not sd or not ed or days_delivery <= 0:
                return None
            e = ed.date() if hasattr(ed, "date") else ed
            s = sd.date() if hasattr(sd, "date") else sd
            today = date.today()
            total_days = (e - s).days + 1
            if total_days <= 0:
                return None
            if e < today:
                return round(completions / negotiated * 100, 1)
            expected = negotiated / total_days * days_delivery
            return round(completions / expected * 100, 1) if expected > 0 else None
        video_pacing = video_pacing_calc(v_viewable_comp, v_neg, v_days_delivery, v_actual_start or start_date, end_date)
        display_ctr    = round(float(r["d_clicks"] or 0) / d_vi * 100, 2) if d_vi > 0 else None
        video_vtr      = round(v_viewable_comp / v_vi * 100, 2)            if v_vi > 0 else None

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
        if video_vtr      is not None: entry["video_vtr"]      = video_vtr

        result.append(entry)

    # Enriquece com cp_email/cs_email lendo a planilha (Sheets API com cache)
    # + tabela de overrides. Falha graciosamente: se a planilha não estiver
    # acessível, owners ficam None e o menu continua funcionando normal.
    try:
        owners.resolve_owners_for_campaigns(result)
    except Exception as e:
        print(f"[WARN query_campaigns_list] resolve_owners falhou: {e}")
        for c in result:
            c.setdefault("cp_email", None)
            c.setdefault("cs_email", None)

    # Enriquece com share_id quando existe — uma única query batch contra
    # campaign_share_ids. Evita o round-trip dedicado que o frontend fazia
    # a cada click em "Link Cliente" (cold start + lookup BigQuery = 1-4s).
    # Com share_id no payload, o menu admin tem o link pronto pra copiar
    # desde o primeiro click, em qualquer dispositivo. Tokens sem share_id
    # criado ainda caem no fallback on-demand do frontend.
    try:
        short_tokens_in_result = [c["short_token"] for c in result if c.get("short_token")]
        share_ids_map = shares.get_share_ids_for_tokens(short_tokens_in_result)
        for c in result:
            sid = share_ids_map.get(c["short_token"])
            if sid:
                c["share_id"] = sid
    except Exception as e:
        print(f"[WARN query_campaigns_list] enriquecer share_ids falhou: {e}")
        # Falha graciosa: campanhas ficam sem share_id no payload e o
        # frontend cai no fallback on-demand (comportamento pré-Frente 2).

    return result
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
        print(f"[WARN query_upload {upload_type}] {e}")
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
