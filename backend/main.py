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
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone

from auth import (
    JWT_TTL_SECONDS,
    authenticate_admin,
    issue_admin_jwt,
    verify_google_id_token,
)
import owners
import shares
import clients
import client_portal
import merges
import sheets_integration
import sheets_alerts
import audit_log
import access_tracking
import pmp_deals
import pmp_lines
import pmp_groups
import compplan_sheet
import xandr_curate
import audience_normalize
import audience_ai

logger = logging.getLogger(__name__)

# ── BQ client com timeout obrigatório ────────────────────────────────────────
# Incidente 04/06: um job BQ pendurou sem timeout, travou um worker do
# ThreadPool e — com minScale=1 mantendo a instância quente — envenenou a
# instância inteira: TODA request (até a leve `data_freshness`) passou a dar
# 504 após os 540s de timeout da função. Causa: nenhum dos ~71 `.result()`
# tinha timeout, então um upstream pendurado bloqueava o worker pra sempre.
#
# Em vez de editar 71 call sites, envolvemos o client num proxy que injeta:
#   - job_timeout_ms no QueryJobConfig → BQ cancela o job server-side
#   - timeout no .result()            → o cliente para de esperar e levanta
# Assim um job pendurado falha rápido (vira erro tratável pelo call site /
# handler) em vez de deadlockar a instância indefinidamente.
_BQ_JOB_TIMEOUT_MS   = 120_000   # BQ aborta a query após 120s
_BQ_RESULT_TIMEOUT_S = 130       # cliente desiste de esperar após 130s


class _TimeoutQueryJob:
    """Proxy de QueryJob que aplica um timeout padrão no .result()."""
    __slots__ = ("_job",)

    def __init__(self, job):
        self._job = job

    def result(self, *args, **kwargs):
        kwargs.setdefault("timeout", _BQ_RESULT_TIMEOUT_S)
        return self._job.result(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._job, name)


class _TimeoutBQClient:
    """Proxy de bigquery.Client que força timeout em toda query.

    Só intercepta .query() (único uso de `bq` no report path); todo o
    resto (get_table, insert_rows_json, etc.) passa direto pro client real
    via __getattr__.
    """
    def __init__(self, client):
        self._client = client

    def query(self, sql, *args, **kwargs):
        job_config = kwargs.get("job_config") or bigquery.QueryJobConfig()
        if getattr(job_config, "job_timeout_ms", None) is None:
            job_config.job_timeout_ms = _BQ_JOB_TIMEOUT_MS
        kwargs["job_config"] = job_config
        return _TimeoutQueryJob(self._client.query(sql, *args, **kwargs))

    def __getattr__(self, name):
        return getattr(self._client, name)


bq = _TimeoutBQClient(bigquery.Client())
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
#   - report (token):    3h    — payload pesado; a base consolidada só muda
#                                1x/dia (~06h via pipeline)
#   - campaigns list:    15min — admin abre/fecha o tempo todo
#
# Invalidação manual:
#   - mutações (save_logo, save_loom, save_survey, save_upload,
#     save_report_owner) limpam o cache do token afetado
#   - ?refresh=true força bypass de cache na request atual
# ─────────────────────────────────────────────────────────────────────────────
# Report: era 600s, conservador demais pra um dado que só muda 1x/dia. 3h
# alinha com o cron de warmup (deploy.sh: a cada 3h, 06h30–18h30 BRT), que
# re-aquece as entradas expiradas — na prática o report fica warm o dia
# inteiro. Mutações continuam invalidando por token via
# _cache_invalidate_token, então o teto de 3h só vale pra mudança EXTERNA
# da base (rebuild manual do Dagster fora de hora) — nesse caso,
# ?refresh=true bypassa.
_REPORT_CACHE_TTL  = 3 * 3600
# Lista admin: 60s → 300s → 900s → 3h. A query consolidada (query_campaigns_list,
# 3 full scans de tabelas não particionadas) custa 15-65s fria, e o dado de
# delivery só muda 1x/dia (~06h). Com 900s o cache vencia entre os warmups (3/3h)
# e o time pagava a query fria; a 3h casa com a cadência do warmup e fica warm o
# dia todo. Mutações de admin já invalidam via _cache_invalidate_token, então
# "stale" só ocorre em mudança externa da base (coberta pelo warmup/?refresh).
_LIST_CACHE_TTL    = 3 * 3600
# View "Por cliente" do menu admin — agregação derivada de query_campaigns_list
# + 1 query temporal pra sparklines. Mesmo raciocínio (e TTL) da lista.
_CLIENTS_CACHE_TTL = 3 * 3600

_report_cache    = {}     # short_token -> (timestamp, payload)
_merged_report_cache = {} # merge_id -> (timestamp, payload merged)
_list_cache      = {}     # "all" -> (timestamp, payload)
_clients_cache   = {}     # "all" -> (timestamp, payload)
# Portal do cliente: payload client-safe agregado por share_id. Era 300s (5min)
# e queimava o acesso: a base só muda 1x/dia (~06h) e qualquer mutação admin
# (save_config/set_publish) já faz `_portal_cache.clear()`, então 5min era
# agressivo à toa — rebuildava (lista + shares + elements + logos) toda hora.
# A 3h casa com os demais caches (_REPORT/_LIST/_CLIENTS) e com o warmup, que
# agora pré-aquece os portais ativos (warmup_caches). Mutação continua limpando.
_PORTAL_CACHE_TTL = 3 * 3600
_portal_cache    = {}     # share_id -> (timestamp, payload)
# Caches dos enrichments paralelos de query_campaigns_list. Compartilham TTL
# da lista — invalidados juntos via _cache_invalidate_token quando ocorre
# mutação que afeta o payload do menu.
_overrides_cache = {}     # "all" -> (timestamp, dict[short_token -> (cp, cs)])
_aliases_cache   = {}     # "all" -> (timestamp, dict[alias_normalized -> canonical_normalized])
_shares_cache    = {}     # "all" -> (timestamp, dict[short_token -> share_id])
_merges_cache    = {}     # "all" -> (timestamp, dict[short_token -> {merge_id, rmnd_mode, pdooh_mode}])
_closures_cache  = {}     # "all" -> (timestamp, dict[short_token -> closed_at_iso])
_pauses_cache    = {}     # "all" -> (timestamp, dict[short_token -> paused_at_iso])
_early_ends_cache= {}     # "all" -> (timestamp, dict[short_token -> {early_end_date, reason, ended_by}])
# Override de core products ATIVOS por token (curadoria admin). Quando presente,
# vence o checklist_info: frentes fora do set têm contratado/bônus zerados em
# _fetch_contracts (some do report). Blinda campanha encerrada de drift da
# pipeline (frente removida no Command que continua materializada). TTL da lista.
_cp_override_cache = {}   # "all" -> (timestamp, dict[short_token -> set(products)])
# Detalhes do fechamento (pós-venda, material extra, checkups) — por token.
# Enriquecido na camada de SERVING do report (não dentro de fetch_campaign_data)
# pra valer também em reports congelados, que servem snapshot verbatim.
_closure_details_cache = {} # short_token -> (timestamp, dict|None)
# Elementos presentes por campanha (nego/logo/loom/survey/rmnd/pdooh/pos_venda)
# — alimenta os mini-dots do card admin. Uma query UNION sobre as tabelas de
# assets (todas pequenas); TTL da lista.
_elements_cache = {}        # "all" -> (timestamp, dict[short_token -> [element]])
# Campanhas congeladas (snapshot servido verbatim). Guarda só o CONJUNTO de
# tokens frozen (leve); o payload em si vive em report_snapshots (BQ) e, depois
# do 1º load, no _report_cache. TTL = lista (frozen muda raramente, via admin).
_frozen_cache    = {}     # "all" -> (timestamp, dict[short_token -> frozen_at_iso])
# Janela de entrega por campanha — bound OPCIONAL e POR TOKEN do range de datas
# contado no report (delivery fora do voo é excluída). Só tokens cadastrados
# são afetados; todos os demais seguem all-time (comportamento atual). Usado
# pra campanhas cujo token "herdou" delivery de outro período (ex: line do DSP
# renomeada e reusada numa campanha nova → mês anterior vaza pro token novo).
_windows_cache   = {}     # "all" -> (timestamp, dict[short_token -> (date_from, date_to)])
# Cache da listagem de forms do Typeform — evita estourar rate-limit em cada
# abertura do SurveyModal (admin abre o modal várias vezes editando blocos).
# TTL curto (5min) porque o admin pode estar criando um form novo e querendo
# vê-lo no dropdown sem esperar muito.
_typeform_forms_cache = {} # "all" -> (timestamp, list[{id,title,last_updated_at,_links}])
# Performers histórico por janela — admin escolhe presets 7d/30d/90d/mês passado.
# Key = "from|to" (ISO YYYY-MM-DD). Para janelas que terminam no passado o
# resultado é virtualmente imutável (delivery histórica não muda), então TTL
# longo. Janelas que tocam hoje ainda se beneficiam dos 5min — o pipeline
# de ingestão diária só atualiza poucas vezes ao dia.
_PERFORMERS_PERIOD_CACHE_TTL = 600
_performers_period_cache = {} # "from|to" -> (timestamp, list[campaign])
# Freshness do rollup diário das bases (DV360/Xandr/StackAdapt). Lê uma
# query agregada barata (group by source) — TTL curto pra que se o admin
# olhar o indicador depois das 06h e o pipeline ainda não tiver rodado,
# o refresh natural (5min) já pega quando rodar. Não tem invalidação
# manual: dado é cosmético, não bloqueante.
_DATA_FRESHNESS_CACHE_TTL = 300
_data_freshness_cache = {}  # "all" -> (timestamp, list[{source, max_date, ...}])
_source_landings_cache = {}  # "all" -> (timestamp, list[{source, max_date}])
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
        _closures_cache.pop("all", None)
        _pauses_cache.pop("all", None)
        _early_ends_cache.pop("all", None)
        _cp_override_cache.pop("all", None)
        _closure_details_cache.pop(short_token, None)
        _elements_cache.pop("all", None)
        _frozen_cache.pop("all", None)
        _windows_cache.pop("all", None)
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

    Campanha CONGELADA (freeze): serve o snapshot persistido verbatim, sem
    tocar nas tabelas de delivery. Vence até force_refresh — o sentido do
    freeze é justamente blindar o report de reprocessamentos do pipeline
    (ex: rename de line no DSP re-derivando short_token e levando o
    histórico embora). Para voltar a recalcular ao vivo: descongelar.
    """
    frozen = _get_frozen_payload(short_token)
    if frozen is not None:
        return frozen, True

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


def _build_clients_payload(campaigns):
    """Monta o payload da view "Por cliente" a partir da lista de campanhas.

    Compartilhado entre o endpoint ?action=list_clients e o warmup — antes
    o corpo vivia inline no handler, e o warmup precisaria duplicá-lo (com
    risco de drift: payload aquecido sem sparkline/trend renderizaria a
    view incompleta por até 1 TTL).
    """
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

    return {"clients": agg, "worklist": worklist}


def warmup_caches(force_refresh=True, max_reports=150, deadline_s=480):
    """Pré-aquece os caches in-memory (lista, clientes, reports ativos).

    Invocado pelo Cloud Scheduler (deploy.sh) a cada 3h entre 06h30 e 18h30
    BRT, com refresh=true. A run das 06h30 é a que importa de verdade: a
    consolidação diária do BQ termina ~06h e, sem warmup, o primeiro acesso
    da manhã a cada report paga query fria (3-6s+). As runs seguintes
    re-aquecem o que o _REPORT_CACHE_TTL (3h) deixou expirar, mantendo o
    cache warm em horário comercial.

    Escopo:
      - lista de campanhas + view "Por cliente" (menu admin);
      - reports cujo fim (early_end_date ou end_date) está a <= 14 dias no
        passado ou no futuro — encerrados há mais tempo raramente são
        abertos e tendem a estar congelados;
      - tokens congelados são pulados (servem snapshot verbatim, barato);
      - visão agregada dos grupos merged que contêm tokens aquecidos
        (membros já quentes → compose barato, sem re-query).

    Concorrência: executor DEDICADO, não o _query_pool — fetch_campaign_data
    submete as sub-queries no _query_pool; rodar o nível externo no mesmo
    pool poderia deadlockar (outers ocupando todos os workers, esperando
    inners que nunca entram). 4 workers limita a pressão sobre o BQ e sobre
    os 16 workers internos compartilhados com tráfego real.

    Best-effort em tudo: erro em um report não derruba os demais; estourar
    o deadline (default 480s < timeout 540s da função) cancela o restante e
    reporta `timed_out` no summary.
    """
    t0 = time.time()
    summary = {"forced": bool(force_refresh)}

    # Espelha o ?refresh=true dos handlers da lista: sem isso, a lista
    # rebuildada às 06h30 reusaria o sheet_cache de owners de ontem.
    if force_refresh:
        owners.invalidate_cache()

    campaigns, _ = _get_campaigns_list_cached(force_refresh=force_refresh)
    summary["list_total"] = len(campaigns)

    try:
        _cache_set(_clients_cache, "all", _build_clients_payload(campaigns))
        summary["clients_warmed"] = True
    except Exception as e:
        logger.warning(f"[WARN warmup clients] {e}")
        summary["clients_warmed"] = False

    try:
        frozen_map = query_frozen_tokens()
    except Exception as e:
        logger.warning(f"[WARN warmup frozen lookup] {e}")
        frozen_map = {}

    today = date.today()
    candidates = []
    for c in campaigns:
        st = c.get("short_token")
        if not st or st in frozen_map:
            continue
        end_d = _parse_iso_date_safe(c.get("early_end_date") or c.get("end_date"))
        if end_d is not None and (today - end_d).days > 14:
            continue
        candidates.append((st, end_d or date.max))

    # Cap de segurança — prioriza fins mais recentes/futuros (em vôo primeiro).
    candidates.sort(key=lambda x: x[1], reverse=True)
    summary["reports_dropped"] = max(0, len(candidates) - max_reports)
    candidates = candidates[:max_reports]
    summary["reports_selected"] = len(candidates)

    ok = errors = 0
    timed_out = False
    # 4 → 2 workers: cada report aquecido dispara várias sub-queries no
    # _query_pool (16 workers); com 4 em paralelo o warmup criava um BURST de
    # slots BQ on-demand que enfileirava as queries de usuário (lista/portal
    # ficavam 15-65s). 2 workers reduz o pico pela metade; o warmup leva ~2x mais
    # (~130s → ~260s, bem dentro do deadline de 480s). Trade-off consciente:
    # warmup um pouco mais lento, menos contenção pro tráfego real.
    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="warmup")
    futures = {
        pool.submit(_get_report_cached, st, force_refresh): st
        for st, _ in candidates
    }
    try:
        budget = max(1.0, deadline_s - (time.time() - t0))
        for fut in as_completed(futures, timeout=budget):
            st = futures[fut]
            try:
                data, _hit = fut.result()
                if data is not None:
                    ok += 1
                else:
                    errors += 1
                    logger.warning(f"[WARN warmup report {st}] payload vazio")
            except Exception as e:
                errors += 1
                logger.warning(f"[WARN warmup report {st}] {e}")
    except TimeoutError:
        timed_out = True
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    summary["reports_warmed"] = ok
    summary["reports_errors"] = errors

    # Grupos merged: re-compõe a visão agregada a partir dos membros recém-
    # aquecidos. NÃO propagar force_refresh — compose_merged_report repassaria
    # pra cada membro e re-pagaria as queries que acabamos de fazer; em vez
    # disso derruba a entrada composta e deixa recompor do cache warm.
    merged_ok = merged_errors = 0
    if not timed_out:
        try:
            merges_lookup = _safe_get_merges()
            warm_tokens = {st for st, _ in candidates}
            merge_ids = sorted({
                info["merge_id"]
                for tok, info in merges_lookup.items()
                if tok in warm_tokens and info.get("merge_id")
            })
            for mid in merge_ids:
                if time.time() - t0 > deadline_s:
                    timed_out = True
                    break
                try:
                    if force_refresh:
                        with _cache_lock:
                            _merged_report_cache.pop(mid, None)
                    data, _hit = _get_merged_report_cached(mid, force_refresh=False)
                    if data is not None:
                        merged_ok += 1
                except Exception as e:
                    merged_errors += 1
                    logger.warning(f"[WARN warmup merged {mid}] {e}")
        except Exception as e:
            logger.warning(f"[WARN warmup merges lookup] {e}")
    summary["merged_warmed"] = merged_ok
    summary["merged_errors"] = merged_errors

    # Portais ativos: pré-aquece o payload de cada um (mata o cold do 1º acesso
    # ao link compartilhável /c/<share_id>). Queries GLOBAIS (shares + elements)
    # rodam uma vez só; por portal, só published_tokens + logos (escopados,
    # baratos). campaigns já está warm. Respeita o deadline; best-effort.
    portals_ok = portals_errors = 0
    if not timed_out:
        try:
            configs = client_portal.list_active_configs()
            if configs:
                all_shares = shares.get_all_share_ids()
                elements_map = _safe_get_elements()
                for cfg in configs:
                    if time.time() - t0 > deadline_s:
                        timed_out = True
                        break
                    try:
                        published = client_portal.get_published_tokens(cfg.get("slug"))
                        share_map = {
                            k.upper(): v for k, v in all_shares.items()
                            if k and k.upper() in published
                        }
                        logos_map = query_logos_for_tokens(sorted(published))
                        payload = client_portal.build_portal_payload(
                            cfg, campaigns, published, share_map, logos_map, elements_map)
                        _cache_set(_portal_cache, cfg["share_id"], payload)
                        portals_ok += 1
                        # Pré-aquece os endpoints LAZY da aba Analytics (audiências
                        # + brand lift) — matam o cold do 1º acesso. Pesados
                        # (detail por campanha / Typeform por survey), então só
                        # rodam se ainda dentro do deadline; best-effort cada um.
                        sid = cfg["share_id"]
                        if time.time() - t0 <= deadline_s:
                            try:
                                res = compute_portal_audiences(sid)
                                if res is not None:
                                    _cache_set(_audiences_cache, sid, res)
                            except Exception as e:
                                logger.warning(f"[WARN warmup audiences {cfg.get('slug')}] {e}")
                        if time.time() - t0 <= deadline_s:
                            try:
                                res = compute_portal_brand_lift(sid)
                                if res is not None:
                                    _cache_set(_brand_lift_cache, sid, res)
                            except Exception as e:
                                logger.warning(f"[WARN warmup brand_lift {cfg.get('slug')}] {e}")
                    except Exception as e:
                        portals_errors += 1
                        logger.warning(f"[WARN warmup portal {cfg.get('slug')}] {e}")
        except Exception as e:
            logger.warning(f"[WARN warmup portals lookup] {e}")
    summary["portals_warmed"] = portals_ok
    summary["portals_errors"] = portals_errors

    summary["timed_out"] = timed_out
    summary["duration_s"] = round(time.time() - t0, 1)
    return summary

PROJECT_ID      = os.environ.get("GCP_PROJECT",        "site-hypr")
DATASET_HUB     = os.environ.get("BQ_DATASET_HUB",     "prod_prod_hypr_reporthub")
TABLE           = os.environ.get("BQ_TABLE",            "campaign_results")
DATASET_ASSETS  = "prod_assets"
# Dataset do Sales Center — checklist rico (PI, peças, proposta, features,
# volumes por feature, audiências, praças, etc). Adoção em curso: campanhas
# antigas não estão lá. query_negotiation() devolve None nesse caso e o
# front esconde o botão "Negociado".
DATASET_SALES_CENTER = "hypr_sales_center"

# ─────────────────────────────────────────────────────────────────────────────
# Expressão SQL que deriva a tática (frente) pelo line_name, ignorando o
# tactic_type da tabela (que pode estar errado por erro de CS).
# Regra (ORDEM IMPORTA — RMNF/Groundflow vence O2O):
#        _RMNF_/_GROUNDFLOW_ (ou hífen, meio ou fim)  →  "GROUNDFLOW" (rótulo: Groundflow)
#        _O2O_/-O2O- no meio ou _O2O/-O2O no final     →  "O2O"
#        _OOH_/-OOH- no meio ou _OOH/-OOH no final     →  "OOH"
#        (delimitador pode ser `_` ou `-`)
#        fallback                                       →  tactic_type original
#
# Por que RMNF antes de O2O: as lines da frente Groundflow vêm nomeadas como
# `..._O2O_GROUNDFLOW_...` (Groundflow aninhado em O2O no naming). Sem a
# prioridade, casariam O2O e a entrega do Groundflow contaria contra o
# contratado só-de-O2O (pacing inflado). Checando RMNF/GROUNDFLOW primeiro,
# a frente é separada corretamente.
# ─────────────────────────────────────────────────────────────────────────────
TACTIC_EXPR = (  # NOTE: legado/não-referenciado — as queries usam CASE inline + _GF_CONTRACT_GATE.
    "CASE"
    " WHEN REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)') THEN 'GROUNDFLOW'"
    " WHEN REGEXP_CONTAINS(line_name, r'(?i)[_-]O2O([_-]|$)') THEN 'O2O'"
    " WHEN REGEXP_CONTAINS(line_name, r'(?i)[_-]OOH([_-]|$)') THEN 'OOH'"
    " ELSE tactic_type"
    " END"
)

# ─────────────────────────────────────────────────────────────────────────────
# Gate de contrato do Groundflow. A frente Groundflow SÓ existe quando a
# campanha tem volumetria contratada de groundflow (display, vídeo ou bônus).
# Sem contrato, lines com token RMNF/GROUNDFLOW são "dark test" e a entrega
# conta na frente do OUTRO token do nome (O2O/OOH normal) — NÃO viram uma
# frente Groundflow fantasma com 0 contratado.
#
# Implementado como subquery escalar correlacionada a @token. checklist_info
# tem 1 linha por token (tabela minúscula) → custo desprezível, avaliada 1x.
# Usado nas queries per-token (totals/daily/detail). A query de lista (todos
# os tokens) usa o flag `gf_on` joinado da CTE checklist (ver query_campaigns_list).
# ─────────────────────────────────────────────────────────────────────────────
_GF_CONTRACT_GATE = (
    "(SELECT COALESCE(MAX(contracted_groundflow_display_impressions),0)"
    " + COALESCE(MAX(contracted_groundflow_video_completions),0)"
    " + COALESCE(MAX(bonus_groundflow_display_impressions),0)"
    " + COALESCE(MAX(bonus_groundflow_video_completions),0)"
    " FROM `site-hypr.prod_assets.checklist_info` WHERE short_token = @token) > 0"
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

    # ══════════════════════════════════════════════════════════════════════════
    # PORTAL DO CLIENTE — dashboard central client-facing (ver client_portal.py)
    # ══════════════════════════════════════════════════════════════════════════

    # Admin: config do portal + mapa de publicação por token. Usado pelo
    # painel "Link compartilhado". NÃO roda a query pesada de campanhas — o
    # front já tem a lista do cliente carregada na página e a passa pro drawer;
    # aqui só fazem-se dois lookups leves (config + publish_map).
    if request.method == "GET" and request.args.get("action") == "client_portal_config":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            slug = clients.normalize_client_slug(request.args.get("slug") or "")
            if not slug:
                return (jsonify({"error": "slug obrigatório"}), 400, headers)
            # Dois lookups independentes em paralelo (cada query BQ tem ~1s de
            # piso de latência; sequencial = 2s, paralelo = ~1s).
            fut_cfg = _query_pool.submit(client_portal.get_config, slug, include_secret=True)
            fut_pub = _query_pool.submit(client_portal.get_publish_map, slug)
            raw = fut_cfg.result()
            publish_map = fut_pub.result()
            # Sanitiza: remove campos internos (_password_hash/_password_plain) e
            # expõe SÓ a senha em texto (admin precisa repassar ao cliente).
            config = None
            if raw:
                config = {k: v for k, v in raw.items() if not k.startswith("_")}
                config["password"] = raw.get("_password_plain") or ""
            return (jsonify({"config": config, "publish_map": publish_map}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR client_portal_config] {e}")
            return (jsonify({"error": "Erro ao carregar config do portal"}), 500, headers)

    # Admin: salvar config do portal (senha, logo, accent, active).
    if request.method == "POST" and request.args.get("action") == "save_client_portal":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            slug = clients.normalize_client_slug(body.get("slug") or "")
            if not slug:
                return (jsonify({"error": "slug obrigatório"}), 400, headers)
            config = client_portal.save_config(
                slug,
                password=(body.get("password") or None),
                display_name=(body.get("display_name") or None),
                logo_base64=(body.get("logo_base64") or None),
                accent_color=(body.get("accent_color") or None),
                active=(body.get("active") if "active" in body else None),
                audience_overrides=(body.get("audience_overrides") if "audience_overrides" in body else None),
                updated_by=admin.get("email"),
            )
            _portal_cache.clear()  # config mudou → invalida payloads cacheados
            _audiences_cache.clear()  # override de audiência muda a quebra → recomputa
            return (jsonify({"config": config}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_client_portal] {e}")
            return (jsonify({"error": "Erro ao salvar portal"}), 500, headers)

    # Admin: publicar/despublicar uma campanha no portal (curadoria).
    if request.method == "POST" and request.args.get("action") == "set_client_publish":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            slug = clients.normalize_client_slug(body.get("slug") or "")
            token = (body.get("short_token") or "").strip()
            if not slug or not token:
                return (jsonify({"error": "slug e short_token obrigatórios"}), 400, headers)
            client_portal.set_publish(slug, token, bool(body.get("published")),
                                      by=admin.get("email"))
            _portal_cache.clear()  # curadoria mudou → invalida payloads cacheados
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR set_client_publish] {e}")
            return (jsonify({"error": "Erro ao publicar campanha"}), 500, headers)

    # Público: resolve (share_id, senha) → slug. Gate de senha do portal.
    if request.method == "POST" and request.args.get("action") == "resolve_client_share":
        try:
            body = request.get_json(silent=True) or {}
            share_id = (body.get("share_id") or "").strip()
            password = (body.get("password") or "").strip()
            if not share_id or not password:
                return (jsonify({"error": "share_id e senha obrigatórios"}), 400, headers)
            # Distingue "portal desativado" de "senha errada" — mensagem honesta
            # (estado de ativação não é sensível; o cliente precisa saber).
            cfg = client_portal.get_config_by_share_id(share_id)
            if not cfg:
                return (jsonify({"error": "Portal não encontrado"}), 404, headers)
            if not cfg.get("active"):
                return (jsonify({"error": "Portal desativado", "inactive": True}), 403, headers)
            slug = client_portal.verify_share_password(share_id, password)
            if not slug:
                return (jsonify({"error": "Senha inválida"}), 401, headers)
            return (jsonify({"slug": slug, "ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR resolve_client_share] {e}")
            return (jsonify({"error": "Erro ao validar acesso"}), 500, headers)

    # Público gated: dados agregados client-safe do portal (por share_id).
    # O share_id (~96 bits) é a credencial de leitura — mesmo posture do
    # ?token= do report. NUNCA expõe dado interno (serializer whitelist).
    if request.method == "GET" and request.args.get("action") == "client_portal_data":
        try:
            share_id = (request.args.get("share_id") or "").strip()
            if not share_id:
                return (jsonify({"error": "share_id obrigatório"}), 400, headers)

            # Browser revalida a cada 60s (evita payload preso durante updates);
            # o cache de servidor (_portal_cache, 5min) ainda protege o backend.
            resp_headers = {**headers, "Cache-Control": "public, max-age=60"}

            # Cache de payload (TTL 5min) — primeira carga constrói; repetidas
            # (qualquer cliente/instância) servem instantâneo. Mutação admin
            # limpa o cache (ver save_client_portal / set_client_publish).
            cached = _cache_get(_portal_cache, share_id, _PORTAL_CACHE_TTL)
            if cached is not None:
                return (jsonify(cached), 200, resp_headers)

            config = client_portal.get_config_by_share_id(share_id)
            if not config or not config.get("active"):
                return (jsonify({"error": "Portal não encontrado"}), 404, headers)
            slug = config["slug"]

            # Paraleliza: tokens publicados + mapa completo de share_ids (full
            # scan barato, ~300 rows) rodam juntos; a lista de campanhas já vem
            # do cache compartilhado. Antes eram 3 queries sequenciais (~3s).
            fut_pub = _query_pool.submit(client_portal.get_published_tokens, slug)
            fut_share = _query_pool.submit(shares.get_all_share_ids)
            fut_elements = _query_pool.submit(_safe_get_elements)
            campaigns, _ = _get_campaigns_list_cached()
            published = fut_pub.result()
            # Logos próprias de cada campanha (batch) — só depois de saber os
            # tokens publicados. Roda em paralelo com a montagem do share_map.
            fut_logos = _query_pool.submit(query_logos_for_tokens, sorted(published))
            all_shares = fut_share.result()
            share_map = {
                k.upper(): v for k, v in all_shares.items()
                if k and k.upper() in published
            }
            logos_map = fut_logos.result()
            elements_map = fut_elements.result()  # {token: {assets, negotiated, closure}}
            payload = client_portal.build_portal_payload(
                config, campaigns, published, share_map, logos_map, elements_map)
            _cache_set(_portal_cache, share_id, payload)
            return (jsonify(payload), 200, resp_headers)
        except Exception as e:
            logger.error(f"[ERROR client_portal_data] {e}")
            return (jsonify({"error": "Erro ao carregar portal"}), 500, headers)

    # ── Endpoint: brand lift mensal agregado (LAZY) ─────────────────────────
    # Separado do client_portal_data porque é pesado (busca Typeform por form).
    # O front chama só ao abrir a aba Analytics. Cache próprio (1h).
    if request.method == "GET" and request.args.get("action") == "client_portal_brand_lift":
        share_id = (request.args.get("share_id") or "").strip()
        if not share_id:
            return (jsonify({"error": "share_id obrigatório"}), 400, headers)
        resp_headers = {**headers, "Cache-Control": "public, max-age=300"}
        cached = _cache_get(_brand_lift_cache, share_id, _BRAND_LIFT_CACHE_TTL)
        if cached is not None:
            return (jsonify(cached), 200, resp_headers)
        try:
            result = compute_portal_brand_lift(share_id)
            if result is None:
                return (jsonify({"error": "Portal não encontrado"}), 404, headers)
        except Exception as e:
            logger.error(f"[ERROR client_portal_brand_lift] {e}")
            return (jsonify({"error": "Erro ao calcular brand lift"}), 500, headers)
        _cache_set(_brand_lift_cache, share_id, result)
        return (jsonify(result), 200, resp_headers)

    # Quebra por audiência (Portal · Analytics). LAZY/pesado (1 detail por
    # campanha) → cache 1h próprio, igual ao brand lift. O front chama ao abrir
    # a aba Analytics e aplica os filtros client-side.
    if request.method == "GET" and request.args.get("action") == "client_portal_audiences":
        share_id = (request.args.get("share_id") or "").strip()
        if not share_id:
            return (jsonify({"error": "share_id obrigatório"}), 400, headers)
        resp_headers = {**headers, "Cache-Control": "public, max-age=300"}
        cached = _cache_get(_audiences_cache, share_id, _AUDIENCES_CACHE_TTL)
        if cached is not None:
            return (jsonify(cached), 200, resp_headers)
        try:
            result = compute_portal_audiences(share_id)
            if result is None:
                return (jsonify({"error": "Portal não encontrado"}), 404, headers)
        except Exception as e:
            logger.error(f"[ERROR client_portal_audiences] {e}")
            return (jsonify({"error": "Erro ao calcular audiências"}), 500, headers)
        _cache_set(_audiences_cache, share_id, result)
        return (jsonify(result), 200, resp_headers)

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
                        "campaign":    camp,
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
                    campaign=campaign,
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
                        "campaign":    camp,
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
                    campaign=payload.get("campaign") or {},
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
                    return ([], [], None)
                return (
                    payload.get("detail") or [],
                    payload.get("totals") or [],
                    payload.get("campaign") or {},
                )

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
                        "campaign":    camp,
                    })
                return out

            summary = sheets_integration.sync_all_due(_token_loader, _merge_loader)
            return (jsonify({"summary": summary}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR sheets_sync_all] {e}")
            return (jsonify({"error": "Erro no sync diário"}), 500, headers)

    # ── Endpoint: alerta diário pra CS sobre integrações stale (cron) ───────
    # Invocado pelo Cloud Scheduler diariamente às 09:00 BRT — 1h depois do
    # sync das 08h, dando tempo do cron rodar.
    #
    # Pra cada integração com last_synced_at > 26h, envia 1 email pro
    # `created_by_email` (CS responsável) listando as campanhas dele.
    # Auth via X-Cron-Secret igual ao sheets_sync_all — Scheduler não tem
    # identidade humana.
    if request.method == "POST" and request.args.get("action") == "sheets_alert_stale":
        provided  = request.headers.get("X-Cron-Secret", "")
        expected  = os.environ.get("CRON_SECRET", "")
        if not expected or not hmac.compare_digest(provided, expected):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            summary = sheets_alerts.alert_stale_integrations()
            return (jsonify({"summary": summary}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR sheets_alert_stale] {e}")
            return (jsonify({"error": "Erro no alerta diário"}), 500, headers)

    # ── Endpoint: auto-freeze de campanhas maduras (cron OU admin) ──────────
    # Cron (Scheduler diário): auth via X-Cron-Secret. Admin: auth via JWT —
    # útil pra rodar dry-run e ver o que congelaria (`?dry_run=1`).
    # Congela campanhas encerradas há 8–45 dias, não-congeladas, que passam
    # nas guardas de sanidade. Idempotente e reversível (unfreeze).
    if request.args.get("action") == "auto_freeze_sweep":
        provided = request.headers.get("X-Cron-Secret", "")
        expected = os.environ.get("CRON_SECRET", "")
        is_cron  = bool(expected) and hmac.compare_digest(provided, expected)
        if not (is_cron or authenticate_admin(request)):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            # dry_run default TRUE para admin (preview seguro); cron passa explícito.
            dry_q = (request.args.get("dry_run") or "").strip().lower()
            dry_run = (dry_q in ("1", "true", "yes")) or (not is_cron and dry_q == "")
            summary = auto_freeze_sweep(dry_run=dry_run)
            return (jsonify(summary), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR auto_freeze_sweep] {e}")
            return (jsonify({"error": "Erro no auto-freeze"}), 500, headers)

    # ── Endpoint: warmup de caches (cron OU admin) ──────────────────────────
    # Cron (Scheduler, deploy.sh: a cada 3h, 06h30–18h30 BRT): auth via
    # X-Cron-Secret. Admin: auth via JWT — útil pra aquecer manualmente após
    # um rebuild fora de hora ("Reconstruir agora" + warmup = reports frescos
    # sem esperar TTL). `?refresh=false` só re-aquece o que expirou.
    if request.args.get("action") == "warmup":
        provided = request.headers.get("X-Cron-Secret", "")
        expected = os.environ.get("CRON_SECRET", "")
        is_cron  = bool(expected) and hmac.compare_digest(provided, expected)
        if not (is_cron or authenticate_admin(request)):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            refresh_q = (request.args.get("refresh") or "").strip().lower()
            force = refresh_q not in ("0", "false", "no")  # default: true
            summary = warmup_caches(force_refresh=force)
            logger.warning(f"[warmup] {json.dumps(summary)}")
            return (jsonify(summary), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR warmup] {e}")
            return (jsonify({"error": "Erro no warmup"}), 500, headers)

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
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = body.get("short_token", "").strip()
            logo_base64 = body.get("logo_base64", "").strip()
            if not short_token or not logo_base64:
                return (jsonify({"error": "short_token e logo_base64 são obrigatórios"}), 400, headers)
            save_logo(short_token, logo_base64)
            _cache_invalidate_token(short_token)
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="logo_changed",
                actor_email=admin.get("email"),
                message="trocou o logo do cliente",
            )
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
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="abs_toggled",
                actor_email=admin.get("email"),
                message=f"marcou Pre-bid ABS como {'ativo' if has_abs else 'inativo'}",
                payload={"has_abs": has_abs},
            )
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_abs_override] {e}")
            return (jsonify({"error": "Erro ao salvar override de ABS"}), 500, headers)

    # ── Endpoint: ler override de agência ────────────────────────────────────
    if request.method == "GET" and request.args.get("action") == "get_agency_override":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        short_token = request.args.get("short_token", "").strip()
        if not short_token:
            return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
        try:
            override = query_agency_override(short_token)
            return (jsonify({"override": override}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR get_agency_override] {e}")
            return (jsonify({"error": "Erro ao buscar override de agência"}), 500, headers)

    # ── Endpoint: salvar override de agência ─────────────────────────────────
    # `agency` vazia limpa o override (header volta ao fallback Sales Center).
    if request.method == "POST" and request.args.get("action") == "save_agency_override":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            agency      = (body.get("agency") or "").strip()
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            save_agency_override(short_token, agency, updated_by=admin.get("email"))
            # Invalida o payload do report — o campaign.agency injetado em
            # fetch_campaign_data reflete na próxima request.
            _cache_invalidate_token(short_token)
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="agency_set",
                actor_email=admin.get("email"),
                message=(f"definiu a agência como \"{agency}\"" if agency else "limpou a agência (volta ao Sales Center)"),
                payload={"agency": agency or None},
            )
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_agency_override] {e}")
            return (jsonify({"error": "Erro ao salvar override de agência"}), 500, headers)

    # ── Endpoint: ler override de core products ─────────────────────────────
    # Devolve {override: {products, updated_by, updated_at}} ou {override: null}
    # (= automático, frentes derivadas do checklist). Admin-only.
    if request.method == "GET" and request.args.get("action") == "get_core_products_override":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        short_token = request.args.get("short_token", "").strip()
        if not short_token:
            return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
        try:
            override = query_core_product_override(short_token)
            return (jsonify({"override": override}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR get_core_products_override] {e}")
            return (jsonify({"error": "Erro ao buscar override de core products"}), 500, headers)

    # ── Endpoint: salvar override de core products ──────────────────────────
    # Body: {short_token, products: ["O2O", ...]}. Lista vazia/ausente → remove o
    # override (volta ao automático). Curadoria de quais frentes aparecem no report.
    if request.method == "POST" and request.args.get("action") == "save_core_products_override":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            products    = body.get("products")
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            valid = sorted(_parse_cp_products(products))
            save_core_product_override(short_token, valid, updated_by=admin.get("email"))
            _cache_invalidate_token(short_token)
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="core_products_override",
                actor_email=admin.get("email"),
                message=(f"definiu core products ativos = {valid}" if valid
                         else "removeu override de core products (automático)"),
                payload={"products": valid},
            )
            return (jsonify({"ok": True, "products": valid}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_core_products_override] {e}")
            return (jsonify({"error": "Erro ao salvar override de core products"}), 500, headers)

    # ── Endpoint: marcar campanha como encerrada (ou reverter) ──────────────
    # Body: {short_token, closed: bool, details?: {pos_venda_url, pos_venda_mode,
    #        extra_url, extra_mode, weekly_checkups}}
    # closed=true  → registra closed_at=NOW na tabela campaign_closures e,
    #                quando `details` vem no body, persiste os dados do
    #                fechamento (pós-venda etc) em campaign_closure_details
    # closed=false → remove o registro (volta ao estado derivado por end_date).
    #                Details são preservados (histórico do fechamento).
    if request.method == "POST" and request.args.get("action") == "save_campaign_closure":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            closed      = bool(body.get("closed"))
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            save_campaign_closure(short_token, closed, closed_by=admin.get("email"))
            details = None
            if closed and isinstance(body.get("details"), dict):
                details = _sanitize_closure_details(body["details"])
                save_closure_details(short_token, details, updated_by=admin.get("email"))
            _cache_invalidate_token(short_token)
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="campaign_closed" if closed else "campaign_reopened",
                actor_email=admin.get("email"),
                message="marcou a campanha como encerrada" if closed else "reabriu a campanha",
                payload=details,
            )
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_campaign_closure] {e}")
            return (jsonify({"error": "Erro ao salvar fechamento da campanha"}), 500, headers)

    # ── Endpoint: editar detalhes do fechamento (pós-venda etc) ─────────────
    # Body: {short_token, details: {...}} — mesmo shape do save_campaign_closure,
    # mas sem tocar no estado closed. Usado pelo admin pra corrigir/completar
    # os dados depois que a campanha já foi encerrada.
    if request.method == "POST" and request.args.get("action") == "save_closure_details":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            details = _sanitize_closure_details(body.get("details") or {})
            save_closure_details(short_token, details, updated_by=admin.get("email"))
            _cache_invalidate_token(short_token)
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="closure_details_updated",
                actor_email=admin.get("email"),
                message="atualizou os dados do fechamento (pós-venda)",
                payload=details,
            )
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_closure_details] {e}")
            return (jsonify({"error": "Erro ao salvar dados do fechamento"}), 500, headers)

    # ── Endpoint: ler detalhes do fechamento (admin) ────────────────────────
    # Pré-popula o popup de edição. Inclui weekly_checkups (admin-only).
    if request.method == "GET" and request.args.get("action") == "get_closure_details":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            short_token = (request.args.get("short_token") or "").strip()
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            return (jsonify({"details": _get_closure_details_cached(short_token)}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR get_closure_details] {e}")
            return (jsonify({"error": "Erro ao buscar dados do fechamento"}), 500, headers)

    # ── Endpoint: salvar check-ups semanais (tracker do drawer) ─────────────
    # Body: {short_token, log: [{week:int, sent_at:"YYYY-MM-DD"|null}, ...]}
    # Atualização SEMANAL durante a veiculação — o CS marca cada semana que
    # mandou o check-up ao cliente. Toca só weekly_checkup_log + a contagem
    # derivada; não mexe em pós-venda. Métrica interna, admin-only.
    if request.method == "POST" and request.args.get("action") == "save_weekly_checkups":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            log = _sanitize_weekly_checkup_log(body.get("log"))
            save_weekly_checkups(short_token, log, updated_by=admin.get("email"))
            _cache_invalidate_token(short_token)
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="weekly_checkups_updated",
                actor_email=admin.get("email"),
                message=f"atualizou os check-ups semanais ({len(log)} enviado(s))",
                payload={"log": log},
            )
            return (jsonify({"ok": True, "log": log, "count": len(log)}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_weekly_checkups] {e}")
            return (jsonify({"error": "Erro ao salvar check-ups semanais"}), 500, headers)

    # ── Endpoint: congelar report (snapshot) ────────────────────────────────
    # Body: {short_token, note?, src?: {unified, campaign_results}}
    # Persiste o payload computado e passa a servi-lo verbatim (imune a
    # reprocessamento do pipeline). `src` (opcional, admin) aponta tabelas de
    # recuperação (time-travel) quando a fonte ao vivo já está corrompida.
    if request.method == "POST" and request.args.get("action") == "freeze_report":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            note        = (body.get("note") or "").strip() or None
            src         = body.get("src") or None
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            payload = build_report_snapshot(
                short_token, src=src, frozen_by=admin.get("email"), note=note
            )
            t = payload.get("totals") or []
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="report_frozen",
                actor_email=admin.get("email"),
                message="congelou o report" + (f" — {note}" if note else ""),
                payload={"note": note, "src": src} if (note or src) else None,
            )
            return (jsonify({"ok": True, "frozen": True, "totals_rows": len(t)}), 200, headers)
        except ValueError as e:
            return (jsonify({"error": str(e)}), 404, headers)
        except Exception as e:
            logger.error(f"[ERROR freeze_report] {e}")
            return (jsonify({"error": "Erro ao congelar o report"}), 500, headers)

    # ── Endpoint: descongelar report ────────────────────────────────────────
    # Remove o snapshot — volta a recalcular ao vivo.
    if request.method == "POST" and request.args.get("action") == "unfreeze_report":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            delete_report_snapshot(short_token)
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="report_unfrozen",
                actor_email=admin.get("email"),
                message="descongelou o report (volta a recalcular ao vivo)",
            )
            return (jsonify({"ok": True, "frozen": False}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR unfreeze_report] {e}")
            return (jsonify({"error": "Erro ao descongelar o report"}), 500, headers)

    # ── Endpoint: status de freeze (admin) ──────────────────────────────────
    if request.method == "GET" and request.args.get("action") == "freeze_status":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            frozen = query_frozen_tokens()
            token = (request.args.get("token") or "").strip()
            if token:
                return (jsonify({"short_token": token, "frozen": token in frozen,
                                 "frozen_at": frozen.get(token)}), 200, headers)
            return (jsonify({"frozen": frozen}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR freeze_status] {e}")
            return (jsonify({"error": "Erro ao consultar freeze"}), 500, headers)

    # ── Endpoint: janela de entrega (bound de datas por token) ──────────────
    # Body: {short_token, date_from?, date_to?, note?}  (datas ISO ou null)
    # date_from/date_to ambos null → equivale a remover (sem bound).
    if request.method == "POST" and request.args.get("action") == "save_delivery_window":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            date_from   = (body.get("date_from") or "").strip() or None
            date_to     = (body.get("date_to")   or "").strip() or None
            note        = (body.get("note") or "").strip() or None
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            if not date_from and not date_to:
                delete_delivery_window(short_token)
                action_done = "removida"
            else:
                save_delivery_window(short_token, date_from, date_to,
                                     note=note, updated_by=admin.get("email"))
                action_done = "salva"
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="delivery_window_set",
                actor_email=admin.get("email"),
                message=f"janela de entrega {action_done}: [{date_from or '-'} → {date_to or '-'}]",
                payload={"date_from": date_from, "date_to": date_to, "note": note},
            )
            return (jsonify({"ok": True, "date_from": date_from, "date_to": date_to}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_delivery_window] {e}")
            return (jsonify({"error": "Erro ao salvar janela de entrega"}), 500, headers)

    # ── Endpoint: pausar/retomar campanha ───────────────────────────────────
    # Body: {short_token, paused: bool, reason?: str}
    # paused=true  → registra paused_at=NOW + reason (opcional)
    # paused=false → remove o registro (retoma — campanha volta ao in_flight)
    if request.method == "POST" and request.args.get("action") == "save_campaign_pause":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            paused      = bool(body.get("paused"))
            reason      = (body.get("reason")      or "").strip() or None
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            save_campaign_pause(short_token, paused, paused_by=admin.get("email"), reason=reason)
            _cache_invalidate_token(short_token)
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="campaign_paused" if paused else "campaign_resumed",
                actor_email=admin.get("email"),
                message=("pausou a campanha" + (f" — {reason}" if reason else "")) if paused else "retomou a campanha",
                payload={"reason": reason} if reason else None,
            )
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_campaign_pause] {e}")
            return (jsonify({"error": "Erro ao salvar pausa da campanha"}), 500, headers)

    # ── Endpoint: encerramento antecipado ───────────────────────────────────
    # Body: {short_token, early_end_date: "YYYY-MM-DD", reason?: str}
    # Grava o registro em campaign_early_ends (upsert). Frontend usa pra
    # exibir badge "antes do previsto" + ajustar período. Pacing continua
    # contra contrato original (Opção B — mostra a perda).
    if request.method == "POST" and request.args.get("action") == "save_campaign_early_end":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token    = (body.get("short_token")    or "").strip()
            early_end_date = (body.get("early_end_date") or "").strip()
            reason         = (body.get("reason")         or "").strip() or None
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            if not early_end_date:
                return (jsonify({"error": "early_end_date é obrigatório (YYYY-MM-DD)"}), 400, headers)
            # Validação de formato + range (start_date ≤ early ≤ end_date original).
            # Backend é a fonte de verdade — frontend aplica o mesmo cap como UX,
            # mas API direto via curl/Postman precisa rejeitar lixo.
            try:
                early_d = date.fromisoformat(early_end_date)
            except ValueError:
                return (jsonify({"error": "early_end_date inválido — use YYYY-MM-DD"}), 400, headers)
            campaign_range = _get_campaign_date_range(short_token)
            if campaign_range:
                start_d, end_d = campaign_range
                if start_d and early_d < start_d:
                    return (jsonify({"error": "early_end_date não pode ser anterior ao início da campanha"}), 400, headers)
                if end_d and early_d > end_d:
                    return (jsonify({"error": "early_end_date não pode ser posterior ao fim original da campanha"}), 400, headers)
            save_campaign_early_end(short_token, early_end_date, reason, ended_by=admin.get("email"))
            _cache_invalidate_token(short_token)
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="campaign_early_ended",
                actor_email=admin.get("email"),
                message=f"encerrou antecipadamente em {early_end_date}" + (f" — {reason}" if reason else ""),
                payload={"early_end_date": early_end_date, "reason": reason},
            )
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_campaign_early_end] {e}")
            return (jsonify({"error": "Erro ao salvar encerramento antecipado"}), 500, headers)

    # ── Endpoint: reverter encerramento antecipado ──────────────────────────
    # Body: {short_token}. Remove o registro — campanha volta ao estado
    # derivado pela end_date original.
    if request.method == "POST" and request.args.get("action") == "delete_campaign_early_end":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            if not short_token:
                return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
            delete_campaign_early_end(short_token)
            _cache_invalidate_token(short_token)
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="campaign_early_end_reverted",
                actor_email=admin.get("email"),
                message="reverteu o encerramento antecipado",
            )
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR delete_campaign_early_end] {e}")
            return (jsonify({"error": "Erro ao reverter encerramento antecipado"}), 500, headers)

    # ── Endpoint: salvar override de nome de audiência (admin) ───────────────
    # Body: {client_name, raw_audience, display_name, scope?, short_token?}
    # scope: "advertiser" (default, vale em todo o anunciante) | "campaign"
    # (só este report — exige short_token). raw_audience pode vir como ARRAY
    # (renomear um grupo já mesclado aplica o mesmo display a todos os crus).
    if request.method == "POST" and request.args.get("action") == "save_audience_override":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            slug = clients.normalize_client_slug(body.get("client_name") or "")
            display_name = (body.get("display_name") or "").strip()
            raw = body.get("raw_audience")
            raws = raw if isinstance(raw, list) else [raw]
            raws = [str(r).strip() for r in raws if r and str(r).strip()]
            scope = (body.get("scope") or "advertiser").strip().lower()
            short_token = (body.get("short_token") or "").strip()
            if not slug:
                return (jsonify({"error": "client_name é obrigatório"}), 400, headers)
            if not raws:
                return (jsonify({"error": "raw_audience é obrigatório"}), 400, headers)
            if not display_name:
                return (jsonify({"error": "display_name é obrigatório"}), 400, headers)
            if len(display_name) > 120:
                return (jsonify({"error": "display_name muito longo (máx 120)"}), 400, headers)
            if scope == "campaign" and not short_token:
                return (jsonify({"error": "short_token é obrigatório p/ escopo de campanha"}), 400, headers)
            scope_token = short_token if scope == "campaign" else ""
            for raw_audience in raws:
                save_audience_override(slug, raw_audience, display_name,
                                       scope_token=scope_token, edited_by=admin.get("email"))
            _audiences_cache.clear()  # quebra do hub usa o seed → recomputa
            audit_log.safe_write_event(
                short_token=short_token or None,
                event_type="audience_override_saved",
                actor_email=admin.get("email"),
                message=f"renomeou audiência {raws} → \"{display_name}\" ({slug}, escopo={scope})",
                payload={"client_slug": slug, "raw_audience": raws,
                         "display_name": display_name, "scope": scope, "scope_token": scope_token},
            )
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_audience_override] {e}")
            return (jsonify({"error": "Erro ao salvar nome da audiência"}), 500, headers)

    # ── Endpoint: remover override de nome de audiência (admin) ──────────────
    # Body: {client_name, raw_audience, scope?, short_token?}. raw_audience pode
    # ser ARRAY. scope: "all" (default — limpa anunciante + esta campanha) |
    # "advertiser" | "campaign".
    if request.method == "POST" and request.args.get("action") == "delete_audience_override":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            slug = clients.normalize_client_slug(body.get("client_name") or "")
            raw = body.get("raw_audience")
            raws = raw if isinstance(raw, list) else [raw]
            raws = [str(r).strip() for r in raws if r and str(r).strip()]
            scope = (body.get("scope") or "all").strip().lower()
            short_token = (body.get("short_token") or "").strip()
            if not slug or not raws:
                return (jsonify({"error": "client_name e raw_audience são obrigatórios"}), 400, headers)
            if scope == "advertiser":
                scope_tokens = [""]
            elif scope == "campaign":
                if not short_token:
                    return (jsonify({"error": "short_token é obrigatório p/ escopo de campanha"}), 400, headers)
                scope_tokens = [short_token]
            else:  # all — limpa o efeito neste report (anunciante + esta campanha)
                scope_tokens = ["", short_token] if short_token else None
            for raw_audience in raws:
                delete_audience_override(slug, raw_audience, scope_tokens=scope_tokens)
            _audiences_cache.clear()
            audit_log.safe_write_event(
                short_token=short_token or None,
                event_type="audience_override_deleted",
                actor_email=admin.get("email"),
                message=f"reverteu override de audiência {raws} ({slug}, escopo={scope})",
                payload={"client_slug": slug, "raw_audience": raws, "scope": scope},
            )
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR delete_audience_override] {e}")
            return (jsonify({"error": "Erro ao reverter nome da audiência"}), 500, headers)

    # ── Endpoint: listar overrides de audiência de um anunciante (admin) ─────
    # GET ?action=list_audience_overrides&client_name=<nome> — alimenta a seção
    # "Gerenciar audiências" do drawer (editar/reverter em lote).
    if request.method == "GET" and request.args.get("action") == "list_audience_overrides":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            slug = clients.normalize_client_slug(request.args.get("client_name") or "")
            if not slug:
                return (jsonify({"error": "client_name é obrigatório"}), 400, headers)
            return (jsonify({"overrides": query_audience_overrides(slug)}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR list_audience_overrides] {e}")
            return (jsonify({"error": "Erro ao listar overrides de audiência"}), 500, headers)

    # ── Endpoint: salvar override de RÓTULO genérico (admin) ─────────────────
    # Dimensões: 'format' (creative_size) | 'creative_line' (linha criativa).
    # Mesma mecânica do override de audiência (relabel/merge no Report Center),
    # mas NÃO alimenta a IA do hub. Body: {client_name, dimension, raw_value,
    # display_name, scope?, short_token?}. raw_value pode vir como ARRAY.
    if request.method == "POST" and request.args.get("action") == "save_label_override":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            slug = clients.normalize_client_slug(body.get("client_name") or "")
            dimension = (body.get("dimension") or "").strip().lower()
            display_name = (body.get("display_name") or "").strip()
            raw = body.get("raw_value")
            raws = raw if isinstance(raw, list) else [raw]
            raws = [str(r).strip() for r in raws if r and str(r).strip()]
            scope = (body.get("scope") or "advertiser").strip().lower()
            short_token = (body.get("short_token") or "").strip()
            if not slug:
                return (jsonify({"error": "client_name é obrigatório"}), 400, headers)
            if dimension not in _LABEL_OVERRIDE_DIMENSIONS:
                return (jsonify({"error": "dimension inválida"}), 400, headers)
            if not raws:
                return (jsonify({"error": "raw_value é obrigatório"}), 400, headers)
            if not display_name:
                return (jsonify({"error": "display_name é obrigatório"}), 400, headers)
            if len(display_name) > 120:
                return (jsonify({"error": "display_name muito longo (máx 120)"}), 400, headers)
            if scope == "campaign" and not short_token:
                return (jsonify({"error": "short_token é obrigatório p/ escopo de campanha"}), 400, headers)
            scope_token = short_token if scope == "campaign" else ""
            for raw_value in raws:
                save_label_override(slug, dimension, raw_value, display_name,
                                    scope_token=scope_token, edited_by=admin.get("email"))
            audit_log.safe_write_event(
                short_token=short_token or None,
                event_type="label_override_saved",
                actor_email=admin.get("email"),
                message=f"renomeou {dimension} {raws} → \"{display_name}\" ({slug}, escopo={scope})",
                payload={"client_slug": slug, "dimension": dimension, "raw_value": raws,
                         "display_name": display_name, "scope": scope, "scope_token": scope_token},
            )
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_label_override] {e}")
            return (jsonify({"error": "Erro ao salvar o nome"}), 500, headers)

    # ── Endpoint: remover override de RÓTULO genérico (admin) ────────────────
    # Body: {client_name, dimension, raw_value, scope?, short_token?}. raw_value
    # pode ser ARRAY. scope: "all" (default) | "advertiser" | "campaign".
    if request.method == "POST" and request.args.get("action") == "delete_label_override":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            slug = clients.normalize_client_slug(body.get("client_name") or "")
            dimension = (body.get("dimension") or "").strip().lower()
            raw = body.get("raw_value")
            raws = raw if isinstance(raw, list) else [raw]
            raws = [str(r).strip() for r in raws if r and str(r).strip()]
            scope = (body.get("scope") or "all").strip().lower()
            short_token = (body.get("short_token") or "").strip()
            if not slug or not raws:
                return (jsonify({"error": "client_name e raw_value são obrigatórios"}), 400, headers)
            if dimension not in _LABEL_OVERRIDE_DIMENSIONS:
                return (jsonify({"error": "dimension inválida"}), 400, headers)
            if scope == "advertiser":
                scope_tokens = [""]
            elif scope == "campaign":
                if not short_token:
                    return (jsonify({"error": "short_token é obrigatório p/ escopo de campanha"}), 400, headers)
                scope_tokens = [short_token]
            else:  # all — limpa anunciante + esta campanha
                scope_tokens = ["", short_token] if short_token else None
            for raw_value in raws:
                delete_label_override(slug, dimension, raw_value, scope_tokens=scope_tokens)
            audit_log.safe_write_event(
                short_token=short_token or None,
                event_type="label_override_deleted",
                actor_email=admin.get("email"),
                message=f"reverteu override de {dimension} {raws} ({slug}, escopo={scope})",
                payload={"client_slug": slug, "dimension": dimension, "raw_value": raws, "scope": scope},
            )
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR delete_label_override] {e}")
            return (jsonify({"error": "Erro ao reverter o nome"}), 500, headers)

    # ── Endpoint: listar overrides de RÓTULO de um anunciante (admin) ────────
    # GET ?action=list_label_overrides&client_name=<nome> — retorna todas as
    # dimensões; o front filtra por dimension. Alimenta os selos de escopo dos
    # modais "Editar formatos" / "Editar linhas criativas".
    if request.method == "GET" and request.args.get("action") == "list_label_overrides":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            slug = clients.normalize_client_slug(request.args.get("client_name") or "")
            if not slug:
                return (jsonify({"error": "client_name é obrigatório"}), 400, headers)
            return (jsonify({"overrides": query_label_overrides(slug)}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR list_label_overrides] {e}")
            return (jsonify({"error": "Erro ao listar overrides"}), 500, headers)

    # ── Endpoint: salvar Alcance & Frequência (admin) ────────────────────────
    # Body: {target_type: "token"|"merge", target_id: <short_token|merge_id>,
    #        alcance, frequencia}
    #
    # Compat: se vier `short_token` no body sem `target_type`, assume escopo
    # token. Cobertura legacy do frontend antigo.
    if request.method == "POST" and request.args.get("action") == "save_af":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            target_type = (body.get("target_type") or "").strip().lower()
            target_id   = (body.get("target_id")   or "").strip()
            if not target_type and body.get("short_token"):
                target_type = "token"
                target_id   = (body.get("short_token") or "").strip()
            alcance    = (body.get("alcance")    or "").strip()
            frequencia = (body.get("frequencia") or "").strip()
            auto_alcance = bool(body.get("auto_alcance"))
            if target_type not in ("token", "merge"):
                return (jsonify({"error": "target_type inválido (use 'token' ou 'merge')"}), 400, headers)
            if not target_id:
                return (jsonify({"error": "target_id é obrigatório"}), 400, headers)
            save_alcance_frequencia(target_type, target_id, alcance, frequencia, auto_alcance)
            # Invalida cache: pra escopo token, derruba só esse token (o
            # _cache_invalidate_token já limpa o cache merged também). Pra
            # escopo merge, derruba o cache merged do grupo + os caches
            # per-token de cada membro — fetch_campaign_data faz fallback
            # de (token, X) vazio pra (merge, merge_id), então os payloads
            # cacheados dos membros precisam ser refeitos pra refletir o
            # novo valor merge-scoped.
            if target_type == "token":
                _cache_invalidate_token(target_id)
            else:
                try:
                    group = merges.get_merge_group(target_id)
                    if group:
                        for m in (group.get("members") or []):
                            if m.get("short_token"):
                                _cache_invalidate_token(m["short_token"])
                except Exception as e:
                    logger.warning(f"[WARN save_af invalidate members merge={target_id}] {e}")
                with _cache_lock:
                    _merged_report_cache.pop(target_id, None)
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR save_af] {e}")
            return (jsonify({"error": "Erro ao salvar Alcance & Frequência"}), 500, headers)

    # ── Endpoint: salvar link Loom ───────────────────────────────────────────
    if request.method == "POST" and request.args.get("action") == "save_loom":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = body.get("short_token", "").strip()
            loom_url    = body.get("loom_url", "").strip()
            if not short_token or not loom_url:
                return (jsonify({"error": "short_token e loom_url são obrigatórios"}), 400, headers)
            # Detecta se já tinha Loom (replaced) ou se é primeiro upload (added).
            # Falha do query NÃO bloqueia a mutation — só afeta a label do log.
            try:
                previous = query_loom(short_token)
            except Exception:
                previous = None
            save_loom(short_token, loom_url)
            _cache_invalidate_token(short_token)
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="loom_replaced" if previous else "loom_added",
                actor_email=admin.get("email"),
                message="trocou o vídeo Loom" if previous else "adicionou um vídeo Loom",
            )
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
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            short_token = body.get("short_token", "").strip()
            survey_data = body.get("survey_data", "").strip()
            if not short_token or not survey_data:
                return (jsonify({"error": "short_token e survey_data são obrigatórios"}), 400, headers)
            try:
                previous_survey = query_survey(short_token)
            except Exception:
                previous_survey = None
            save_survey(short_token, survey_data)
            _cache_invalidate_token(short_token)
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="survey_updated" if previous_survey else "survey_created",
                actor_email=admin.get("email"),
                message="ajustou perguntas da Survey" if previous_survey else "criou uma Survey",
            )
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

    # ── Endpoint: buscar negociação (Sales Center) ───────────────────────────
    # GET público — mesmo nível de acesso do report (quem tem o short_token,
    # vê). Devolve o checklist comercial cadastrado no Sales Center, com PI,
    # peças, proposta, features e volumes negociados. Devolve {"negotiation":
    # null} quando a campanha não está cadastrada (legacy pre-Sales Center) —
    # 200 OK pra o front esconder o botão sem precisar tratar erro.
    if request.method == "GET" and request.args.get("action") == "get_negotiation":
        short_token = (request.args.get("short_token") or request.args.get("token") or "").strip()
        if not short_token:
            return (jsonify({"error": "short_token é obrigatório"}), 400, headers)
        try:
            nego = query_negotiation(short_token)
            return (jsonify({"negotiation": nego}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR get_negotiation] {e}")
            return (jsonify({"error": "Erro ao buscar negociação"}), 500, headers)

    # ── Endpoint: salvar upload RMND/PDOOH ───────────────────────────────────
    if request.method == "POST" and request.args.get("action") == "save_upload":
        admin = authenticate_admin(request)
        if not admin:
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
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="rmnd_uploaded" if upload_type == "RMND" else "pdooh_uploaded",
                actor_email=admin.get("email"),
                message="subiu CSV do Amazon Ads" if upload_type == "RMND" else "subiu relatório PDOOH",
            )
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
            # Mensagem denormalizada — frontend prefere ler `message` direto
            # em vez de cruzar `payload` com team_members pra cada row.
            owner_parts = []
            if cp_email: owner_parts.append(f"CP={cp_email}")
            if cs_email: owner_parts.append(f"CS={cs_email}")
            owner_summary = ", ".join(owner_parts) if owner_parts else "removeu owners"
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="owner_changed",
                actor_email=admin.get("email"),
                message=f"alterou owner ({owner_summary})",
                payload={"cp_email": cp_email or None, "cs_email": cs_email or None},
            )
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
            # Invalida cache de cada membro + caches da lista. Audit log
            # vai uma row POR membro do grupo — assim cada report mostra a
            # ação no próprio changelog.
            member_tokens = [m["short_token"] for m in (group.get("members") or [])]
            for tok in member_tokens:
                _cache_invalidate_token(tok)
            other_tokens = [t for t in member_tokens]
            for tok in member_tokens:
                peers = [t for t in other_tokens if t != tok]
                audit_log.safe_write_event(
                    short_token=tok,
                    event_type="merge_linked",
                    actor_email=admin.get("email"),
                    message=f"agrupou com {', '.join(peers)}" if peers else "criou grupo",
                    payload={"merge_id": group.get("merge_id"), "peers": peers},
                )
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
            audit_log.safe_write_event(
                short_token=short_token,
                event_type="merge_unlinked",
                actor_email=admin.get("email"),
                message="removeu este token do agrupamento",
            )
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
            # Cada membro do grupo recebe uma entry — o setting muda como
            # cada report calcula RMND/PDOOH, então é relevante per-token.
            settings_parts = []
            if rmnd_mode  is not None: settings_parts.append(f"RMND={rmnd_mode}")
            if pdooh_mode is not None: settings_parts.append(f"PDOOH={pdooh_mode}")
            settings_summary = ", ".join(settings_parts) if settings_parts else "settings"
            for m in (group.get("members") or []):
                audit_log.safe_write_event(
                    short_token=m["short_token"],
                    event_type="merge_linked",  # reusa o type — é mudança de config do mesmo grupo
                    actor_email=admin.get("email"),
                    message=f"atualizou settings do agrupamento ({settings_summary})",
                    payload={"merge_id": merge_id, "rmnd_mode": rmnd_mode, "pdooh_mode": pdooh_mode},
                )
            return (jsonify({"group": group}), 200, headers)
        except merges.MergeError as e:
            return (jsonify({"error": str(e)}), e.code, headers)
        except Exception as e:
            logger.error(f"[ERROR update_merge_settings] {e}")
            return (jsonify({"error": "Erro ao atualizar settings"}), 500, headers)

    # ── Endpoints: Access Tracking + Audit Log (Analytics do report) ──────
    #
    # Stack:
    #   POST ?action=track_access    → público, ingere events do client (rate-limited)
    #   GET  ?action=report_analytics → admin, lê rollup + agregações
    #   GET  ?action=report_audit_log → admin, lê changelog de mudanças
    #   GET  ?action=access_summary  → admin, summary leve pra o badge do card
    #
    # Implementação em backend/access_tracking.py + backend/audit_log.py.

    # POST ?action=track_access — PÚBLICO (sem auth). Recebe pageview/heartbeat/
    # tab_change/session_end do client. Validamos token + bot UA + rate limit
    # antes de inserir. Falhas silenciosas (return 200) pra não vazar info.
    if request.method == "POST" and request.args.get("action") == "track_access":
        try:
            body = request.get_json(silent=True) or {}
            short_token = (body.get("short_token") or "").strip()
            share_id    = (body.get("share_id") or "").strip() or None
            session_id  = (body.get("session_id") or "").strip()
            event_type  = (body.get("event_type") or "").strip()
            # event_id do client habilita idempotência de retry — backend
            # reusa quando vier; senão gera novo. Necessário pra rollup
            # deduplicar via ROW_NUMBER OVER (PARTITION BY event_id).
            event_id    = (body.get("event_id") or "").strip() or None
            tab_id      = (body.get("tab_id") or "").strip() or None
            prev_tab_id = (body.get("prev_tab_id") or "").strip() or None
            duration_ms = body.get("duration_ms")
            viewport_w  = body.get("viewport_w")
            viewport_h  = body.get("viewport_h")
            referrer    = (body.get("referrer") or "").strip()
            client_ts   = (body.get("client_ts") or "").strip()

            # Validação 1: token existe (filtra lixo / scans)
            if not access_tracking.validate_short_token(short_token):
                return (jsonify({"ok": True}), 200, headers)

            # Validação 2: bot UA conhecido (Slackbot etc.)
            ua = request.headers.get("User-Agent", "")
            if access_tracking.is_blocked_bot(ua):
                return (jsonify({"ok": True}), 200, headers)

            # IP do client — pega do X-Forwarded-For (Cloud Functions atrás
            # do GFE). Se ausente, cai pro remote_addr.
            raw_ip = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            if not raw_ip:
                raw_ip = request.remote_addr or ""
            ip_hash = access_tracking.hash_ip(raw_ip) if raw_ip else None

            # Validação 3: rate limit por IP-hash
            if ip_hash and not access_tracking.rate_limit_check(ip_hash):
                return (jsonify({"ok": True}), 200, headers)

            # Timestamp do server vence drift do client
            when = access_tracking.validate_timestamp(client_ts)

            # is_internal: pode vir do client (hook frontend marca quando
            # detecta sessão admin no localStorage) — admin não deveria
            # disparar eventos, mas se escapar, marcamos pra filtragem.
            is_internal = bool(body.get("is_internal"))

            access_tracking.safe_write_event(
                short_token=short_token,
                share_id=share_id,
                session_id=session_id,
                event_type=event_type,
                event_id=event_id,
                tab_id=tab_id,
                prev_tab_id=prev_tab_id,
                device_family=access_tracking.device_family_from_ua(ua),
                ip_hash=ip_hash,
                is_internal=is_internal,
                duration_ms=duration_ms,
                viewport_w=viewport_w,
                viewport_h=viewport_h,
                referrer_host=access_tracking.extract_referrer_host(referrer),
                when=when,
            )
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            # Endpoint público — NUNCA propaga exceção pro caller.
            logger.error(f"[ERROR track_access] {e}")
            return (jsonify({"ok": True}), 200, headers)

    # GET ?action=report_analytics — admin-only. Devolve TUDO que o modal
    # precisa em 1 round-trip (kpis + series + tabs + devices + heatmap +
    # sessions + tracking_start_date). Range em dias (default 30).
    #
    # PERFORMANCE: cada query no BQ leva 1-4s. Em sequência seriam 15s
    # totais. Disparamos as 7 em PARALELO via _query_pool (já existe pra
    # fetch_campaign_data) — tempo total = max(query individual) ≈ 3-4s.
    #
    # Cache em memória 60s: admin abre o mesmo modal várias vezes na
    # sessão (ex: troca de campanha e volta) — primeira é cold, próximas
    # são instantâneas. Cache key = (short_token, range_days, include_internal).
    if request.method == "GET" and request.args.get("action") == "report_analytics":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            short_token = (request.args.get("token") or "").strip()
            if not short_token:
                return (jsonify({"error": "token é obrigatório"}), 400, headers)
            try:
                range_days = int(request.args.get("range", "30"))
            except ValueError:
                range_days = 30
            range_days = max(1, min(range_days, 365))
            include_internal = request.args.get("include_internal", "").lower() == "true"

            # Cache hit? Retorna na hora. TTL curto pra não atrasar
            # demais o reflexo de novos events (60s é bom trade-off:
            # admin clicando rápido em modais não bate BQ várias vezes,
            # mas dados ficam frescos o suficiente pra demos ao vivo).
            cache_key = (short_token, range_days, include_internal)
            cached = _cache_get(_analytics_cache, cache_key, _ANALYTICS_TTL)
            if cached is not None:
                return (jsonify(cached), 200, headers)

            # Paralelização: 7 queries independentes disparadas no pool
            # existente (16 workers). Tempo total ≈ max(query) em vez de
            # sum(queries).
            futures = {
                "summary":             _query_pool.submit(access_tracking.query_summary,            short_token, range_days, include_internal),
                "timeline":            _query_pool.submit(access_tracking.query_timeline,           short_token, range_days, include_internal),
                "tabs":                _query_pool.submit(access_tracking.query_tabs_breakdown,     short_token, range_days, include_internal),
                "ctas":                _query_pool.submit(access_tracking.query_ctas_breakdown,     short_token, range_days, include_internal),
                "devices":             _query_pool.submit(access_tracking.query_devices_breakdown,  short_token, range_days, include_internal),
                "heatmap":             _query_pool.submit(access_tracking.query_heatmap,            short_token, range_days, include_internal),
                "recent_sessions":     _query_pool.submit(access_tracking.query_recent_sessions,    short_token, 8, include_internal),
                "tracking_start_date": _query_pool.submit(access_tracking.query_tracking_start_date),
            }
            payload = {k: f.result() for k, f in futures.items()}

            _cache_set(_analytics_cache, cache_key, payload)
            return (jsonify(payload), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR report_analytics] {e}")
            return (jsonify({"error": "Erro ao buscar analytics"}), 500, headers)

    # GET ?action=access_summary — admin-only. Versão leve da agregação
    # pro badge do card no menu admin. Retorna {total_pageviews,
    # unique_sessions, last_access_at, range_days}. Range é fixo em 30d.
    if request.method == "GET" and request.args.get("action") == "access_summary":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            short_token = (request.args.get("token") or "").strip()
            if not short_token:
                return (jsonify({"error": "token é obrigatório"}), 400, headers)
            summary = access_tracking.query_summary(short_token, 30, include_internal=False)
            return (jsonify(summary), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR access_summary] {e}")
            return (jsonify({"error": "Erro ao buscar summary"}), 500, headers)

    # POST ?action=access_summary_batch — admin-only. Batched version pro
    # menu admin (270+ cards). Body: { tokens: [...] }. Resposta:
    # { summaries: { token: {total_pageviews, unique_sessions, last_at} } }.
    # POST porque a lista de tokens pode passar do limite de query string.
    if request.method == "POST" and request.args.get("action") == "access_summary_batch":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            tokens = body.get("tokens") or []
            if not isinstance(tokens, list):
                return (jsonify({"error": "tokens deve ser array"}), 400, headers)
            # Sanitiza: só strings, dedup, máximo 500 tokens por request
            tokens = list({t.strip() for t in tokens if isinstance(t, str) and t.strip()})
            tokens = tokens[:500]
            summaries = access_tracking.query_summary_batch(tokens, range_days=30)
            return (jsonify({"summaries": summaries}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR access_summary_batch] {e}")
            return (jsonify({"error": "Erro ao buscar batch"}), 500, headers)

    # GET ?action=report_audit_log — admin-only. Devolve o changelog de
    # mudanças (Loom adicionado, owner trocado, etc.) ordenado por
    # created_at DESC. Resolve actor_email → actor_name via teamMap quando
    # disponível (mantemos a denormalização na resposta pra o frontend
    # exibir direto sem JOIN).
    if request.method == "GET" and request.args.get("action") == "report_audit_log":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            short_token = (request.args.get("token") or "").strip()
            if not short_token:
                return (jsonify({"error": "token é obrigatório"}), 400, headers)
            try:
                limit = int(request.args.get("limit", "50"))
            except ValueError:
                limit = 50
            limit = max(1, min(limit, 200))
            events = audit_log.query_recent_events(short_token, limit)
            return (jsonify({"events": events}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR report_audit_log] {e}")
            return (jsonify({"error": "Erro ao buscar audit log"}), 500, headers)

    # GET ?action=data_freshness — admin-only. Frescor da base de dados
    # por DSP (MAX(date) por source). Devolve `server_now` (UTC ISO) pra
    # o frontend decidir o cutoff de "ainda não rodou às 7h" usando o
    # relógio do servidor — evita falso positivo se o client estiver em
    # outro fuso ou com clock skew.
    if request.method == "GET" and request.args.get("action") == "data_freshness":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            # `sources` = aterrissagem REAL por fonte (tabelas tratadas) — verdade
            # por-DSP, não contamina nem esconde. `unified_max` = frescor do OUTPUT
            # consolidado que os reports consomem (headline "reports atualizados?").
            # Comparar os dois distingue "fonte não entregou" de "só o unified
            # atrasou" — o front usa isso pra gatear o botão Reconstruir.
            landings = query_source_landings()
            unified_rows = query_data_freshness()
            unified_max = max(
                (r["max_date"] for r in unified_rows if r.get("max_date")),
                default=None,
            )
            return (jsonify({
                "sources":     landings,
                "unified_max": unified_max,
                "server_now":  datetime.now(timezone.utc).isoformat(),
            }), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR data_freshness] {e}")
            return (jsonify({"error": "Erro ao buscar freshness"}), 500, headers)

    # POST ?action=rebuild_unified — admin-only. Escape manual pra re-disparar
    # o job do Dagster que reconstrói as bases unificadas, quando o run diário
    # falhou (tipicamente porque uma fonte atrasou e a DAG pulou o `unified`).
    # Ver trigger_dagster_rebuild(). Idempotente — o job é full-rebuild.
    if request.method == "POST" and request.args.get("action") == "rebuild_unified":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            res = trigger_dagster_rebuild()
            if res.get("already_running"):
                logger.info(f"[rebuild_unified] clique deduplicado — run {res['run_id']} já em andamento (solicitante: {admin.get('email','?')})")
            else:
                logger.info(f"[rebuild_unified] run {res['run_id']} disparada por {admin.get('email','?')}")
            return (jsonify({"ok": True, **res}), 200, headers)
        except RuntimeError as e:
            # Falha esperada (config ausente / Dagster recusou) — mensagem amigável.
            return (jsonify({"error": str(e)}), 502, headers)
        except Exception as e:
            logger.exception(f"[ERROR rebuild_unified] {e}")
            return (jsonify({"error": "Erro ao disparar reconstrução"}), 500, headers)

    # ── Endpoints: PMP Deals (admin) ──────────────────────────────────────────
    # Análise das entregas dos deals de pagamento HYPR — substitui o fluxo
    # manual de baixar o report do Xandr Curate e alimentar a planilha
    # "HYPR Product Performance" no Google Sheets.
    #
    #   POST ?action=pmp_setup_schema           → cria tabelas idempotente
    #   GET  ?action=pmp_list                   → lista de deals + delivery agregada
    #   GET  ?action=pmp_get&deal_id=...        → detalhes + daily timeseries
    #   POST ?action=pmp_save_deal              → upsert master (campos manuais)
    #   POST ?action=pmp_archive_deal           → soft delete (is_archived=TRUE)
    #   POST ?action=pmp_sync_xandr             → sync v1 manual (deals_delivery)
    if request.method == "POST" and request.args.get("action") == "pmp_setup_schema":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            res = pmp_deals.setup_schema()
            return (jsonify({"ok": True, "tables": res}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR pmp_setup_schema] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "GET" and request.args.get("action") == "pmp_list":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            include_archived = (request.args.get("include_archived") or "").lower() in ("1", "true", "yes")
            deals = pmp_deals.list_deals(include_archived=include_archived)
            return (jsonify({"deals": deals}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR pmp_list] {e}")
            return (jsonify({"error": "Erro ao listar deals"}), 500, headers)

    if request.method == "GET" and request.args.get("action") == "pmp_get":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            deal_id = (request.args.get("deal_id") or "").strip()
            if not deal_id:
                return (jsonify({"error": "deal_id obrigatório"}), 400, headers)
            deal = pmp_deals.get_deal(deal_id)
            if not deal:
                return (jsonify({"error": "Deal não encontrado"}), 404, headers)
            return (jsonify(deal), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR pmp_get] {e}")
            return (jsonify({"error": "Erro ao buscar deal"}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "pmp_save_deal":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            deal_id = (body.get("deal_id") or "").strip()
            if not deal_id:
                return (jsonify({"error": "deal_id obrigatório"}), 400, headers)
            # Remove deal_id e metadados read-only do payload de fields.
            fields = {k: v for k, v in body.items()
                       if k not in ("deal_id", "created_by", "created_at",
                                     "updated_by", "updated_at")}
            # Strings vazias viram NULL (permite limpar campo no front).
            for k, v in list(fields.items()):
                if isinstance(v, str) and v.strip() == "":
                    fields[k] = None
            deal = pmp_deals.save_deal(
                deal_id=deal_id,
                fields=fields,
                updated_by=admin.get("email", "unknown"),
            )
            return (jsonify(deal), 200, headers)
        except ValueError as ve:
            return (jsonify({"error": str(ve)}), 400, headers)
        except Exception as e:
            logger.error(f"[ERROR pmp_save_deal] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "pmp_archive_deal":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            deal_id = (body.get("deal_id") or "").strip()
            archive = bool(body.get("archive", True))
            if not deal_id:
                return (jsonify({"error": "deal_id obrigatório"}), 400, headers)
            if archive:
                pmp_deals.archive_deal(deal_id, admin.get("email", "unknown"))
            else:
                pmp_deals.unarchive_deal(deal_id, admin.get("email", "unknown"))
            return (jsonify({"ok": True}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR pmp_archive_deal] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    # ── Endpoint: sync Xandr Curate → pmp_deals_delivery (v1) ────────────────
    # Roda 3 passos: auth → POST /report → poll → download → upsert no BQ.
    # Mantido como sync v1 standalone (deal-level, sem line items). O cron
    # diário roda o `pmp_sync_v2` que cobre a granularidade que a UI usa.
    # Aceita scheduler-auth via X-Scheduler-Secret pra uso futuro.
    #
    # Body opcional:
    #   {report_interval: "yesterday"|"last_7_days"|"last_month"|"month_to_date"}
    # ou
    #   {start_date: "YYYY-MM-DD", end_date: "YYYY-MM-DD"}
    #
    # Default = last_7_days (cobre eventual atraso de pipeline do Xandr).
    if request.method == "POST" and request.args.get("action") == "pmp_sync_xandr":
        # Auth: admin OU scheduler. Scheduler usa segredo compartilhado
        # via header X-Scheduler-Secret (configurado no Cloud Scheduler job).
        actor = "unknown"
        scheduler_secret_env = os.environ.get("PMP_SCHEDULER_SECRET", "")
        provided_secret = request.headers.get("X-Scheduler-Secret", "")
        is_scheduler = bool(scheduler_secret_env) and provided_secret == scheduler_secret_env

        if is_scheduler:
            actor = "scheduler"
        else:
            admin = authenticate_admin(request)
            if not admin:
                return (jsonify({"error": "Não autorizado"}), 401, headers)
            actor = admin.get("email", "unknown")

        try:
            body = request.get_json(silent=True) or {}
            start_raw = (body.get("start_date") or "").strip()
            end_raw   = (body.get("end_date") or "").strip()
            interval  = (body.get("report_interval") or "last_7_days").strip()

            start_date = None
            end_date   = None
            if start_raw and end_raw:
                try:
                    start_date = datetime.strptime(start_raw, "%Y-%m-%d").date()
                    end_date   = datetime.strptime(end_raw,   "%Y-%m-%d").date()
                except ValueError:
                    return (jsonify({"error": "Formato de data inválido — use YYYY-MM-DD"}), 400, headers)
                if start_date > end_date:
                    return (jsonify({"error": "start_date precisa ser ≤ end_date"}), 400, headers)

            summary = xandr_curate.sync(
                start_date=start_date,
                end_date=end_date,
                report_interval=interval,
                created_by=actor,
            )
            return (jsonify(summary), 200, headers)
        except xandr_curate.XandrError as xe:
            logger.error(f"[ERROR pmp_sync_xandr] {xe}")
            return (jsonify({"error": str(xe)}), 502, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_sync_xandr] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    # ── Endpoints: PMP Lines v2 (admin) ──────────────────────────────────────
    # API redesenhada em volta de LINE ITEM (a unidade real do negócio),
    # enriquecida com Hypr Command via line.code = checklists.short_token.
    #
    #   GET  ?action=pmp_lines_list                    → lista enriquecida
    #   GET  ?action=pmp_lines_window&date_from&date_to → métricas agregadas na janela
    #   GET  ?action=pmp_lines_timeseries&date_from&date_to → série diária por line (Analytics)
    #   GET  ?action=pmp_line_get&line_id=...          → drill-down + daily
    #   POST ?action=pmp_save_line_overrides           → campos manuais
    #   GET  ?action=pmp_suggest_links&line_id=...     → fuzzy match Command
    #   POST ?action=pmp_link_command                  → PUT code no Xandr + local
    #   POST ?action=pmp_sync_v2                       → orquestra full sync
    #
    # `pmp_sync_v2` é o endpoint que o Cloud Scheduler dispara 1x/dia às 04:00
    # BRT (header X-Scheduler-Secret, body {"report_interval":"last_7_days"}).
    # Setup do job é mantido idempotente em backend/deploy.sh.
    if request.method == "GET" and request.args.get("action") == "pmp_lines_list":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            include_archived = (request.args.get("include_archived") or "").lower() in ("1","true","yes")
            only_active      = (request.args.get("only_active") or "1").lower() in ("1","true","yes")
            lines = pmp_lines.list_lines(include_archived=include_archived, only_active=only_active)
            return (jsonify({"lines": lines}), 200, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_lines_list] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    # Métricas de delivery agregadas por line DENTRO de uma janela [date_from, date_to].
    # Usado pelo Histórico pra "janelar" cost/revenue/margem/imps (tipo filtro de
    # Excel). PI não entra — é valor de contrato, sempre cheio no frontend.
    if request.method == "GET" and request.args.get("action") == "pmp_lines_window":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            date_from = (request.args.get("date_from") or "").strip()
            date_to   = (request.args.get("date_to")   or "").strip()
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_from) or not re.match(r"^\d{4}-\d{2}-\d{2}$", date_to):
                return (jsonify({"error": "date_from/date_to obrigatórios (YYYY-MM-DD)"}), 400, headers)
            metrics = pmp_lines.window_metrics(date_from, date_to)
            return (jsonify({"metrics": metrics}), 200, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_lines_window] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    # Série diária de delivery por line dentro de [date_from, date_to]. Uma row
    # por (line_id, day) — alimenta o Analytics do PMP, que fatia por dia/mês e
    # aplica filtros de line client-side. Difere do window (que soma a janela
    # inteira). Scan barato graças à partição por `day`.
    if request.method == "GET" and request.args.get("action") == "pmp_lines_timeseries":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            date_from = (request.args.get("date_from") or "").strip()
            date_to   = (request.args.get("date_to")   or "").strip()
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_from) or not re.match(r"^\d{4}-\d{2}-\d{2}$", date_to):
                return (jsonify({"error": "date_from/date_to obrigatórios (YYYY-MM-DD)"}), 400, headers)
            rows = pmp_lines.timeseries(date_from, date_to)
            return (jsonify({"rows": rows}), 200, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_lines_timeseries] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "GET" and request.args.get("action") == "pmp_line_get":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            line_id_raw = (request.args.get("line_id") or "").strip()
            if not line_id_raw.isdigit():
                return (jsonify({"error": "line_id obrigatório (int)"}), 400, headers)
            line = pmp_lines.get_line(int(line_id_raw))
            if not line:
                return (jsonify({"error": "Line não encontrada"}), 404, headers)
            return (jsonify(line), 200, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_line_get] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "pmp_save_line_overrides":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            line_id = body.get("line_id")
            if not isinstance(line_id, int) and not (isinstance(line_id, str) and line_id.isdigit()):
                return (jsonify({"error": "line_id obrigatório (int)"}), 400, headers)
            line_id = int(line_id)
            fields = {k: v for k, v in body.items() if k != "line_id"}
            for k, v in list(fields.items()):
                if isinstance(v, str) and v.strip() == "":
                    fields[k] = None
            line = pmp_lines.save_line_overrides(line_id, fields, admin.get("email","unknown"))
            return (jsonify(line), 200, headers)
        except ValueError as ve:
            return (jsonify({"error": str(ve)}), 400, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_save_line_overrides] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "GET" and request.args.get("action") == "pmp_suggest_links":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            line_id_raw = (request.args.get("line_id") or "").strip()
            if not line_id_raw.isdigit():
                return (jsonify({"error": "line_id obrigatório"}), 400, headers)
            suggestions = pmp_lines.suggest_command_links(int(line_id_raw))
            return (jsonify({"suggestions": suggestions}), 200, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_suggest_links] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "pmp_link_command":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            line_id = int(body.get("line_id") or 0)
            short_token = (body.get("short_token") or "").strip().upper()
            if not line_id or not short_token:
                return (jsonify({"error": "line_id e short_token obrigatórios"}), 400, headers)
            existing = pmp_lines.is_token_in_use(short_token, exclude_line_id=line_id)
            if existing and not body.get("force"):
                return (jsonify({
                    "error": f"short_token {short_token} já está vinculado à line {existing}",
                    "conflict_line_id": existing,
                }), 409, headers)
            # 1) PUT no Xandr (com retry pra token expirado)
            xandr_curate.set_line_code(line_id, short_token)
            # 2) Atualiza local + refresca tabela enriched
            pmp_lines.set_line_code_local(line_id, short_token, admin.get("email","unknown"))
            line = pmp_lines.get_line(line_id)
            return (jsonify(line), 200, headers)
        except xandr_curate.XandrError as xe:
            logger.warning(f"[pmp_link_command] xandr err: {xe}")
            return (jsonify({"error": str(xe)}), 502, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_link_command] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    # ── Endpoints: PMP Line Groups (admin) ────────────────────────────────────
    # Agrupa N lines do Xandr sob o MESMO PI compartilhado (A/B test, Fixed
    # vs Flex, etc.). Espelha a UX do Merge Reports mas opera em line_id
    # em vez de short_token.
    if request.method == "GET" and request.args.get("action") == "pmp_groupable_lines":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            line_id_raw = (request.args.get("line_id") or "").strip()
            if not line_id_raw.isdigit():
                return (jsonify({"error": "line_id obrigatório"}), 400, headers)
            lines = pmp_groups.list_groupable_lines(int(line_id_raw))
            return (jsonify({"lines": lines}), 200, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_groupable_lines] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "pmp_group_lines":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            line_ids = body.get("line_ids") or []
            if not isinstance(line_ids, list) or len(line_ids) < 2:
                return (jsonify({"error": "line_ids precisa ser lista com ≥ 2 IDs"}), 400, headers)
            try:
                line_ids = [int(x) for x in line_ids]
            except (TypeError, ValueError):
                return (jsonify({"error": "line_ids devem ser inteiros"}), 400, headers)
            group = pmp_groups.group_lines(
                line_ids=line_ids,
                short_token=(body.get("short_token") or "").strip() or None,
                group_name=(body.get("group_name") or "").strip() or None,
                created_by=admin.get("email", "unknown"),
            )
            return (jsonify(group), 200, headers)
        except pmp_groups.GroupError as ge:
            return (jsonify({"error": str(ge)}), ge.code, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_group_lines] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "pmp_ungroup_line":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            line_id = body.get("line_id")
            if line_id is None or (isinstance(line_id, str) and not line_id.isdigit()):
                return (jsonify({"error": "line_id obrigatório"}), 400, headers)
            res = pmp_groups.ungroup_line(int(line_id), admin.get("email", "unknown"))
            return (jsonify(res), 200, headers)
        except pmp_groups.GroupError as ge:
            return (jsonify({"error": str(ge)}), ge.code, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_ungroup_line] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "GET" and request.args.get("action") == "pmp_group_get":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            group_id = (request.args.get("group_id") or "").strip()
            if not group_id:
                return (jsonify({"error": "group_id obrigatório"}), 400, headers)
            group = pmp_groups.get_group(group_id)
            if not group:
                return (jsonify({"error": "Grupo não encontrado"}), 404, headers)
            return (jsonify(group), 200, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_group_get] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "pmp_group_update":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            group_id = (body.get("group_id") or "").strip()
            if not group_id:
                return (jsonify({"error": "group_id obrigatório"}), 400, headers)
            group = pmp_groups.update_group_meta(
                group_id=group_id,
                group_name=body.get("group_name"),
                short_token=body.get("short_token"),
                notes=body.get("notes"),
                updated_by=admin.get("email", "unknown"),
            )
            return (jsonify(group), 200, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_group_update] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "pmp_sync_v2":
        scheduler_secret_env = os.environ.get("PMP_SCHEDULER_SECRET", "")
        provided_secret = request.headers.get("X-Scheduler-Secret", "")
        is_scheduler = bool(scheduler_secret_env) and provided_secret == scheduler_secret_env
        actor = "scheduler" if is_scheduler else None
        if not is_scheduler:
            admin = authenticate_admin(request)
            if not admin:
                return (jsonify({"error": "Não autorizado"}), 401, headers)
            actor = admin.get("email","unknown")
        try:
            body = request.get_json(silent=True) or {}
            interval = (body.get("report_interval") or "last_7_days").strip()
            advertiser_id = 5472841  # HYPR — único advertiser do member 13053
            io_res     = xandr_curate.sync_insertion_orders(advertiser_id=advertiser_id)
            line_res   = xandr_curate.sync_line_items(advertiser_id=advertiser_id)
            deliv_res  = xandr_curate.sync_delivery_by_line(report_interval=interval)
            # Recopia o espelho de checklists do Command ANTES do refresh, senão
            # checklists novos nunca chegam ao espelho e a auto-vinculação fica cega.
            mirror_res = pmp_lines.sync_checklists_mirror()
            pmp_lines.refresh_enriched_table()
            # Push do compplan pra planilha Google (se conectada). Best-effort:
            # falha aqui não pode derrubar o sync do Xandr — o erro fica em
            # last_error da integração (alerta de stale cobre o resto).
            try:
                compplan_res = compplan_sheet.sync_if_connected()
            except Exception as ce:
                logger.warning(f"[pmp_sync_v2 compplan push] {ce}")
                compplan_res = {"error": str(ce)}
            return (jsonify({
                "actor": actor,
                "insertion_orders": io_res,
                "line_items":       line_res,
                "delivery":         deliv_res,
                "checklists_mirror": mirror_res,
                "view_refreshed":   True,
                "compplan_sheet":   compplan_res,
            }), 200, headers)
        except xandr_curate.XandrError as xe:
            return (jsonify({"error": str(xe)}), 502, headers)
        except Exception as e:
            logger.exception(f"[ERROR pmp_sync_v2] {e}")
            return (jsonify({"error": str(e)}), 500, headers)

    # ── Endpoints: Compplan Sheet (admin) ────────────────────────────────────
    # Planilha Google auto-atualizada com o compplan do PMP (1 row por deal,
    # all-time, modelo HYPR_PMP_Deals_All-Time). Integração singleton na
    # sheets_integrations (target_type='compplan'); push automático no fim
    # de cada pmp_sync_v2. Ver compplan_sheet.py.
    if request.method == "POST" and request.args.get("action") == "compplan_sheet_connect":
        admin = authenticate_admin(request)
        if not admin:
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            code         = (body.get("code") or "").strip()
            redirect_uri = (body.get("redirect_uri") or "postmessage").strip()
            if not code:
                return (jsonify({"error": "code é obrigatório"}), 400, headers)
            tokens = sheets_integration.exchange_code_for_tokens(code, redirect_uri)
            refresh_token = tokens.get("refresh_token")
            if not refresh_token:
                return (
                    jsonify({"error": "refresh_token ausente. Tente novamente — pode ser preciso revogar e reautorizar o app."}),
                    400, headers,
                )
            result = compplan_sheet.create_compplan_sheet(
                refresh_token=refresh_token,
                member_email=admin.get("email") or "unknown",
            )
            return (jsonify({
                "status":          "active",
                "spreadsheet_id":  result["spreadsheet_id"],
                "spreadsheet_url": result["spreadsheet_url"],
            }), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR compplan_sheet_connect] {e}")
            return (jsonify({"error": f"Erro ao criar sheet do compplan: {e}"}), 500, headers)

    if request.method == "GET" and request.args.get("action") == "compplan_sheet_status":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            status = sheets_integration.status_for_response(
                compplan_sheet.COMPPLAN_TARGET_ID,
                is_admin=True,
                target_type=sheets_integration.TARGET_COMPPLAN,
            )
            return (jsonify({"integration": status}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR compplan_sheet_status] {e}")
            return (jsonify({"error": "Erro ao buscar status"}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "compplan_sheet_sync_now":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            compplan_sheet.sync_compplan_sheet()
            status = sheets_integration.status_for_response(
                compplan_sheet.COMPPLAN_TARGET_ID,
                is_admin=True,
                target_type=sheets_integration.TARGET_COMPPLAN,
            )
            return (jsonify({"ok": True, "integration": status}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR compplan_sheet_sync_now] {e}")
            return (jsonify({"error": f"Erro ao sincronizar: {e}"}), 500, headers)

    if request.method == "POST" and request.args.get("action") == "compplan_sheet_delete":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            body = request.get_json(silent=True) or {}
            result = sheets_integration.delete_integration(
                compplan_sheet.COMPPLAN_TARGET_ID,
                delete_sheet=bool(body.get("delete_sheet")),
                target_type=sheets_integration.TARGET_COMPPLAN,
            )
            return (jsonify({"ok": True, **result}), 200, headers)
        except Exception as e:
            logger.error(f"[ERROR compplan_sheet_delete] {e}")
            return (jsonify({"error": f"Erro ao excluir: {e}"}), 500, headers)

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
    # ── Endpoint: performers por período (admin) ─────────────────────────────
    # Top Performers do menu admin com filtro de janela temporal. Reagregar
    # campaign_results + unified_daily_performance_metrics restringindo `date`
    # à janela [from, to]. Resposta tem o mesmo shape do ?list=true pros
    # campos consumidos por computeTopPerformers — o front passa direto pra
    # função existente sem ramificação.
    #
    # Pacing histórico = realized/(daily_rate × overlap_days da janela com
    # contrato). 100% = entregou no ritmo do contrato durante a janela.
    if request.args.get("action") == "performers":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            from_raw = (request.args.get("from") or "").strip()
            to_raw   = (request.args.get("to")   or "").strip()
            if not from_raw or not to_raw:
                return (jsonify({"error": "Parâmetros 'from' e 'to' são obrigatórios (YYYY-MM-DD)"}), 400, headers)
            try:
                window_from = datetime.strptime(from_raw, "%Y-%m-%d").date()
                window_to   = datetime.strptime(to_raw,   "%Y-%m-%d").date()
            except ValueError:
                return (jsonify({"error": "Formato inválido — use YYYY-MM-DD"}), 400, headers)
            if window_from > window_to:
                return (jsonify({"error": "'from' precisa ser ≤ 'to'"}), 400, headers)
            # Janela máxima 365d. Sem teto, um admin curioso poderia escanear
            # anos de delivery numa request — escala BQ rapidamente.
            if (window_to - window_from).days > 365:
                return (jsonify({"error": "Janela máxima de 365 dias"}), 400, headers)

            t0 = time.time()
            force_refresh = request.args.get("refresh") == "true"
            cache_key = f"{from_raw}|{to_raw}"
            cached = None if force_refresh else _cache_get(_performers_period_cache, cache_key, _PERFORMERS_PERIOD_CACHE_TTL)
            if cached is not None:
                total_ms = int((time.time() - t0) * 1000)
                resp_headers = {
                    **headers,
                    "Cache-Control": "private, max-age=60",
                    "Server-Timing": f"performers;dur={total_ms};desc=\"hit\"",
                }
                return _etag_response(
                    {"campaigns": cached, "from": from_raw, "to": to_raw, "_cache": "hit"},
                    request,
                    resp_headers,
                )

            campaigns = query_performers_for_period(window_from, window_to)
            _cache_set(_performers_period_cache, cache_key, campaigns)
            total_ms = int((time.time() - t0) * 1000)
            resp_headers = {
                **headers,
                "Cache-Control": "private, max-age=60",
                "Server-Timing": f"performers;dur={total_ms};desc=\"miss\"",
            }
            return _etag_response(
                {"campaigns": campaigns, "from": from_raw, "to": to_raw, "_cache": "miss"},
                request,
                resp_headers,
            )
        except Exception as e:
            logger.error(f"[ERROR performers] {e}")
            return (jsonify({"error": "Erro ao calcular performers"}), 500, headers)

    if request.args.get("action") == "list_clients":
        if not authenticate_admin(request):
            return (jsonify({"error": "Não autorizado"}), 401, headers)
        try:
            t0 = time.time()
            force_refresh = request.args.get("refresh") == "true"
            # Refresh manual também invalida o cache da planilha de owners —
            # sem isso, admin que consertou a planilha continua vendo "sem
            # owner" porque o list_cache é rebuildado com sheet_cache stale.
            if force_refresh:
                owners.invalidate_cache()
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

            # Agregação + worklist + sparklines/trend — corpo compartilhado
            # com o warmup (ver _build_clients_payload).
            t_build = time.time()
            payload = _build_clients_payload(campaigns)
            build_ms = int((time.time() - t_build) * 1000)

            _cache_set(_clients_cache, "all", payload)
            total_ms = int((time.time() - t0) * 1000)
            resp_headers = {
                **headers,
                "Cache-Control": "private, max-age=30",
                "Server-Timing": (
                    f"list;dur={list_ms};desc=\"{'hit' if list_hit else 'miss'}\","
                    f"build;dur={build_ms},total;dur={total_ms}"
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
            # Refresh manual também invalida o cache da planilha de owners —
            # sem isso, admin que consertou a planilha continua vendo "sem
            # owner" porque o list_cache é rebuildado com sheet_cache stale.
            if force_refresh:
                owners.invalidate_cache()
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
            # Pós-venda na visão agregada: usa o do active_token (mês mais
            # recente) — é o fechamento mais atual do grupo. Drill-down por
            # mês mostra o pós-venda daquele mês via caminho single-token.
            try:
                active_tok = (data.get("merge_meta") or {}).get("active_token")
                pv = _pos_venda_public(active_tok) if active_tok else None
                if pv:
                    data = {**data, "pos_venda": pv}
            except Exception as e:
                logger.warning(f"[WARN attach pos_venda to merged view] {e}")
            data = _attach_audience_overrides(data)
            data = _attach_label_overrides(data)
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

        # Pós-venda (chip no header do report) — anexado AQUI, na camada de
        # serving, e não dentro de fetch_campaign_data: reports encerrados
        # costumam estar congelados (snapshot verbatim) e o pós-venda é salvo
        # justamente DEPOIS do freeze, no fechamento.
        pv = _pos_venda_public(target_token)
        if pv:
            data = {**data, "pos_venda": pv}

        data = _attach_audience_overrides(data)
        data = _attach_label_overrides(data)

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


def fetch_campaign_data(short_token, src=None):
    """
    Busca todos os dados de um report.

    `src` (opcional): dict {"unified": "`...`", "campaign_results": "`...`"}
    com overrides de fonte (já entre crases). Usado SÓ pelo builder de
    snapshot pra construir o congelado a partir de tabelas de recuperação
    (time-travel) quando as tabelas ao vivo estão corrompidas. None = fontes
    ao vivo normais (todo o tráfego público).

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
    src = src or {}
    _unified_src = src.get("unified")
    _cr_src      = src.get("campaign_results")

    # Janela de entrega (bound de datas) — só tokens cadastrados; default None.
    try:
        _win_from, _win_to = (query_delivery_windows().get(short_token) or (None, None))
    except Exception as e:
        logger.warning(f"[WARN fetch_campaign_data window {short_token}] {e}")
        _win_from, _win_to = (None, None)

    # Dispara campaign_info + auxiliares simultaneamente
    fut_campaign = _query_pool.submit(query_campaign_info, short_token, _cr_src)
    fut_agency   = _query_pool.submit(query_agency_override, short_token)
    aux_tasks = {
        "daily":  _query_pool.submit(query_daily,  short_token, _cr_src, _win_from, _win_to),
        "detail": _query_pool.submit(query_detail, short_token, _cr_src, _win_from, _win_to),
        "logo":   _query_pool.submit(query_logo,   short_token),
        "loom":   _query_pool.submit(query_loom,   short_token),
        "rmnd":   _query_pool.submit(query_upload, short_token, "RMND"),
        "pdooh":  _query_pool.submit(query_upload, short_token, "PDOOH"),
        "survey": _query_pool.submit(query_survey, short_token),
        "alcance_frequencia": _query_pool.submit(query_alcance_frequencia, "token", short_token),
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

    # Injeta early_end_date quando admin marcou encerramento antecipado.
    # `end_date` no payload PERMANECE intocado (= contrato original) — o
    # frontend cliente usa early_end_date só pra display do período. O
    # pacing math em query_totals abaixo continua usando end_date original,
    # mostrando a "perda" naturalmente (Opção B do design). `reason` e
    # `ended_by` são admin-only e NÃO entram no payload do cliente.
    early_map = _safe_get_early_ends()
    early_for_token = early_map.get(short_token)
    if early_for_token and early_for_token.get("early_end_date"):
        campaign_info["early_end_date"] = early_for_token["early_end_date"]

    # Override de core products ativos (curadoria admin). Quando presente, o front
    # esconde frentes fora do set INCLUSIVE as que têm entrega (o backend já zerou
    # o contrato delas em _fetch_contracts → gating por contrato cai sozinho; este
    # campo cobre o gating por ENTREGA). Ausente ≡ automático (deriva do checklist).
    try:
        _cp_active = query_core_product_overrides().get(short_token)
        if _cp_active:
            campaign_info["active_core_products"] = sorted(_cp_active)
    except Exception as e:
        logger.warning(f"[WARN active_core_products {short_token}] {e}")

    # Agência (override admin) — exibida no eyebrow do header do report.
    # Sem override, o campo fica ausente e o front cai pra agency do Sales
    # Center (negociação que o header já busca via get_negotiation).
    try:
        _agency_ov = fut_agency.result()
        if _agency_ov and _agency_ov.get("agency"):
            campaign_info["agency"] = _agency_ov["agency"]
    except Exception as e:
        logger.warning(f"[WARN agency_override {short_token}] {e}")

    # totals é o único que depende de campaign_info — dispara agora
    fut_totals = _query_pool.submit(query_totals, short_token, campaign_info, _unified_src, _win_from, _win_to)

    result = {"campaign": campaign_info}
    result["totals"] = _safe_future_result(fut_totals, "totals", default=[])
    for key, future in aux_tasks.items():
        # Falha em uma query auxiliar não deve derrubar o report inteiro.
        # Front sabe lidar com chaves nulas (logo, loom, survey, rmnd, pdooh).
        # Para daily/detail logamos e retornamos vazio para que a UI mostre
        # "sem dados" em vez de erro 500.
        nullable = key in ("logo", "loom", "rmnd", "pdooh", "survey", "sheets_integration")
        if key == "alcance_frequencia":
            default = {"alcance": "", "frequencia": "", "auto_alcance": False, "updated_at": ""}
        else:
            default = None if nullable else []
        result[key] = _safe_future_result(future, key, default=default)
    # Achatamos alcance_frequencia em chaves de topo (`alcance`, `frequencia`,
    # `auto_alcance`, `alcance_updated_at`) — frontend lê direto, sem
    # aninhamento. _resolve_alcance_frequencia aplica o fallback merge-scoped
    # (par (token, X) vazio → lê do grupo merge, cobrindo o save na "Visão
    # agregada") e é a MESMA função usada no overlay de report congelado.
    # Reaproveita o `af_token` já consultado em paralelo pelo _query_pool.
    af_token = result.pop("alcance_frequencia", None)
    result.update(_resolve_alcance_frequencia(short_token, af_token=af_token))
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
        "o2o_display_budget", "ooh_display_budget", "groundflow_display_budget",
        "o2o_video_budget", "ooh_video_budget", "groundflow_video_budget",
        "contracted_o2o_display_impressions", "contracted_ooh_display_impressions",
        "contracted_groundflow_display_impressions",
        "contracted_o2o_video_completions", "contracted_ooh_video_completions",
        "contracted_groundflow_video_completions",
        "bonus_o2o_display_impressions", "bonus_ooh_display_impressions",
        "bonus_groundflow_display_impressions",
        "bonus_o2o_video_completions", "bonus_ooh_video_completions",
        "bonus_groundflow_video_completions",
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
                      "contracted_groundflow_display_impressions",
                      "contracted_o2o_video_completions",   "contracted_ooh_video_completions",
                      "contracted_groundflow_video_completions",
                      "bonus_o2o_display_impressions", "bonus_ooh_display_impressions",
                      "bonus_groundflow_display_impressions",
                      "bonus_o2o_video_completions", "bonus_ooh_video_completions",
                      "bonus_groundflow_video_completions")
    MONEY_FIELDS = ("total_invested", "effective_total_cost", "effective_cost_with_over",
                    "o2o_display_budget", "ooh_display_budget", "groundflow_display_budget",
                    "o2o_video_budget", "ooh_video_budget", "groundflow_video_budget")

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
    `mode='merge'`  → 2 caminhos, dependendo do formato dos payloads:
        a) **Formato V2 RMND** (`{format: "amazon-ads-2026", rows: [...]}`):
           concat das `rows` de todos members + dedup por
           (date, adGroup, asin, sku, adProduct) — quando o mesmo registro
           aparece em 2+ tokens (períodos sobrepostos no upload), o do
           membro MAIS RECENTE prevalece. Resultado retornado como objeto
           V2 com `filters` somando os intervalos cobertos.
        b) **Formato legacy (array JSON)**: concatena os arrays como antes.
        Se um membro tem formato e outro tem outro, faz log e cai pra latest
        (ambos legacy e V2 numa mesma campanha não devia acontecer; se
        acontecer é sinal de migração incompleta).

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

    # mode == 'merge': parseia cada membro e classifica formato
    parsed_by_token = {}
    has_v2 = False
    has_legacy = False
    for t in members_sorted:
        raw = raw_by_token.get(t)
        if not raw:
            continue
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
        except Exception as e:
            logger.warning(f"[WARN _compose_asset_payload {key}] token={t} parse falhou: {e}; cai pra latest")
            return latest_non_null()
        parsed_by_token[t] = parsed
        if isinstance(parsed, dict) and parsed.get("format") == "amazon-ads-2026":
            has_v2 = True
        elif isinstance(parsed, list):
            has_legacy = True
        else:
            logger.warning(f"[WARN _compose_asset_payload {key}] token={t} payload em formato desconhecido; cai pra latest")
            return latest_non_null()

    if has_v2 and has_legacy:
        logger.warning(f"[WARN _compose_asset_payload {key}] mistura V2 + legacy entre membros; cai pra latest")
        return latest_non_null()

    if has_v2:
        return _merge_v2_amazon_ads(parsed_by_token, members_sorted)

    # Legacy: concatena arrays
    accumulated = []
    for t in members_sorted:
        parsed = parsed_by_token.get(t)
        if isinstance(parsed, list):
            accumulated.extend(parsed)
    if not accumulated:
        return None
    return json.dumps(accumulated)


def _merge_v2_amazon_ads(parsed_by_token, members_sorted):
    """Concat + dedup das rows V2 do RMND.

    Dedup key: (date, adProduct, adGroup, asin, sku). Quando o mesmo registro
    aparece em N members (períodos que se sobrepõem no upload do admin), o
    do membro mais RECENTE (último em members_sorted asc) prevalece — assume
    que dado mais novo é mais correto que retroativo. Sem dedup, totais
    duplicariam silenciosamente em qualquer dia coberto por 2 bases.
    """
    by_key = {}
    earliest_from = None
    latest_to = None
    all_ad_groups = set()
    uploaded_ats = []
    for t in members_sorted:
        parsed = parsed_by_token.get(t)
        if not isinstance(parsed, dict):
            continue
        rows = parsed.get("rows") or []
        for row in rows:
            if not isinstance(row, dict):
                continue
            key = (
                row.get("date"),
                row.get("adProduct"),
                row.get("adGroup"),
                row.get("asin"),
                row.get("sku"),
            )
            by_key[key] = row  # último (mais recente) prevalece
        flt = parsed.get("filters") or {}
        dr = flt.get("dateRange") or {}
        f, to = dr.get("from"), dr.get("to")
        if f and (earliest_from is None or f < earliest_from):
            earliest_from = f
        if to and (latest_to is None or to > latest_to):
            latest_to = to
        for g in flt.get("adGroups") or []:
            all_ad_groups.add(g)
        ua = parsed.get("uploadedAt")
        if ua:
            uploaded_ats.append(ua)

    if not by_key:
        return None

    composed = {
        "version": 2,
        "type": "RMND",
        "format": "amazon-ads-2026",
        "uploadedAt": max(uploaded_ats) if uploaded_ats else None,
        "filters": {
            "adGroups": sorted(all_ad_groups),
            "dateRange": {"from": earliest_from, "to": latest_to} if (earliest_from and latest_to) else None,
        },
        "rows": list(by_key.values()),
        "_merged": {
            "members": list(parsed_by_token.keys()),
            "rows_total": len(by_key),
        },
    }
    return json.dumps(composed)


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
        # Agência: prefere o ativo; fallback membro mais recente com valor
        # (mesma régua do logo/loom via first_non_null, mas campo aninhado).
        "agency":            active_camp.get("agency") or next(
            (
                (per_token[t].get("campaign") or {}).get("agency")
                for t in reversed(members_sorted)
                if (per_token[t].get("campaign") or {}).get("agency")
            ),
            None,
        ),
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

    # Alcance & Frequência da visão agregada: escopo próprio (merge_id), não
    # soma dos membros. A soma sobre-contaria usuários únicos que aparecem em
    # mais de um mês — o admin insere manualmente o valor agregado correto.
    af_merge = query_alcance_frequencia("merge", group["merge_id"])

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
        "alcance":            af_merge.get("alcance", "")    or "",
        "frequencia":         af_merge.get("frequencia", "") or "",
        "auto_alcance":       bool(af_merge.get("auto_alcance")),
        "alcance_updated_at": af_merge.get("updated_at", "") or "",
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


def query_logos_for_tokens(tokens):
    """Batch: {short_token_upper: logo_base64} pros tokens com logo cadastrado.

    Usado pelo Portal do Cliente pra exibir a logo PRÓPRIA de cada campanha no
    card (não só a co-brand do cliente). Uma única query; tokens sem logo ficam
    ausentes do dict.
    """
    if not tokens:
        return {}
    upper = sorted({(t or "").upper() for t in tokens if t})
    if not upper:
        return {}
    sql = f"""
        SELECT short_token, logo_base64
        FROM `{PROJECT_ID}.{DATASET_ASSETS}.client_logos`
        WHERE UPPER(short_token) IN UNNEST(@tokens)
          AND logo_base64 IS NOT NULL
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ArrayQueryParameter("tokens", "STRING", upper)]
    )
    try:
        rows = list(bq.query(sql, job_config=job_config).result())
        return {r["short_token"].upper(): r["logo_base64"] for r in rows if r["logo_base64"]}
    except Exception as e:
        logger.warning(f"[WARN query_logos_for_tokens] {e}")
        return {}


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


def query_data_freshness():
    """Devolve o MAX(date) por `source` na unified_daily_performance_metrics.

    Usado pelo indicador de frescor de dados no header admin. Cada fonte
    (DV360/Xandr/StackAdapt) é ingerida diariamente no rollup das 06h —
    se MAX(date) < ontem após 7h, o pipeline daquela fonte falhou.

    Query dinâmica (GROUP BY source sem hardcode de label) pra ser
    resiliente a novas fontes ou renames sem mexer no backend. Janela
    de 7 dias é só pra reduzir partition scan — não afeta o resultado
    porque a tabela tem rows novas todo dia.

    Tabela está na região US (mesma constraint das outras queries desta
    base) — passar location explícito.
    """
    cached = _cache_get(_data_freshness_cache, "all", _DATA_FRESHNESS_CACHE_TTL)
    if cached is not None:
        return cached
    sql = f"""
        SELECT
            source,
            MAX(date) AS max_date,
            COUNT(DISTINCT date) AS days_in_window
        FROM `{PROJECT_ID}.{DATASET_ASSETS}.unified_daily_performance_metrics`
        WHERE date >= DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL 7 DAY)
        GROUP BY source
        ORDER BY source
    """
    job_config = bigquery.QueryJobConfig()
    rows = bq.query(sql, job_config=job_config, location="US").result()
    out = []
    for r in rows:
        out.append({
            "source": r["source"],
            "max_date": r["max_date"].isoformat() if r["max_date"] else None,
            "days_in_window": int(r["days_in_window"] or 0),
        })
    _cache_set(_data_freshness_cache, "all", out)
    return out


# Fontes → tabela TRATADA por-fonte (prod_assets.<t>_daily_performance_metrics)
# + coluna de data e se ela é STRING (precisa SAFE_CAST). Diferente de
# query_data_freshness (que lê o OUTPUT consolidado `unified`), aqui medimos a
# aterrissagem REAL de cada fonte no seu próprio modelo dbt — verdade por-fonte,
# independente do unified. Crucial porque: (a) uma fonte travada (ex: DV360 sem
# export) skipa o unified e, lendo só o unified, TODAS as fontes parecem velhas;
# (b) uma fonte parada há +Nd some da janela do unified e deixa de alarmar. Ler
# a tratada distingue "fonte não entregou" (reconstruir é inútil) de "fontes
# prontas, só o unified atrasou" (reconstruir resolve).
_SOURCE_LANDING_TABLES = [
    ("DV360",      "dv360_daily_performance_metrics",      "date", False),
    ("Amazon",     "amazon_daily_performance_metrics",     "date", False),
    ("XANDR",      "xandr_daily_performance_metrics",      "date", True),
    ("StackAdapt", "stackadapt_daily_performance_metrics", "date", False),
]


def query_source_landings():
    """MAX(date) por fonte nas tabelas TRATADAS — aterrissagem real por DSP.

    Cada fonte é medida na sua própria `prod_assets.<t>_daily_performance_metrics`
    (não no `unified`), então uma fonte que atrasa não contamina o frescor das
    outras nem some por estar fora de janela. Devolve [{source, max_date}].
    Região US (mesma constraint das demais). Cacheado com o mesmo TTL.
    """
    cached = _cache_get(_source_landings_cache, "all", _DATA_FRESHNESS_CACHE_TTL)
    if cached is not None:
        return cached
    selects = []
    for label, table, col, is_str in _SOURCE_LANDING_TABLES:
        expr = f"SAFE_CAST({col} AS DATE)" if is_str else col
        selects.append(
            f'SELECT "{label}" AS source, MAX({expr}) AS max_date '
            f"FROM `{PROJECT_ID}.{DATASET_ASSETS}.{table}`"
        )
    sql = "\nUNION ALL\n".join(selects)
    rows = bq.query(sql, job_config=bigquery.QueryJobConfig(), location="US").result()
    out = [
        {"source": r["source"],
         "max_date": r["max_date"].isoformat() if r["max_date"] else None}
        for r in rows
    ]
    out.sort(key=lambda r: r["source"])
    _cache_set(_source_landings_cache, "all", out)
    return out


# ── Trigger de reconstrução das bases unificadas via Dagster+ ────────────────
# A `prod_assets.unified_daily_performance_metrics` (e demais unified_*) é
# materializada por um job dbt orquestrado no Dagster+ (org `hypr`, deployment
# `prod`, location `hyprster`, job `dbt_assets_freshness_06am_job`). O job roda
# 06h diário, mas depende das 4 fontes (DV360/Amazon/StackAdapt/Xandr) terem
# aterrissado — quando uma atrasa (tipicamente o DV360, horário variável), o
# run das 06h pula o `unified` e as bases congelam. Este endpoint é o escape
# manual: dispara uma nova run do job sob demanda (mesmo efeito do "Materialize"
# na UI). Idempotente — o job é full-rebuild.
#
# Config via env (injetada do Secret Manager no Cloud Run):
#   DAGSTER_API_TOKEN     (obrigatório — user token do Dagster+)
#   DAGSTER_GRAPHQL_URL   default https://hypr.dagster.cloud/prod/graphql
#   DAGSTER_JOB_NAME      default dbt_assets_freshness_06am_job
#   DAGSTER_REPO_LOCATION default hyprster
#   DAGSTER_REPO_NAME     default __repository__
_DAGSTER_LAUNCH_MUTATION = """
mutation($params: ExecutionParams!) {
  launchRun(executionParams: $params) {
    __typename
    ... on LaunchRunSuccess { run { runId } }
    ... on PythonError { message }
    ... on RunConfigValidationInvalid { errors { message } }
    ... on PipelineNotFoundError { message }
    ... on InvalidSubsetError { message }
  }
}
"""

# Runs do job ainda não terminadas (fila ou executando). Usada pra deduplicar
# o "Reconstruir agora": clique repetido (mesmo admin impaciente ou dois admins
# em máquinas diferentes) NÃO dispara run nova — devolve a que já roda. Em
# 09/06 quatro cliques em 73min custaram ~US$ 187 à toa; o job leva ~15min.
_DAGSTER_ACTIVE_RUNS_QUERY = """
query($job: String!) {
  runsOrError(
    filter: {pipelineName: $job, statuses: [QUEUED, NOT_STARTED, STARTING, STARTED]}
    limit: 1
  ) {
    __typename
    ... on Runs { results { runId } }
  }
}
"""


def _dagster_graphql(graphql_url, token, query, variables):
    """POST GraphQL no Dagster+; devolve `data` ou lança RuntimeError amigável."""
    import urllib.error

    req = urllib.request.Request(
        graphql_url,
        data=json.dumps({"query": query, "variables": variables}).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Dagster-Cloud-Api-Token": token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:200] if hasattr(e, "read") else ""
        raise RuntimeError(f"Dagster respondeu HTTP {e.code}. {detail}")
    except Exception as e:
        raise RuntimeError(f"Falha ao contatar o Dagster: {e}")

    if body.get("errors"):
        raise RuntimeError(f"Dagster GraphQL: {body['errors'][0].get('message', 'erro desconhecido')[:200]}")
    return body.get("data") or {}


def trigger_dagster_rebuild():
    """Dispara uma run do job de bases unificadas no Dagster+.

    Antes de lançar, checa se já existe run do job em andamento (fila ou
    executando) — se sim, devolve essa run com already_running=True em vez de
    empilhar outra. Cada run completa do job custa caro em BigQuery; cliques
    repetidos eram cobrados integralmente.

    Devolve {"run_id", "run_url", "already_running"}. Lança RuntimeError com
    mensagem amigável em qualquer falha (config ausente, HTTP, GraphQL, ou
    recusa do launchRun).
    """
    token = os.environ.get("DAGSTER_API_TOKEN", "").strip()
    if not token:
        raise RuntimeError("Reconstrução não configurada (DAGSTER_API_TOKEN ausente no ambiente).")

    graphql_url = os.environ.get("DAGSTER_GRAPHQL_URL", "https://hypr.dagster.cloud/prod/graphql")
    job_name    = os.environ.get("DAGSTER_JOB_NAME", "dbt_assets_freshness_06am_job")
    repo_loc    = os.environ.get("DAGSTER_REPO_LOCATION", "hyprster")
    repo_name   = os.environ.get("DAGSTER_REPO_NAME", "__repository__")
    base        = graphql_url.replace("/graphql", "")

    # Dedupe: run em andamento → devolve ela, não dispara outra. Se a checagem
    # falhar (ex.: indisponibilidade momentânea do Dagster), o launchRun logo
    # abaixo falharia igual — então deixamos o erro subir daqui mesmo.
    active = _dagster_graphql(graphql_url, token, _DAGSTER_ACTIVE_RUNS_QUERY, {"job": job_name})
    runs = ((active.get("runsOrError") or {}).get("results")) or []
    if runs:
        run_id = runs[0]["runId"]
        return {"run_id": run_id, "run_url": f"{base}/runs/{run_id}", "already_running": True}

    data = _dagster_graphql(graphql_url, token, _DAGSTER_LAUNCH_MUTATION, {"params": {
        "selector": {
            "repositoryLocationName": repo_loc,
            "repositoryName": repo_name,
            "jobName": job_name,
        },
        "executionMetadata": {"tags": [
            {"key": "dagster/from_ui", "value": "true"},
            {"key": "triggered_by", "value": "report-hub"},
        ]},
    }})

    res = data.get("launchRun") or {}
    if res.get("__typename") != "LaunchRunSuccess":
        msg = res.get("message") or res.get("errors") or res.get("__typename") or "recusado"
        raise RuntimeError(f"Dagster não lançou a run: {msg}")

    run_id = res["run"]["runId"]
    return {"run_id": run_id, "run_url": f"{base}/runs/{run_id}", "already_running": False}


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
# Agency override — agência do cliente exibida no eyebrow do header do report
# (ex: "OBOTICÁRIO · ALMAPBBDO"). Fonte primária é o Sales Center
# (checklists.agency, que o front já busca via get_negotiation); este override
# cobre campanhas pré-Sales Center e correções. Precedência no front:
# override > Sales Center > nada. Salvar agency vazia LIMPA o override
# (volta ao fallback do Sales Center).
# ─────────────────────────────────────────────────────────────────────────────
def _agency_override_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.campaign_agency_overrides"


_agency_override_table_ensured = False
_agency_override_ensure_lock = threading.Lock()


def _ensure_agency_override_table() -> None:
    """Cria a tabela `campaign_agency_overrides` se não existir. Idempotente."""
    global _agency_override_table_ensured
    if _agency_override_table_ensured:
        return
    with _agency_override_ensure_lock:
        if _agency_override_table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_agency_override_table_id()}` (
                short_token STRING NOT NULL,
                agency      STRING,
                updated_by  STRING,
                updated_at  TIMESTAMP
            )
        """
        bq.query(sql).result()
        _agency_override_table_ensured = True


def save_agency_override(short_token: str, agency: str | None, updated_by: str | None = None):
    """UPSERT da agência na tabela campaign_agency_overrides (atômico via MERGE).
    `agency` vazia/None grava NULL — semanticamente "override limpo"."""
    _ensure_agency_override_table()
    agency_clean = (agency or "").strip() or None
    sql = f"""
        MERGE `{_agency_override_table_id()}` T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
            UPDATE SET agency = @agency, updated_at = CURRENT_TIMESTAMP(), updated_by = @updated_by
        WHEN NOT MATCHED THEN
            INSERT (short_token, agency, updated_at, updated_by)
            VALUES (@token, @agency, CURRENT_TIMESTAMP(), @updated_by)
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token",      "STRING", short_token),
            bigquery.ScalarQueryParameter("agency",     "STRING", agency_clean),
            bigquery.ScalarQueryParameter("updated_by", "STRING", updated_by),
        ]
    )
    bq.query(sql, job_config=job_config).result()


def query_agency_override(short_token: str):
    """Retorna {agency, updated_by} do override do token, ou None se não existe
    (linha ausente OU agency NULL — ambos significam "sem override")."""
    _ensure_agency_override_table()
    sql = f"""
        SELECT agency, updated_by
        FROM `{_agency_override_table_id()}`
        WHERE short_token = @token AND agency IS NOT NULL
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    try:
        rows = list(bq.query(sql, job_config=job_config).result())
        if rows:
            return {"agency": rows[0]["agency"], "updated_by": rows[0]["updated_by"]}
    except Exception as e:
        logger.warning(f"[WARN query_agency_override] {e}")
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Core products override — curadoria admin de QUAIS frentes (O2O/OOH/GROUNDFLOW)
# aparecem no report de um token. Existe pra resolver uma classe de bug recorrente:
# ao encerrar uma campanha o CS edita o Command pra remover uma frente, mas
# `checklist_info` mantém `contracted_<frente>_*`/`bonus_<frente>_*` stale (a
# pipeline hyprster materializa o que o Command emite e não zera frente removida).
# Como o report deriva a presença da frente do contrato (contracted_* > 0) — e lê
# isso AO VIVO até em report congelado (_overlay_live_contracts) — a frente
# "fantasma" reaparece. Ajuste de front ou UPDATE manual em checklist_info não
# seguram (read ao vivo + re-materialização da pipeline os sobrescrevem).
#
# Este override é a fonte autoritativa do Report Hub: quando presente, _fetch_contracts
# ZERA contratado/bônus das frentes fora do set — propagando pra TODA a matemática
# (budget/pacing/CPM/gating de tab), num único ponto. Mesma família de freeze /
# delivery_window / ABS override. Ausência ≡ "automático" (deriva do checklist).
# ─────────────────────────────────────────────────────────────────────────────
VALID_CORE_PRODUCTS = ("O2O", "OOH", "GROUNDFLOW")
# Prefixo de coluna em checklist_info por frente (espelha _compute_totals).
_CP_COLUMN_PREFIX = {"O2O": "o2o", "OOH": "ooh", "GROUNDFLOW": "groundflow"}


def _cp_override_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.report_core_products_override"


_cp_override_table_ensured = False
_cp_override_ensure_lock = threading.Lock()


def _ensure_cp_override_table() -> None:
    """Cria a tabela `report_core_products_override` se não existir. Idempotente."""
    global _cp_override_table_ensured
    if _cp_override_table_ensured:
        return
    with _cp_override_ensure_lock:
        if _cp_override_table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_cp_override_table_id()}` (
                short_token STRING NOT NULL,
                products    STRING,
                note        STRING,
                updated_by  STRING,
                updated_at  TIMESTAMP
            )
        """
        bq.query(sql).result()
        _cp_override_table_ensured = True


def _parse_cp_products(raw) -> set:
    """Normaliza 'O2O,OOH' (ou lista) → set válido contra VALID_CORE_PRODUCTS."""
    if not raw:
        return set()
    items = raw if isinstance(raw, (list, tuple, set)) else str(raw).split(",")
    return {p for p in (str(x).strip().upper() for x in items) if p in VALID_CORE_PRODUCTS}


def query_core_product_overrides() -> dict:
    """Retorna {short_token: set(products)} de TODOS os overrides cadastrados.
    Cacheado no TTL da lista (tabela pequena, só exceções curadas). Usado por
    _fetch_contracts (lookup por token, sem custo de query no caminho do report)."""
    cached = _cache_get(_cp_override_cache, "all", _LIST_CACHE_TTL)
    if cached is not None:
        return cached
    _ensure_cp_override_table()
    out = {}
    try:
        for row in bq.query(f"SELECT short_token, products FROM `{_cp_override_table_id()}`").result():
            products = _parse_cp_products(row["products"])
            if products:  # set vazio ≡ sem override (não esconde tudo)
                out[row["short_token"]] = products
    except Exception as e:
        logger.warning(f"[WARN query_core_product_overrides] {e}")
    _cache_set(_cp_override_cache, "all", out)
    return out


def query_core_product_override(short_token: str):
    """Override de um token: {products: [...], updated_by, updated_at} ou None."""
    _ensure_cp_override_table()
    sql = f"""
        SELECT products, updated_by, updated_at
        FROM `{_cp_override_table_id()}`
        WHERE short_token = @token
        LIMIT 1
    """
    jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", short_token)
    ])
    try:
        rows = list(bq.query(sql, job_config=jc).result())
        if rows:
            products = sorted(_parse_cp_products(rows[0]["products"]))
            if products:
                ts = rows[0]["updated_at"]
                return {"products": products,
                        "updated_by": rows[0]["updated_by"],
                        "updated_at": ts.isoformat() if ts else None}
    except Exception as e:
        logger.warning(f"[WARN query_core_product_override {short_token}] {e}")
    return None


def save_core_product_override(short_token: str, products, note: str | None = None,
                               updated_by: str | None = None):
    """UPSERT do override (atômico via MERGE). `products` = lista/set das frentes
    ATIVAS. Set vazio → DELETE (volta ao automático)."""
    _ensure_cp_override_table()
    valid = sorted(_parse_cp_products(products))
    if not valid:
        delete_core_product_override(short_token)
        return
    sql = f"""
        MERGE `{_cp_override_table_id()}` T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
            UPDATE SET products = @products, note = @note,
                       updated_by = @by, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN
            INSERT (short_token, products, note, updated_by, updated_at)
            VALUES (@token, @products, @note, @by, CURRENT_TIMESTAMP())
    """
    jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token",    "STRING", short_token),
        bigquery.ScalarQueryParameter("products", "STRING", ",".join(valid)),
        bigquery.ScalarQueryParameter("note",     "STRING", note),
        bigquery.ScalarQueryParameter("by",       "STRING", updated_by),
    ])
    bq.query(sql, job_config=jc).result()
    _cache_invalidate_token(short_token)


def delete_core_product_override(short_token: str):
    """Remove o override — token volta a derivar frentes do checklist (automático)."""
    _ensure_cp_override_table()
    jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", short_token)
    ])
    bq.query(f"DELETE FROM `{_cp_override_table_id()}` WHERE short_token = @token",
             job_config=jc).result()
    _cache_invalidate_token(short_token)


def _apply_cp_override_to_contracts(check_row, short_token):
    """Se há override de core products pro token, devolve um DICT do contrato com
    contratado/bônus ZERADO nas frentes fora do set. Sem override → devolve a Row
    original intacta (zero overhead, zero mudança de comportamento).

    Ponto ÚNICO: _fetch_contracts é a fonte de contrato do serve ao vivo
    (query_totals) E do overlay de report congelado — então zerar aqui propaga
    pra toda a matemática (budget/pacing/CPM) e pro gating de tab no front."""
    if check_row is None:
        return None
    try:
        active = query_core_product_overrides().get(short_token)
    except Exception as e:
        logger.warning(f"[WARN _apply_cp_override fetch {short_token}] {e}")
        return check_row
    if not active:
        return check_row
    # Materializa a Row num dict mutável e zera as frentes inativas.
    c = dict(check_row.items()) if hasattr(check_row, "items") else dict(check_row)
    for frente, prefix in _CP_COLUMN_PREFIX.items():
        if frente in active:
            continue
        for col in (f"contracted_{prefix}_display_impressions",
                    f"contracted_{prefix}_video_completions",
                    f"bonus_{prefix}_display_impressions",
                    f"bonus_{prefix}_video_completions"):
            if col in c:
                c[col] = 0
    return c


# ─────────────────────────────────────────────────────────────────────────────
# Campaign closure — admin marca campanha como "encerrada" depois de fazer o
# fechamento (sheet final, relatório, faturamento). Tabela `campaign_closures`
# guarda só os tokens fechados manualmente; ausência ≡ "ainda aberta".
#
# Combinado com end_date (que vem de query_campaigns_list), o frontend deriva
# 3 estados:
#   • in_flight        → end_date >= hoje
#   • awaiting_closure → end_date < hoje, sem closed_at, ≤30 dias do fim
#   • ended            → closed_at preenchido OU >30 dias do fim (auto-close)
#
# O auto-close de 30 dias é puro client-side — não persistimos closed_at
# automaticamente, só derivamos visualmente. Mantém o backend simples e
# permite reverter a regra sem migração.
# ─────────────────────────────────────────────────────────────────────────────
_closures_table_ensured = False
_closures_ensure_lock = threading.Lock()


def _closures_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.campaign_closures"


def _ensure_closures_table() -> None:
    """Cria a tabela `campaign_closures` se não existir. Idempotente."""
    global _closures_table_ensured
    if _closures_table_ensured:
        return
    with _closures_ensure_lock:
        if _closures_table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_closures_table_id()}` (
                short_token STRING NOT NULL,
                closed_at   TIMESTAMP NOT NULL,
                closed_by   STRING
            )
        """
        bq.query(sql).result()
        _closures_table_ensured = True


def save_campaign_closure(short_token: str, closed: bool, closed_by: str | None = None):
    """Marca/desmarca campanha como encerrada manualmente.

    closed=True  → UPSERT com closed_at=NOW
    closed=False → DELETE (volta pro estado derivado por end_date+30d)
    """
    _ensure_closures_table()
    if closed:
        sql = f"""
            MERGE `{_closures_table_id()}` T
            USING (SELECT @token AS short_token) S
            ON T.short_token = S.short_token
            WHEN MATCHED THEN
                UPDATE SET closed_at = CURRENT_TIMESTAMP(), closed_by = @closed_by
            WHEN NOT MATCHED THEN
                INSERT (short_token, closed_at, closed_by)
                VALUES (@token, CURRENT_TIMESTAMP(), @closed_by)
        """
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("token",     "STRING", short_token),
                bigquery.ScalarQueryParameter("closed_by", "STRING", closed_by),
            ]
        )
    else:
        sql = f"""
            DELETE FROM `{_closures_table_id()}`
            WHERE short_token = @token
        """
        job_config = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
        )
    bq.query(sql, job_config=job_config).result()


def query_all_closures() -> dict:
    """Retorna {short_token: closed_at_iso} de todas as campanhas fechadas.
    Tabela pequena (só fechadas) — full scan + cache atrelado ao TTL da lista.
    Tolera tabela inexistente (deploy novo)."""
    _ensure_closures_table()
    sql = f"""
        SELECT short_token, closed_at
        FROM `{_closures_table_id()}`
    """
    out = {}
    try:
        for row in bq.query(sql).result():
            ts = row["closed_at"]
            if ts:
                out[row["short_token"]] = ts.isoformat()
    except Exception as e:
        logger.warning(f"[WARN query_all_closures] {e}")
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Closure details — dados do fechamento coletados no popup "Marcar como
# encerrada": link do pós-venda (Google Slides) + se foi apresentado/enviado,
# link de material adicional (mesma pergunta) e nº de checkups semanais com o
# cliente (e-mails de fup/resumo).
#
# pos_venda_url/extra_url + modes vão pro payload PÚBLICO do report (chip
# "Pós-venda" no header). weekly_checkups é métrica interna — admin-only,
# nunca entra no payload do cliente.
# ─────────────────────────────────────────────────────────────────────────────
_closure_details_table_ensured = False
_closure_details_ensure_lock = threading.Lock()

_CLOSURE_DELIVERY_MODES = ("apresentado", "enviado")


def _closure_details_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.campaign_closure_details"


def _ensure_closure_details_table() -> None:
    """Cria a tabela `campaign_closure_details` se não existir. Idempotente."""
    global _closure_details_table_ensured
    if _closure_details_table_ensured:
        return
    with _closure_details_ensure_lock:
        if _closure_details_table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_closure_details_table_id()}` (
                short_token     STRING NOT NULL,
                pos_venda_url   STRING,
                pos_venda_mode  STRING,
                extra_url       STRING,
                extra_mode      STRING,
                weekly_checkups INT64,
                pos_venda_date  DATE,
                extra_date      DATE,
                updated_at      TIMESTAMP,
                updated_by      STRING
            )
        """
        bq.query(sql).result()
        # Migração leve: as colunas de data ("apresentado em") entraram depois
        # do launch — tabelas criadas pela versão anterior não as têm. ADD
        # COLUMN IF NOT EXISTS é idempotente e no-op quando já existem.
        #
        # weekly_checkup_log: JSON (como STRING) com o registro POR SEMANA dos
        # check-ups enviados — `[{"week": 1, "sent_at": "2026-06-03"}, ...]`.
        # Substitui a semântica antiga de `weekly_checkups` (contagem agregada
        # que misturava onboarding + semanais + fechamento). Agora o CS marca
        # cada semana de veiculação durante a campanha; `weekly_checkups` passa
        # a ser só a CONTAGEM derivada (len do log) — mantida pra não quebrar o
        # marcador de fechamento do card e o resumo do drawer.
        bq.query(f"""
            ALTER TABLE `{_closure_details_table_id()}`
            ADD COLUMN IF NOT EXISTS pos_venda_date DATE,
            ADD COLUMN IF NOT EXISTS extra_date DATE,
            ADD COLUMN IF NOT EXISTS weekly_checkup_log STRING
        """).result()
        _closure_details_table_ensured = True


def _sanitize_closure_details(body: dict) -> dict:
    """Normaliza o objeto `details` vindo do frontend. URLs vazias viram None,
    modes fora do enum viram None, checkups vira int >= 0 (ou None)."""
    def _url(v):
        v = (v or "").strip()
        if not v:
            return None
        if not v.lower().startswith(("http://", "https://")):
            v = f"https://{v}"
        return v[:2000]

    def _mode(v):
        v = (v or "").strip().lower()
        return v if v in _CLOSURE_DELIVERY_MODES else None

    def _date(v):
        v = (v or "").strip()[:10]
        if not v:
            return None
        try:
            datetime.strptime(v, "%Y-%m-%d")
            return v
        except ValueError:
            return None

    checkups = body.get("weekly_checkups")
    try:
        checkups = max(0, int(checkups)) if checkups is not None else None
    except (TypeError, ValueError):
        checkups = None

    pos_url   = _url(body.get("pos_venda_url"))
    extra_url = _url(body.get("extra_url"))
    pos_mode   = _mode(body.get("pos_venda_mode")) if pos_url else None
    extra_mode = _mode(body.get("extra_mode")) if extra_url else None
    return {
        "pos_venda_url":   pos_url,
        "pos_venda_mode":  pos_mode,
        "extra_url":       extra_url,
        "extra_mode":      extra_mode,
        # Data só faz sentido quando o material foi APRESENTADO (a pergunta
        # do popup é "quando foi apresentado?"). Enviado não carrega data.
        "pos_venda_date":  _date(body.get("pos_venda_date")) if pos_mode == "apresentado" else None,
        "extra_date":      _date(body.get("extra_date")) if extra_mode == "apresentado" else None,
        "weekly_checkups": checkups,
    }


def _sanitize_weekly_checkup_log(raw) -> list[dict]:
    """Normaliza o log de check-ups semanais vindo do frontend.

    Entrada: lista de `{"week": int, "sent_at": "YYYY-MM-DD"|null}` (só as
    semanas MARCADAS como enviadas entram). Saída: lista limpa, deduplicada
    por semana e ordenada por semana. `week` precisa ser inteiro >= 1; datas
    inválidas viram None (a semana segue marcada, só sem data registrada)."""
    if not isinstance(raw, list):
        return []

    def _date(v):
        v = (v or "").strip()[:10]
        if not v:
            return None
        try:
            datetime.strptime(v, "%Y-%m-%d")
            return v
        except (ValueError, TypeError):
            return None

    by_week: dict[int, dict] = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            week = int(item.get("week"))
        except (TypeError, ValueError):
            continue
        if week < 1 or week > 104:  # teto defensivo (~2 anos de campanha)
            continue
        by_week[week] = {"week": week, "sent_at": _date(item.get("sent_at"))}
    return [by_week[w] for w in sorted(by_week)]


def save_weekly_checkups(short_token: str, log: list[dict], updated_by: str | None = None):
    """UPSERT só dos check-ups semanais (atômico via MERGE).

    Toca APENAS weekly_checkup_log + weekly_checkups (contagem derivada) +
    auditoria — não mexe em pós-venda/material, que são donos do popup de
    fechamento. Assim o tracker do drawer (durante a campanha) e o popup de
    fechamento gravam no mesmo registro sem se sobrescrever."""
    _ensure_closure_details_table()
    log_json = json.dumps(log, ensure_ascii=False)
    count = len(log)
    sql = f"""
        MERGE `{_closure_details_table_id()}` T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
            UPDATE SET
                weekly_checkup_log = @log,
                weekly_checkups    = @count,
                updated_at         = CURRENT_TIMESTAMP(),
                updated_by         = @updated_by
        WHEN NOT MATCHED THEN
            INSERT (short_token, weekly_checkup_log, weekly_checkups,
                    updated_at, updated_by)
            VALUES (@token, @log, @count, CURRENT_TIMESTAMP(), @updated_by)
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token",      "STRING", short_token),
            bigquery.ScalarQueryParameter("log",        "STRING", log_json),
            bigquery.ScalarQueryParameter("count",      "INT64",  count),
            bigquery.ScalarQueryParameter("updated_by", "STRING", updated_by),
        ]
    )
    bq.query(sql, job_config=job_config).result()


def save_closure_details(short_token: str, details: dict, updated_by: str | None = None):
    """UPSERT dos detalhes do fechamento (atômico via MERGE).

    NÃO toca em weekly_checkup_log/weekly_checkups — esses são donos do tracker
    de check-ups semanais (save_weekly_checkups). Numa campanha que já tem
    check-ups registrados, salvar o fechamento aqui preserva o log."""
    _ensure_closure_details_table()
    sql = f"""
        MERGE `{_closure_details_table_id()}` T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
            UPDATE SET
                pos_venda_url   = @pos_venda_url,
                pos_venda_mode  = @pos_venda_mode,
                extra_url       = @extra_url,
                extra_mode      = @extra_mode,
                pos_venda_date  = @pos_venda_date,
                extra_date      = @extra_date,
                updated_at      = CURRENT_TIMESTAMP(),
                updated_by      = @updated_by
        WHEN NOT MATCHED THEN
            INSERT (short_token, pos_venda_url, pos_venda_mode, extra_url,
                    extra_mode, pos_venda_date, extra_date,
                    updated_at, updated_by)
            VALUES (@token, @pos_venda_url, @pos_venda_mode, @extra_url,
                    @extra_mode, @pos_venda_date, @extra_date,
                    CURRENT_TIMESTAMP(), @updated_by)
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token",           "STRING", short_token),
            bigquery.ScalarQueryParameter("pos_venda_url",   "STRING", details.get("pos_venda_url")),
            bigquery.ScalarQueryParameter("pos_venda_mode",  "STRING", details.get("pos_venda_mode")),
            bigquery.ScalarQueryParameter("extra_url",       "STRING", details.get("extra_url")),
            bigquery.ScalarQueryParameter("extra_mode",      "STRING", details.get("extra_mode")),
            bigquery.ScalarQueryParameter("pos_venda_date",  "DATE",   details.get("pos_venda_date")),
            bigquery.ScalarQueryParameter("extra_date",      "DATE",   details.get("extra_date")),
            bigquery.ScalarQueryParameter("updated_by",      "STRING", updated_by),
        ]
    )
    bq.query(sql, job_config=job_config).result()


def query_closure_details(short_token: str) -> dict | None:
    """Retorna os detalhes do fechamento do token, ou None se nunca salvos."""
    _ensure_closure_details_table()
    sql = f"""
        SELECT pos_venda_url, pos_venda_mode, extra_url, extra_mode,
               weekly_checkups, weekly_checkup_log, pos_venda_date, extra_date,
               updated_at, updated_by
        FROM `{_closure_details_table_id()}`
        WHERE short_token = @token
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    rows = list(bq.query(sql, job_config=job_config).result())
    if not rows:
        return None
    r = rows[0]
    # weekly_checkup_log é JSON guardado como STRING; sanitiza na leitura pra
    # blindar contra lixo/payload de versão antiga.
    try:
        log = _sanitize_weekly_checkup_log(json.loads(r["weekly_checkup_log"])) \
            if r["weekly_checkup_log"] else []
    except (ValueError, TypeError):
        log = []
    return {
        "pos_venda_url":      r["pos_venda_url"],
        "pos_venda_mode":     r["pos_venda_mode"],
        "extra_url":          r["extra_url"],
        "extra_mode":         r["extra_mode"],
        "weekly_checkups":    r["weekly_checkups"],
        "weekly_checkup_log": log,
        "pos_venda_date":     r["pos_venda_date"].isoformat() if r["pos_venda_date"] else None,
        "extra_date":         r["extra_date"].isoformat() if r["extra_date"] else None,
        "updated_at":         r["updated_at"].isoformat() if r["updated_at"] else None,
        "updated_by":         r["updated_by"],
    }


def query_all_campaign_elements() -> dict:
    """{short_token: {"assets": [...], "negotiated": [...], "closure": [...]}}

    Três categorias por campanha, numa única query UNION (tabelas pequenas;
    BQ colunar só lê short_token + coluna do filtro):
      • assets     — o que já está ATIVO no hub (loom/survey/rmnd/pdooh)
      • negotiated — o que foi NEGOCIADO no Sales Center (survey/pdooh/rmnd),
        detectado por regex no extras JSON do checklist (os campos diretos
        `features`/`studies_used` estão vazios na prática; o que foi vendido
        vive em extras.cl_features / ftext_Survey / fv_P-DOOH_* etc — mesma
        fonte que o NegotiationModal parseia). Pragmático por substring;
        falso-positivo só faria o chip de setup cobrar um item a mais.
      • closure    — fechamento registrado (pos_venda / checkups)

    Alimenta o chip "setup N/M" (negociado ∧ não-ativo + Loom sempre
    esperado) e os dots de fechamento do card admin.

    DUAS queries de propósito: assets/closure vivem em prod_assets +
    dev_assets (região US), e checklists vive em hypr_sales_center (outra
    região) — UNION não cruza regiões no BQ (job falha com "dataset not
    found in location US"). Cada query roda na região dos próprios datasets.
    """
    _ensure_closure_details_table()
    sql_assets = f"""
        SELECT short_token, 'asset' AS kind, 'loom' AS item
        FROM `{PROJECT_ID}.{DATASET_ASSETS}.campaign_looms`
        WHERE loom_url IS NOT NULL
        UNION ALL
        SELECT short_token, 'asset', 'survey' FROM `{PROJECT_ID}.{DATASET_ASSETS}.campaign_surveys`
        WHERE survey_data IS NOT NULL
        UNION ALL
        SELECT short_token, 'asset', 'rmnd' FROM `site-hypr.dev_assets.rmnd_data`
        WHERE data_json IS NOT NULL
        UNION ALL
        SELECT short_token, 'asset', 'pdooh' FROM `site-hypr.dev_assets.pdooh_data`
        WHERE data_json IS NOT NULL
        UNION ALL
        SELECT short_token, 'closure', 'pos_venda' FROM `{_closure_details_table_id()}`
        WHERE pos_venda_url IS NOT NULL OR extra_url IS NOT NULL
        UNION ALL
        SELECT short_token, 'closure', 'checkups' FROM `{_closure_details_table_id()}`
        WHERE weekly_checkups IS NOT NULL
        UNION ALL
        -- Contagem de check-ups enviados (fallback p/ closures legados sem log).
        SELECT short_token, 'checkup_count', CAST(weekly_checkups AS STRING)
        FROM `{_closure_details_table_id()}`
        WHERE weekly_checkups IS NOT NULL
        UNION ALL
        -- Log POR SEMANA dos check-ups — `item` carrega o JSON. O card precisa
        -- saber QUAIS semanas foram enviadas (não só quantas) pra pintar semana
        -- pulada como atrasada e pro drawer semear estado fresco sem refetch.
        SELECT short_token, 'checkup_log', weekly_checkup_log
        FROM `{_closure_details_table_id()}`
        WHERE weekly_checkup_log IS NOT NULL
    """
    sql_negotiated = f"""
        SELECT DISTINCT short_token, 'negotiated' AS kind, 'survey' AS item
        FROM `{PROJECT_ID}.{DATASET_SALES_CENTER}.checklists`
        WHERE short_token IS NOT NULL AND short_token != ''
          AND REGEXP_CONTAINS(LOWER(TO_JSON_STRING(extras)), r'survey')
        UNION ALL
        SELECT DISTINCT short_token, 'negotiated', 'pdooh'
        FROM `{PROJECT_ID}.{DATASET_SALES_CENTER}.checklists`
        WHERE short_token IS NOT NULL AND short_token != ''
          AND REGEXP_CONTAINS(LOWER(TO_JSON_STRING(extras)), r'p-?dooh')
        UNION ALL
        SELECT DISTINCT short_token, 'negotiated', 'rmnd'
        FROM `{PROJECT_ID}.{DATASET_SALES_CENTER}.checklists`
        WHERE short_token IS NOT NULL AND short_token != ''
          AND (
            REGEXP_CONTAINS(LOWER(TO_JSON_STRING(extras)), r'rmnd')
            OR REGEXP_CONTAINS(LOWER(ARRAY_TO_STRING(products, ',')), r'rmn')
          )
        UNION ALL
        -- Pacote COMPLETO de features negociadas (extras.cl_features) — lista
        -- crua que o NegotiationModal parseia. Alimenta os chips de "tudo que
        -- foi negociado" na tabela do portal (Design Studio, etc.).
        SELECT DISTINCT short_token, 'negfeat', feat
        FROM `{PROJECT_ID}.{DATASET_SALES_CENTER}.checklists`,
             UNNEST(JSON_EXTRACT_STRING_ARRAY(TO_JSON_STRING(extras), '$.cl_features')) AS feat
        WHERE short_token IS NOT NULL AND short_token != ''
          AND feat IS NOT NULL AND TRIM(feat) != ''
    """
    out = {}
    for sql in (sql_assets, sql_negotiated):
        for row in bq.query(sql).result():
            bucket = out.setdefault(row["short_token"], {"assets": [], "negotiated": [], "closure": [], "neg_features": []})
            kind = row["kind"]
            if kind == "checkup_count":
                try:
                    bucket["checkup_count"] = int(row["item"])
                except (TypeError, ValueError):
                    pass
                continue
            if kind == "checkup_log":
                try:
                    bucket["checkup_log"] = _sanitize_weekly_checkup_log(json.loads(row["item"])) if row["item"] else []
                except (TypeError, ValueError):
                    pass
                continue
            key = {"asset": "assets", "negotiated": "negotiated", "closure": "closure", "negfeat": "neg_features"}[kind]
            if row["item"] not in bucket[key]:
                bucket[key].append(row["item"])
    return out


def _safe_get_elements():
    """query_all_campaign_elements com cache (TTL da lista). Em falha
    retorna None — e o caller PULA o enrichment de setup/fechamento.
    O fallback NÃO pode ser {} : com mapa vazio, toda campanha pareceria
    "sem Loom" e o chip âmbar de setup pintaria nos 300+ cards de uma vez
    (aconteceu no primeiro deploy, quando o UNION cross-região falhava)."""
    cached = _cache_get(_elements_cache, "all", _LIST_CACHE_TTL)
    if cached is not None:
        return cached
    try:
        m = query_all_campaign_elements()
    except Exception as e:
        logger.warning(f"[WARN query_all_campaign_elements] {e}")
        return None
    _cache_set(_elements_cache, "all", m)
    return m


def _pos_venda_public(short_token: str) -> dict | None:
    """View PÚBLICA do pós-venda pro payload do report (chip no header).
    weekly_checkups fica de fora de propósito (métrica interna, admin-only).
    Retorna None quando não há nenhum link salvo."""
    cd = _get_closure_details_cached(short_token)
    if not cd or not (cd.get("pos_venda_url") or cd.get("extra_url")):
        return None
    return {
        "url":        cd.get("pos_venda_url"),
        "mode":       cd.get("pos_venda_mode"),
        "date":       cd.get("pos_venda_date"),
        "extra_url":  cd.get("extra_url"),
        "extra_mode": cd.get("extra_mode"),
        "extra_date": cd.get("extra_date"),
    }


def _get_closure_details_cached(short_token: str) -> dict | None:
    """query_closure_details com cache por token (TTL do report). Cacheia
    também o None (sentinela) — a maioria dos reports não tem pós-venda e
    não vale uma query BQ por acesso. Best-effort: erro vira None sem
    derrubar o report."""
    cached = _cache_get(_closure_details_cache, short_token, _REPORT_CACHE_TTL)
    if cached is not None:
        return cached.get("details")
    try:
        details = query_closure_details(short_token)
    except Exception as e:
        logger.warning(f"[WARN closure_details {short_token}] {e}")
        return None
    _cache_set(_closure_details_cache, short_token, {"details": details})
    return details


# ─────────────────────────────────────────────────────────────────────────────
# Report freeze — snapshot do payload final de uma campanha encerrada.
#
# Motivação (incidente Listerine N8Z4B7, jun/2026): o report recalcula sempre
# ao vivo da unified/campaign_results, e o `short_token` é derivado por regex
# do `line_name` do DSP. Renomear o prefixo `ID-XXXX_` de uma line (ex: pra
# reusá-la numa campanha nova) re-deriva o token de TODO o histórico no rebuild
# diário do dbt → o mês já entregue "vaza" pro token novo e o report encerrado
# muda retroativamente. Freeze = blindagem: ao encerrar, persiste-se o payload
# computado e passa-se a servi-lo verbatim, imune a qualquer reprocessamento.
#
# O payload é o MESMO JSON de fetch_campaign_data (todas as abas/gráficos),
# então o front renderiza igual sem mudança. Quando a fonte ao vivo está
# corrompida (caso N8Z4B7), o builder usa tabelas de recuperação (time-travel)
# via `src` — ver build_report_snapshot.
# ─────────────────────────────────────────────────────────────────────────────
_snapshots_table_ensured = False
_snapshots_ensure_lock = threading.Lock()


def _snapshots_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.report_snapshots"


def _ensure_snapshots_table() -> None:
    """Cria a tabela `report_snapshots` se não existir. Idempotente."""
    global _snapshots_table_ensured
    if _snapshots_table_ensured:
        return
    with _snapshots_ensure_lock:
        if _snapshots_table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_snapshots_table_id()}` (
                short_token  STRING NOT NULL,
                payload_json STRING NOT NULL,
                frozen_at    TIMESTAMP NOT NULL,
                frozen_by    STRING,
                note         STRING
            )
        """
        bq.query(sql).result()
        _snapshots_table_ensured = True


def query_frozen_tokens() -> dict:
    """Retorna {short_token: frozen_at_iso} das campanhas congeladas.
    Cacheado no TTL da lista (frozen muda raro, via admin). Tabela pequena."""
    cached = _cache_get(_frozen_cache, "all", _LIST_CACHE_TTL)
    if cached is not None:
        return cached
    _ensure_snapshots_table()
    sql = f"SELECT short_token, frozen_at FROM `{_snapshots_table_id()}`"
    out = {}
    try:
        for row in bq.query(sql).result():
            ts = row["frozen_at"]
            out[row["short_token"]] = ts.isoformat() if ts else None
    except Exception as e:
        logger.warning(f"[WARN query_frozen_tokens] {e}")
    _cache_set(_frozen_cache, "all", out)
    return out


def _load_snapshot_payload(short_token):
    """Lê e desserializa o payload congelado do token, ou None."""
    _ensure_snapshots_table()
    sql = f"SELECT payload_json FROM `{_snapshots_table_id()}` WHERE short_token = @token LIMIT 1"
    jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", short_token)
    ])
    try:
        rows = list(bq.query(sql, job_config=jc).result())
        if not rows:
            return None
        return json.loads(rows[0]["payload_json"])
    except Exception as e:
        logger.warning(f"[WARN _load_snapshot_payload {short_token}] {e}")
        return None


def _get_frozen_payload(short_token):
    """Se o token está congelado, devolve o payload do snapshot; senão None.
    O conjunto de frozen é cacheado (barato); o payload, após o 1º load, vive
    no _report_cache (mesmo TTL dos reports ao vivo)."""
    try:
        frozen = query_frozen_tokens()
    except Exception as e:
        logger.warning(f"[WARN _get_frozen_payload set] {e}")
        return None
    if short_token not in frozen:
        return None
    # IMPORTANTE: só confiar no _report_cache se a entrada for DE FATO congelada.
    # O mesmo keyspace guarda payloads ao vivo — uma entrada ao vivo cacheada
    # ANTES do freeze (frozen ausente) faria o report servir o número velho até
    # o TTL expirar. Exige frozen=True; senão, lê o snapshot do BQ.
    cached = _cache_get(_report_cache, short_token, _REPORT_CACHE_TTL)
    if cached is not None and cached.get("frozen"):
        return cached
    payload = _load_snapshot_payload(short_token)
    if payload is not None:
        payload = _overlay_frozen_live_fields(short_token, payload)
        payload = _overlay_live_contracts(short_token, payload)
        _cache_set(_report_cache, short_token, payload)
    return payload


def _overlay_frozen_live_fields(short_token, payload):
    """Sobrepõe ao snapshot os campos que continuam editáveis pós-freeze.
    O freeze protege MÉTRICAS de entrega (totals/daily/detail); anexos de
    conteúdo que o admin edita depois do encerramento — survey, loom — devem
    seguir o banco, senão um survey salvo após o freeze fica invisível pra
    sempre (snapshot guarda survey=null). Roda só no cache miss do snapshot;
    os saves desses campos já invalidam o _report_cache do token."""
    for key, fn in (("survey", query_survey), ("loom", query_loom)):
        try:
            payload[key] = fn(short_token)
        except Exception as e:
            logger.warning(f"[WARN frozen overlay {key} {short_token}] {e}")
    # Alcance & Frequência: 4 chaves de TOPO (não objeto aninhado como
    # survey/loom). O snapshot guarda o valor do momento do freeze; uma edição
    # posterior — inclusive o toggle auto_alcance, que grava alcance vazio de
    # propósito — precisa sobrepor o congelado, senão o reload mostra o valor
    # velho (ou perde o cálculo automático). save_af já invalida o
    # _report_cache do token, então isto roda no cache miss seguinte.
    try:
        payload.update(_resolve_alcance_frequencia(short_token))
    except Exception as e:
        logger.warning(f"[WARN frozen overlay alcance_frequencia {short_token}] {e}")
    # Agência: metadado de header editável pós-freeze — segue o override
    # atual, não o do momento do snapshot. Limpar o override também remove
    # do payload congelado (front volta ao fallback Sales Center).
    try:
        camp = payload.get("campaign")
        if isinstance(camp, dict):
            _ag = query_agency_override(short_token)
            if _ag and _ag.get("agency"):
                camp["agency"] = _ag["agency"]
            else:
                camp.pop("agency", None)
    except Exception as e:
        logger.warning(f"[WARN frozen overlay agency {short_token}] {e}")
    return payload


def _overlay_live_contracts(short_token, payload):
    """Em report CONGELADO, sobrepõe ao snapshot a VOLUMETRIA CONTRATADA / CPM
    ao vivo (checklist_info), recomputando budget/pacing/CPM-efetivo/
    rentabilidade SOBRE A ENTREGA CONGELADA.

    Por quê: report encerrado é servido verbatim do snapshot. Uma edição de
    volumetria no Command (campanha já encerrada) nunca aparecia sozinha. Aqui
    ela passa a refletir no dia seguinte (quando checklist_info re-materializa),
    SEM destravar a entrega — a única parte vulnerável a contaminação por rename
    de line (ver freeze). Espelha o mesmo princípio do card admin
    (_apply_frozen_delivery_override mantém contratado/budget/cpm ao vivo).

    Reusa _compute_totals (fonte única da matemática) com perf_rows
    reconstruídos da entrega congelada → zero risco de drift de fórmula. Roda só
    no cache miss do snapshot (idem survey/loom). Guard anti-buraco: se a
    checklist ao vivo some/zera (falha de pipeline upstream), MANTÉM o congelado
    em vez de zerar a volumetria de um report bom."""
    totals = payload.get("totals")
    if not totals or not isinstance(totals, list):
        return payload
    camp = payload.get("campaign") or {}
    start_raw = _parse_iso_date_safe(camp.get("start_date"))
    end_raw   = _parse_iso_date_safe(camp.get("end_date"))
    if not start_raw or not end_raw:
        return payload  # sem datas confiáveis → não recomputa pacing
    try:
        check_row = _fetch_contracts(short_token)
    except Exception as e:
        logger.warning(f"[WARN _overlay_live_contracts fetch {short_token}] {e}")
        return payload
    if check_row is None:
        return payload
    # Guard: checklist ao vivo sem NENHUM contrato → não sobrescreve (snapshot
    # tinha dado bom; pipeline pode ter dropado as colunas/linha).
    _contract_keys = (
        "contracted_o2o_display_impressions", "contracted_ooh_display_impressions",
        "contracted_groundflow_display_impressions", "contracted_o2o_video_completions",
        "contracted_ooh_video_completions", "contracted_groundflow_video_completions",
        "bonus_o2o_display_impressions", "bonus_ooh_display_impressions",
        "bonus_groundflow_display_impressions", "bonus_o2o_video_completions",
        "bonus_ooh_video_completions", "bonus_groundflow_video_completions",
    )
    contract_sum = 0.0
    for k in _contract_keys:
        try:
            contract_sum += float(check_row.get(k) or 0)
        except Exception:
            pass
    if contract_sum <= 0:
        return payload
    # Reconstrói perf_rows a partir da ENTREGA CONGELADA (tactic/mídia/agregados).
    # cost cru não vive no snapshot, mas só alimenta o cpc — cpc*clicks recompõe
    # o MESMO cpc (puro-entrega → idêntico ao congelado).
    perf_rows = []
    for t in totals:
        clicks = float(t.get("clicks") or 0)
        cpc    = float(t.get("cpc") or 0)
        perf_rows.append({
            "tactic_type":          t.get("tactic_type"),
            "media_type":           t.get("media_type"),
            "actual_start_date":    t.get("actual_start_date"),
            "days_with_delivery":   int(t.get("days_with_delivery") or 0),
            "impressions":          float(t.get("impressions") or 0),
            "viewable_impressions": float(t.get("viewable_impressions") or 0),
            "clicks":               clicks,
            "completions":          float(t.get("completions") or 0),
            "effective_total_cost": cpc * clicks,
        })
    campaign_info = {"_start_date_raw": start_raw, "_end_date_raw": end_raw}
    try:
        new_totals = _compute_totals(perf_rows, check_row, campaign_info)
    except Exception as e:
        logger.warning(f"[WARN _overlay_live_contracts compute {short_token}] {e}")
        return payload
    if not new_totals:
        return payload
    payload = dict(payload)
    payload["totals"] = new_totals
    return payload


def save_report_snapshot(short_token: str, payload: dict, frozen_by: str | None = None, note: str | None = None):
    """UPSERT do snapshot. Invalida caches pra que o freeze valha de imediato."""
    _ensure_snapshots_table()
    sql = f"""
        MERGE `{_snapshots_table_id()}` T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
            UPDATE SET payload_json = @payload, frozen_at = CURRENT_TIMESTAMP(),
                       frozen_by = @by, note = @note
        WHEN NOT MATCHED THEN
            INSERT (short_token, payload_json, frozen_at, frozen_by, note)
            VALUES (@token, @payload, CURRENT_TIMESTAMP(), @by, @note)
    """
    jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token",   "STRING", short_token),
        # default=str espelha a serialização do serve ao vivo (linha ~459):
        # objetos `date` (ex: campaign._start_date_raw) viram string, então o
        # snapshot armazenado é idêntico ao JSON que o cliente recebe.
        bigquery.ScalarQueryParameter("payload", "STRING", json.dumps(payload, ensure_ascii=False, default=str)),
        bigquery.ScalarQueryParameter("by",      "STRING", frozen_by),
        bigquery.ScalarQueryParameter("note",    "STRING", note),
    ])
    bq.query(sql, job_config=jc).result()
    _cache_invalidate_token(short_token)


def delete_report_snapshot(short_token: str):
    """Descongela: remove o snapshot e invalida caches (volta a recalcular ao vivo)."""
    _ensure_snapshots_table()
    sql = f"DELETE FROM `{_snapshots_table_id()}` WHERE short_token = @token"
    jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", short_token)
    ])
    bq.query(sql, job_config=jc).result()
    _cache_invalidate_token(short_token)


def build_report_snapshot(short_token: str, src: dict | None = None,
                          frozen_by: str | None = None, note: str | None = None) -> dict:
    """Computa o payload do report (opcionalmente a partir de fontes de
    recuperação via `src`) e persiste como snapshot congelado. Retorna o
    payload salvo. Levanta ValueError se a campanha não existe."""
    data = fetch_campaign_data(short_token, src=src)
    if data is None:
        raise ValueError(f"campanha {short_token} não encontrada")
    data["frozen"] = True
    save_report_snapshot(short_token, data, frozen_by=frozen_by, note=note)
    return data


# ─────────────────────────────────────────────────────────────────────────────
# Report delivery window — bound OPCIONAL e POR TOKEN do range de datas contado
# no report. Default (token ausente da tabela) = all-time, comportamento atual.
# Cirúrgico de propósito: NÃO é um bound global (que mudaria centenas de
# campanhas com delivery fora do voo legítima); só os tokens cadastrados são
# afetados. Caso de uso: token que herdou delivery de outro período via rename
# de line no DSP (ex: QG2MRY herdou maio do N8Z4B7).
# ─────────────────────────────────────────────────────────────────────────────
_windows_table_ensured = False
_windows_ensure_lock = threading.Lock()


def _windows_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.report_delivery_window"


def _ensure_windows_table() -> None:
    """Cria a tabela `report_delivery_window` se não existir. Idempotente."""
    global _windows_table_ensured
    if _windows_table_ensured:
        return
    with _windows_ensure_lock:
        if _windows_table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_windows_table_id()}` (
                short_token STRING NOT NULL,
                date_from   DATE,
                date_to     DATE,
                note        STRING,
                updated_by  STRING,
                updated_at  TIMESTAMP
            )
        """
        bq.query(sql).result()
        _windows_table_ensured = True


def query_delivery_windows() -> dict:
    """Retorna {short_token: (date_from, date_to)} das janelas cadastradas.
    Cacheado no TTL da lista. Tabela pequena (só exceções)."""
    cached = _cache_get(_windows_cache, "all", _LIST_CACHE_TTL)
    if cached is not None:
        return cached
    _ensure_windows_table()
    out = {}
    try:
        for row in bq.query(f"SELECT short_token, date_from, date_to FROM `{_windows_table_id()}`").result():
            out[row["short_token"]] = (row["date_from"], row["date_to"])
    except Exception as e:
        logger.warning(f"[WARN query_delivery_windows] {e}")
    _cache_set(_windows_cache, "all", out)
    return out


def save_delivery_window(short_token: str, date_from, date_to,
                         note: str | None = None, updated_by: str | None = None):
    """UPSERT da janela de entrega. date_from/date_to são strings ISO (YYYY-MM-DD)
    ou None (sem limite daquele lado)."""
    _ensure_windows_table()
    sql = f"""
        MERGE `{_windows_table_id()}` T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
            UPDATE SET date_from = @df, date_to = @dt, note = @note,
                       updated_by = @by, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN
            INSERT (short_token, date_from, date_to, note, updated_by, updated_at)
            VALUES (@token, @df, @dt, @note, @by, CURRENT_TIMESTAMP())
    """
    jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", short_token),
        bigquery.ScalarQueryParameter("df",    "DATE",   date_from),
        bigquery.ScalarQueryParameter("dt",    "DATE",   date_to),
        bigquery.ScalarQueryParameter("note",  "STRING", note),
        bigquery.ScalarQueryParameter("by",    "STRING", updated_by),
    ])
    bq.query(sql, job_config=jc).result()
    _cache_invalidate_token(short_token)


def delete_delivery_window(short_token: str):
    """Remove a janela — token volta a contar all-time."""
    _ensure_windows_table()
    jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", short_token)
    ])
    bq.query(f"DELETE FROM `{_windows_table_id()}` WHERE short_token = @token", job_config=jc).result()
    _cache_invalidate_token(short_token)


# ─────────────────────────────────────────────────────────────────────────────
# Auto-freeze — congela automaticamente campanhas já maduras (entrega final).
#
# Roda diário (Cloud Scheduler). Pra cada campanha que terminou na JANELA DE
# MATURIDADE [hoje-MAX_DAYS, hoje-MIN_DAYS] e ainda não está congelada, tira o
# snapshot. MIN_DAYS=8 cobre o lag D+7 de ingestão dos connectors (congelar
# antes travaria entrega incompleta). MAX_DAYS limita o backlog: a feature NÃO
# congela em massa todo o histórico (campanhas muito antigas podem já estar
# corrompidas — essas ficam pra freeze manual com revisão). Em regime, cada
# campanha é pega 1x ao cruzar a janela.
#
# 3 guardas de sanidade — NÃO congelar número suspeito de corrupção:
#   1. Frescor: se alguma fonte estiver desatualizada (pipeline quebrado hoje),
#      aborta o sweep inteiro — não congela nada num dia ruim.
#   2. Não-vazio: pula campanha sem entrega (viewable=0).
#   3. Estabilidade: compara com time-travel de 3d atrás; queda >10% = algo
#      sumiu da base (rename/delete) → pula e registra pra revisão manual.
#      (Campanha madura não cresce mais, então queda só pode ser perda.)
# Tudo reversível (unfreeze) e auditado.
# ─────────────────────────────────────────────────────────────────────────────
_AUTO_FREEZE_MIN_DAYS = 8     # cobre o lag D+7 dos connectors
_AUTO_FREEZE_MAX_DAYS = 45    # backlog máximo (campanha recente, provavelmente íntegra)
_AUTO_FREEZE_DROP_TOL = 0.10  # queda tolerada vs 3d atrás antes de bloquear


def _freshness_is_healthy() -> bool:
    """True se o rebuild diário rodou — a fonte MAIS FRESCA está a ≤2 dias.
    Confirma só que o pipeline rodou hoje (não exige toda fonte secundária em
    dia; StackAdapt/Amazon têm cadência própria). A guarda real contra perda
    de dados é a estabilidade por campanha (_stability_ok). Campanha madura
    (>8d) tem entrega toda no passado já ingerida, então o lag da borda
    recente não afeta o número congelado."""
    try:
        fresh = query_data_freshness()
        if not fresh:
            return False
        ref = (date.today() - timedelta(days=2)).isoformat()
        return any((f.get("max_date") or "") >= ref for f in fresh)
    except Exception as e:
        logger.warning(f"[WARN _freshness_is_healthy] {e}")
        return False


def _auto_freeze_candidates(min_days=_AUTO_FREEZE_MIN_DAYS, max_days=_AUTO_FREEZE_MAX_DAYS):
    """Tokens cuja campanha terminou na janela de maturidade e ainda não
    estão congelados. end_date vem de campaign_results (bounded no voo)."""
    sql = f"""
        SELECT short_token, MAX(end_date) AS end_dt
        FROM `{PROJECT_ID}.{DATASET_HUB}.{TABLE}`
        GROUP BY short_token
        HAVING end_dt BETWEEN
                 DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL @max_days DAY)
             AND DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL @min_days DAY)
    """
    jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("min_days", "INT64", min_days),
        bigquery.ScalarQueryParameter("max_days", "INT64", max_days),
    ])
    frozen = query_frozen_tokens()
    out = []
    for r in bq.query(sql, job_config=jc).result():
        tok = r["short_token"]
        if tok and tok not in frozen:
            out.append((tok, r["end_dt"]))
    return out


def _stability_ok(short_token, viewable_now) -> tuple:
    """Compara viewable atual com o de 3 dias atrás (time-travel). Campanha
    madura não cresce — queda > tolerância = corrupção provável. Retorna
    (ok, reason). Tolera falha do time-travel (não bloqueia por isso)."""
    if viewable_now <= 0:
        return (False, "sem entrega (viewable=0)")
    # Tokens com janela de entrega são curados manualmente — bound != all-time,
    # então a comparação com a unified crua não se aplica. Libera.
    try:
        if short_token in query_delivery_windows():
            return (True, "janela curada")
    except Exception:
        pass
    try:
        sql = f"""
            SELECT SUM(viewable_impressions) v
            FROM `{PROJECT_ID}.{DATASET_ASSETS}.unified_daily_performance_metrics`
              FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 DAY)
            WHERE short_token = @token
              AND NOT REGEXP_CONTAINS(UPPER(line_name), r'SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST')
              AND UPPER(creative_name) NOT LIKE '%SURVEY%'
        """
        jc = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("token", "STRING", short_token)])
        rows = list(bq.query(sql, job_config=jc, location="US").result())
        v_old = float(rows[0]["v"] or 0) if rows else 0.0
        if v_old > 0 and (viewable_now - v_old) / v_old < -_AUTO_FREEZE_DROP_TOL:
            pct = (1 - viewable_now / v_old) * 100
            return (False, f"queda de {pct:.0f}% vs 3d atrás — possível corrupção")
    except Exception as e:
        logger.warning(f"[WARN _stability_ok timetravel {short_token}] {e}")
    return (True, "ok")


_AUTO_FREEZE_MAX_PER_RUN = 20  # cabe no timeout (540s); backlog dreca em runs diários


def auto_freeze_sweep(dry_run=False, min_days=_AUTO_FREEZE_MIN_DAYS,
                      max_days=_AUTO_FREEZE_MAX_DAYS,
                      max_per_run=_AUTO_FREEZE_MAX_PER_RUN) -> dict:
    """Congela campanhas maduras não-congeladas (com guardas). Idempotente.
    Limita `max_per_run` por execução (cada freeze faz fetch + check, ~15s) pra
    fechar dentro do timeout da função; o backlog dreca nos runs diários
    seguintes (próximo run pula as já congeladas). Retorna sumário."""
    summary = {"checked": 0, "frozen": [], "skipped": [], "errors": [], "dry_run": dry_run}

    # Guarda 1: dia ruim de pipeline → não congela nada.
    if not _freshness_is_healthy():
        summary["aborted"] = "bases desatualizadas hoje — sweep adiado"
        logger.warning("[auto_freeze] abortado: freshness não-saudável")
        return summary

    candidates = _auto_freeze_candidates(min_days, max_days)
    summary["pending"] = len(candidates)
    if max_per_run and len(candidates) > max_per_run:
        candidates = candidates[:max_per_run]
    summary["checked"] = len(candidates)
    for token, end_date in candidates:
        try:
            data = fetch_campaign_data(token)
            if not data:
                summary["skipped"].append({"token": token, "reason": "report vazio"})
                continue
            viewable = sum(float(r.get("viewable_impressions") or 0) for r in (data.get("totals") or []))
            ok, reason = _stability_ok(token, viewable)
            if not ok:
                summary["skipped"].append({"token": token, "reason": reason})
                logger.warning(f"[auto_freeze] pulou {token}: {reason}")
                continue
            if dry_run:
                summary["frozen"].append({"token": token, "viewable": viewable, "would_freeze": True})
                continue
            data["frozen"] = True
            save_report_snapshot(token, data, frozen_by="auto-freeze",
                                 note=f"Auto-freeze: encerrada em {end_date} (madura, guardas OK).")
            summary["frozen"].append({"token": token, "viewable": viewable})
            try:
                audit_log.safe_write_event(
                    short_token=token, event_type="report_frozen_auto",
                    actor_email="auto-freeze",
                    message=f"congelou automaticamente (encerrada {end_date}, viewable {viewable:,.0f})")
            except Exception:
                pass
        except Exception as e:
            logger.error(f"[auto_freeze] erro em {token}: {e}")
            summary["errors"].append({"token": token, "error": str(e)})
    logger.info(f"[auto_freeze] checked={summary['checked']} "
                f"frozen={len(summary['frozen'])} skipped={len(summary['skipped'])} "
                f"errors={len(summary['errors'])} dry_run={dry_run}")
    return summary


# ─────────────────────────────────────────────────────────────────────────────
# Campaign pause — admin pausa temporariamente uma campanha em vôo (campanha
# travou no DSP, cliente pediu pra parar X dias, etc). Diferente de closure:
# pausa é reversível (toggle) e só faz sentido enquanto end_date >= hoje.
# Após end_date, o ciclo natural (awaiting_closure → ended) toma conta e a
# pausa vira metadata histórico.
# ─────────────────────────────────────────────────────────────────────────────
_pauses_table_ensured = False
_pauses_ensure_lock = threading.Lock()


def _pauses_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.campaign_pauses"


def _ensure_pauses_table() -> None:
    """Cria a tabela `campaign_pauses` se não existir + adiciona a coluna
    `reason` em deploys que já tinham a tabela (idempotente)."""
    global _pauses_table_ensured
    if _pauses_table_ensured:
        return
    with _pauses_ensure_lock:
        if _pauses_table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_pauses_table_id()}` (
                short_token STRING NOT NULL,
                paused_at   TIMESTAMP NOT NULL,
                paused_by   STRING,
                reason      STRING
            )
        """
        bq.query(sql).result()
        # ALTER pra deploys que criaram a tabela antes do campo `reason`
        # existir. ADD COLUMN IF NOT EXISTS é idempotente — não erra se
        # a coluna já existe (deploy novo do CREATE acima).
        alter_sql = f"""
            ALTER TABLE `{_pauses_table_id()}`
            ADD COLUMN IF NOT EXISTS reason STRING
        """
        try:
            bq.query(alter_sql).result()
        except Exception as e:
            logger.warning(f"[WARN _ensure_pauses_table ALTER] {e}")
        _pauses_table_ensured = True


def save_campaign_pause(short_token: str, paused: bool, paused_by: str | None = None, reason: str | None = None):
    """Pausa/despausa campanha.

    paused=True  → UPSERT com paused_at=NOW e reason (opcional)
    paused=False → DELETE (retoma — volta ao estado in_flight)

    `reason` permite que o admin registre o motivo da pausa, que vira tooltip
    no badge e bloco "Observação" no drawer.
    """
    _ensure_pauses_table()
    if paused:
        sql = f"""
            MERGE `{_pauses_table_id()}` T
            USING (SELECT @token AS short_token) S
            ON T.short_token = S.short_token
            WHEN MATCHED THEN
                UPDATE SET paused_at = CURRENT_TIMESTAMP(),
                           paused_by = @paused_by,
                           reason    = @reason
            WHEN NOT MATCHED THEN
                INSERT (short_token, paused_at, paused_by, reason)
                VALUES (@token, CURRENT_TIMESTAMP(), @paused_by, @reason)
        """
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("token",     "STRING", short_token),
                bigquery.ScalarQueryParameter("paused_by", "STRING", paused_by),
                bigquery.ScalarQueryParameter("reason",    "STRING", reason),
            ]
        )
    else:
        sql = f"""
            DELETE FROM `{_pauses_table_id()}`
            WHERE short_token = @token
        """
        job_config = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
        )
    bq.query(sql, job_config=job_config).result()


def query_all_pauses() -> dict:
    """Retorna {short_token: {paused_at_iso, reason}} de todas as pausas
    ativas. Mesma estrutura de query_all_early_ends — frontend usa pra
    derivar paused_at (status) e paused_reason (tooltip)."""
    _ensure_pauses_table()
    sql = f"""
        SELECT short_token, paused_at, reason
        FROM `{_pauses_table_id()}`
    """
    out = {}
    try:
        for row in bq.query(sql).result():
            ts = row["paused_at"]
            if ts:
                out[row["short_token"]] = {
                    "paused_at": ts.isoformat(),
                    "reason":    row["reason"] or "",
                }
    except Exception as e:
        logger.warning(f"[WARN query_all_pauses] {e}")
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Campaign early end — admin termina campanha antes da end_date original
# (solicitação externa, cancelamento, etc). Difere de pause + closure:
#   • Pause é reversível e temporária (campanha "ainda vai voltar")
#   • Closure é só paperwork (campanha terminou natural, falta arrumar planilha)
#   • Early end é DEFINITIVO — a campanha terminou, e antes do previsto.
#
# Decisão (Opção B): a end_date original NÃO é tocada no payload. O frontend
# usa `early_end_date` pra display do período e pra status badge, mas o pacing
# continua sendo calculado contra o contrato original (denominator = volume
# negociado completo). Isso mostra a "perda" — o quanto da entrega contratada
# o cliente perdeu por encerrar antes.
#
# Reason é admin-only (não vai pro report do cliente).
# ─────────────────────────────────────────────────────────────────────────────
_early_ends_table_ensured = False
_early_ends_ensure_lock = threading.Lock()


def _early_ends_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.campaign_early_ends"


def _ensure_early_ends_table() -> None:
    """Cria a tabela `campaign_early_ends` se não existir. Idempotente."""
    global _early_ends_table_ensured
    if _early_ends_table_ensured:
        return
    with _early_ends_ensure_lock:
        if _early_ends_table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_early_ends_table_id()}` (
                short_token    STRING NOT NULL,
                early_end_date DATE NOT NULL,
                reason         STRING,
                ended_by       STRING,
                updated_at     TIMESTAMP NOT NULL
            )
        """
        bq.query(sql).result()
        _early_ends_table_ensured = True


def save_campaign_early_end(short_token: str, early_end_date: str, reason: str | None, ended_by: str | None = None):
    """UPSERT do encerramento antecipado. `early_end_date` é STRING YYYY-MM-DD,
    convertido pra DATE no SQL via DATE(). Reason opcional."""
    _ensure_early_ends_table()
    sql = f"""
        MERGE `{_early_ends_table_id()}` T
        USING (SELECT @token AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN
            UPDATE SET early_end_date = DATE(@early_end_date), reason = @reason,
                       ended_by = @ended_by, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN
            INSERT (short_token, early_end_date, reason, ended_by, updated_at)
            VALUES (@token, DATE(@early_end_date), @reason, @ended_by, CURRENT_TIMESTAMP())
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("token",          "STRING", short_token),
            bigquery.ScalarQueryParameter("early_end_date", "STRING", early_end_date),
            bigquery.ScalarQueryParameter("reason",         "STRING", reason),
            bigquery.ScalarQueryParameter("ended_by",       "STRING", ended_by),
        ]
    )
    bq.query(sql, job_config=job_config).result()


def delete_campaign_early_end(short_token: str):
    """Remove registro de encerramento antecipado (reverte)."""
    _ensure_early_ends_table()
    sql = f"""
        DELETE FROM `{_early_ends_table_id()}`
        WHERE short_token = @token
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    bq.query(sql, job_config=job_config).result()


# ─────────────────────────────────────────────────────────────────────────────
# Override de NOME de audiência (Report Center) — admin corrige uma audiência
# que veio estranha/mal separada da plataforma. Distinto do override de
# audiência do PORTAL (client_portal.audience_overrides, hard no hub):
#   • No Report Center é APLICADO (front faz relabel/merge da quebra crua).
#   • No Client Hub é uma DICA pra IA (seed em compute_portal_audiences) — só
#     o nível ANUNCIANTE entra como seed; a IA continua mandando lá.
#
# ESCOPO (scope_token) — o admin escolhe a cada edição:
#   • ''           → todo o anunciante: vale em TODAS as campanhas do cliente.
#   • <short_token>→ só aquela campanha.
# Precedência ao servir um report: o override DA CAMPANHA vence o do anunciante
# pro mesmo rótulo. Chave lógica: (client_slug, scope_token, raw_key) com
# raw_key = normalize_key(raw_audience).
# ─────────────────────────────────────────────────────────────────────────────
_aud_overrides_table_ensured = False
_aud_overrides_ensure_lock = threading.Lock()
_AUD_OVERRIDES_TTL = 300  # 5min — escrita admin limpa o slug afetado na hora
_aud_overrides_cache = {}  # client_slug -> [rows]  (lista crua, resolução é por report)


def _aud_overrides_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.audience_overrides"


def _ensure_aud_overrides_table() -> None:
    """Cria a tabela `audience_overrides` se não existir + garante a coluna
    `scope_token` (tabelas antigas nasceram sem ela). Idempotente."""
    global _aud_overrides_table_ensured
    if _aud_overrides_table_ensured:
        return
    with _aud_overrides_ensure_lock:
        if _aud_overrides_table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_aud_overrides_table_id()}` (
                client_slug  STRING NOT NULL,
                raw_key      STRING NOT NULL,
                raw_audience STRING,
                display_name STRING NOT NULL,
                scope_token  STRING,
                edited_by    STRING,
                updated_at   TIMESTAMP NOT NULL
            )
        """
        bq.query(sql).result()
        # Migração p/ tabelas pré-escopo: adiciona a coluna e normaliza NULL→''
        # (overrides antigos eram todos a nível anunciante).
        try:
            bq.query(
                f"ALTER TABLE `{_aud_overrides_table_id()}` "
                f"ADD COLUMN IF NOT EXISTS scope_token STRING"
            ).result()
            bq.query(
                f"UPDATE `{_aud_overrides_table_id()}` "
                f"SET scope_token = '' WHERE scope_token IS NULL"
            ).result()
        except Exception as e:
            logger.warning(f"[WARN _ensure_aud_overrides_table scope_token] {e}")
        _aud_overrides_table_ensured = True


def save_audience_override(client_slug: str, raw_audience: str, display_name: str,
                           scope_token: str = "", edited_by: str | None = None):
    """UPSERT por (client_slug, scope_token, raw_key). scope_token='' = anunciante;
    =short_token = só aquela campanha. raw_key vem de normalize_key (mesma
    normalização do front)."""
    _ensure_aud_overrides_table()
    raw_key = audience_normalize.normalize_key(raw_audience)
    scope = scope_token or ""
    sql = f"""
        MERGE `{_aud_overrides_table_id()}` T
        USING (SELECT @slug AS client_slug, @scope AS scope_token, @raw_key AS raw_key) S
        ON T.client_slug = S.client_slug
           AND IFNULL(T.scope_token, '') = S.scope_token
           AND T.raw_key = S.raw_key
        WHEN MATCHED THEN
            UPDATE SET raw_audience = @raw_audience, display_name = @display_name,
                       edited_by = @edited_by, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN
            INSERT (client_slug, scope_token, raw_key, raw_audience, display_name, edited_by, updated_at)
            VALUES (@slug, @scope, @raw_key, @raw_audience, @display_name, @edited_by, CURRENT_TIMESTAMP())
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("slug",         "STRING", client_slug),
            bigquery.ScalarQueryParameter("scope",        "STRING", scope),
            bigquery.ScalarQueryParameter("raw_key",      "STRING", raw_key),
            bigquery.ScalarQueryParameter("raw_audience", "STRING", raw_audience),
            bigquery.ScalarQueryParameter("display_name", "STRING", display_name),
            bigquery.ScalarQueryParameter("edited_by",    "STRING", edited_by),
        ]
    )
    bq.query(sql, job_config=job_config).result()
    _aud_overrides_cache.pop(client_slug, None)


def delete_audience_override(client_slug: str, raw_audience: str, scope_tokens: list | None = None):
    """Remove override(s) de um rótulo. `scope_tokens` = lista de escopos a
    apagar ('' = anunciante, token = campanha). Default: apaga AMBOS os níveis
    do rótulo (revert total)."""
    _ensure_aud_overrides_table()
    raw_key = audience_normalize.normalize_key(raw_audience)
    scopes = [s or "" for s in scope_tokens] if scope_tokens else None
    if scopes is None:
        where = "client_slug = @slug AND raw_key = @raw_key"
        params = [
            bigquery.ScalarQueryParameter("slug",    "STRING", client_slug),
            bigquery.ScalarQueryParameter("raw_key", "STRING", raw_key),
        ]
    else:
        where = ("client_slug = @slug AND raw_key = @raw_key "
                 "AND IFNULL(scope_token, '') IN UNNEST(@scopes)")
        params = [
            bigquery.ScalarQueryParameter("slug",    "STRING", client_slug),
            bigquery.ScalarQueryParameter("raw_key", "STRING", raw_key),
            bigquery.ArrayQueryParameter("scopes", "STRING", scopes),
        ]
    bq.query(
        f"DELETE FROM `{_aud_overrides_table_id()}` WHERE {where}",
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    ).result()
    _aud_overrides_cache.pop(client_slug, None)


def query_audience_overrides(client_slug: str) -> list:
    """Linhas cruas de override de um anunciante (todos os escopos), cacheadas
    (TTL 5min). Cada linha: {raw_key, raw_audience, display_name, scope_token,
    edited_by, updated_at}."""
    if not client_slug:
        return []
    cached = _cache_get(_aud_overrides_cache, client_slug, _AUD_OVERRIDES_TTL)
    if cached is not None:
        return cached
    _ensure_aud_overrides_table()
    sql = f"""
        SELECT raw_key, raw_audience, display_name, IFNULL(scope_token, '') AS scope_token,
               edited_by, updated_at
        FROM `{_aud_overrides_table_id()}`
        WHERE client_slug = @slug
        ORDER BY display_name
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("slug", "STRING", client_slug)]
    )
    out = []
    try:
        for row in bq.query(sql, job_config=job_config).result():
            ts = row["updated_at"]
            out.append({
                "raw_key":      row["raw_key"],
                "raw_audience": row["raw_audience"] or "",
                "display_name": row["display_name"] or "",
                "scope_token":  row["scope_token"] or "",
                "edited_by":    row["edited_by"] or "",
                "updated_at":   ts.isoformat() if ts else "",
            })
    except Exception as e:
        logger.warning(f"[WARN query_audience_overrides] {e}")
    _cache_set(_aud_overrides_cache, client_slug, out)
    return out


def audience_overrides_map_for_report(client_slug: str, short_token: str | None) -> dict:
    """{raw_key: display} EFETIVO pra um report: nível anunciante ('') sobreposto
    pelo nível da campanha (scope_token == short_token, que VENCE)."""
    if not client_slug:
        return {}
    rows = query_audience_overrides(client_slug)
    adv = {r["raw_key"]: r["display_name"] for r in rows if r["scope_token"] == ""}
    camp = {r["raw_key"]: r["display_name"] for r in rows
            if short_token and r["scope_token"] == short_token}
    return {**adv, **camp}


def audience_overrides_advertiser_map(client_slug: str) -> dict:
    """{raw_key: display} SÓ do nível anunciante — é o que vira seed pra IA do
    hub (override de campanha é granular demais pra quebra agregada do portal)."""
    if not client_slug:
        return {}
    return {r["raw_key"]: r["display_name"]
            for r in query_audience_overrides(client_slug) if r["scope_token"] == ""}


def _attach_audience_overrides(data: dict) -> dict:
    """Anexa `audience_overrides` ({raw_key: display} EFETIVO) ao payload do
    report, na camada de serving — vale também pra reports congelados (relabel de
    exibição, não mexe nos dados). Resolve escopo anunciante+campanha pro token
    do report. Front (DisplayV2/VideoV2) aplica via shared/aggregations.js."""
    try:
        camp = (data or {}).get("campaign") or {}
        slug = clients.normalize_client_slug(camp.get("client_name") or "")
        token = camp.get("short_token")
        ov = audience_overrides_map_for_report(slug, token) if slug else {}
        if ov:
            return {**data, "audience_overrides": ov}
    except Exception as e:
        logger.warning(f"[WARN _attach_audience_overrides] {e}")
    return data


# ─────────────────────────────────────────────────────────────────────────────
# Override genérico de RÓTULO por dimensão (Report Center) — formato e linha
# criativa. Mesma mecânica do override de audiência (relabel/merge da quebra
# crua), generalizada por uma coluna `dimension` numa ÚNICA tabela:
#
#   • 'format'        → renomeia/funde `creative_size`  (tabela "Por Tamanho")
#   • 'creative_line' → renomeia/funde a linha criativa (getCreativeLineKey)
#
# DIFERENÇA pro override de audiência: este NÃO alimenta a IA do Client Hub
# (formato/linha não fazem parte da quebra agregada de audiência do portal).
# É puramente relabel/merge no Report Center — por isso não há "advertiser_map"
# de seed nem clear de `_audiences_cache`. Audiência continua na sua própria
# tabela `audience_overrides`, intocada.
#
# Chave lógica: (client_slug, dimension, scope_token, raw_key) com
# raw_key = normalize_key(raw_value). Precedência ao servir: override DA
# CAMPANHA (scope_token == short_token) vence o do anunciante (scope_token='').
# ─────────────────────────────────────────────────────────────────────────────
_LABEL_OVERRIDE_DIMENSIONS = {"format", "creative_line"}
_label_overrides_table_ensured = False
_label_overrides_ensure_lock = threading.Lock()
_LABEL_OVERRIDES_TTL = 300  # 5min — escrita admin limpa o slug afetado na hora
_label_overrides_cache = {}  # client_slug -> [rows]  (lista crua, resolução é por report)


def _label_overrides_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.label_overrides"


def _ensure_label_overrides_table() -> None:
    """Cria a tabela `label_overrides` se não existir. Idempotente."""
    global _label_overrides_table_ensured
    if _label_overrides_table_ensured:
        return
    with _label_overrides_ensure_lock:
        if _label_overrides_table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_label_overrides_table_id()}` (
                client_slug  STRING NOT NULL,
                dimension    STRING NOT NULL,
                raw_key      STRING NOT NULL,
                raw_value    STRING,
                display_name STRING NOT NULL,
                scope_token  STRING,
                edited_by    STRING,
                updated_at   TIMESTAMP NOT NULL
            )
        """
        bq.query(sql).result()
        _label_overrides_table_ensured = True


def save_label_override(client_slug: str, dimension: str, raw_value: str, display_name: str,
                        scope_token: str = "", edited_by: str | None = None):
    """UPSERT por (client_slug, dimension, scope_token, raw_key). scope_token=''
    = anunciante; =short_token = só aquela campanha. raw_key vem de normalize_key
    (mesma normalização do front)."""
    _ensure_label_overrides_table()
    raw_key = audience_normalize.normalize_key(raw_value)
    scope = scope_token or ""
    sql = f"""
        MERGE `{_label_overrides_table_id()}` T
        USING (SELECT @slug AS client_slug, @dimension AS dimension,
                      @scope AS scope_token, @raw_key AS raw_key) S
        ON T.client_slug = S.client_slug
           AND T.dimension = S.dimension
           AND IFNULL(T.scope_token, '') = S.scope_token
           AND T.raw_key = S.raw_key
        WHEN MATCHED THEN
            UPDATE SET raw_value = @raw_value, display_name = @display_name,
                       edited_by = @edited_by, updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN
            INSERT (client_slug, dimension, scope_token, raw_key, raw_value, display_name, edited_by, updated_at)
            VALUES (@slug, @dimension, @scope, @raw_key, @raw_value, @display_name, @edited_by, CURRENT_TIMESTAMP())
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("slug",         "STRING", client_slug),
            bigquery.ScalarQueryParameter("dimension",    "STRING", dimension),
            bigquery.ScalarQueryParameter("scope",        "STRING", scope),
            bigquery.ScalarQueryParameter("raw_key",      "STRING", raw_key),
            bigquery.ScalarQueryParameter("raw_value",    "STRING", raw_value),
            bigquery.ScalarQueryParameter("display_name", "STRING", display_name),
            bigquery.ScalarQueryParameter("edited_by",    "STRING", edited_by),
        ]
    )
    bq.query(sql, job_config=job_config).result()
    _label_overrides_cache.pop(client_slug, None)


def delete_label_override(client_slug: str, dimension: str, raw_value: str,
                          scope_tokens: list | None = None):
    """Remove override(s) de um rótulo numa dimensão. `scope_tokens` = lista de
    escopos a apagar ('' = anunciante, token = campanha). Default: apaga AMBOS
    os níveis do rótulo (revert total)."""
    _ensure_label_overrides_table()
    raw_key = audience_normalize.normalize_key(raw_value)
    scopes = [s or "" for s in scope_tokens] if scope_tokens else None
    base = "client_slug = @slug AND dimension = @dimension AND raw_key = @raw_key"
    params = [
        bigquery.ScalarQueryParameter("slug",      "STRING", client_slug),
        bigquery.ScalarQueryParameter("dimension", "STRING", dimension),
        bigquery.ScalarQueryParameter("raw_key",   "STRING", raw_key),
    ]
    if scopes is None:
        where = base
    else:
        where = base + " AND IFNULL(scope_token, '') IN UNNEST(@scopes)"
        params.append(bigquery.ArrayQueryParameter("scopes", "STRING", scopes))
    bq.query(
        f"DELETE FROM `{_label_overrides_table_id()}` WHERE {where}",
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    ).result()
    _label_overrides_cache.pop(client_slug, None)


def query_label_overrides(client_slug: str) -> list:
    """Linhas cruas de override de um anunciante (todas as dimensões e escopos),
    cacheadas (TTL 5min). Cada linha: {dimension, raw_key, raw_value,
    display_name, scope_token, edited_by, updated_at}."""
    if not client_slug:
        return []
    cached = _cache_get(_label_overrides_cache, client_slug, _LABEL_OVERRIDES_TTL)
    if cached is not None:
        return cached
    _ensure_label_overrides_table()
    sql = f"""
        SELECT dimension, raw_key, raw_value, display_name,
               IFNULL(scope_token, '') AS scope_token, edited_by, updated_at
        FROM `{_label_overrides_table_id()}`
        WHERE client_slug = @slug
        ORDER BY dimension, display_name
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("slug", "STRING", client_slug)]
    )
    out = []
    try:
        for row in bq.query(sql, job_config=job_config).result():
            ts = row["updated_at"]
            out.append({
                "dimension":    row["dimension"],
                "raw_key":      row["raw_key"],
                "raw_value":    row["raw_value"] or "",
                "display_name": row["display_name"] or "",
                "scope_token":  row["scope_token"] or "",
                "edited_by":    row["edited_by"] or "",
                "updated_at":   ts.isoformat() if ts else "",
            })
    except Exception as e:
        logger.warning(f"[WARN query_label_overrides] {e}")
    _cache_set(_label_overrides_cache, client_slug, out)
    return out


def label_overrides_maps_for_report(client_slug: str, short_token: str | None) -> dict:
    """{dimension: {raw_key: display}} EFETIVO pra um report: nível anunciante
    ('') sobreposto pelo nível da campanha (scope_token == short_token, que
    VENCE), por dimensão."""
    if not client_slug:
        return {}
    rows = query_label_overrides(client_slug)
    out = {}
    for dim in _LABEL_OVERRIDE_DIMENSIONS:
        adv = {r["raw_key"]: r["display_name"] for r in rows
               if r["dimension"] == dim and r["scope_token"] == ""}
        camp = {r["raw_key"]: r["display_name"] for r in rows
                if r["dimension"] == dim and short_token and r["scope_token"] == short_token}
        merged = {**adv, **camp}
        if merged:
            out[dim] = merged
    return out


def _attach_label_overrides(data: dict) -> dict:
    """Anexa `label_overrides` ({dimension: {raw_key: display}} EFETIVO) ao
    payload do report, na camada de serving — vale também pra reports congelados
    (relabel de exibição, não mexe nos dados). Front (DisplayV2/VideoV2) aplica
    via shared/aggregations.js."""
    try:
        camp = (data or {}).get("campaign") or {}
        slug = clients.normalize_client_slug(camp.get("client_name") or "")
        token = camp.get("short_token")
        maps = label_overrides_maps_for_report(slug, token) if slug else {}
        if maps:
            return {**data, "label_overrides": maps}
    except Exception as e:
        logger.warning(f"[WARN _attach_label_overrides] {e}")
    return data


def _get_campaign_date_range(short_token: str):
    """Retorna (start_date, end_date) da campanha em `campaign_results` ou
    None se token não existe / sem dados. Usado pra validar range do
    encerramento antecipado no endpoint. Datas vêm como `date` (BQ DATE)."""
    sql = f"""
        SELECT MAX(start_date) AS start_date, MAX(end_date) AS end_date
        FROM {table_ref()}
        WHERE short_token = @token
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    try:
        rows = list(bq.query(sql, job_config=job_config).result())
        if rows and rows[0]["start_date"] and rows[0]["end_date"]:
            return (rows[0]["start_date"], rows[0]["end_date"])
    except Exception as e:
        logger.warning(f"[WARN _get_campaign_date_range] {e}")
    return None


def query_all_early_ends() -> dict:
    """Retorna {short_token: {early_end_date_iso, reason, ended_by}} de
    todos os encerramentos antecipados. Tabela pequena — full scan + cache."""
    _ensure_early_ends_table()
    sql = f"""
        SELECT short_token, early_end_date, reason, ended_by
        FROM `{_early_ends_table_id()}`
    """
    out = {}
    try:
        for row in bq.query(sql).result():
            d = row["early_end_date"]
            if d:
                out[row["short_token"]] = {
                    "early_end_date": d.isoformat(),
                    "reason":         row["reason"]   or "",
                    "ended_by":       row["ended_by"] or "",
                }
    except Exception as e:
        logger.warning(f"[WARN query_all_early_ends] {e}")
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Alcance & Frequência — salvar e buscar
# ─────────────────────────────────────────────────────────────────────────────
# Campos manuais (texto livre, formatados pelo admin) que o cliente vê no
# bloco "Alcance & Frequência" da Visão Geral. São independentes por escopo:
#
#   scope_type="token" + scope_id=<short_token>  → valor por report individual.
#                                                  Cobre tanto reports avulsos
#                                                  quanto cada membro de um
#                                                  grupo merge (drill-down por
#                                                  mês).
#   scope_type="merge" + scope_id=<merge_id>     → valor da visão agregada do
#                                                  grupo. Não é soma dos membros
#                                                  (haveria overlap entre meses);
#                                                  o admin insere manualmente o
#                                                  alcance único agregado.
#
# Frequência é opcional — o frontend calcula automaticamente a partir do
# alcance + impressões totais entregues, e só persiste aqui se o admin
# fez override manual.
# ─────────────────────────────────────────────────────────────────────────────

_alc_freq_table_ensured = False
_alc_freq_ensure_lock = threading.Lock()


def _alc_freq_table_id() -> str:
    return f"{PROJECT_ID}.{DATASET_ASSETS}.campaign_alcance_frequencia"


def _ensure_alc_freq_table() -> None:
    """Cria a tabela `campaign_alcance_frequencia` se não existir.
    Idempotente, com flag de instância pra evitar query repetida em warm path."""
    global _alc_freq_table_ensured
    if _alc_freq_table_ensured:
        return
    with _alc_freq_ensure_lock:
        if _alc_freq_table_ensured:
            return
        sql = f"""
            CREATE TABLE IF NOT EXISTS `{_alc_freq_table_id()}` (
                scope_type   STRING NOT NULL,
                scope_id     STRING NOT NULL,
                alcance      STRING,
                frequencia   STRING,
                auto_alcance BOOL,
                updated_at   TIMESTAMP NOT NULL
            )
        """
        bq.query(sql).result()
        # Tabelas criadas antes do toggle "calcular alcance automaticamente"
        # não têm a coluna — adiciona idempotente (no-op se já existe).
        bq.query(
            f"ALTER TABLE `{_alc_freq_table_id()}` "
            f"ADD COLUMN IF NOT EXISTS auto_alcance BOOL"
        ).result()
        _alc_freq_table_ensured = True


def save_alcance_frequencia(scope_type: str, scope_id: str, alcance: str, frequencia: str, auto_alcance: bool = False):
    """UPSERT do par (alcance, frequencia) + flag auto_alcance para um escopo
    (token ou merge). `auto_alcance` registra se o admin deixou o alcance ser
    derivado da frequência — sem ele, o reload volta pro modo manual e o
    alcance derivado some."""
    _ensure_alc_freq_table()
    sql = f"""
        MERGE `{_alc_freq_table_id()}` T
        USING (SELECT @scope_type AS scope_type, @scope_id AS scope_id) S
        ON T.scope_type = S.scope_type AND T.scope_id = S.scope_id
        WHEN MATCHED THEN
            UPDATE SET alcance = @alcance, frequencia = @frequencia,
                       auto_alcance = @auto_alcance,
                       updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN
            INSERT (scope_type, scope_id, alcance, frequencia, auto_alcance, updated_at)
            VALUES (@scope_type, @scope_id, @alcance, @frequencia, @auto_alcance, CURRENT_TIMESTAMP())
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("scope_type",   "STRING", scope_type),
            bigquery.ScalarQueryParameter("scope_id",     "STRING", scope_id),
            bigquery.ScalarQueryParameter("alcance",      "STRING", alcance or ""),
            bigquery.ScalarQueryParameter("frequencia",   "STRING", frequencia or ""),
            bigquery.ScalarQueryParameter("auto_alcance", "BOOL",   bool(auto_alcance)),
        ]
    )
    bq.query(sql, job_config=job_config).result()


def query_alcance_frequencia(scope_type: str, scope_id: str):
    """Retorna {"alcance": str, "frequencia": str, "auto_alcance": bool,
    "updated_at": str ISO} do escopo, ou valores vazios se nunca foi salvo.
    Tolera tabela inexistente (deploy novo)."""
    sql = f"""
        SELECT alcance, frequencia, auto_alcance, updated_at
        FROM `{_alc_freq_table_id()}`
        WHERE scope_type = @scope_type AND scope_id = @scope_id
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("scope_type", "STRING", scope_type),
            bigquery.ScalarQueryParameter("scope_id",   "STRING", scope_id),
        ]
    )
    try:
        rows = list(bq.query(sql, job_config=job_config).result())
        if rows:
            ts = rows[0]["updated_at"]
            return {
                "alcance":      rows[0]["alcance"]    or "",
                "frequencia":   rows[0]["frequencia"] or "",
                "auto_alcance": bool(rows[0]["auto_alcance"]),
                "updated_at":   ts.isoformat() if ts else "",
            }
    except Exception as e:
        logger.warning(f"[WARN query_alcance_frequencia {scope_type}:{scope_id}] {e}")
    return {"alcance": "", "frequencia": "", "auto_alcance": False, "updated_at": ""}


def _resolve_alcance_frequencia(short_token, af_token=None):
    """Resolve os 4 campos de topo de Alcance & Frequência de um token, já com
    o fallback merge-scoped (par (token, X) vazio → lê do grupo merge).

    Fonte ÚNICA usada tanto pelo serve ao vivo (fetch_campaign_data) quanto pelo
    overlay de report congelado (_overlay_frozen_live_fields). Sem o overlay, um
    valor salvo APÓS o freeze some no reload — o snapshot é servido verbatim e
    no modo auto_alcance o alcance é gravado vazio de propósito, então o report
    voltava pro modo manual com alcance em branco (o cálculo "sumia").

    Aceita `af_token` já consultado pra reaproveitar a query paralela do
    _query_pool no caminho ao vivo."""
    af = (af_token if af_token is not None
          else query_alcance_frequencia("token", short_token)) or {}
    if not (af.get("alcance") or af.get("frequencia")):
        try:
            merges_lookup = _safe_get_merges()
            merge_info = (
                merges_lookup.get(short_token)
                or merges_lookup.get(short_token.upper())
            )
            if merge_info and merge_info.get("merge_id"):
                af_merge = query_alcance_frequencia("merge", merge_info["merge_id"])
                if af_merge.get("alcance") or af_merge.get("frequencia"):
                    af = af_merge
        except Exception as e:
            logger.warning(f"[WARN _resolve_alcance_frequencia merge_fallback {short_token}] {e}")
    return {
        "alcance":            af.get("alcance", "")    or "",
        "frequencia":         af.get("frequencia", "") or "",
        "auto_alcance":       bool(af.get("auto_alcance")),
        "alcance_updated_at": af.get("updated_at", "") or "",
    }


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
# Negotiation (Sales Center) — checklist comercial rico, fonte de verdade
# do que foi vendido. Tabela `hypr_sales_center.checklists` traz:
#   - Plano: investment, cpm, cpcv, formats[], products[], deal_dv360
#   - Volumes: o2o_impressoes/views (+ bonus_*), feature_volumes (JSON)
#   - Features ativadas: extras.cl_features (JSON), com fv_<f>_<m> volumes
#   - Documentos: pi_link, pecas_link, proposta_link, ooh_link
#   - Geo OOH: pracas_type/detail
#   - Times: cp_name/email, cs_name/email, submitted_by(_email)
#   - Audiências: campo livre `audiences`
#   - Estudos usados: studies_used + extras.selected_studies
#
# Cobertura: campanhas pré-Sales Center não têm registro — devolvemos None
# e o front esconde o botão. O `extras` JSON é desempacotado no front pra
# extrair cl_features e parametrizar o card de features.
# ─────────────────────────────────────────────────────────────────────────────
def query_negotiation(short_token: str):
    sql = f"""
        SELECT
            id,
            cp_name, cp_email,
            cs_name, cs_email,
            agency, industry, campaign_type,
            client, campaign_name,
            start_date, end_date,
            investment, cpm, cpcv,
            deal_dv360, has_bonus, had_cs_meeting,
            formats, products, marketplaces, features, studies_used,
            o2o_impressoes, o2o_views,
            bonus_o2o_impressoes, bonus_o2o_views,
            ooh_link, audiences,
            pracas_type, pracas_detail,
            pi_link, pecas_link, proposta_link,
            redirect_urls,
            submitted_by, submitted_by_email,
            TO_JSON_STRING(feature_volumes) AS feature_volumes_json,
            TO_JSON_STRING(extras)          AS extras_json,
            created_at,
            short_token
        FROM `{PROJECT_ID}.{DATASET_SALES_CENTER}.checklists`
        WHERE short_token = @token
        ORDER BY created_at DESC
        LIMIT 1
    """
    job_config = bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("token", "STRING", short_token)]
    )
    try:
        rows = list(bq.query(sql, job_config=job_config).result())
        if not rows:
            return None
        r = rows[0]
        def _f(v):
            return float(v) if v is not None else None
        def _i(v):
            return int(v) if v is not None else None
        def _b(v):
            return bool(v) if v is not None else None
        return {
            "id":                 r["id"],
            "cp_name":            r["cp_name"],
            "cp_email":           r["cp_email"],
            "cs_name":            r["cs_name"],
            "cs_email":           r["cs_email"],
            "agency":             r["agency"],
            "industry":           r["industry"],
            "campaign_type":      r["campaign_type"],
            "client":             r["client"],
            "campaign_name":      r["campaign_name"],
            "start_date":         str(r["start_date"]) if r["start_date"] else None,
            "end_date":           str(r["end_date"])   if r["end_date"]   else None,
            "investment":         _f(r["investment"]),
            "cpm":                _f(r["cpm"]),
            "cpcv":               _f(r["cpcv"]),
            "deal_dv360":         _b(r["deal_dv360"]),
            "has_bonus":          _b(r["has_bonus"]),
            "had_cs_meeting":     _b(r["had_cs_meeting"]),
            "formats":            list(r["formats"]      or []),
            "products":           list(r["products"]     or []),
            "marketplaces":       list(r["marketplaces"] or []),
            "features":           list(r["features"]     or []),
            "studies_used":       list(r["studies_used"] or []),
            "o2o_impressoes":         _i(r["o2o_impressoes"]),
            "o2o_views":              _i(r["o2o_views"]),
            "bonus_o2o_impressoes":   _i(r["bonus_o2o_impressoes"]),
            "bonus_o2o_views":        _i(r["bonus_o2o_views"]),
            "ooh_link":           r["ooh_link"],
            "audiences":          r["audiences"],
            "pracas_type":        r["pracas_type"],
            "pracas_detail":      r["pracas_detail"],
            "pi_link":            r["pi_link"],
            "pecas_link":         r["pecas_link"],
            "proposta_link":      r["proposta_link"],
            "redirect_urls":      list(r["redirect_urls"] or []),
            "submitted_by":       r["submitted_by"],
            "submitted_by_email": r["submitted_by_email"],
            "feature_volumes":    r["feature_volumes_json"],
            "extras":             r["extras_json"],
            "created_at":         str(r["created_at"]) if r["created_at"] else None,
            "short_token":        r["short_token"],
        }
    except Exception as e:
        logger.warning(f"[WARN query_negotiation] {e}")
    return None

# ─────────────────────────────────────────────────────────────────────────────
def query_campaign_info(token, cr_src=None):
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
        FROM {cr_src or table_ref()}
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


def query_totals(token, campaign_info, unified_src=None, win_from=None, win_to=None):
    """
    Fonte de métricas: unified_daily_performance_metrics (incremental, região US)
    Fonte de contratos: checklist_info (prod_assets, região US)
    Todos os cálculos de CPM/CPCV efetivo, rentabilidade e pacing feitos em Python.

    `unified_src` (opcional): override da tabela de delivery (já entre crases),
    usado pelo builder de snapshot pra construir o congelado a partir de uma
    tabela de recuperação (time-travel) quando a unified ao vivo está corrompida.
    `win_from`/`win_to` (opcional): janela de entrega — exclui delivery fora do
    range (token que herdou delivery de outro período via rename de line).
    """
    UNIFIED = unified_src or "`site-hypr.prod_assets.unified_daily_performance_metrics`"
    win_sql = _win_clause(win_from, win_to)
    CHECKLIST = "`site-hypr.prod_assets.checklist_info`"

    sql_perf = f"""
        WITH base AS (
            SELECT
                CASE
                    WHEN REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)') AND {_GF_CONTRACT_GATE} THEN 'GROUNDFLOW'
                    WHEN REGEXP_CONTAINS(line_name, r'(?i)[_-]O2O([_-]|$)') THEN 'O2O'
                    WHEN REGEXP_CONTAINS(line_name, r'(?i)[_-]OOH([_-]|$)') THEN 'OOH'
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
              AND NOT REGEXP_CONTAINS(UPPER(line_name), r'SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST')
              AND UPPER(creative_name) NOT LIKE '%SURVEY%'{win_sql}
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

    # unified_daily_performance_metrics está na região US — passar location explícito.
    # As 2 queries (perf + checklist) são independentes e tocam tabelas diferentes —
    # rodar em paralelo via _query_pool corta a latência pela metade no caminho
    # crítico do report (essa função é a query mais pesada de fetch_campaign_data).
    _perf_params = [bigquery.ScalarQueryParameter("token", "STRING", token)]
    if win_from is not None:
        _perf_params.append(bigquery.ScalarQueryParameter("win_from", "DATE", win_from))
    if win_to is not None:
        _perf_params.append(bigquery.ScalarQueryParameter("win_to", "DATE", win_to))
    job_config = bigquery.QueryJobConfig(query_parameters=_perf_params)

    fut_perf  = _query_pool.submit(
        lambda: list(bq.query(sql_perf, job_config=job_config, location="US").result())
    )
    # checklist (contrato) não tem janela — só @token; roda em paralelo
    fut_check = _query_pool.submit(_fetch_contracts, token)
    perf_rows  = fut_perf.result()
    check_row  = fut_check.result()

    if check_row is None:
        return []
    return _compute_totals(perf_rows, check_row, campaign_info)


def _fetch_contracts(token):
    """Lê a linha de contratos (volumetria contratada, bônus, CPM/CPCV
    negociado) de checklist_info pro token. Fonte ÚNICA do contrato — usada
    por query_totals e pelo overlay de contratos ao vivo em report congelado.
    Retorna a Row do BQ, ou None se o token não está no checklist_info."""
    sql = """
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
            MAX(bonus_ooh_video_completions)            AS bonus_ooh_video_completions,
            MAX(contracted_groundflow_display_impressions)    AS contracted_groundflow_display_impressions,
            MAX(contracted_groundflow_video_completions)      AS contracted_groundflow_video_completions,
            MAX(bonus_groundflow_display_impressions)         AS bonus_groundflow_display_impressions,
            MAX(bonus_groundflow_video_completions)           AS bonus_groundflow_video_completions
        FROM `site-hypr.prod_assets.checklist_info`
        WHERE short_token = @token
    """
    jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", token)
    ])
    rows = list(bq.query(sql, job_config=jc, location="US").result())
    if not rows:
        return None
    # Override de core products (curadoria admin) vence o checklist: zera
    # contratado/bônus das frentes fora do set ANTES de virar budget/pacing.
    return _apply_cp_override_to_contracts(rows[0], token)


def _compute_totals(perf_rows, c, campaign_info):
    """Calcula as linhas de `totals` (por frente×mídia) a partir da ENTREGA
    (`perf_rows`) e do CONTRATO (`c`, Row/dict de _fetch_contracts). Toda a
    matemática de budget/CPM-efetivo/rentabilidade/pacing vive AQUI — fonte
    única reusada pelo serve ao vivo (query_totals) e pelo overlay de contratos
    ao vivo em report congelado (entrega congelada + contrato ao vivo)."""
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
    # RMNF (Groundflow) — 3ª frente. BigQuery Row.get() devolve None se a
    # coluna não existir; só vira KeyError no SELECT acima se a checklist_info
    # ainda não tiver as colunas groundflow — por isso o deploy do backend só pode
    # ir DEPOIS de a pipeline hyprster materializar essas colunas. Hoje só
    # DISPLAY tem dado (RMNF_imp); vídeo/bônus vêm 0 até o Command emiti-los.
    contracted_groundflow_display = float(c.get("contracted_groundflow_display_impressions") or 0)
    contracted_groundflow_video   = float(c.get("contracted_groundflow_video_completions")   or 0)
    bonus_groundflow_display      = float(c.get("bonus_groundflow_display_impressions")      or 0)
    bonus_groundflow_video        = float(c.get("bonus_groundflow_video_completions")        or 0)

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
    o2o_display_budget  = contracted_o2o_display  * cpm_neg  / 1000
    ooh_display_budget  = contracted_ooh_display  * cpm_neg  / 1000
    groundflow_display_budget = contracted_groundflow_display * cpm_neg  / 1000
    o2o_video_budget    = contracted_o2o_video    * cpcv_neg
    ooh_video_budget    = contracted_ooh_video    * cpcv_neg
    groundflow_video_budget   = contracted_groundflow_video   * cpcv_neg

    # Impressões/views negociadas (contratado + bonus)
    neg_o2o_display  = contracted_o2o_display  + bonus_o2o_display
    neg_ooh_display  = contracted_ooh_display  + bonus_ooh_display
    neg_groundflow_display = contracted_groundflow_display + bonus_groundflow_display
    neg_o2o_video    = contracted_o2o_video    + bonus_o2o_video
    neg_ooh_video    = contracted_ooh_video    + bonus_ooh_video
    neg_groundflow_video   = contracted_groundflow_video   + bonus_groundflow_video

    # Lookup por frente — extensível (O2O/OOH/RMNF) e à prova de fallback
    # (tactic desconhecido → 0). Substitui os ternários is_o2o de 2 frentes.
    _disp_budget = {"O2O": o2o_display_budget, "OOH": ooh_display_budget, "GROUNDFLOW": groundflow_display_budget}
    _vid_budget  = {"O2O": o2o_video_budget,   "OOH": ooh_video_budget,   "GROUNDFLOW": groundflow_video_budget}
    _disp_neg    = {"O2O": neg_o2o_display, "OOH": neg_ooh_display, "GROUNDFLOW": neg_groundflow_display}
    _vid_neg     = {"O2O": neg_o2o_video,   "OOH": neg_ooh_video,   "GROUNDFLOW": neg_groundflow_video}

    result = []
    for r in perf_rows:
        tactic    = r["tactic_type"]
        media     = r["media_type"]
        is_video  = media == "VIDEO"

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
            # CLAMP ao início contratual: o runway nunca começa antes de
            # `start`. Entrega pré-voo (tráfego de teste OU contaminação por
            # rename de line re-derivando short_token — ex: XV2FZA com imps
            # fantasma em 29-31/mai num voo de junho) puxava actual_start pra
            # trás, inflava o esperado e deflacionava o pacing (84,6% vs 153,9%
            # da curva, que usa start_date). max() preserva a intenção original
            # (frente que começa DEPOIS não é punida → usa actual_start).
            row_start = max(actual_start, start) if start else actual_start
        else:
            row_start = start
        row_total_days   = (end - row_start).days + 1 if row_start and end else total_days
        row_elapsed_days = max(0, (today - row_start).days) if row_start else elapsed_days
        row_is_ended     = end < today if end else False


        # Budget e negociado por tática/mídia (lookup por frente)
        if is_video:
            budget   = _vid_budget.get(tactic, 0.0)
            neg      = _vid_neg.get(tactic, 0.0)
        else:
            budget   = _disp_budget.get(tactic, 0.0)
            neg      = _disp_neg.get(tactic, 0.0)

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
        #
        # No último dia / após o fim, a campanha já decorreu por inteiro — o
        # esperado é 100% do negociado. Espelha o front (`computeMediaPacing`:
        # `now > end ? tDays`) e o `?list` (`pacing_expected_to_date`: `today >=
        # e`). Sem isso, o per-row prorrateava 30/31 no dia 31 e mostrava OVER
        # enquanto Visão Geral/Admin já mostravam UNDER (bug Video OOH 101,6% vs
        # 98,4%). Usa `today >= end` (inclui o último dia) — `row_is_ended` na
        # 4630 usa `end < today` (estrito) só pro budget_prop, não serve aqui.
        pacing_elapsed = row_total_days if (end and today >= end) else row_elapsed_days
        pacing_capped_elapsed = min(pacing_elapsed, row_total_days) if row_total_days > 0 else 0
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
            #
            # Quando `over=True`, por definição cpm_ef = budget_prop/viewable*1000
            # (idem cpcv_ef = budget_prop/completions). Então cpm_ef*viewable/1000
            # colapsa em budget_prop algebricamente — mas em float IEEE754 acumula
            # ±1 centavo por linha. Usar budget_prop direto preserva a identidade
            # matemática sem deriva (custo entregue == budget contratado da frente).
            "effective_total_cost":     round(
                budget_prop if over else (cpcv_ef * completions if is_video else cpm_ef * viewable / 1000),
                2,
            ),
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
            "groundflow_display_budget":                 round(groundflow_display_budget, 4),
            "o2o_video_budget":                    round(o2o_video_budget,   4),
            "ooh_video_budget":                    round(ooh_video_budget,   4),
            "groundflow_video_budget":                   round(groundflow_video_budget,  4),
            "contracted_o2o_display_impressions":  contracted_o2o_display,
            "contracted_ooh_display_impressions":  contracted_ooh_display,
            "contracted_groundflow_display_impressions": contracted_groundflow_display,
            "contracted_o2o_video_completions":    contracted_o2o_video,
            "contracted_ooh_video_completions":    contracted_ooh_video,
            "contracted_groundflow_video_completions":   contracted_groundflow_video,
            "bonus_o2o_display_impressions":       bonus_o2o_display,
            "bonus_ooh_display_impressions":       bonus_ooh_display,
            "bonus_groundflow_display_impressions":      bonus_groundflow_display,
            "bonus_o2o_video_completions":         bonus_o2o_video,
            "bonus_ooh_video_completions":         bonus_ooh_video,
            "bonus_groundflow_video_completions":        bonus_groundflow_video,
            "viewable_video_view_100_complete":    completions,
        })
    return result


def effective_cost_front(
    is_video, delivered, budget, neg, cpm_neg, cpcv_neg,
    actual_start, days_with_delivery, start, end, today,
):
    """Custo efetivo (faturável consumido) de UMA frente×mídia.

    Fonte ÚNICA da fórmula de `effective_total_cost` que hoje vive inline em
    `_compute_totals` (report). Extraída pra que o CARD do menu admin
    (`query_campaigns_list` → `client_delivered_value`) produza o MESMO número
    que a Visão Geral do report — antes o card usava `min(entrega×neg, contrato
    CHEIO)` por mídia, que não trava o over no pró-rata como o report faz, então
    no meio do voo uma frente adiantada mostrava a MAIS (ex.: Diageo I4U4HR card
    256k vs report 248k — gap 100% no vídeo, que entrega acima do esperado).

    Regra (idêntica ao report):
      • `budget` = contratado (SEM bônus) × CPM/CPCV negociado.
      • over-delivery (entregou mais que o esperado pró-rata) → custo travado no
        `budget_prop` (budget proporcional aos dias decorridos; budget cheio se
        encerrada). No meio do voo isso é MENOR que entrega×neg.
      • sub-delivery → entrega × negociado (valor do que rodou).
    `neg` = contratado + bônus (limiar do over/esperado); `delivered` = viewable
    impressions (display) ou viewable completions (video), sempre do UNIFIED —
    mesma fonte do report. Espelha `_compute_totals` linhas ~7695-7806 (mantém
    a paridade coberta por test_effective_cost.py)."""
    if not (start and end):
        return 0.0
    total_days   = (end - start).days + 1
    elapsed_days = max(0, (today - start).days)
    is_ended     = end < today
    row_start = max(actual_start, start) if actual_start else start
    row_total_days = (end - row_start).days + 1 if (row_start and end) else total_days
    if is_ended:
        budget_prop = budget
    elif is_video:
        budget_prop = (budget / row_total_days * days_with_delivery) if (row_total_days > 0 and days_with_delivery > 0) else 0.0
    elif total_days > 0 and elapsed_days > 0:
        budget_prop = budget / total_days * elapsed_days
    else:
        budget_prop = 0.0
    if is_video:
        expected  = (neg / row_total_days * days_with_delivery) if (row_total_days > 0 and days_with_delivery > 0) else 0
        views_esp = expected if not is_ended else neg
        over = delivered > views_esp
        return budget_prop if over else cpcv_neg * delivered
    else:
        expected  = (neg / total_days * elapsed_days) if (total_days > 0 and elapsed_days > 0) else 0
        impr_esp  = expected if not is_ended else neg
        over = delivered > impr_esp
        return budget_prop if over else cpm_neg * delivered / 1000


def query_daily(token, cr_src=None, win_from=None, win_to=None):
    """Daily aggregated by date + media_type + tactic_type for charts.

    `cr_src` (opcional): override da tabela campaign_results (já entre crases),
    usado pelo builder de snapshot (fonte de recuperação).
    `win_from`/`win_to` (opcional): janela de entrega — bound de datas."""
    win_sql = _win_clause(win_from, win_to)
    sql = f"""
        SELECT
            date,
            media_type,
            CASE WHEN REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)') AND {_GF_CONTRACT_GATE} THEN 'GROUNDFLOW' WHEN REGEXP_CONTAINS(line_name, r'(?i)[_-]O2O([_-]|$)') THEN 'O2O' WHEN REGEXP_CONTAINS(line_name, r'(?i)[_-]OOH([_-]|$)') THEN 'OOH' ELSE 'O2O' END AS tactic_type,
            SUM(impressions)                        AS impressions,
            SUM(viewable_impressions)               AS viewable_impressions,
            SUM(clicks)                             AS clicks,
            SUM(viewable_video_starts)              AS video_starts,
            SUM(viewable_video_view_100_complete)   AS video_view_100,
            -- effective_total_cost é acumulado: usar MAX por (date, line) para evitar inflação
            -- Aqui já agrupamos por date+line_name, então MAX = valor daquele dia para aquela linha
            MAX(effective_total_cost)               AS effective_total_cost
        FROM {cr_src or table_ref()}
        WHERE short_token = @token
          AND NOT REGEXP_CONTAINS(UPPER(line_name), r'SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST')
          AND UPPER(creative_name) NOT LIKE '%SURVEY%'{win_sql}
        GROUP BY date, media_type, 3
        ORDER BY date ASC
    """
    rows = run_query(sql, token, win_from, win_to)
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

    Fontes (2 queries — tabelas em regiões diferentes, não dá cross-region
    join direto):
      - campaign_results (região default): métricas viewable_* (starts,
        view_100, viewable_impressions) e clicks/impressions.
      - unified_daily_performance_metrics (US): `total_cost` raw (custo
        HYPR/admin) — bate com o threshold do score do Top Performers.
        Antes usávamos `effective_total_cost` daqui (custo cliente, com
        markup CPM/CPCV negociado × delivery), gerando eCPM de R$ 11+ vs
        threshold de R$ 0,70 — confundia o diagnóstico.

    Merge em Python por (line_name, media_type). Se uma LI aparece só em
    campaign_results (improvável mas possível), admin_total_cost = 0.
    """
    sql_metrics = f"""
        SELECT
            line_name,
            media_type,
            SUM(impressions)                        AS impressions,
            SUM(viewable_impressions)               AS viewable_impressions,
            SUM(clicks)                             AS clicks,
            SUM(viewable_video_starts)              AS video_starts,
            SUM(viewable_video_view_100_complete)   AS video_view_100
        FROM {table_ref()}
        WHERE short_token = @token
          AND media_type IN ('DISPLAY', 'VIDEO')
          AND NOT REGEXP_CONTAINS(UPPER(line_name), r'SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST')
          AND UPPER(creative_name) NOT LIKE '%SURVEY%'
        GROUP BY line_name, media_type
        ORDER BY impressions DESC
    """
    sql_cost = """
        SELECT
            line_name,
            media_type,
            SUM(total_cost) AS admin_total_cost
        FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
        WHERE short_token = @token
          AND media_type IN ('DISPLAY', 'VIDEO')
          AND NOT REGEXP_CONTAINS(UPPER(line_name), r'SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST')
          AND UPPER(creative_name) NOT LIKE '%SURVEY%'
        GROUP BY line_name, media_type
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("token", "STRING", token)
    ])

    # Paralelo: queries independentes em tabelas diferentes — ~metade da latência.
    fut_metrics = _query_pool.submit(
        lambda: list(bq.query(sql_metrics, job_config=job_config).result())
    )
    fut_cost = _query_pool.submit(
        lambda: list(bq.query(sql_cost, job_config=job_config, location="US").result())
    )
    metrics_rows = fut_metrics.result()
    cost_rows = fut_cost.result()

    cost_by_key = {
        (r["line_name"] or "", r["media_type"] or ""): float(r["admin_total_cost"] or 0)
        for r in cost_rows
    }

    result = []
    for r in metrics_rows:
        key = (r["line_name"] or "", r["media_type"] or "")
        result.append({
            "line_name":            r["line_name"]            or "",
            "media_type":           r["media_type"]           or "",
            "impressions":          int(r["impressions"]          or 0),
            "viewable_impressions": int(r["viewable_impressions"] or 0),
            "clicks":               int(r["clicks"]               or 0),
            "video_starts":         int(r["video_starts"]         or 0),
            "video_view_100":       int(r["video_view_100"]       or 0),
            "admin_total_cost":     cost_by_key.get(key, 0.0),
        })
    return result


def query_detail(token, cr_src=None, win_from=None, win_to=None):
    win_sql = _win_clause(win_from, win_to)
    sql = f"""
        SELECT
            date,
            campaign_name,
            line_name,
            creative_name,
            creative_size,
            media_type,
            CASE WHEN REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)') AND {_GF_CONTRACT_GATE} THEN 'GROUNDFLOW' WHEN REGEXP_CONTAINS(line_name, r'(?i)[_-]O2O([_-]|$)') THEN 'O2O' WHEN REGEXP_CONTAINS(line_name, r'(?i)[_-]OOH([_-]|$)') THEN 'OOH' ELSE 'O2O' END AS tactic_type,
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
        FROM {cr_src or table_ref()}
        WHERE short_token = @token
          AND NOT REGEXP_CONTAINS(UPPER(line_name), r'SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST')
          AND UPPER(creative_name) NOT LIKE '%SURVEY%'{win_sql}
        GROUP BY
            date, campaign_name, line_name,
            creative_name, creative_size, media_type, 7
        ORDER BY date ASC, media_type, creative_name
    """
    rows = run_query(sql, token, win_from, win_to)
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


def run_query(sql, token, win_from=None, win_to=None):
    params = [bigquery.ScalarQueryParameter("token", "STRING", token)]
    if win_from is not None:
        params.append(bigquery.ScalarQueryParameter("win_from", "DATE", win_from))
    if win_to is not None:
        params.append(bigquery.ScalarQueryParameter("win_to", "DATE", win_to))
    job_config = bigquery.QueryJobConfig(query_parameters=params)
    job  = bq.query(sql, job_config=job_config)
    rows = list(job.result())
    return [dict(r) for r in rows]


def _win_clause(win_from, win_to) -> str:
    """Predicado SQL de janela de entrega (vazio se sem limites). Usa os
    params @win_from/@win_to que run_query/query_totals adicionam."""
    c = ""
    if win_from is not None:
        c += " AND date >= @win_from"
    if win_to is not None:
        c += " AND date <= @win_to"
    return c


def _window_sql_predicate(windows: dict) -> str:
    """Constrói um predicado SQL (CASE) que limita as linhas dos tokens COM
    delivery window cadastrada ao range [date_from, date_to]; os demais tokens
    passam sem filtro (ELSE TRUE). Devolve "" se não houver window.

    Por quê: o card do menu (query_campaigns_list) agrega delivery ao vivo por
    token e, sem isso, NÃO honra a window que o report individual já honra —
    então um token que herdou delivery de outro período via rename de line
    (ex: QG2MRY herdou maio do N8Z4B7) aparece over no card mesmo com o report
    correto. Injetado nas CTEs que varrem tabelas com coluna `date`.

    Seguro contra injection: só tokens [A-Za-z0-9_-]+ entram; datas via
    .isoformat() de objetos DATE do BQ.
    """
    clauses = []
    for tok, bounds in (windows or {}).items():
        if not tok or not re.fullmatch(r"[A-Za-z0-9_-]+", str(tok)):
            continue
        wf, wt = (bounds or (None, None))
        conds = []
        if wf is not None:
            conds.append(f"date >= DATE '{wf.isoformat() if hasattr(wf, 'isoformat') else wf}'")
        if wt is not None:
            conds.append(f"date <= DATE '{wt.isoformat() if hasattr(wt, 'isoformat') else wt}'")
        if not conds:
            continue
        clauses.append(f"WHEN '{tok}' THEN {' AND '.join(conds)}")
    if not clauses:
        return ""
    body = "\n".join("                    " + c for c in clauses)
    return f"AND (CASE short_token\n{body}\n                    ELSE TRUE END)"


def _apply_frozen_delivery_override(r: dict, payload: dict) -> None:
    """Sobrescreve IN PLACE os campos de ENTREGA da row da lista com os do
    snapshot congelado. Só entrega é tocada — contratado, budget, datas e cpm
    vêm de tabelas não-delivery (corretas ao vivo, imunes ao rename de line).

    Por quê: sem isso o card do menu de um token congelado mostra a entrega ao
    vivo (vazada via rename → re-derivação do short_token no rebuild dbt),
    divergindo do report que serve o snapshot. Ver incidente Listerine N8Z4B7.

    LIMITAÇÃO: custo CRU admin (admin_total_cost*, monthly_cost_full) NÃO está
    no snapshot (payload do cliente não carrega) → permanece ao vivo
    (best-effort). Afeta só ECPM ADM / Tech do card encerrado, não o pacing.
    """
    totals = payload.get("totals") or []
    if not totals:
        return
    D = [t for t in totals if t.get("media_type") == "DISPLAY"]
    V = [t for t in totals if t.get("media_type") == "VIDEO"]

    def _sum(rows, key):
        return sum(float(t.get(key) or 0) for t in rows)

    def _sum_tac(rows, tac, key):
        return sum(float(t.get(key) or 0) for t in rows if t.get("tactic_type") == tac)

    def _pdate(s):
        if not s:
            return None
        if hasattr(s, "year"):
            return s
        try:
            return date.fromisoformat(str(s)[:10])
        except Exception:
            return None

    def _astart(rows, tac=None):
        ds = [t.get("actual_start_date") for t in rows
              if t.get("actual_start_date") and (tac is None or t.get("tactic_type") == tac)]
        return _pdate(min(ds)) if ds else None

    # ── Display ──
    d_view = _sum(D, "viewable_impressions")
    r["d_vi"]                       = d_view   # denominador do display_ctr (= viewable)
    r["d_viewable_impressions"]     = d_view   # numerador do display_pacing
    r["d_clicks"]                   = _sum(D, "clicks")
    r["d_cost"]                     = _sum(D, "effective_total_cost")
    r["d_o2o_viewable_impressions"] = _sum_tac(D, "O2O", "viewable_impressions")
    r["d_ooh_viewable_impressions"] = _sum_tac(D, "OOH", "viewable_impressions")
    r["d_days_with_delivery"]       = max((int(t.get("days_with_delivery") or 0) for t in D), default=0)
    r["d_actual_start_date"]        = _astart(D)
    r["d_o2o_actual_start_date"]    = _astart(D, "O2O")
    r["d_ooh_actual_start_date"]    = _astart(D, "OOH")

    # ── Video (numerador de VTR/pacing = viewable completions) ──
    v_view_imp  = _sum(V, "viewable_impressions")
    v_view_comp = _sum(V, "viewable_video_view_100_complete")
    r["v_vi"]                       = v_view_imp
    r["v_viewable_impressions"]     = v_view_imp
    r["v_completions"]              = _sum(V, "completions")
    r["v_viewable_completions"]     = v_view_comp
    r["v_clicks"]                   = _sum(V, "clicks")
    r["v_cost"]                     = _sum(V, "effective_cost_with_over")
    r["v_o2o_viewable_completions"] = _sum_tac(V, "O2O", "viewable_video_view_100_complete")
    r["v_ooh_viewable_completions"] = _sum_tac(V, "OOH", "viewable_video_view_100_complete")
    r["v_days_with_delivery"]       = max((int(t.get("days_with_delivery") or 0) for t in V), default=0)
    r["v_actual_start_date"]        = _astart(V)
    r["v_o2o_actual_start_date"]    = _astart(V, "O2O")
    r["v_ooh_actual_start_date"]    = _astart(V, "OOH")

    # ── Faturável consumido (client_delivered_value) ──
    # Report congelado serve o snapshot VERBATIM (entrega + custo travados),
    # então o "consumido" do card = Σ effective_total_cost gravado nas rows de
    # totals — exatamente o Custo Efetivo que a Visão Geral do report exibe.
    # Sinaliza pro loop pular o recálculo live (effective_cost_front) e usar
    # estes valores congelados. Chave privada (prefixo _) — não sai no payload.
    r["_frozen_d_delivered_value"] = _sum(D, "effective_total_cost")
    r["_frozen_v_delivered_value"] = _sum(V, "effective_total_cost")


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
    #
    # `win` = predicado de delivery window (vazio quando não há nenhuma). É
    # injetado nas CTEs que varrem tabelas com coluna `date` (dedup, unified,
    # monthly_cost_full, unified_cost_full) pra que o card honre a mesma janela
    # do report. Tokens sem window não são afetados (ELSE TRUE).
    win = _window_sql_predicate(query_delivery_windows())
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
                MAX(contracted_groundflow_display_impressions) AS contracted_groundflow_display,
                MAX(contracted_groundflow_video_completions)   AS contracted_groundflow_video,
                MAX(bonus_o2o_display_impressions)          AS bonus_o2o_display,
                MAX(bonus_ooh_display_impressions)          AS bonus_ooh_display,
                MAX(bonus_o2o_video_completions)            AS bonus_o2o_video,
                MAX(bonus_ooh_video_completions)            AS bonus_ooh_video,
                MAX(bonus_groundflow_display_impressions)   AS bonus_groundflow_display,
                MAX(bonus_groundflow_video_completions)     AS bonus_groundflow_video,
                -- gate do Groundflow: TRUE só quando há contrato/bônus de
                -- groundflow. Sem isso, line groundflow é dark test → O2O/OOH.
                (COALESCE(MAX(contracted_groundflow_display_impressions),0)
                 + COALESCE(MAX(contracted_groundflow_video_completions),0)
                 + COALESCE(MAX(bonus_groundflow_display_impressions),0)
                 + COALESCE(MAX(bonus_groundflow_video_completions),0)) > 0 AS gf_on
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
        -- Agrega por (date, line_name, creative_name) preservando media_type.
        -- viewable_impressions / clicks / completions são ADITIVOS → SUM, igual
        -- query_detail (fonte da Visão Geral e das abas). Antes usava MAX aqui,
        -- o que inflava o CTR do card do admin vs o report — ex: Listerine
        -- 1,48% (admin) vs 1,32% (report). Já effective_total_cost /
        -- effective_cost_with_over são ACUMULADOS (cumulative) no
        -- campaign_results → MAX pega o último valor por linha (last-write-wins).
        dedup AS (
            SELECT
                short_token, media_type,
                date, line_name, creative_name,
                SUM(viewable_impressions)             AS vi,
                SUM(clicks)                           AS clicks,
                MAX(effective_total_cost)             AS effective_total_cost,
                SUM(viewable_video_view_100_complete) AS v100_complete,
                MAX(effective_cost_with_over)         AS effective_cost_with_over,
                -- gate do Groundflow por token (carregado pro agg classificar)
                ANY_VALUE(gf_on)                      AS gf_on
            FROM {table_ref()}
            LEFT JOIN checklist USING(short_token)
            WHERE media_type IN ('DISPLAY', 'VIDEO')
              AND NOT REGEXP_CONTAINS(UPPER(line_name), r'SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST')
              AND UPPER(creative_name) NOT LIKE '%SURVEY%'
              {win}
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
                SUM(IF(media_type='VIDEO',   effective_cost_with_over, 0)) AS v_cost,
                -- Splits CR por frente (entrega) pra pacing/VTR baterem 1:1 com
                -- o report (query_detail também é CR). O numerador de entrega
                -- vem daqui — NÃO da CTE `unified` (que usa fórmula aproximada
                -- de viewable p/ vídeo e viewable ≈ impressões p/ display quando
                -- a viewability não é medida). Mesmo regex de tactic do app.
                -- Groundflow vence O2O/OOH (mesma prioridade do CASE): as lines
                -- vêm como `_O2O_GROUNDFLOW_`, então O2O/OOH EXCLUEM groundflow
                -- pra não dupla-contar.
                SUM(IF(media_type='DISPLAY' AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]O2O([_-]|$)'), vi,            0)) AS d_o2o_vi,
                SUM(IF(media_type='DISPLAY' AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]OOH([_-]|$)'), vi,            0)) AS d_ooh_vi,
                SUM(IF(media_type='DISPLAY' AND gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)'), vi,            0)) AS d_groundflow_vi,
                SUM(IF(media_type='VIDEO'   AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]O2O([_-]|$)'), v100_complete, 0)) AS v_o2o_comp,
                SUM(IF(media_type='VIDEO'   AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]OOH([_-]|$)'), v100_complete, 0)) AS v_ooh_comp,
                SUM(IF(media_type='VIDEO'   AND gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)'), v100_complete, 0)) AS v_groundflow_comp
            FROM dedup
            GROUP BY short_token
        ),
        -- Cálculos de pacing: usa unified_daily como source-of-truth pra
        -- viewable_impressions e days_with_delivery, igual o legacy fazia
        -- em CTEs separadas. Agora numa única varredura.
        unified AS (
            SELECT
                short_token,
                -- Actual start dates: primeiro dia que cada frente realmente
                -- entregou. Usados como base do pacing (em vez do start
                -- contratual da campanha) — frente que atrasa não é punida
                -- pelos dias em que não rodou. Per-tactic é necessário porque
                -- O2O e OOH podem começar em dias diferentes mesmo dentro
                -- da mesma mídia.
                MIN(IF(media_type='VIDEO', date, NULL))              AS v_actual_start_date,
                MIN(IF(media_type='DISPLAY', date, NULL))            AS d_actual_start_date,
                MIN(IF(media_type='DISPLAY' AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]O2O([_-]|$)'), date, NULL)) AS d_o2o_actual_start_date,
                MIN(IF(media_type='DISPLAY' AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]OOH([_-]|$)'), date, NULL)) AS d_ooh_actual_start_date,
                MIN(IF(media_type='DISPLAY' AND gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)'), date, NULL)) AS d_groundflow_actual_start_date,
                MIN(IF(media_type='VIDEO'   AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]O2O([_-]|$)'), date, NULL)) AS v_o2o_actual_start_date,
                MIN(IF(media_type='VIDEO'   AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]OOH([_-]|$)'), date, NULL)) AS v_ooh_actual_start_date,
                MIN(IF(media_type='VIDEO'   AND gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)'), date, NULL)) AS v_groundflow_actual_start_date,
                COUNT(DISTINCT IF(media_type='VIDEO', date, NULL)) AS v_days_with_delivery,
                SUM(IF(media_type='VIDEO' AND impressions > 0,
                        video_view_100_complete * (viewable_impressions / impressions),
                        0))                                        AS v_viewable_completions,
                SUM(IF(media_type='VIDEO', viewable_impressions, 0)) AS v_viewable_impressions,
                COUNT(DISTINCT IF(media_type='DISPLAY', date, NULL)) AS d_days_with_delivery,
                SUM(IF(media_type='DISPLAY', viewable_impressions, 0)) AS d_viewable_impressions,
                -- Entrega UNIFIED por FRENTE (viewable display / viewable
                -- completions video) + dias de entrega do vídeo por frente.
                -- Alimentam o FATURÁVEL per-frente (client_delivered_value via
                -- effective_cost_front), que precisa decidir over/under POR
                -- FRENTE — o report (_compute_totals) faz exatamente isso lendo
                -- o UNIFIED. O pacing per-frente continua vindo do CR (`agg`);
                -- só o faturável usa estes campos unified. Mesmo regex/gate de
                -- Groundflow das demais frentes (GF vence O2O/OOH).
                SUM(IF(media_type='DISPLAY' AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]O2O([_-]|$)'), viewable_impressions, 0)) AS d_o2o_uview,
                SUM(IF(media_type='DISPLAY' AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]OOH([_-]|$)'), viewable_impressions, 0)) AS d_ooh_uview,
                SUM(IF(media_type='DISPLAY' AND gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)'), viewable_impressions, 0)) AS d_groundflow_uview,
                SUM(IF(media_type='VIDEO' AND impressions > 0 AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]O2O([_-]|$)'), video_view_100_complete * (viewable_impressions / impressions), 0)) AS v_o2o_ucomp,
                SUM(IF(media_type='VIDEO' AND impressions > 0 AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]OOH([_-]|$)'), video_view_100_complete * (viewable_impressions / impressions), 0)) AS v_ooh_ucomp,
                SUM(IF(media_type='VIDEO' AND impressions > 0 AND gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)'), video_view_100_complete * (viewable_impressions / impressions), 0)) AS v_groundflow_ucomp,
                COUNT(DISTINCT IF(media_type='VIDEO' AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]O2O([_-]|$)'), date, NULL)) AS v_o2o_udays,
                COUNT(DISTINCT IF(media_type='VIDEO' AND NOT (gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)')) AND REGEXP_CONTAINS(line_name, r'(?i)[_-]OOH([_-]|$)'), date, NULL)) AS v_ooh_udays,
                COUNT(DISTINCT IF(media_type='VIDEO' AND gf_on AND REGEXP_CONTAINS(line_name, r'(?i)[_-](RMNF|GROUNDFLOW)([_-]|$)'), date, NULL)) AS v_groundflow_udays,
                -- NOTA: a entrega por frente pra PACING (d_o2o_viewable_impressions
                -- etc.) vem do CR (CTE `agg`), pra o pacing per-frente do card
                -- bater 1:1 com o report (query_detail). Os totais unified
                -- (d_viewable_impressions / v_viewable_completions) e os splits
                -- *_uview/*_ucomp acima alimentam o FATURÁVEL
                -- (client_delivered_value), que espelha o effective_total_cost
                -- do report — esse, sim, é unified.
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
            LEFT JOIN checklist USING(short_token)
            WHERE media_type IN ('DISPLAY', 'VIDEO')
              AND NOT REGEXP_CONTAINS(UPPER(line_name), r'SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST')
              AND UPPER(creative_name) NOT LIKE '%SURVEY%'
              {win}
            GROUP BY short_token
        ),
        -- Entrega de ontem (D-1) por mídia. Alimenta a coluna "Viewable
        -- Imps. D-1" / "Views 100% D-1" da aba Diagnóstico do menu admin.
        -- "Ontem" calculado em BRT (America/Sao_Paulo) pra ser consistente
        -- com `query_data_freshness()` na linha ~3580 — mesma tabela, mesmo
        -- timezone. Filtro `date = ontem` aproveita partition pruning da
        -- tabela (custo BQ trivial).
        --
        -- Quando o rollup das 6h BRT ainda não rodou ou a campanha não
        -- entregou nada ontem, a row some via LEFT JOIN → entry omite
        -- o campo → frontend renderiza "—" (semântica honesta de "sem
        -- dado", em vez de zero confuso).
        yesterday_delivery AS (
            SELECT
                short_token,
                SUM(IF(media_type='DISPLAY', viewable_impressions, 0)) AS d_yesterday_viewable,
                -- Video usa mesma matemática de v_viewable_completions
                -- (linhas 4937-4939) pra evitar VTR > 100% por descasamento
                -- de fontes — viewable_completions ponderado pela
                -- viewability daquele dia.
                SUM(IF(media_type='VIDEO' AND impressions > 0,
                        video_view_100_complete * (viewable_impressions / impressions),
                        0)) AS v_yesterday_completions
            FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
            WHERE date = DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL 1 DAY)
              AND media_type IN ('DISPLAY', 'VIDEO')
              AND NOT REGEXP_CONTAINS(UPPER(line_name), r'SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST')
              AND UPPER(creative_name) NOT LIKE '%SURVEY%'
            GROUP BY short_token
        ),
        -- Entrega dos últimos 7 dias (janela rolling, exclui hoje porque hoje
        -- ainda não fechou). Mesma matemática do yesterday_delivery, só muda
        -- o filtro de data: BETWEEN D-7 AND D-1 (7 dias completos antes de
        -- hoje). Usado pela aba Diagnóstico pra projetar pacing forward —
        -- 7 dias suaviza variação diária (fim de semana, anomalia DSP, dia
        -- de spike) sem carregar o histórico antigo da campanha.
        --
        -- Partition pruning aproveita: a tabela é particionada por date,
        -- então o intervalo de 7 dias custa ~7x o yesterday_delivery, ainda
        -- desprezível no custo total da query.
        --
        -- Campanha com elapsed < 7 dias: a soma vai cobrir só o que existir
        -- (não há registro de dias antes do start). O frontend divide por
        -- min(7, elapsed_days) pra não subestimar o ritmo de campanhas curtas.
        last7d_delivery AS (
            SELECT
                short_token,
                SUM(IF(media_type='DISPLAY', viewable_impressions, 0)) AS d_last7d_viewable,
                SUM(IF(media_type='VIDEO' AND impressions > 0,
                        video_view_100_complete * (viewable_impressions / impressions),
                        0)) AS v_last7d_completions
            FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
            WHERE date BETWEEN DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL 7 DAY)
                           AND DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL 1 DAY)
              AND media_type IN ('DISPLAY', 'VIDEO')
              AND NOT REGEXP_CONTAINS(UPPER(line_name), r'SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST')
              AND UPPER(creative_name) NOT LIKE '%SURVEY%'
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
        ),
        -- Custo TOTAL por (token, mês calendário) — ADMIN-ONLY.
        --
        -- Usado pelo KPI strip pra calcular tech cost com a régua
        -- assimetrica HYPR: numerador soma o custo gasto DENTRO do mês
        -- selecionado por TODAS campanhas que tocaram esse mês (incluindo
        -- cross-month tail tipo Neutrogena 27/04→31/05); denominador soma
        -- só os budgets de PIs vendidas pra aquele mês (start_date em M).
        --
        -- Granularidade mês resolve o problema do modelo vintage puro:
        --   - PI sold pra Abr que cruza pra Mai → custo de Abr fica em
        --     Abr, custo de Mai vai pra Mai. Budget fica em Abr (PI foi
        --     vendida em Abr).
        --   - Não tem double counting entre meses do custo.
        --
        -- Sem filtro de SURVEY/CONTROLE/EXPOSTO: admin precisa do custo
        -- real DSP, survey incluso. Espelha a regra do `unified_cost_full`
        -- abaixo (que é o total lifetime sem survey).
        --
        -- Estrutura ARRAY<STRUCT<month_key, cost>> permite JOIN sem fanout
        -- no SELECT principal (uma row por token) — Python desempacota
        -- pra dict {{month_key: cost}} no entry.
        monthly_cost_full AS (
            SELECT
                short_token,
                ARRAY_AGG(STRUCT(month_key, cost) ORDER BY month_key) AS months
            FROM (
                SELECT
                    short_token,
                    FORMAT_DATE('%Y-%m', date) AS month_key,
                    SUM(total_cost) AS cost
                FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
                WHERE media_type IN ('DISPLAY', 'VIDEO')
                  -- INTENCIONAL: sem filtro de survey (mesmo motivo do
                  -- unified_cost_full — tech cost considera custo real).
                  {win}
                GROUP BY short_token, month_key
            )
            GROUP BY short_token
        ),
        -- Custo TOTAL incluindo lines de survey — ADMIN-ONLY, usado pelo
        -- KPI strip (tech cost agregado) e pela coluna Custo/Tech do
        -- diagnostico. Survey custa dinheiro real no DSP e sai da carteira
        -- HYPR, então pra visão de margem da operação ele PRECISA entrar.
        --
        -- Decisão: NÃO mexer no `admin_total_cost` da CTE `unified` (que ja
        -- exclui survey). Aquele campo alimenta o eCPM (cost/impressions),
        -- que precisa de cost E impressions ambos sem survey pra ratio
        -- fazer sentido. Tech cost usa outro denominador (PI cliente em
        -- R$, não em impressions), então pode incluir survey no numerador
        -- sem distorcer a matematica.
        --
        -- Pacing, BID, CTR, VTR, viewability continuam sem survey (usam
        -- viewable_impressions da `unified` que mantem filtro de survey).
        -- Report do cliente NÃO usa essa CTE — endpoint single-token
        -- tem sua propria query que mantem survey fora.
        unified_cost_full AS (
            SELECT
                short_token,
                SUM(total_cost)                              AS admin_total_cost_full,
                SUM(IF(media_type='DISPLAY', total_cost, 0)) AS d_admin_total_cost_full,
                SUM(IF(media_type='VIDEO',   total_cost, 0)) AS v_admin_total_cost_full
            FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
            WHERE media_type IN ('DISPLAY', 'VIDEO')
              -- INTENCIONAL: sem filtro de SURVEY/CONTROLE/EXPOSTO aqui.
              -- Survey faz parte do custo real DSP — admin precisa ver.
              {win}
            GROUP BY short_token
        )
        SELECT
            b.short_token, b.client_name, b.campaign_name,
            b.start_date, b.end_date, b.updated_at,
            a.d_vi, a.d_clicks, a.d_cost,
            a.v_vi, a.v_clicks, a.v_completions, a.v_cost,
            -- Entrega por frente vem do CR (agg), não do unified — pacing
            -- per-frente bate com o report. Aliasada pros nomes canônicos pra
            -- não mexer no Python nem no override de freeze.
            a.d_o2o_vi   AS d_o2o_viewable_impressions,
            a.d_ooh_vi   AS d_ooh_viewable_impressions,
            a.d_groundflow_vi AS d_groundflow_viewable_impressions,
            a.v_o2o_comp AS v_o2o_viewable_completions,
            a.v_ooh_comp AS v_ooh_viewable_completions,
            a.v_groundflow_comp AS v_groundflow_viewable_completions,
            c.cpm_amount, c.cpcv_amount,
            c.contracted_o2o_display, c.contracted_ooh_display,
            c.contracted_groundflow_display,
            c.contracted_o2o_video,   c.contracted_ooh_video,
            c.contracted_groundflow_video,
            c.bonus_o2o_display,      c.bonus_ooh_display,
            c.bonus_groundflow_display,
            c.bonus_o2o_video,        c.bonus_ooh_video,
            c.bonus_groundflow_video,
            u.v_actual_start_date,    u.v_days_with_delivery,  u.v_viewable_completions,
            u.v_viewable_impressions,
            u.d_actual_start_date,
            u.d_o2o_actual_start_date, u.d_ooh_actual_start_date,
            u.d_groundflow_actual_start_date,
            u.v_o2o_actual_start_date, u.v_ooh_actual_start_date,
            u.v_groundflow_actual_start_date,
            u.d_days_with_delivery,   u.d_viewable_impressions,
            -- Entrega UNIFIED por frente (faturável per-frente = effective_cost_front)
            u.d_o2o_uview,   u.d_ooh_uview,   u.d_groundflow_uview,
            u.v_o2o_ucomp,   u.v_ooh_ucomp,   u.v_groundflow_ucomp,
            u.v_o2o_udays,   u.v_ooh_udays,   u.v_groundflow_udays,
            u.admin_total_cost,       u.admin_impressions,
            u.d_admin_total_cost,     u.d_admin_impressions,
            u.v_admin_total_cost,     u.v_admin_impressions,
            yd.d_yesterday_viewable,  yd.v_yesterday_completions,
            l7.d_last7d_viewable,     l7.v_last7d_completions,
            uf.admin_total_cost_full, uf.d_admin_total_cost_full, uf.v_admin_total_cost_full,
            mcf.months                AS monthly_cost_full_arr,
            ab.display_has_abs,       ab.video_has_abs
        FROM base b
        LEFT JOIN agg                a USING (short_token)
        LEFT JOIN checklist          c USING (short_token)
        LEFT JOIN unified            u USING (short_token)
        LEFT JOIN yesterday_delivery yd USING (short_token)
        LEFT JOIN last7d_delivery    l7 USING (short_token)
        LEFT JOIN unified_cost_full  uf USING (short_token)
        LEFT JOIN monthly_cost_full  mcf USING (short_token)
        LEFT JOIN campaign_abs       ab USING (short_token)
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
    fut_closures = _query_pool.submit(_safe_get_closures)
    fut_pauses   = _query_pool.submit(_safe_get_pauses)
    fut_early    = _query_pool.submit(_safe_get_early_ends)
    fut_frozen   = _query_pool.submit(query_frozen_tokens)
    fut_elements = _query_pool.submit(_safe_get_elements)

    rows           = fut_query.result()
    lookup_owners  = fut_owners.result()
    overrides_map  = fut_overrides.result()
    aliases_map    = fut_aliases.result()
    share_ids_map  = fut_shares.result()
    merges_map     = fut_merges.result()
    closures_map   = fut_closures.result()
    pauses_map     = fut_pauses.result()
    early_map      = fut_early.result()
    frozen_map     = fut_frozen.result()
    elements_map   = fut_elements.result()

    # Override de core products (curadoria admin) — zera contratado/bônus das
    # frentes fora do set TAMBÉM no card admin, consistente com o report
    # client-facing (que aplica em _fetch_contracts). Só toca tokens COM override
    # (raros): converte a Row pra dict mutável e zera as colunas da frente
    # inativa. Mixed Row/dict é seguro — o loop abaixo lê via r[...]/r.get(...).
    try:
        _cp_overrides = query_core_product_overrides()
    except Exception as e:
        logger.warning(f"[WARN list cp_override] {e}")
        _cp_overrides = {}
    if _cp_overrides:
        _new_rows = []
        for r in rows:
            active = _cp_overrides.get(r["short_token"])
            if not active:
                _new_rows.append(r)
                continue
            rd = dict(r.items())
            for frente, prefix in _CP_COLUMN_PREFIX.items():
                if frente in active:
                    continue
                for tmpl in ("contracted_{p}_display", "contracted_{p}_video",
                             "bonus_{p}_display", "bonus_{p}_video"):
                    col = tmpl.format(p=prefix)
                    if col in rd:
                        rd[col] = 0
            _new_rows.append(rd)
        rows = _new_rows

    # Tokens congelados presentes na lista: carrega o snapshot pra sobrescrever
    # a ENTREGA do card (delivery ao vivo vaza via rename → diverge do report).
    # Raro (0-2 tokens normalmente); load em paralelo. Ver
    # _apply_frozen_delivery_override.
    snap_payloads = {}
    _frozen_here = [r["short_token"] for r in rows if r["short_token"] in frozen_map]
    if _frozen_here:
        _snap_futs = {t: _query_pool.submit(_load_snapshot_payload, t) for t in _frozen_here}
        snap_payloads = {t: f.result() for t, f in _snap_futs.items()}

    # Helpers do loop abaixo — definidos UMA vez fora do loop (antes eram
    # redefinidos a cada iteração, ~270×/request). Funções puras: todo input
    # chega por argumento, nada captura variáveis da iteração.

    # Parse actual_start_date helper — BQ pode devolver datetime ou date.
    # Fallback null preservado (None significa "frente nunca entregou").
    def _coerce_date(val):
        if val is None:
            return None
        return val.date() if hasattr(val, "date") else val

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
    # O per-row pacing (campo `pacing` em totals, consumido pelo Resumo
    # por mídia + Detalhamento + barra da aba Video) já foi alinhado em
    # query_totals (~4671): calendar-elapsed com cap em row_total_days e a
    # regra `today >= end → esperado = negociado cheio`, igual a esta.
    #
    # Retorna o "esperado até hoje" pra base do pacing.
    # delivered/expected × 100 dá a % de pacing — exposta como métrica
    # calculada no payload. expected também vai cru pro front pra permitir
    # agregação correta (Σdelivered / Σexpected) por owner/cliente em vez
    # de média de razões (que distorce por amostra pequena).
    #
    # `actual_start` opcional: quando a frente atrasou pra começar, usar
    # o primeiro dia de entrega real evita penalizar a frente pelos dias
    # em que não rodou. Fallback pra `sd` (start contratual) quando a
    # frente ainda não entregou nada — nesse caso delivered=0 e o pacing
    # será 0% independente do start usado.
    def pacing_expected_to_date(negotiated, sd, ed, actual_start=None):
        if negotiated <= 0 or not sd or not ed:
            return None
        s_camp = sd.date() if hasattr(sd, "date") else sd
        e = ed.date() if hasattr(ed, "date") else ed
        # CLAMP ao início contratual (ver query_totals/aggregations.js):
        # entrega pré-voo não estica o runway pra trás. max() preserva o
        # caso de frente que começa DEPOIS (actual_start > s_camp).
        s = max(actual_start, s_camp) if actual_start else s_camp
        today = date.today()
        total_days = (e - s).days + 1
        if total_days <= 0:
            return None
        # No último dia (ou depois) a campanha já decorreu por inteiro —
        # o esperado é 100% do negociado. Alinha com o front
        # (computeMediaPacing: `now > end ? tDays`). Mid-flight conta só
        # dias completos (dia corrente não entra), igual ao floor() do front.
        if today >= e:
            elapsed_days = total_days
        else:
            elapsed_days = max(0, (today - s).days)
        if elapsed_days <= 0:
            return None
        return negotiated / total_days * elapsed_days

    result = []
    for r in rows:
        # Cópia mutável da Row do BQ: pra tokens congelados sobrescrevemos os
        # campos de entrega in-place (contratado/budget/datas/cpm ficam ao vivo,
        # corretos). O resto do loop computa pacing/ctr/vtr a partir daqui.
        r = dict(r)
        _tok = r["short_token"]
        if snap_payloads.get(_tok):
            _apply_frozen_delivery_override(r, snap_payloads[_tok])

        start_date = r["start_date"]
        end_date   = r["end_date"]

        d_vi   = float(r["d_vi"]          or 0)
        d_cost = float(r["d_cost"]        or 0)
        v_vi              = float(r["v_vi"]                  or 0)
        v_comp            = float(r["v_completions"]          or 0)
        v_cost            = float(r["v_cost"]                 or 0)
        v_days_delivery   = int(r["v_days_with_delivery"]     or 0)
        v_actual_start    = _coerce_date(r["v_actual_start_date"])
        d_actual_start    = _coerce_date(r["d_actual_start_date"])
        d_o2o_actual_start = _coerce_date(r["d_o2o_actual_start_date"])
        d_ooh_actual_start = _coerce_date(r["d_ooh_actual_start_date"])
        d_groundflow_actual_start = _coerce_date(r["d_groundflow_actual_start_date"])
        v_o2o_actual_start = _coerce_date(r["v_o2o_actual_start_date"])
        v_ooh_actual_start = _coerce_date(r["v_ooh_actual_start_date"])
        v_groundflow_actual_start = _coerce_date(r["v_groundflow_actual_start_date"])
        d_days_delivery   = int(r["d_days_with_delivery"]     or 0)

        cpm_amount  = float(r["cpm_amount"]  or 0)
        cpcv_amount = float(r["cpcv_amount"] or 0)

        d_clicks = float(r["d_clicks"] or 0)
        v_clicks = float(r["v_clicks"] or 0)

        # Negociado por tactic (contrato + bonus) — denominador do pacing per-frente.
        d_o2o_neg = float(r["contracted_o2o_display"] or 0) + float(r["bonus_o2o_display"] or 0)
        d_ooh_neg = float(r["contracted_ooh_display"] or 0) + float(r["bonus_ooh_display"] or 0)
        d_groundflow_neg = float(r["contracted_groundflow_display"] or 0) + float(r["bonus_groundflow_display"] or 0)
        v_o2o_neg = float(r["contracted_o2o_video"]   or 0) + float(r["bonus_o2o_video"]   or 0)
        v_ooh_neg = float(r["contracted_ooh_video"]   or 0) + float(r["bonus_ooh_video"]   or 0)
        v_groundflow_neg = float(r["contracted_groundflow_video"] or 0) + float(r["bonus_groundflow_video"] or 0)

        # Entrega por tactic (viewable impressions/completions) — numerador.
        d_o2o_viewable = float(r["d_o2o_viewable_impressions"]  or 0)
        d_ooh_viewable = float(r["d_ooh_viewable_impressions"]  or 0)
        d_groundflow_viewable = float(r["d_groundflow_viewable_impressions"] or 0)
        v_o2o_viewable = float(r["v_o2o_viewable_completions"]  or 0)
        v_ooh_viewable = float(r["v_ooh_viewable_completions"]  or 0)
        v_groundflow_viewable = float(r["v_groundflow_viewable_completions"] or 0)

        # Pacing per-frente. Emite só quando há contrato pra aquela frente
        # — sem contrato (None) o front esconde a sub-barra (sem ruído).
        # Com contrato + zero delivery → 0.0% (sinaliza "vendido, não iniciou").
        # Usa actual_start_date per-tactic — frente atrasada não é penalizada.
        d_o2o_expected = pacing_expected_to_date(d_o2o_neg, start_date, end_date, d_o2o_actual_start)
        d_ooh_expected = pacing_expected_to_date(d_ooh_neg, start_date, end_date, d_ooh_actual_start)
        d_groundflow_expected = pacing_expected_to_date(d_groundflow_neg, start_date, end_date, d_groundflow_actual_start)
        v_o2o_expected = pacing_expected_to_date(v_o2o_neg, start_date, end_date, v_o2o_actual_start)
        v_ooh_expected = pacing_expected_to_date(v_ooh_neg, start_date, end_date, v_ooh_actual_start)
        v_groundflow_expected = pacing_expected_to_date(v_groundflow_neg, start_date, end_date, v_groundflow_actual_start)
        display_pacing_o2o = round(d_o2o_viewable / d_o2o_expected * 100, 1) if d_o2o_expected and d_o2o_expected > 0 else None
        display_pacing_ooh = round(d_ooh_viewable / d_ooh_expected * 100, 1) if d_ooh_expected and d_ooh_expected > 0 else None
        display_pacing_groundflow = round(d_groundflow_viewable / d_groundflow_expected * 100, 1) if d_groundflow_expected and d_groundflow_expected > 0 else None
        video_pacing_o2o   = round(v_o2o_viewable / v_o2o_expected * 100, 1) if v_o2o_expected and v_o2o_expected > 0 else None
        video_pacing_ooh   = round(v_ooh_viewable / v_ooh_expected * 100, 1) if v_ooh_expected and v_ooh_expected > 0 else None
        video_pacing_groundflow = round(v_groundflow_viewable / v_groundflow_expected * 100, 1) if v_groundflow_expected and v_groundflow_expected > 0 else None

        # Esperado AGREGADO = Σ esperado por frente (cada uma com seu próprio
        # actual_start/runway), NÃO o negociado combinado contra um único
        # actual_start. Espelha computeMediaPacing (tactic="ALL"): Σentregue /
        # Σesperado. Antes usava v_neg/d_neg total + o actual_start mais cedo
        # (MIN das frentes), o que inflava o esperado da frente que começou mais
        # tarde → o pacing agregado do card podia ficar ABAIXO de ambas as
        # frentes (ex.: Diageo vídeo 90% no card vs O2O 138% / OOH 117% no
        # report; display 59% vs 92% — OOH entrou ~15 dias depois do O2O).
        # Também corrige os campos *_expected_* expostos pro rollup por owner.
        d_expected = ((d_o2o_expected or 0) + (d_ooh_expected or 0) + (d_groundflow_expected or 0)) or None
        v_expected = ((v_o2o_expected or 0) + (v_ooh_expected or 0) + (v_groundflow_expected or 0)) or None

        # Entrega (numerador do pacing) vem do CR: d_vi / v_comp = mesma fonte
        # do report (query_detail). ANTES usava d_viewable_impr / v_viewable_comp
        # (unified), onde o viewable de DISPLAY pode vir ≈ impressões e o de
        # VÍDEO usa fórmula aproximada — divergia do report. Faturável
        # (client_delivered_value) continua no unified (espelha effective_total_cost).
        display_pacing = round(d_vi   / d_expected * 100, 1) if d_expected and d_expected > 0 else None
        video_pacing   = round(v_comp / v_expected * 100, 1) if v_expected and v_expected > 0 else None
        display_ctr    = round(d_clicks         / d_vi          * 100, 2) if d_vi             > 0       else None
        # video_ctr: cliques de vídeo são raros (geralmente skip-button ou
        # clickthrough do creative). Quando existem, o threshold do score
        # é mais brando que Display (>0,3% vs >0,6%) — formatos diferentes.
        video_ctr      = round(v_clicks         / v_vi          * 100, 2) if v_vi             > 0       else None
        # VTR: viewable_completions / viewable_impressions — ambos do CR (agg):
        # v_comp / v_vi. Mesma fonte → consistente (não dá VTR > 100% por
        # descasamento) e bate com o report (query_detail também é CR). ANTES
        # vinha do unified (v_viewable_comp / v_viewable_impr), que divergia.
        video_vtr      = round(v_comp / v_vi * 100, 2) if v_vi > 0 else None

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
        # Pacing por frente — front usa pra colorir o card no primeiro paint
        # (sem precisar do detail prefetched). Só sai no payload quando há
        # contrato pra aquela frente; 0% sinaliza "vendido, não iniciou".
        if display_pacing_o2o is not None: entry["display_pacing_o2o"] = display_pacing_o2o
        if display_pacing_ooh is not None: entry["display_pacing_ooh"] = display_pacing_ooh
        if display_pacing_groundflow is not None: entry["display_pacing_groundflow"] = display_pacing_groundflow
        if video_pacing_o2o   is not None: entry["video_pacing_o2o"]   = video_pacing_o2o
        if video_pacing_ooh   is not None: entry["video_pacing_ooh"]   = video_pacing_ooh
        if video_pacing_groundflow is not None: entry["video_pacing_groundflow"] = video_pacing_groundflow
        if display_ctr    is not None: entry["display_ctr"]    = display_ctr
        if video_ctr      is not None: entry["video_ctr"]      = video_ctr
        if video_vtr      is not None: entry["video_vtr"]      = video_vtr

        # Actual start dates — usados pelo admin diagnostic pra reconstruir
        # negotiated/ideal_diaria a partir do mesmo runway que o backend usou
        # pro pacing. Sem isso, o front recalculava com camp.start_date e
        # divergia do display_pacing/video_pacing que o backend já emitiu.
        if d_actual_start: entry["display_actual_start_date"] = d_actual_start.isoformat()
        if v_actual_start: entry["video_actual_start_date"]   = v_actual_start.isoformat()
        if d_o2o_actual_start: entry["display_o2o_actual_start_date"] = d_o2o_actual_start.isoformat()
        if d_ooh_actual_start: entry["display_ooh_actual_start_date"] = d_ooh_actual_start.isoformat()
        if v_o2o_actual_start: entry["video_o2o_actual_start_date"]   = v_o2o_actual_start.isoformat()
        if v_ooh_actual_start: entry["video_ooh_actual_start_date"]   = v_ooh_actual_start.isoformat()

        # Campos brutos pra agregação correta no frontend. CTR/VTR/Pacing
        # são razões — agregar via "média de razões por campanha" infla VTR
        # > 100% e distorce KPIs com campanhas pequenas. Frontend deve
        # sempre fazer Σ numerador / Σ denominador. Esses campos são
        # admin-gated junto com o resto do payload.
        # Entrega bruta = CR (d_vi / v_comp / v_vi), mesma fonte do pacing/VTR
        # acima, pra o rollup por owner (Σnum/Σdenom) bater com os cards e com
        # o report. NÃO usar os campos unified (d_viewable_impr etc.) aqui —
        # esses ficam só no faturável.
        if d_vi              > 0: entry["display_impressions"]            = int(d_vi)
        if d_clicks          > 0: entry["display_clicks"]                 = int(d_clicks)
        if d_vi              > 0: entry["display_viewable_impressions"]   = int(d_vi)
        if d_expected and d_expected > 0: entry["display_expected_impressions"] = int(d_expected)
        # Negociado REAL por mídia = Σ (contratado + bônus) das frentes presentes.
        # O diagnóstico (front) usa ISSO direto como denominador da projeção em
        # vez de reconstruir negotiated via expected_to_date / elapsed_ratio.
        #
        # Por que: a reconstrução do front quebrava no ÚLTIMO DIA. O backend usa
        # `today >= end` em pacing_expected_to_date → no fim, expected = negociado
        # CHEIO. Mas o front reconstruía `negotiated = expected / (elapsed/total)`
        # com `today > end` (estrito) → elapsed = total-1 → ratio < 1 → negociado
        # INFLADO por total/(total-1). Numa campanha de 19 dias isso é +5,6%,
        # suficiente pra rebaixar uma projeção de 105% pra 99,8% e marcar Under
        # falso (ex.: Itaú/Mondelez no último dia do voo). Também corrige o caso
        # multi-frente com starts escalonados (a soma de expected por frente não
        # é reconstruível por um único elapsed_ratio agregado).
        d_negotiated = (d_o2o_neg + d_ooh_neg + d_groundflow_neg) or None
        if d_negotiated and d_negotiated > 0: entry["display_negotiated"] = int(d_negotiated)
        # VTR usa viewable/viewable (não total), ambos CR: v_comp / v_vi.
        if v_vi              > 0: entry["video_impressions"]               = int(v_vi)
        if v_clicks          > 0: entry["video_clicks"]                    = int(v_clicks)
        if v_vi              > 0: entry["video_viewable_impressions"]     = int(v_vi)
        if v_comp            > 0: entry["video_viewable_completions"]     = int(v_comp)
        if v_expected and v_expected > 0: entry["video_expected_completions"]  = int(v_expected)
        v_negotiated = (v_o2o_neg + v_ooh_neg + v_groundflow_neg) or None
        if v_negotiated and v_negotiated > 0: entry["video_negotiated"] = int(v_negotiated)

        # Entrega de ontem (D-1, BRT) por mídia — alimenta a aba Diagnóstico
        # do menu admin. Quando o rollup das 6h ainda não rodou OU a campanha
        # não entregou nada ontem, o LEFT JOIN devolve NULL → omitimos o
        # campo → frontend renderiza "—". Semântica honesta de "sem dado".
        d_yesterday_viewable    = float(r["d_yesterday_viewable"]    or 0)
        v_yesterday_completions = float(r["v_yesterday_completions"] or 0)
        if d_yesterday_viewable    > 0: entry["display_yesterday_viewable"]    = int(d_yesterday_viewable)
        if v_yesterday_completions > 0: entry["video_yesterday_completions"]   = int(v_yesterday_completions)

        # Entrega dos últimos 7 dias (janela rolling, BRT, exclui hoje). Usado
        # pela projeção do diagnóstico em vez do D-1 puro — média semanal
        # suaviza variação diária (anomalia de DSP, fim de semana, spike)
        # mantendo o sinal recente. Omitido quando == 0 (frontend cai pra
        # fallback de D-1 → pacing histórico).
        d_last7d_viewable    = float(r["d_last7d_viewable"]    or 0)
        v_last7d_completions = float(r["v_last7d_completions"] or 0)
        if d_last7d_viewable    > 0: entry["display_last7d_viewable"]    = int(d_last7d_viewable)
        if v_last7d_completions > 0: entry["video_last7d_completions"]   = int(v_last7d_completions)

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

        # Custo TOTAL incluindo lines de survey — admin-only. Usado SOMENTE
        # pelo calculo de Tech Cost (numerador do `cost / client_budget`).
        # NÃO usar pra eCPM: o denominador `admin_impressions` ignora survey,
        # então misturar inflaria o eCPM artificialmente. Tech cost usa PI
        # cliente em R$, então survey entra sem distorcer a matematica.
        # Frontend faz fallback pro `admin_total_cost` (sem survey) quando o
        # campo `_full` esta ausente — graceful degradation pre-deploy.
        admin_total_cost_full   = float(r["admin_total_cost_full"]   or 0)
        d_admin_cost_full       = float(r["d_admin_total_cost_full"] or 0)
        v_admin_cost_full       = float(r["v_admin_total_cost_full"] or 0)
        if admin_total_cost_full > 0:
            entry["admin_total_cost_full"]   = round(admin_total_cost_full,   2)
        if d_admin_cost_full > 0:
            entry["d_admin_total_cost_full"] = round(d_admin_cost_full,       2)
        if v_admin_cost_full > 0:
            entry["v_admin_total_cost_full"] = round(v_admin_cost_full,       2)

        # Custo por mês calendário — usado pelo KPI strip pra tech cost
        # com regra assimetrica: numerador soma cost gasto NO mês por
        # qualquer campanha que tocou esse mês (incluindo cross-month),
        # denominador soma só os budgets de PIs com start_date em M.
        # Estrutura: dict {"2026-04": 1200.0, "2026-05": 7500.0, ...}
        # Omite chaves com zero pra reduzir payload. ARRAY do BQ vem como
        # lista de Row objects que tem .month_key e .cost.
        monthly_arr = r["monthly_cost_full_arr"] or []
        monthly_dict = {}
        for m in monthly_arr:
            mk = m.get("month_key") if isinstance(m, dict) else m["month_key"]
            mc = m.get("cost")      if isinstance(m, dict) else m["cost"]
            if mk and mc and float(mc) > 0:
                monthly_dict[mk] = round(float(mc), 2)
        if monthly_dict:
            entry["monthly_cost_full"] = monthly_dict

        # eCPM por mídia (admin-only, mesmo conceito do admin_ecpm — custo cru
        # do DSP / impressions gross). Usado pelo Top Performers que avalia
        # com thresholds diferentes por formato (Display < R$ 0,70; Video < R$ 2,00).
        d_admin_cost = float(r["d_admin_total_cost"] or 0)
        d_admin_impr = int(r["d_admin_impressions"] or 0)
        v_admin_cost = float(r["v_admin_total_cost"] or 0)
        v_admin_impr = int(r["v_admin_impressions"] or 0)
        # Splits no payload pro Top Performers agregar correto via
        # Σnumerador/Σdenominador (eCPM Display e Video do CS). Sem isso o
        # frontend só tinha o eCPM já calculado por campanha e não dava pra
        # somar de volta sem perder precisão.
        if d_admin_impr > 0:
            entry["d_admin_total_cost"] = round(d_admin_cost, 2)
            entry["d_admin_impressions"] = d_admin_impr
            if d_admin_cost > 0:
                entry["display_ecpm"] = round(d_admin_cost / d_admin_impr * 1000, 2)
        if v_admin_impr > 0:
            entry["v_admin_total_cost"] = round(v_admin_cost, 2)
            entry["v_admin_impressions"] = v_admin_impr
            if v_admin_cost > 0:
                entry["video_ecpm"] = round(v_admin_cost / v_admin_impr * 1000, 2)

        # Budget cliente por mídia (valor PI faturado) — alimenta o Tech Cost
        # na aba Diagnóstico do menu admin. Calculado como
        #   contracted_impressions × CPM/CPCV negociado
        # SEM os volumes bônus (que são cortesia, fora do faturamento). O
        # frontend faz a razão `d_admin_total_cost / d_client_budget × 100`
        # pra obter o % de Tech Cost — quanto do PI virou custo cru de DSP.
        # Só emite se > 0; campanhas single-media ou 100% bonificadas ficam
        # sem o campo → UI mostra "—". Admin-only (mesma gate dos admin_*).
        d_contracted = (
            float(r["contracted_o2o_display"] or 0) +
            float(r["contracted_ooh_display"] or 0)
        )
        cpm_amount = float(r["cpm_amount"] or 0)
        d_client_budget = d_contracted * cpm_amount / 1000 if d_contracted > 0 and cpm_amount > 0 else 0
        if d_client_budget > 0:
            entry["d_client_budget"] = round(d_client_budget, 2)

        v_contracted = (
            float(r["contracted_o2o_video"] or 0) +
            float(r["contracted_ooh_video"] or 0)
        )
        cpcv_amount = float(r["cpcv_amount"] or 0)
        # Video: CPCV é preço por completion (sem /1000), diferente de CPM.
        v_client_budget = v_contracted * cpcv_amount if v_contracted > 0 and cpcv_amount > 0 else 0
        if v_client_budget > 0:
            entry["v_client_budget"] = round(v_client_budget, 2)

        # Valor entregue ao cliente (faturável consumido) = MESMO número que o
        # "Custo Efetivo · Total" da Visão Geral do report. Calculado POR FRENTE
        # via effective_cost_front (fonte única compartilhada com o report):
        # entrega UNIFIED valorada ao CPM/CPCV negociado, com over-delivery
        # travada no budget PRÓ-RATA (não no contrato cheio). O modelo antigo
        # (`min(entrega×neg, contrato CHEIO)` por mídia) não travava o over no
        # meio do voo → card mostrava a MAIS que o report (ex.: Diageo I4U4HR
        # card 256k vs report 248k). Cálculo por frente também impede over de
        # uma frente cobrir under da outra (o report é per-frente).
        #
        # Report congelado: usa o effective_total_cost gravado no snapshot
        # (servido verbatim), setado por _apply_frozen_delivery_override.
        _start_dt = _coerce_date(start_date)
        _end_dt   = _coerce_date(end_date)
        _today    = date.today()
        if r.get("_frozen_d_delivered_value") is not None:
            d_delivered_value = float(r.get("_frozen_d_delivered_value") or 0)
            v_delivered_value = float(r.get("_frozen_v_delivered_value") or 0)
        else:
            # Entrega UNIFIED por frente (mesma fonte do report). budget por
            # frente = contratado (SEM bônus) × preço; neg (limiar over) já é
            # contratado + bônus (d_*_neg / v_*_neg acima).
            _d_fronts = (
                (float(r["d_o2o_uview"] or 0),        float(r["contracted_o2o_display"] or 0),        d_o2o_neg,        d_o2o_actual_start),
                (float(r["d_ooh_uview"] or 0),        float(r["contracted_ooh_display"] or 0),        d_ooh_neg,        d_ooh_actual_start),
                (float(r["d_groundflow_uview"] or 0), float(r["contracted_groundflow_display"] or 0), d_groundflow_neg, d_groundflow_actual_start),
            )
            _v_fronts = (
                (float(r["v_o2o_ucomp"] or 0),        float(r["contracted_o2o_video"] or 0),        v_o2o_neg,        int(r["v_o2o_udays"] or 0),        v_o2o_actual_start),
                (float(r["v_ooh_ucomp"] or 0),        float(r["contracted_ooh_video"] or 0),        v_ooh_neg,        int(r["v_ooh_udays"] or 0),        v_ooh_actual_start),
                (float(r["v_groundflow_ucomp"] or 0), float(r["contracted_groundflow_video"] or 0), v_groundflow_neg, int(r["v_groundflow_udays"] or 0), v_groundflow_actual_start),
            )
            # Arredonda POR FRENTE antes de somar — o report arredonda cada
            # effective_total_cost a 2 casas (round em _compute_totals) e o
            # frontend soma; replicar aqui evita deriva de ±1 centavo.
            d_delivered_value = sum(
                round(effective_cost_front(False, view, contr * cpm_amount / 1000, neg, cpm_amount, cpcv_amount, astart, 0, _start_dt, _end_dt, _today), 2)
                for view, contr, neg, astart in _d_fronts
            )
            v_delivered_value = sum(
                round(effective_cost_front(True, comp, contr * cpcv_amount, neg, cpm_amount, cpcv_amount, astart, days, _start_dt, _end_dt, _today), 2)
                for comp, contr, neg, days, astart in _v_fronts
            )
        client_delivered_value = d_delivered_value + v_delivered_value
        # Emite só quando há PI cliente (>0) — bonificada / sem CPM-CPCV fica
        # sem campo → UI mostra "—" (semântica honesta de "sem faturável").
        if (d_client_budget > 0 or v_client_budget > 0):
            entry["client_delivered_value"] = round(client_delivered_value, 2)
        # Por mídia — alimenta o refaturamento do Diagnóstico (tech cost por
        # mídia). Mesma régua, separado por mídia.
        if d_client_budget > 0:
            entry["d_client_delivered_value"] = round(d_delivered_value, 2)
        if v_client_budget > 0:
            entry["v_client_delivered_value"] = round(v_delivered_value, 2)

        # Brand Safety pre-bid (ABS) por mídia, agregando DV360 + Xandr. Quando
        # a flag é TRUE, scoreCampaignDetailed no frontend usa thresholds mais
        # permissivos pra eCPM e CTR daquela mídia (inventário com pre-bid é
        # estruturalmente mais caro). Só emite no payload se TRUE — economiza
        # bytes e deixa o frontend usar `if (c.display_has_abs)` direto.
        if r["display_has_abs"]:
            entry["display_has_abs"] = True
        if r["video_has_abs"]:
            entry["video_has_abs"] = True

        # Campanha 100% bonificada — todo volume contratado é cortesia (sem
        # custo faturado). Frontend usa pra renderizar selo "BONIFICADA" no
        # card do menu admin (espelha o tratamento do report público em
        # CampaignHeaderV2 + OverviewV2). Só emite quando TRUE.
        contracted_total = (
            float(r["contracted_o2o_display"] or 0) +
            float(r["contracted_ooh_display"] or 0) +
            float(r["contracted_o2o_video"]   or 0) +
            float(r["contracted_ooh_video"]   or 0)
        )
        bonus_total = (
            float(r["bonus_o2o_display"] or 0) +
            float(r["bonus_ooh_display"] or 0) +
            float(r["bonus_o2o_video"]   or 0) +
            float(r["bonus_ooh_video"]   or 0)
        )
        if contracted_total == 0 and bonus_total > 0:
            entry["is_bonus_only"] = True

        # Fechamento manual — admin clicou em "Marcar como encerrada" no
        # CampaignDrawer. Quando presente, força status="ended" no frontend
        # (sai do limbo "aguardando fechamento"). Só emite quando preenchido
        # — campanhas em vôo / aguardando fechamento não carregam o campo.
        closed_at = closures_map.get(r["short_token"])
        if closed_at:
            entry["closed_at"] = closed_at

        # Pausa temporária — admin clicou em "Pausar campanha" no drawer.
        # Quando presente e a campanha ainda está em vôo, o frontend
        # renderiza status="paused" (badge azul). Após end_date, a pausa
        # vira metadata e o status natural (awaiting_closure / ended) toma
        # conta. Só emite quando preenchido. `paused_reason` é opcional e
        # mostra como tooltip no badge + observação no drawer.
        pause = pauses_map.get(r["short_token"])
        if pause:
            entry["paused_at"] = pause["paused_at"]
            if pause.get("reason"):
                entry["paused_reason"] = pause["reason"]

        # Encerramento antecipado — campanha terminou antes da end_date
        # original (solicitação externa, cancelamento). Opção B: NÃO
        # tocamos no end_date do payload — pacing continua sendo calculado
        # contra o contrato original pra mostrar a "perda". Frontend usa
        # early_end_date só pra display do período e badge de status.
        # `early_end_reason` é admin-only — não vai pro report do cliente
        # (que usa endpoint separado, /api?token=X). `ended_by` fica só no
        # banco — não tem UI consumindo, sai do payload pra economizar bytes.
        early = early_map.get(r["short_token"])
        if early:
            entry["early_end_date"]   = early["early_end_date"]
            if early.get("reason"):
                entry["early_end_reason"] = early["reason"]

        # Fechamento + Setup do card.
        #   • `fechamento`: subset de [pos_venda, checkups] já registrado —
        #     dots verde/cinza em campanha encerrada/aguardando fechamento.
        #   • `setup`: itens esperados ainda não ativados. Esperado = Loom
        #     (entregável padrão de toda campanha) + condicionais que constam
        #     na NEGOCIAÇÃO (survey/pdooh/rmnd). Só emite quando falta algo —
        #     campanha completa não carrega o campo (chip âmbar só aparece
        #     quando há pendência; zero ruído no scan).
        # elements_map None = fetch de elementos falhou → pula o enrichment
        # inteiro (sem chip/dots nesse refresh) em vez de cobrar Loom de
        # todo mundo com base em dado ausente.
        if elements_map is not None:
            info = elements_map.get(r["short_token"]) or {}
            closure_items = info.get("closure") or []
            if closure_items:
                entry["fechamento"] = closure_items
            # Check-ups semanais — alimenta o chip "check-ups N/M" do card. O log
            # (quais semanas) é a fonte da verdade: o card pinta semana pulada
            # como atrasada e o drawer semeia estado fresco sem refetch. Cai pra
            # contagem crua só em closure legado (sem log). Admin-only.
            log = info.get("checkup_log")
            if log is not None:
                entry["weekly_checkup_log"] = log
                entry["weekly_checkups"] = len(log)
            elif info.get("checkup_count") is not None:
                entry["weekly_checkups"] = info["checkup_count"]
            expected = {"loom"} | (set(info.get("negotiated") or []) & {"survey", "pdooh", "rmnd"})
            missing = sorted(expected - set(info.get("assets") or []))
            if missing:
                entry["setup"] = {
                    "done":    len(expected) - len(missing),
                    "total":   len(expected),
                    "missing": missing,
                }

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


# ─────────────────────────────────────────────────────────────────────────────
# Performers por período — agregação histórica filtrada por janela de tempo.
#
# Usado pelo Top Performers do menu admin pra "evolução por mês/semana". Por
# que função separada em vez de parâmetro opcional em query_campaigns_list:
#   • Pacing usa fórmula diferente (realized/expected da janela, não snapshot
#     calendar-based contra o contrato inteiro).
#   • Driving table é `unified` filtrada (só campanhas com delivery na janela)
#     em vez de `base` (todas).
#   • Payload mais enxuto — não precisa de pauses/closures/early_ends/merges
#     (campanha pausada que entregou na janela continua pontuando).
# ─────────────────────────────────────────────────────────────────────────────
def query_performers_for_period(window_from: date, window_to: date):
    """Retorna lista de campanhas com métricas agregadas dentro da janela
    [window_from, window_to]. Schema do output bate com query_campaigns_list
    pros campos consumidos por computeTopPerformers (front).

    Filtros:
      • Apenas campanhas com viewable_impressions > 0 na janela (driver = unified)
      • SURVEY/CONTROLE/EXPOSTO line_names excluídos (mesma regra das outras queries)

    Pacing histórico = realized / (daily_rate × dias da janela que sobrepõem
    o contrato da campanha). 100% = entregou conforme contrato naquele período.
    """
    sql = f"""
        WITH checklist AS (
            SELECT
                short_token,
                MAX(cpm_amount)                         AS cpm_amount,
                MAX(cpcv_amount)                        AS cpcv_amount,
                MAX(contracted_o2o_display_impressions) AS contracted_o2o_display,
                MAX(contracted_ooh_display_impressions) AS contracted_ooh_display,
                MAX(contracted_o2o_video_completions)   AS contracted_o2o_video,
                MAX(contracted_ooh_video_completions)   AS contracted_ooh_video,
                MAX(bonus_o2o_display_impressions)      AS bonus_o2o_display,
                MAX(bonus_ooh_display_impressions)      AS bonus_ooh_display,
                MAX(bonus_o2o_video_completions)        AS bonus_o2o_video,
                MAX(bonus_ooh_video_completions)        AS bonus_ooh_video
            FROM `site-hypr.prod_assets.checklist_info`
            GROUP BY short_token
        ),
        base AS (
            SELECT
                short_token, client_name, campaign_name,
                MAX(start_date) AS start_date,
                MAX(end_date)   AS end_date
            FROM {table_ref()}
            GROUP BY short_token, client_name, campaign_name
        ),
        -- Agrega por (date, line_name, creative_name) preservando media_type,
        -- dentro da janela. viewable/clicks são ADITIVOS → SUM, igual
        -- query_detail (fonte do report). Antes usava MAX, inflando o CTR do
        -- admin vs o report.
        dedup AS (
            SELECT
                short_token, media_type, date, line_name, creative_name,
                SUM(viewable_impressions)             AS vi,
                SUM(clicks)                           AS clicks,
                SUM(viewable_video_view_100_complete) AS v100_complete
            FROM {table_ref()}
            WHERE date BETWEEN @from_date AND @to_date
              AND media_type IN ('DISPLAY', 'VIDEO')
              AND NOT REGEXP_CONTAINS(UPPER(line_name), r'SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST')
              AND UPPER(creative_name) NOT LIKE '%SURVEY%'
            GROUP BY short_token, media_type, date, line_name, creative_name
        ),
        agg AS (
            SELECT
                short_token,
                SUM(IF(media_type='DISPLAY', vi,            0)) AS d_vi,
                SUM(IF(media_type='DISPLAY', clicks,        0)) AS d_clicks,
                SUM(IF(media_type='VIDEO',   vi,            0)) AS v_vi,
                SUM(IF(media_type='VIDEO',   clicks,        0)) AS v_clicks,
                -- Completions de vídeo do CR (viewable v100) — numerador de
                -- pacing/VTR, igual ao report e à lista ao vivo. Antes a
                -- windowed usava o v_viewable_completions do `unified` (fórmula
                -- aproximada), divergindo do score da aba "Agora".
                SUM(IF(media_type='VIDEO',   v100_complete, 0)) AS v_completions
            FROM dedup
            GROUP BY short_token
        ),
        -- unified filtrada pela janela. É o driver: campanha sem delivery
        -- aqui sai do ranking ("ativa no período" = teve entrega na janela).
        unified AS (
            SELECT
                short_token,
                -- Driver da inclusão no ranking (campanha com delivery na
                -- janela) + custo cru DSP pro eCPM. A ENTREGA (viewable/
                -- completions) agora vem do CR (CTE `agg`) — ver pacing/VTR.
                SUM(total_cost)  AS admin_total_cost,
                SUM(impressions) AS admin_impressions,
                SUM(IF(media_type='DISPLAY', total_cost,  0)) AS d_admin_total_cost,
                SUM(IF(media_type='DISPLAY', impressions, 0)) AS d_admin_impressions,
                SUM(IF(media_type='VIDEO',   total_cost,  0)) AS v_admin_total_cost,
                SUM(IF(media_type='VIDEO',   impressions, 0)) AS v_admin_impressions
            FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
            WHERE date BETWEEN @from_date AND @to_date
              AND media_type IN ('DISPLAY', 'VIDEO')
              AND NOT REGEXP_CONTAINS(UPPER(line_name), r'SURVEY|_(CONTROLE|EXPOSTO)(_|$)|DARK[ _-]?TEST')
              AND UPPER(creative_name) NOT LIKE '%SURVEY%'
            GROUP BY short_token
        ),
        -- Custo TOTAL incluindo lines de survey (ADMIN-ONLY). Scoped pela
        -- janela [@from_date, @to_date] como o `unified` acima — só muda
        -- que NÃO filtra survey/controle/exposto. Usado pelo tech cost no
        -- modo histórico (Top Performers em "Mês passado / 7d / 30d / 90d
        -- / Custom"). Espelha unified_cost_full do query_campaigns_list.
        unified_cost_full AS (
            SELECT
                short_token,
                SUM(total_cost)                              AS admin_total_cost_full,
                SUM(IF(media_type='DISPLAY', total_cost, 0)) AS d_admin_total_cost_full,
                SUM(IF(media_type='VIDEO',   total_cost, 0)) AS v_admin_total_cost_full
            FROM `site-hypr.prod_assets.unified_daily_performance_metrics`
            WHERE date BETWEEN @from_date AND @to_date
              AND media_type IN ('DISPLAY', 'VIDEO')
              -- INTENCIONAL: sem filtro de survey aqui.
            GROUP BY short_token
        ),
        -- ABS detection: mesma estrutura de query_campaigns_list. Não filtra
        -- por janela — flag de ABS é propriedade da campanha (Brand Safety
        -- pre-bid foi contratado ou não), não do período.
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
            u.short_token,
            b.client_name, b.campaign_name, b.start_date, b.end_date,
            a.d_vi, a.d_clicks, a.v_vi, a.v_clicks, a.v_completions,
            u.admin_total_cost, u.admin_impressions,
            u.d_admin_total_cost, u.d_admin_impressions,
            u.v_admin_total_cost, u.v_admin_impressions,
            uf.admin_total_cost_full, uf.d_admin_total_cost_full, uf.v_admin_total_cost_full,
            c.cpm_amount, c.cpcv_amount,
            c.contracted_o2o_display, c.contracted_ooh_display,
            c.contracted_o2o_video,   c.contracted_ooh_video,
            c.bonus_o2o_display,      c.bonus_ooh_display,
            c.bonus_o2o_video,        c.bonus_ooh_video,
            ab.display_has_abs, ab.video_has_abs
        FROM unified u
        JOIN base b USING (short_token)
        LEFT JOIN agg              a USING (short_token)
        LEFT JOIN checklist        c USING (short_token)
        LEFT JOIN unified_cost_full uf USING (short_token)
        LEFT JOIN campaign_abs     ab USING (short_token)
    """

    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("from_date", "DATE", window_from),
            bigquery.ScalarQueryParameter("to_date",   "DATE", window_to),
        ]
    )

    # Paraleliza query + owners (Sheets+overrides+aliases). Performers não
    # precisa de share_ids/merges/closures/pauses/early_ends — só do enrichment
    # de cp_email/cs_email pro agrupamento.
    fut_query     = _query_pool.submit(lambda: list(bq.query(sql, job_config=job_config).result()))
    fut_owners    = _query_pool.submit(_safe_get_owners_lookup)
    fut_overrides = _query_pool.submit(_safe_get_overrides)
    fut_aliases   = _query_pool.submit(_safe_get_aliases)

    rows           = fut_query.result()
    lookup_owners  = fut_owners.result()
    overrides_map  = fut_overrides.result()
    aliases_map    = fut_aliases.result()

    # Janela em date (não datetime) pra arithmetic limpa.
    wf = window_from
    wt = window_to
    window_days = (wt - wf).days + 1

    def expected_in_window(negotiated, sd, ed):
        """Quantos impressions/completions a campanha 'deveria' ter
        entregue dentro da janela, dado seu contrato linear.

        daily_rate × dias_de_overlap_entre_contrato_e_janela. Retorna None
        quando não dá pra calcular (contrato zero ou datas faltando)."""
        if negotiated <= 0 or not sd or not ed:
            return None
        s = sd.date() if hasattr(sd, "date") else sd
        e = ed.date() if hasattr(ed, "date") else ed
        total_days = (e - s).days + 1
        if total_days <= 0:
            return None
        # Overlap entre contrato e janela.
        ovf = max(s, wf)
        ovt = min(e, wt)
        if ovf > ovt:
            return 0
        overlap_days = (ovt - ovf).days + 1
        return negotiated / total_days * overlap_days

    result = []
    for r in rows:
        start_date = r["start_date"]
        end_date   = r["end_date"]

        d_vi              = float(r["d_vi"]                   or 0)
        d_clicks          = float(r["d_clicks"]               or 0)
        v_vi              = float(r["v_vi"]                   or 0)
        v_clicks          = float(r["v_clicks"]               or 0)
        v_comp            = float(r["v_completions"]          or 0)

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

        d_expected = expected_in_window(d_neg, start_date, end_date)
        v_expected = expected_in_window(v_neg, start_date, end_date)

        # Entrega (numerador de pacing/VTR) vem do CR — igual ao report e à
        # lista ao vivo. Denominador do pacing continua window-based
        # (expected_in_window): "quanto pacearia DENTRO da janela" é a pergunta
        # certa pro Top Performers histórico — intencionalmente ≠ do lifetime.
        display_pacing = round(d_vi   / d_expected * 100, 1) if d_expected and d_expected > 0 else None
        video_pacing   = round(v_comp / v_expected * 100, 1) if v_expected and v_expected > 0 else None
        display_ctr    = round(d_clicks / d_vi     * 100, 2) if d_vi > 0 else None
        video_vtr      = round(v_comp   / v_vi     * 100, 2) if v_vi > 0 else None

        entry = {
            "short_token":   r["short_token"],
            "client_name":   r["client_name"],
            "campaign_name": r["campaign_name"],
            "start_date":    str(start_date) if start_date else None,
            "end_date":      str(end_date)   if end_date   else None,
        }
        if display_pacing is not None: entry["display_pacing"] = display_pacing
        if video_pacing   is not None: entry["video_pacing"]   = video_pacing
        if display_ctr    is not None: entry["display_ctr"]    = display_ctr
        if video_vtr      is not None: entry["video_vtr"]      = video_vtr

        # Brutos pra computeTopPerformers refazer agregação correta no front
        # (Σ numerador / Σ denominador por owner). Entrega = CR (d_vi/v_comp/
        # v_vi), mesma fonte do pacing/VTR acima, pra o rollup por owner bater
        # com os cards. Escopo da janela.
        if d_vi            > 0: entry["display_impressions"]          = int(d_vi)
        if d_clicks        > 0: entry["display_clicks"]               = int(d_clicks)
        if d_vi            > 0: entry["display_viewable_impressions"] = int(d_vi)
        if d_expected and d_expected > 0: entry["display_expected_impressions"] = int(d_expected)
        if v_vi            > 0: entry["video_impressions"]            = int(v_vi)
        if v_clicks        > 0: entry["video_clicks"]                 = int(v_clicks)
        if v_vi            > 0: entry["video_viewable_impressions"]   = int(v_vi)
        if v_comp          > 0: entry["video_viewable_completions"]   = int(v_comp)
        if v_expected and v_expected > 0: entry["video_expected_completions"] = int(v_expected)

        # ADMIN-ONLY: custo cru DSP pra eCPM. Mesmo gating dos outros admin_*.
        admin_total_cost   = float(r["admin_total_cost"]   or 0)
        admin_impressions  = int(r["admin_impressions"]    or 0)
        if admin_impressions > 0 and admin_total_cost > 0:
            entry["admin_total_cost"] = round(admin_total_cost, 2)
            entry["admin_impressions"] = admin_impressions
            entry["admin_ecpm"] = round(admin_total_cost / admin_impressions * 1000, 2)

        d_admin_cost = float(r["d_admin_total_cost"] or 0)
        d_admin_impr = int(r["d_admin_impressions"]  or 0)
        v_admin_cost = float(r["v_admin_total_cost"] or 0)
        v_admin_impr = int(r["v_admin_impressions"]  or 0)
        if d_admin_impr > 0:
            entry["d_admin_total_cost"] = round(d_admin_cost, 2)
            entry["d_admin_impressions"] = d_admin_impr
            if d_admin_cost > 0:
                entry["display_ecpm"] = round(d_admin_cost / d_admin_impr * 1000, 2)
        if v_admin_impr > 0:
            entry["v_admin_total_cost"] = round(v_admin_cost, 2)
            entry["v_admin_impressions"] = v_admin_impr
            if v_admin_cost > 0:
                entry["video_ecpm"] = round(v_admin_cost / v_admin_impr * 1000, 2)

        # Custo COM survey (ADMIN-ONLY) — alimenta tech cost no Top Performers
        # histórico. Numerador do tech cost agregado por CS na janela.
        admin_total_cost_full = float(r["admin_total_cost_full"]   or 0)
        d_admin_cost_full     = float(r["d_admin_total_cost_full"] or 0)
        v_admin_cost_full     = float(r["v_admin_total_cost_full"] or 0)
        if admin_total_cost_full > 0:
            entry["admin_total_cost_full"]   = round(admin_total_cost_full,   2)
        if d_admin_cost_full > 0:
            entry["d_admin_total_cost_full"] = round(d_admin_cost_full,       2)
        if v_admin_cost_full > 0:
            entry["v_admin_total_cost_full"] = round(v_admin_cost_full,       2)

        # Client budget por mídia (ADMIN-ONLY) — denominador do tech cost.
        # Calculado a partir do checklist: contracted × CPM/CPCV. Bonus
        # NÃO entra (bônus não fatura pro cliente). Quando CPM/CPCV vazio
        # ou contratado zero (campanha 100% bonificada), o budget vira 0 e
        # o tech cost sai como null naturalmente (sem ratio inflado).
        cpm_amount  = float(r["cpm_amount"]  or 0)
        cpcv_amount = float(r["cpcv_amount"] or 0)
        d_contracted = float(r["contracted_o2o_display"] or 0) + float(r["contracted_ooh_display"] or 0)
        v_contracted = float(r["contracted_o2o_video"]   or 0) + float(r["contracted_ooh_video"]   or 0)
        d_client_budget = (d_contracted * cpm_amount / 1000.0) if cpm_amount  > 0 and d_contracted > 0 else 0.0
        v_client_budget = (v_contracted * cpcv_amount)         if cpcv_amount > 0 and v_contracted > 0 else 0.0
        if d_client_budget > 0:
            entry["d_client_budget"] = round(d_client_budget, 2)
        if v_client_budget > 0:
            entry["v_client_budget"] = round(v_client_budget, 2)

        if r["display_has_abs"]:
            entry["display_has_abs"] = True
        if r["video_has_abs"]:
            entry["video_has_abs"] = True

        result.append(entry)

    # Enrichment de owners — mesmo pipeline da listagem atual (override BQ
    # vence sobre lookup Sheets; alias resolve antes de buscar no lookup).
    for c in result:
        token = c.get("short_token")
        ov_cp, ov_cs = overrides_map.get(token, (None, None))
        lk_cp, lk_cs = owners.resolve_owner_for_client(
            c.get("client_name"), lookup_owners, aliases_map
        )
        c["cp_email"] = ov_cp or lk_cp
        c["cs_email"] = ov_cs or lk_cs

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


def _safe_get_closures():
    """Wrapper resiliente + cacheado pro dict de fechamentos manuais.

    Tabela `campaign_closures` só tem rows pra tokens fechados manualmente
    (~dezenas no máximo). Full scan + cache atrelado ao TTL da lista. Falha
    em dict vazio — sem closed_at, frontend deriva ended por end_date+30d.
    """
    cached = _cache_get(_closures_cache, "all", _LIST_CACHE_TTL)
    if cached is not None:
        return cached
    try:
        data = query_all_closures()
    except Exception as e:
        logger.warning(f"[WARN _safe_get_closures] {e}")
        data = {}
    _cache_set(_closures_cache, "all", data)
    return data


def _safe_get_pauses():
    """Wrapper resiliente + cacheado pro dict de pausas ativas. Mesmo padrão
    de _safe_get_closures — tabela pequena, full scan, cache atrelado ao TTL
    da lista."""
    cached = _cache_get(_pauses_cache, "all", _LIST_CACHE_TTL)
    if cached is not None:
        return cached
    try:
        data = query_all_pauses()
    except Exception as e:
        logger.warning(f"[WARN _safe_get_pauses] {e}")
        data = {}
    _cache_set(_pauses_cache, "all", data)
    return data


def _safe_get_early_ends():
    """Wrapper resiliente + cacheado pro dict de encerramentos antecipados."""
    cached = _cache_get(_early_ends_cache, "all", _LIST_CACHE_TTL)
    if cached is not None:
        return cached
    try:
        data = query_all_early_ends()
    except Exception as e:
        logger.warning(f"[WARN _safe_get_early_ends] {e}")
        data = {}
    _cache_set(_early_ends_cache, "all", data)
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

# Cache do report_analytics — endpoint pesado (7 queries BQ paralelas).
# Hit cacheia a estrutura completa do modal por 60s. Cobre o caso comum
# de admin fechar/reabrir o mesmo modal rápido + trocar range e voltar.
# 60s é trade-off com frescor: events recentes refletem em até 1min,
# aceitável pra um dashboard de engagement (não é real-time analytics).
_ANALYTICS_TTL = 60
_analytics_cache = {}  # (short_token, range_days, include_internal) -> (timestamp, payload)


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


# ─────────────────────────────────────────────────────────────────────────────
# Brand lift agregado mensal (Portal do Cliente) — client-safe.
#
# Calcula, por mês, o lift médio (relativo % + absoluto pp) das campanhas do
# cliente que têm survey conectado. É PESADO (busca Typeform por form), então
# roda num endpoint LAZY próprio (?action=client_portal_brand_lift), NÃO no
# payload do portal — pra não regredir a carga do 1º acesso.
#
# Metodologia (escolha pragmática p/ um headline único e comparável):
#   - Só perguntas CHOICE entram no número (formato padrão de brand lift:
#     "conhece a marca? Sim/Não"). Matrix (nota/escala) fica fora do headline
#     mensal — unidade diferente, não somável a pontos percentuais.
#   - Por pergunta: foca no label `focusRow` (se houver) ou no de maior share
#     no grupo EXPOSTO. lift_abs = exp% − ctrl% (pp); lift_rel = lift_abs/ctrl%.
#   - Por campanha: média das perguntas ponderada por respostas (exposto).
#   - Por mês: média das campanhas ponderada por respostas.
# ─────────────────────────────────────────────────────────────────────────────
_BRAND_LIFT_CACHE_TTL = 10800  # 3h — casa com o warmup (3/3h) e o cache do report;
                               # survey muda devagar; admin invalida ao salvar
_brand_lift_cache = {}  # share_id -> (timestamp, payload)
_YMD_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse_survey_config_py(survey_json):
    """Porte Python do parseSurveyConfig (src/shared/surveyConfig.js). Normaliza
    o blob em {questions, clientRange}. Legacy CSV → None (sem Typeform, fora
    do escopo do brand lift agregado)."""
    if not survey_json:
        return None
    try:
        parsed = json.loads(survey_json) if isinstance(survey_json, str) else survey_json
    except Exception:
        return None
    if not parsed:
        return None

    def norm_range(r):
        if not isinstance(r, dict):
            return None
        f, t = r.get("from"), r.get("to")
        if isinstance(f, str) and isinstance(t, str) and _YMD_RE.match(f) and _YMD_RE.match(t) and f <= t:
            return {"from": f, "to": t}
        return None

    if isinstance(parsed, dict) and parsed.get("version") == 2 and isinstance(parsed.get("questions"), list):
        return {"questions": parsed["questions"], "clientRange": norm_range(parsed.get("clientRange"))}
    if isinstance(parsed, list):
        return {"questions": parsed, "clientRange": None}
    return None


def _fetch_typeform_counts(form_id, tf_token, date_from=None, date_to=None):
    """Contagens agregadas de um form Typeform (choice ou matrix), com filtro
    opcional de janela (BRT→UTC). Mesma lógica do endpoint typeform_proxy,
    extraída p/ reuso server-side no brand lift."""
    since_param = ""
    until_param = ""
    BRT_OFFSET = timedelta(hours=3)
    if date_from and _YMD_RE.match(date_from):
        d0 = datetime.strptime(date_from, "%Y-%m-%d") + BRT_OFFSET
        since_param = f"&since={d0.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    if date_to and _YMD_RE.match(date_to):
        d1 = datetime.strptime(date_to, "%Y-%m-%d") + timedelta(hours=23, minutes=59, seconds=59) + BRT_OFFSET
        until_param = f"&until={d1.strftime('%Y-%m-%dT%H:%M:%SZ')}"

    field_to_row = _fetch_typeform_form_def(form_id, tf_token)
    flat_counts = Counter()
    matrix_rows = {}
    has_matrix = False
    total = 0
    before_token = None
    while True:
        url = f"https://api.typeform.com/forms/{urllib.parse.quote(form_id)}/responses?page_size=1000&completed=true{since_param}{until_param}"
        if before_token:
            url += f"&before={before_token}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tf_token}"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        items = data.get("items", [])
        total += len(items)
        page_flat, page_matrix, page_has_matrix, _ = _process_typeform_items(items, field_to_row)
        flat_counts.update(page_flat)
        if page_has_matrix:
            has_matrix = True
        for rl, rc in page_matrix.items():
            matrix_rows.setdefault(rl, Counter()).update(rc)
        if len(items) < 1000:
            break
        before_token = items[-1].get("token")
    if has_matrix:
        return {"type": "matrix", "total": total}
    return {"type": "choice", "counts": dict(flat_counts), "total": total}


def _survey_side_counts(q, side, tf_token, date_from, date_to):
    """({label:n}, total) p/ um lado (ctrl/exp) de uma pergunta CHOICE.
    videoask → counts embutidos; typeform → fetch. (None, 0) se matrix/indisponível."""
    src_field = "ctrlSource" if side == "ctrl" else "expSource"
    src = q.get(src_field)
    if src not in ("typeform", "videoask"):
        src = "videoask" if q.get("tipo") == "videoask" else "typeform"
    if src == "videoask":
        raw = (q.get("ctrlCounts") if side == "ctrl" else q.get("expCounts")) or {}
        counts = {}
        for k, v in raw.items():
            try:
                n = int(v)
            except (TypeError, ValueError):
                continue
            if n > 0:
                counts[k] = n
        return counts, sum(counts.values())
    url = q.get("ctrlUrl") if side == "ctrl" else q.get("expUrl")
    fid = (q.get("ctrlFormId") if side == "ctrl" else q.get("expFormId")) or (_extract_typeform_form_id(url) if url else None)
    if not fid:
        return None, 0
    res = _fetch_typeform_counts(fid, tf_token, date_from, date_to)
    if res.get("type") != "choice":
        return None, 0
    counts = res.get("counts") or {}
    return counts, res.get("total", sum(counts.values()))


def _campaign_question_lifts(survey_json, tf_token):
    """Lift POR PERGUNTA da campanha (não agregado) — alimenta tanto o lift
    mensal quanto a quebra por TIPO de survey (chip verde/vermelho + hover).

    Retorna [{type, exposed, control, lift_abs, lift_rel, weight}] (choice-only,
    foco no focusRow/maior share no exposto). `exposed`/`control` são TAXAS (%),
    client-safe; `weight` é interno (Σ respostas expostas) e NUNCA é emitido."""
    cfg = _parse_survey_config_py(survey_json)
    if not cfg or not cfg.get("questions"):
        return []
    crange = cfg.get("clientRange") or {}
    df, dt = crange.get("from"), crange.get("to")
    out = []
    for q in cfg["questions"]:
        if not isinstance(q, dict):
            continue
        try:
            ctrl, ct = _survey_side_counts(q, "ctrl", tf_token, df, dt)
            exp, et = _survey_side_counts(q, "exp", tf_token, df, dt)
        except Exception as e:
            logger.warning(f"[WARN brand_lift question] {e}")
            continue
        if not ctrl or not exp or ct <= 0 or et <= 0:
            continue
        focus = q.get("focusRow")
        if focus not in exp:
            focus = max(exp, key=lambda k: exp[k]) if exp else None
        if not focus or focus not in ctrl:
            continue
        cp = ctrl[focus] / ct * 100
        ep = exp[focus] / et * 100
        if cp <= 0:
            continue
        out.append({
            "type": _normalize_survey_type(q.get("nome")) or "Survey",
            "exposed": ep,
            "control": cp,
            "lift_abs": ep - cp,
            "lift_rel": (ep - cp) / cp * 100,
            "weight": et,
        })
    return out


# Categorias canônicas de survey (etapas do funil). Os `nome` no config são
# texto livre e variam ("AdRecall OOH", "Adrecall", "Ad Recall" → "Ad Recall";
# "Intent" → "Intenção"). Normalizamos pra rótulos estáveis e client-safe.
_SURVEY_TYPE_RULES = (
    (("ad recall", "adrecall", "recall", "lembran"),       "Ad Recall"),
    (("inten",),                                            "Intenção"),
    (("consider",),                                         "Consideração"),
    (("awareness", "conhecimento"),                         "Awareness"),
    (("associa", "associat"),                               "Associação"),
    (("favorab",),                                          "Favorabilidade"),
    (("prefer",),                                           "Preferência"),
    (("recomend", "recommend", "nps"),                      "Recomendação"),
)
# Ordem de exibição (topo→fundo de funil). Tipos fora da lista vão ao fim (alfa).
_SURVEY_TYPE_ORDER = ["Awareness", "Consideração", "Intenção", "Preferência",
                      "Favorabilidade", "Associação", "Ad Recall", "Recomendação"]
_SURVEY_MEDIA_SUFFIXES = (" ooh", " o2o", " pdooh", " display", " video", " vídeo")


def _normalize_survey_type(nome):
    """Rótulo canônico de funil p/ o `nome` livre de uma pergunta, ou None."""
    if not nome or not isinstance(nome, str):
        return None
    s = nome.strip().lower()
    for suf in _SURVEY_MEDIA_SUFFIXES:
        if s.endswith(suf):
            s = s[: -len(suf)].strip()
    for keys, label in _SURVEY_TYPE_RULES:
        if any(k in s for k in keys):
            return label
    cleaned = nome.strip()
    return (cleaned[:1].upper() + cleaned[1:]) if cleaned else None


def _sort_survey_types(labels):
    """Ordena rótulos por funil (depois alfabético p/ desconhecidos)."""
    order = {l: i for i, l in enumerate(_SURVEY_TYPE_ORDER)}
    return sorted(labels, key=lambda l: (order.get(l, len(_SURVEY_TYPE_ORDER)), l))


def compute_portal_brand_lift(share_id: str):
    """Brand lift mensal agregado client-safe p/ o portal. Retorna
    {"months": [{month, liftRel, liftAbs, surveyTypes, surveyCount}],
    "has_survey": bool}. NUNCA expõe contagem de respostas (interno só p/
    ponderar a média)."""
    config = client_portal.get_config_by_share_id(share_id)
    if not config or not config.get("active"):
        return None
    slug = config.get("slug")
    published = client_portal.get_published_tokens(slug)
    pub = {t for t, ok in published.items() if ok} if isinstance(published, dict) else set(published or [])
    if not pub:
        return {"months": [], "has_survey": False}

    campaigns, _ = _get_campaigns_list_cached()
    start_by_token = {}
    for c in (campaigns or []):
        t = (c.get("short_token") or "").upper()
        if t:
            start_by_token[t] = c.get("start_date")

    tf_token = os.environ.get("TYPEFORM_TOKEN", "")
    tokens = [t for t in pub if t]

    # Surveys em paralelo (BQ).
    surveys = {}
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="blift-sv") as ex:
        futs = {ex.submit(query_survey, t): t for t in tokens}
        for f in futs:
            try:
                surveys[futs[f]] = f.result()
            except Exception:
                surveys[futs[f]] = None

    has_survey = any(bool(sv) for sv in surveys.values())
    with_survey = [(t, sv) for t, sv in surveys.items() if sv]

    # Lift por PERGUNTA por campanha (Typeform IO-bound, paralelo) — base tanto
    # do lift mensal quanto da quebra por tipo de survey.
    results = {}
    if with_survey and tf_token:
        with ThreadPoolExecutor(max_workers=4, thread_name_prefix="blift-tf") as ex:
            futs = {ex.submit(_campaign_question_lifts, sv, tf_token): t for t, sv in with_survey}
            for f in futs:
                try:
                    results[futs[f]] = f.result() or []
                except Exception as e:
                    logger.warning(f"[WARN brand_lift campaign {futs[f]}] {e}")
                    results[futs[f]] = []

    # Tipos de survey ativados por mês + quantidade de surveys. Conta TODA
    # campanha com survey conectado no mês (mesmo as que não renderam lift
    # mensurável) — "surveys ativadas" = quantas rodaram, não quantas tiveram
    # número. Client-safe: categorias do funil, sem contagem de respostas.
    month_types = {}
    month_survey_count = {}
    for t, sv in with_survey:
        m = (start_by_token.get(t) or start_by_token.get((t or "").upper()) or "")[:7]
        if not m:
            continue
        cfg = _parse_survey_config_py(sv)
        labels = set()
        for q in ((cfg or {}).get("questions") or []):
            if isinstance(q, dict):
                lbl = _normalize_survey_type(q.get("nome"))
                if lbl:
                    labels.add(lbl)
        month_types.setdefault(m, set()).update(labels)
        month_survey_count[m] = month_survey_count.get(m, 0) + 1

    # Agrega lift por MÊS (geral) e por (MÊS, TIPO), ponderado por respostas
    # expostas (peso interno — nunca emitido).
    months = {}      # m -> {rel, abs, w}
    month_type = {}  # m -> {type -> {ea, ca, ab, rel, w}}
    for t, qs in results.items():
        m = (start_by_token.get(t) or start_by_token.get((t or "").upper()) or "")[:7]
        if not m:
            continue
        for q in qs:
            w = q["weight"]
            if w <= 0:
                continue
            b = months.setdefault(m, {"rel": 0.0, "abs": 0.0, "w": 0.0})
            b["rel"] += q["lift_rel"] * w
            b["abs"] += q["lift_abs"] * w
            b["w"]   += w
            tb = month_type.setdefault(m, {}).setdefault(
                q["type"], {"ea": 0.0, "ca": 0.0, "ab": 0.0, "rel": 0.0, "w": 0.0})
            tb["ea"]  += q["exposed"] * w
            tb["ca"]  += q["control"] * w
            tb["ab"]  += q["lift_abs"] * w
            tb["rel"] += q["lift_rel"] * w
            tb["w"]   += w

    _order = {l: i for i, l in enumerate(_SURVEY_TYPE_ORDER)}

    def _details(m):
        rows = []
        for tp, v in (month_type.get(m) or {}).items():
            if v["w"] <= 0:
                continue
            rows.append({
                "type":    tp,
                "exposed": round(v["ea"] / v["w"], 1),  # taxa %, client-safe
                "control": round(v["ca"] / v["w"], 1),
                "liftAbs": round(v["ab"] / v["w"], 1),  # pontos percentuais
                "liftRel": round(v["rel"] / v["w"], 1),
            })
        rows.sort(key=lambda r: (_order.get(r["type"], len(_order)), r["type"]))
        return rows

    # Inclui meses com survey mesmo sem lift mensurável (lift = None) — o cliente
    # ainda vê "surveys ativadas". Chips com lift mensurável recebem cor+hover.
    all_months = sorted(set(months) | set(month_survey_count))
    out = []
    for m in all_months:
        v = months.get(m)
        has_w = bool(v and v["w"] > 0)
        out.append({
            "month":         m,
            "liftRel":       round(v["rel"] / v["w"], 1) if has_w else None,
            "liftAbs":       round(v["abs"] / v["w"], 1) if has_w else None,
            "surveyTypes":   _sort_survey_types(month_types.get(m, set())),
            "surveyCount":   month_survey_count.get(m, 0),
            "surveyDetails": _details(m),
        })
    return {"months": out, "has_survey": has_survey}


# ─────────────────────────────────────────────────────────────────────────────
# Quebra por AUDIÊNCIA agregada (Portal do Cliente · aba Analytics) — client-safe.
#
# Lê o detail (query_detail) de cada campanha publicada, agrega por
# (token, mês, mídia, frente, audiência crua) e UNIFICA as audiências cruas em
# grupos canônicos (audience_normalize — plural/acento/caixa + sinônimos seed +
# fuzzy). Devolve as linhas JÁ taggeadas com a audiência canônica, em granular
# o bastante (token/mês/mídia/frente) p/ o front re-aplicar os filtros do
# Analytics (período, core product, formato, campanha) e re-agregar por
# audiência sem perda.
#
# Métricas expostas: impressão total, impressão visível, cliques (CTR é
# derivado no front = cliques/visíveis). NENHUMA é sensível (não há custo /
# margem / CPM admin), então passa no whitelist client-safe.
#
# PESADO (1 query_detail por campanha) → endpoint LAZY próprio
# (?action=client_portal_audiences) com cache 1h, fora do payload do portal —
# mesmo molde do brand lift, não regride o 1º acesso do dia.
# ─────────────────────────────────────────────────────────────────────────────
_AUDIENCES_CACHE_TTL = 10800  # 3h — casa com o warmup (3/3h) e o cache do report
_audiences_cache = {}  # share_id -> (timestamp, payload)


def compute_portal_audiences(share_id: str):
    """Quebra por audiência canônica agregada das campanhas publicadas.

    Retorna {
      "rows": [{token, month, media, tactic, audience, impressions,
                viewable_impressions, clicks}],
      "groups": {audiência_canônica: [rótulos_crus...]},  # transparência
      "has_data": bool,
    } ou None se o portal não existe / inativo.
    """
    config = client_portal.get_config_by_share_id(share_id)
    if not config or not config.get("active"):
        return None
    slug = config.get("slug")
    published = client_portal.get_published_tokens(slug)
    pub = {t for t, ok in published.items() if ok} if isinstance(published, dict) else set(published or [])
    tokens = [t for t in pub if t]
    if not tokens:
        return {"rows": [], "groups": {}, "has_data": False}

    # Detail por campanha em paralelo (IO-bound em BQ), igual ao brand lift.
    details = {}
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="aud-detail") as ex:
        futs = {ex.submit(query_detail, t): t for t in tokens}
        for f in futs:
            try:
                details[futs[f]] = f.result() or []
            except Exception as e:
                logger.warning(f"[WARN portal_audiences detail {futs[f]}] {e}")
                details[futs[f]] = []

    # Agrega por (token, mês, mídia, frente, audiência crua).
    buckets = {}          # key -> {impressions, viewable_impressions, clicks}
    raw_weight = {}       # rótulo cru -> Σ impressões visíveis (peso p/ display)
    for token, rows in details.items():
        for r in rows:
            raw_aud = audience_normalize.extract_audience(r.get("line_name"))
            if audience_normalize._is_ignorable(raw_aud):
                continue
            month = (r.get("date") or "")[:7]
            if not month:
                continue
            key = (token, month, r.get("media_type") or "", r.get("tactic_type") or "", raw_aud)
            b = buckets.get(key)
            if b is None:
                b = {"impressions": 0.0, "viewable_impressions": 0.0, "clicks": 0.0}
                buckets[key] = b
            vi = float(r.get("viewable_impressions") or 0)
            b["impressions"]          += float(r.get("impressions") or 0)
            b["viewable_impressions"] += vi
            b["clicks"]               += float(r.get("clicks") or 0)
            raw_weight[raw_aud] = raw_weight.get(raw_aud, 0.0) + vi

    if not buckets:
        return {"rows": [], "groups": {}, "has_data": False}

    # 1) Heurística determinística (plural/acento/caixa + seed de sinônimos).
    # Os nomes corrigidos pelo admin no Report Center (por anunciante) entram
    # como SEED — dica pra IA, não override forte. A IA (Fase 2) ainda refina;
    # o override DO PORTAL (Fase 3, abaixo) é o que vence de fato no hub.
    admin_seed = audience_overrides_advertiser_map(slug)
    grouped = audience_normalize.group_audiences(raw_weight, seed_overrides=admin_seed)
    mapping = grouped["mapping"]

    # 2) Camada IA (Fase 2): funde sinônimos entre os displays canônicos
    # (cacheada pelo conjunto de rótulos; identidade no fallback gracioso).
    displays = list({v for v in mapping.values()})
    ai_map = audience_ai.refine_groups_with_ai(displays)
    mapping = {raw: ai_map.get(disp, disp) for raw, disp in mapping.items()}

    # 3) Override do admin (precedência FINAL — vence heurística e IA).
    overrides = config.get("audience_overrides") or {}
    mapping = audience_normalize.apply_overrides(mapping, overrides)

    # Reconstrói os grupos (transparência) a partir do mapeamento final.
    groups_final = {}
    for raw, disp in mapping.items():
        groups_final.setdefault(disp, []).append(raw)

    rows_out = []
    for (token, month, media, tactic, raw_aud), b in buckets.items():
        rows_out.append({
            "token":                token,
            "month":                month,
            "media":                media,
            "tactic":               tactic,
            "audience":             mapping.get(raw_aud, audience_normalize.prettify(raw_aud)),
            "impressions":          round(b["impressions"]),
            "viewable_impressions": round(b["viewable_impressions"]),
            "clicks":               round(b["clicks"]),
        })

    return {"rows": rows_out, "groups": groups_final, "has_data": True}
