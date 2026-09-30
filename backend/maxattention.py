"""
Respostas da pesquisa nativa do Max Attention (etapa de survey do Tap to
Choose) — leitura no BigQuery, ADMIN-ONLY.

Contexto
--------
O Report Center já lê Brand Lift do Typeform via API. A HYPR passou a
rodar a MESMA pesquisa também na própria mídia, na etapa de survey do
Tap to Choose: mesmo título, mesmas perguntas, mesmas opções. Numa
campanha como a da L'Oréal, "Ad Recall" existe nas duas bases ao mesmo
tempo e o cliente quer UM número, somado — não dois relatórios.

Este módulo é a metade "de onde vem o dado" dessa soma. A metade "o que
soma com o quê" (reconciliação de rótulos entre bases) vive no front, em
`src/shared/surveySources.js`, e não sabe da existência deste arquivo:
aqui só devolvemos contagens no MESMO contrato que o proxy do Typeform
já devolve, e o resto do pipeline segue igual.

Contrato de entrada: uma VIEW, não uma tabela
---------------------------------------------
A fonte é o lake de eventos que a plataforma (o2o-platform) já drena pro
BigQuery no MESMO projeto — `site-hypr.adsiq_raw.maxattention_creative_events`,
evento `survey_answer`, rótulo em `metadata.optionLabel`. Mas o schema
daquele lake é da plataforma e muda no ritmo dela, e há uma regra de
leitura que não dá pra esquecer (dedupe por event_id: o lake tem dois
escritores e re-export sobreposto é parte do desenho).

Por isso não lemos a tabela: dependemos de UMA view com contrato fixo,
apontada por env. O SQL dela está em `backend/sql/ma_survey_view.sql`.

    MA_SURVEY_VIEW = "projeto.dataset.view"

    creative_id    STRING     NOT NULL  -- id do criativo na plataforma
    option         STRING     NOT NULL  -- opção escolhida
    responded_at   TIMESTAMP  NOT NULL  -- quando a resposta veio
    session_id     STRING               -- opcional, mas MUITO recomendado:
                                        --   sem ele contamos EVENTO, e quem
                                        --   recarrega a peça responde de novo.
                                        --   Medido na FXR5US: 383 eventos
                                        --   contra 265 respondentes.
    creative_name  STRING               -- opcional: nome do criativo. É
                                        --   ele que carrega token e lado
                                        --   ("ID-FXR5US_..._CONTROLE");
                                        --   sem ele o vínculo é manual.
    question       STRING               -- opcional: título da pergunta.
                                        --   Só existe em criativo de
                                        --   múltiplas perguntas; no Tap
                                        --   to Choose de pergunta única
                                        --   vem NULL, e está certo.
    short_token    STRING               -- opcional: campanha
    responses      INT64                -- opcional: se a view já vier
                                        --   agregada. Ausente/NULL = 1
                                        --   linha por resposta.

Quem mantém o mapeamento é o lado que conhece o schema, e uma mudança lá
não vira incidente aqui — vira uma alteração de view. Sem a env, os
endpoints respondem 501 com essa instrução, em vez de 500 silencioso.

Amarração com a campanha
------------------------
`short_token` na view é o caminho limpo. Quando ele não existe, sobra a
convenção de nomenclatura que o time já usa nos criativos:

    ID-FXR5US_HYPR_LOREAL_..._SURVEY_AWARENESS_CONTROLE
       ^^^^^^ short_token                      ^^^^^^^^ lado

Então o fallback de busca é por nome contendo o token, e o lado
(controle/exposto) sai do sufixo. É heurística e está marcada como tal:
`match` diz se veio de `short_token` (forte) ou de `name` (convenção), e
o admin confirma na UI antes de salvar. Nada é vinculado sozinho.
"""

import logging
import os
import re
import unicodedata
from collections import Counter
import threading
import time
from datetime import datetime, timedelta, timezone

from google.cloud import bigquery

import bq_client

logger = logging.getLogger(__name__)

# Janela padrão de listagem. Criativo de survey vive semanas, não anos —
# olhar 180 dias mantém o dropdown curto e a query barata.
DEFAULT_LOOKBACK_DAYS = 180

# Teto de bytes que uma query daqui pode bilar. Guardrail contra varredura
# catastrófica (view apontada errada, filtro que não podou partição), NÃO
# controle de custo fino.
#
# Generoso de propósito, e a razão vem do próprio o2o-platform: o BigQuery
# aplica esse cap sobre a ESTIMATIVA, e a estimativa considera poda de
# PARTIÇÃO mas não de CLUSTER. Nossas duas queries filtram por período
# (partição, entra na estimativa) e a de detalhe ainda filtra por creative_id
# (cluster, só reduz o custo real). Um cap apertado mataria query que custa
# centavos. Lá, um cap apertado zerou painel em produção.
# 48 GiB, não 32: o ramo AMPLO da listagem (todas as campanhas, 30 dias) é
# estimado em ~36 GiB porque a view faz DISTINCT sobre todas as colunas e o
# planejador não consegue podar coluna nem cluster. Custo real por query fria
# ~R$1, admin-only, cacheado 10 min. Se a listagem voltar a bater aqui, o
# conserto é materializar `survey_answer` numa tabela pequena, não subir de
# novo.
MAX_BYTES_BILLED = str(48 * 1024 ** 3)  # 48 GiB de ESTIMATIVA
#
# Atualização (set/2026): voltou a bater — 63 GiB estimados contra 48, no
# modal da PPV8JF, oito dias depois de o teto subir de 32 pra 48. O lake cresce
# ~3 GiB/dia nas colunas que a view lê, e toda leitura que atravessa a view
# paga a janela inteira de novo. Subir o teto só adiava a próxima quebra; o
# conserto foi o que o parágrafo acima já dizia: materializar. Ver
# "Materialização" abaixo. Este teto agora vale pro SYNC (que lê o lake em
# fatias pequenas) e pro modo legado `MA_SURVEY_MATERIALIZE=0`.

# Teto das LEITURAS quando a fonte é a tabela materializada. Ela tem uma linha
# por resposta (milhares, não bilhões), então qualquer coisa acima disto é
# fonte apontada errado — e a falha tem que ser alta e cedo, não uma conta.
READ_MAX_BYTES_BILLED = str(2 * 1024 ** 3)  # 2 GiB

# Teto de opções distintas devolvidas por criativo na LISTAGEM. Serve pra
# comparar conjuntos de opções, não pra exibir: uma dúzia já decide se duas
# perguntas são a mesma. Cortado em Python porque DISTINCT + LIMIT juntos na
# mesma agregação não passam no BigQuery.
MAX_OPTIONS_LISTED = 20

# Janela usada quando a listagem NÃO tem campanha pra podar por criativo.
# Curta de propósito: sem o filtro de creative_id o scan é largo, e este é o
# caminho manual (o modal sempre manda o token).
UNSCOPED_LOOKBACK_DAYS = 30

# Teto de linhas agregadas devolvidas por criativo. Uma pergunta com mais
# de 500 opções distintas não é uma pergunta — é dado sujo, e o corte
# aparece explícito na resposta em vez de virar um total silenciosamente
# menor.
MAX_OPTIONS = 500

_VIEW_RE = re.compile(r"^[A-Za-z0-9_\-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$")


class NotConfigured(RuntimeError):
    """MA_SURVEY_VIEW ausente ou malformada."""


def survey_view():
    """
    Nome qualificado da view, validado. Interpolamos direto no SQL (BQ não
    aceita nome de tabela como parâmetro), então o formato é conferido
    antes: três identificadores simples separados por ponto, nada mais.
    """
    raw = os.environ.get("MA_SURVEY_VIEW", "").strip().strip("`")
    if not raw:
        raise NotConfigured(
            "MA_SURVEY_VIEW não configurada. Aponte para a view "
            "`projeto.dataset.view` com as colunas creative_id, "
            "creative_name, question, option, responded_at "
            "(e opcionalmente short_token, responses)."
        )
    if not _VIEW_RE.match(raw):
        raise NotConfigured(
            f"MA_SURVEY_VIEW inválida ({raw!r}). "
            "Esperado 'projeto.dataset.view'."
        )
    return raw


def creatives_dim_table():
    """Tabela de criativos, no MESMO dataset da view.

    Existe porque a listagem precisa resolver "quais criativos são desta
    campanha" ANTES de tocar o lake. Ver `list_creatives` pro porquê.

    Derivada da view em vez de virar env nova (uma variável a menos pra
    configurar e pra alguém esquecer num deploy); `MA_CREATIVES_DIM`
    sobrescreve se um dia os dois morarem em datasets diferentes.
    """
    override = os.environ.get("MA_CREATIVES_DIM", "").strip().strip("`")
    if override:
        if not _VIEW_RE.match(override):
            raise NotConfigured(f"MA_CREATIVES_DIM inválida ({override!r}).")
        return override
    project, dataset, _ = survey_view().split(".")
    return f"{project}.{dataset}.creatives_dim"


def is_configured():
    try:
        survey_view()
        return True
    except NotConfigured:
        return False


# ── Convenção de nome do criativo ───────────────────────────────────────────

_SIDE_ALIASES = {
    "controle": ("controle", "control", "ctrl", "controlado"),
    "exposto": ("exposto", "exposed", "exposta", "expuesto", "expostos"),
}


def _strip_accents(s):
    return "".join(
        c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn"
    )


def detect_side(creative_name):
    """
    "..._SURVEY_AWARENESS_CONTROLE" → "controle". None quando o nome não
    diz. Só igualdade exata de token: o palpite serve pra pré-selecionar
    um slot na UI, e errar aqui custa mais caro que não sugerir nada.
    """
    tokens = re.split(r"[_\-\s]+", _strip_accents(str(creative_name or "")).lower())
    for tok in tokens:
        for side, aliases in _SIDE_ALIASES.items():
            if tok in aliases:
                return side
    return None


def token_in_name(creative_name, short_token):
    """Token da campanha aparece como palavra inteira no nome do criativo."""
    if not short_token:
        return False
    tokens = re.split(r"[_\-\s]+", _strip_accents(str(creative_name or "")).upper())
    return short_token.strip().upper() in tokens


# ── Queries ─────────────────────────────────────────────────────────────────

def _weight_expr(has_session_col, has_responses_col):
    """Como uma resposta é CONTADA.

    Sessão distinta primeiro, e não é detalhe: contar evento infla a base
    porque quem recarrega a peça emite `survey_answer` de novo. Medido na
    campanha FXR5US: 383 eventos contra 265 respondentes — 45% a mais.

    Isso desce direto no lift (proporção de PESSOAS, não de toques) e na
    significância, que assume n de respondentes independentes: com n inflado
    a confiança sai superestimada, que é o erro pior dos dois. A régua é a
    mesma do brand lift do AdBolt (`surveyLift.ts`): "o denominador correto
    da proporção é respondentes — usar a soma inflaria n".

    Sessão que responde duas coisas diferentes (recarregou e mudou de ideia)
    conta uma vez em cada opção. Pegar só a primeira exigiria função de
    janela, que derruba a poda de partição da view — troca ruim por um caso
    de borda raro.
    """
    if has_session_col:
        return "COUNT(DISTINCT session_id)"
    if has_responses_col:
        return "SUM(COALESCE(responses, 1))"
    return "COUNT(*)"


def _client_key(name):
    """Chave frouxa de comparação de nome de cliente: minúsculo, sem acento,
    só letras e números. "NINTENDO" == "Nintendo"; "L'Oréal" == "LOREAL"."""
    return re.sub(r"[^a-z0-9]", "", _strip_accents(str(name or "")).lower())


def same_client(a, b):
    """Dois nomes de cliente apontam pro mesmo anunciante? Igualdade pela
    chave frouxa, ou um contido no outro quando o menor tem 4+ caracteres
    ("Diageo" ⊂ "Diageo Brasil"). Curto demais não casa: "VW" cairia em
    qualquer coisa."""
    ka, kb = _client_key(a), _client_key(b)
    if not ka or not kb:
        return False
    if ka == kb:
        return True
    short, long_ = sorted((ka, kb), key=len)
    return len(short) >= 4 and short in long_


def _dim_creatives_for_token(token, client_name=None, limit=500):
    """Criativos de uma campanha, resolvidos na DIMENSÃO (não no lake).

    Alguns KB contra dezenas de GB: a dimensão tem uma linha por criativo,
    enquanto o lake tem uma por evento. E é o que devolve a chave líder do
    cluster pro filtro seguinte.

    Dois vínculos, do mais forte pro mais fraco:

      "name"   — token no nome da peça ("ID-FXR5US_..."), a mesma regra que
                 a view usa pra derivar `short_token`;
      "client" — peça do MESMO CLIENTE da campanha (`client_name` da
                 dimensão × cliente da campanha no Report Center).

    O segundo existe porque a convenção de nome não é seguida na prática:
    74% das respostas do lake vêm de peças sem token (caso Nintendo:
    `HYPR_NINTENDO_FY27_SURVEY_..._CONTROLE`, campanha PS604Q). Sem ele a
    campanha não tinha lista, e a busca ampla, cara, era o único caminho.
    Casar pelo cliente traz as peças certas pela chave líder do cluster, e
    o admin ainda confirma qual é qual pelo nome.

    Devolve `[{creative_id, creative_name, match}]` — o nome volta junto
    porque, quando a listagem sai vazia, é ele que diz ao admin QUAIS peças
    a campanha tem e por que nenhuma entrou.
    """
    dim = creatives_dim_table()
    token = (token or "").strip()
    conds = []
    params = []
    if token:
        conds.append("REGEXP_CONTAINS(UPPER(COALESCE(creative_name, '')), @token_re)")
        params.append(bigquery.ScalarQueryParameter(
            "token_re", "STRING",
            r"(^|[^A-Z0-9])" + re.escape(token.upper()) + r"([^A-Z0-9]|$)",
        ))
    if client_name:
        # Pré-filtro largo no SQL (cliente preenchido); a comparação frouxa
        # de nome fica no Python, onde é fácil de testar e de explicar.
        conds.append("client_name IS NOT NULL AND TRIM(client_name) != ''")
    if not conds:
        return []
    sql = f"""
        SELECT creative_id, creative_name, client_name
        FROM `{dim}`
        WHERE {' OR '.join(f'({c})' for c in conds)}
        LIMIT {int(limit) * 10}
    """
    rows = _client().query(sql, job_config=_job_config(params)).result()
    out = []
    for r in rows:
        if not r["creative_id"]:
            continue
        name = r["creative_name"] or ""
        if token and token_in_name(name, token):
            match = "name"
        elif client_name and same_client(r["client_name"], client_name):
            match = "client"
        else:
            continue
        out.append({"creative_id": r["creative_id"], "creative_name": name, "match": match})
    # Token no nome primeiro; empate mantém a ordem da dimensão.
    out.sort(key=lambda c: 0 if c["match"] == "name" else 1)
    return out[:limit]


def _creative_ids_for_token(token, limit=500):
    return [c["creative_id"] for c in _dim_creatives_for_token(token, limit=limit)]


def _dim_stats():
    """Quantos criativos a dimensão tem e quando foi a última carga.

    Só é consultado quando a listagem de uma campanha sai VAZIA — é o que
    separa "a dimensão nunca carregou" (problema do cron da plataforma) de
    "carregou, mas nenhum criativo desta campanha segue a convenção de nome"
    (problema de nomenclatura). Sem essa distinção, o admin vê uma lista
    vazia e não tem como saber pra quem ligar.

    Tolerante a dimensão sem `synced_at` (override por MA_CREATIVES_DIM):
    devolve o que conseguir, nunca derruba a listagem por causa disso.
    """
    dim = creatives_dim_table()
    try:
        rows = list(_client().query(
            f"SELECT COUNT(*) AS n, MAX(synced_at) AS synced_at FROM `{dim}`",
            job_config=_job_config([]),
        ).result())
        r = rows[0]
        synced = r["synced_at"]
        return {"rows": int(r["n"] or 0), "synced_at": synced.isoformat() if synced else None}
    except Exception as e:  # noqa: BLE001 — diagnóstico não pode virar erro
        logger.warning(f"[maxattention] _dim_stats falhou (synced_at?): {e}")
        try:
            rows = list(_client().query(
                f"SELECT COUNT(*) AS n FROM `{dim}`", job_config=_job_config([]),
            ).result())
            return {"rows": int(rows[0]["n"] or 0), "synced_at": None}
        except Exception as e2:  # noqa: BLE001
            logger.warning(f"[maxattention] _dim_stats falhou de novo: {e2}")
            return {"rows": None, "synced_at": None}


def _client():
    return bq_client.get_client()


def _job_config(params, max_bytes=None):
    return bigquery.QueryJobConfig(
        query_parameters=params,
        maximum_bytes_billed=max_bytes or MAX_BYTES_BILLED,
        # Cache de query do BigQuery: ligado, mas HOJE ele não pega nada —
        # e o comentário anterior aqui dizia o contrário, o que é pior que
        # não ter comentário.
        #
        # O BigQuery não cacheia resultado de query não-determinística, e a
        # view (`backend/sql/ma_survey_view.sql`) filtra partição com
        # `CURRENT_TIMESTAMP()`. Toda query daqui atravessa a view, então
        # nenhuma é elegível: um cold start do backend re-varre de verdade,
        # não "cai na segunda linha de defesa" — quem segura custo aqui é o
        # cache em memória do backend (`main.py:_MA_RESULTS_TTL`) mais a poda
        # de partição e cluster.
        #
        # Fica `True` de propósito: é o default certo, custo zero, e volta a
        # valer sozinho no dia em que a view trocar `CURRENT_TIMESTAMP()` por
        # um limite fixo.
        use_query_cache=True,
    )


# ── Materialização ──────────────────────────────────────────────────────────
#
# Por que existe: a view (`backend/sql/ma_survey_view.sql`) é um SELECT
# DISTINCT sobre `creative_events_raw`, e cada leitura daqui atravessava ela
# até o lake. O BigQuery aplica o teto de bytes sobre a ESTIMATIVA, e a
# estimativa ignora poda de cluster — então filtrar por creative_id deixava a
# query barata de verdade, mas não a deixava passar no teto. A estimativa
# acompanha o tamanho do lake (todas as colunas lidas, de TODOS os eventos, na
# janela), e o lake cresce todo dia: 34 GiB → teto de 32 → 36,5 GiB → teto de
# 48 → 63 GiB. Três remendos em uma manhã, e a quebra voltou em oito dias.
# O detalhe público (`fetch_results`, chamado no render do report do cliente)
# ia pelo mesmo caminho, sem corte de data: a janela inteira da view.
#
# Agora: `survey_answer` é copiado pra uma tabela pequena em `prod_assets`
# (uma linha por resposta; milhares, não bilhões), e TODA leitura vai nela.
# Quem lê o lake é só o sync, em fatias de poucos dias — cada fatia estima só
# as partições dela, então o custo por rodada não cresce com o histórico.
#
# O sync anda do RECENTE pro antigo, e a cobertura é explícita. A primeira
# versão (29/09) andava pra frente a partir da partição mais antiga, com
# orçamento de tempo por rodada: o primeiro uso gastou as rodadas em meses
# vazios e a tabela parcial foi servida como completa — o modal da PPV8JF
# disse "nenhuma resposta, confira a coleta" com a peça recebendo resposta.
# Duas regras saíram disso e estão travadas por teste:
#   - ordem: ponta (última marca → agora) primeiro, depois os buracos do
#     histórico, cada um andando pra trás; dias sem partição no lake são
#     pulados sem MERGE;
#   - honestidade: `window_covered` / `sync` no payload. "Não houve resposta"
#     só é dito quando a tabela cobre a janela inteira; fora disso o front
#     diz que a cópia está em andamento, e o erro do sync vai junto.
#
# Quem roda o sync:
#   - o tick agendado (`sync_tick`, Cloud Scheduler a cada 5 min em horário
#     comercial): só a ponta, com teto por MERGE e orçamento diário. É o
#     caminho que deixa a resposta nova visível em minutos;
#   - o warmup do main.py: o primeiro do dia reconcilia 3 dias pra trás
#     (`reconcile_daily`), pra pegar evento que chegou atrasado no lake; os
#     demais fazem só um tick;
#   - a própria leitura, quando a última rodada tem mais de
#     `MA_SURVEY_SYNC_MIN` (default 60) — rede de segurança pra quando o tick
#     não roda (fora do horário, orçamento esgotado). Best-effort: se o sync
#     falhar, a leitura serve o que já está na tabela e o erro vai pro log;
#   - `refresh=true` do admin, que força um tick (também dentro do orçamento).
#
# `MA_SURVEY_MATERIALIZE=0` volta ao modo antigo (lendo a view direto). Existe
# pra emergência, não pra uso: é o modo que quebra.

# Colunas que a fonte materializada expõe, na ordem de `_view_columns`:
# (short_token, responses, creative_name, question, session_id).
_MATERIALIZED_COLUMNS = (True, False, True, True, True)

# Janela máxima que o backfill inicial olha — a mesma teto da view.
BACKFILL_DAYS = 730

# Tamanho da fatia do sync. 7 dias estimam ~20 GiB no volume de set/2026; se
# um dia estourar o teto, a fatia cai pela metade sozinha (até 1 dia).
SYNC_CHUNK_DAYS = 7

# Sobreposição da rodada incremental com a anterior. O Worker de ingestão
# grava em quase tempo real; 2h cobrem o streaming buffer e relógio torto. O
# warmup usa 1 dia (`DEEP_SYNC_OVERLAP`) pra cobrir re-export atrasado.
SYNC_OVERLAP = timedelta(hours=2)
DEEP_SYNC_OVERLAP = timedelta(days=1)

# Orçamento de tempo de uma rodada. O backfill inicial pode ter dezenas de
# fatias; cada fatia grava a própria marca d'água, então parar no meio é
# seguro — a próxima rodada continua de onde esta parou.
SYNC_BUDGET_S = 60
# Orçamento quando o sync roda DENTRO de uma leitura (modal / report). Curto:
# o backfill anda do recente pro antigo, então os primeiros segundos já trazem
# a campanha no ar; o resto do histórico vem nas próximas rodadas e no warmup.
READ_SYNC_BUDGET_S = 20
# O detalhe (`fetch_results`) roda no navegador do CLIENTE: orçamento menor.
RESULTS_SYNC_BUDGET_S = 8
# Intervalo mínimo entre rodadas de backfill disparadas por leitura.
_BACKFILL_RETRY_S = 30

# ── Tick: custo com teto ─────────────────────────────────────────────────────
#
# Cada MERGE lê a partição INTEIRA do dia no lake, não só a janela pedida: o
# dado recente mora no streaming buffer, que não é clusterizado, então o
# filtro por event_type não poda. Medido em 30/09: 0,7 GB às 08h46 BRT, 1,8 GB
# às 16h49 — cresce ao longo do dia UTC, e cresce com o lake. Rodar a cada 5
# min é barato, mas não é de graça, e "não é de graça" sem teto é como a conta
# vira surpresa. Três travas:
#
#   1. o tick só copia a PONTA (marca d'água → agora). Buraco de histórico é
#      trabalho do warmup e da leitura, nunca do tick — um backfill disparado
#      por agendamento de 5 min seria a conta bizarra;
#   2. teto de bytes por MERGE (`MA_SURVEY_TICK_MAX_GB`, default 8): rodada
#      fora do padrão falha sem cobrar;
#   3. orçamento DIÁRIO compartilhado entre instâncias
#      (`MA_SURVEY_DAILY_GB`, default 200 ≈ US$ 1,25/dia no on-demand). O
#      gasto vem do próprio log de fatias (`bytes_billed`), então vale pra
#      todas as instâncias da função. Esgotado, o tick para e o report volta
#      pra cadência da leitura (60 min) até o dia virar.
#
# O que conta no orçamento: tudo que o sync cobrou no dia (tick, warmup,
# admin). O que ele BLOQUEIA: só o tick e o refresh do admin — a reconciliação
# diária e a rede de segurança da leitura já têm cadência limitada.
TICK_MAX_GB_DEFAULT = 8
DAILY_GB_DEFAULT = 200
# Reconciliação do primeiro warmup do dia. Na amostra de 30/09 havia resposta
# chegando ao lake 48h depois do `occurred_at`; com a sobreposição de 2h do
# tick (ou 1 dia do warmup antigo) ela nunca era copiada.
DAILY_RECONCILE_OVERLAP = timedelta(days=3)
# Refresh do admin: se alguém sincronizou há menos que isto, não repete.
FORCED_MIN_INTERVAL_S = 60


def _env_gb(name, default):
    try:
        v = float(os.environ.get(name, "") or default)
    except ValueError:
        v = float(default)
    return int(max(0.0, v) * 1024 ** 3)


def tick_max_bytes():
    return _env_gb("MA_SURVEY_TICK_MAX_GB", TICK_MAX_GB_DEFAULT)


def daily_budget_bytes():
    return _env_gb("MA_SURVEY_DAILY_GB", DAILY_GB_DEFAULT)

_SYNC_LOCK = threading.Lock()
LOCK_WAIT_S = 25
# checked_at: monotonic da última vez que confirmamos frescor (evita ir ao
# BigQuery a cada leitura). synced_through: marca d'água conhecida.
_SYNC_STATE = {"checked_at": None, "synced_through": None, "covered_from": None,
               "complete": False, "last_error": None, "partitions_error": None,
               "last_run": None}
_TABLES_READY = set()


def materialized():
    return os.environ.get("MA_SURVEY_MATERIALIZE", "1").strip() != "0"


def _sync_ttl_s():
    try:
        return max(1, int(os.environ.get("MA_SURVEY_SYNC_MIN", "60"))) * 60
    except ValueError:
        return 3600


def _qualified_env(name, default):
    raw = os.environ.get(name, "").strip().strip("`")
    if not raw:
        return default
    if not _VIEW_RE.match(raw):
        raise NotConfigured(f"{name} inválida ({raw!r}). Esperado 'projeto.dataset.tabela'.")
    return raw


def answers_table():
    """Tabela materializada. Em `prod_assets` porque é lá que a service
    account do Report Center já escreve (MERGE de overrides, checklist...);
    em `prod_analytics` ela só tem leitura."""
    project = survey_view().split(".")[0]
    return _qualified_env("MA_SURVEY_ANSWERS_TABLE", f"{project}.prod_assets.ma_survey_answers")


def _sync_log_table():
    return answers_table() + "_sync"


def events_raw_table():
    project, dataset, _ = survey_view().split(".")
    return _qualified_env("MA_EVENTS_RAW", f"{project}.{dataset}.creative_events_raw")


def _source(view, with_dim=True):
    """O que vai depois do FROM nas leituras: a view (modo legado) ou a tabela
    materializada com o MESMO contrato de colunas da view.

    Dedupe por event_id aqui, na leitura: MERGE só de INSERT pode rodar em
    paralelo entre instâncias, e duas rodadas simultâneas gravariam a mesma
    resposta duas vezes. A contagem por sessão distinta já absorveria isso,
    mas contagem certa não deveria depender de qual unidade está em uso. Na
    tabela pequena, função de janela custa nada."""
    if not materialized():
        return f"`{view}`"
    if not with_dim:
        # Sem a dimensão: o detalhe do report não usa nome nem token, e o
        # BigQuery cobra no mínimo 10 MB por tabela referenciada — o join
        # dobrava o custo de cada leitura do report sem trazer nada.
        return f"""(
          SELECT creative_id, session_id, question, option, responded_at
          FROM `{answers_table()}`
          WHERE TRUE
          QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY synced_at) = 1
        )"""
    return f"""(
          SELECT
            a.creative_id,
            d.creative_name,
            REGEXP_EXTRACT(UPPER(COALESCE(d.creative_name, '')), r'^ID-([A-Z0-9]{{4,10}})_') AS short_token,
            a.session_id,
            a.question,
            a.option,
            a.responded_at
          FROM (
            SELECT * FROM `{answers_table()}`
            WHERE TRUE
            QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY synced_at) = 1
          ) a
          LEFT JOIN `{creatives_dim_table()}` d ON d.creative_id = a.creative_id
        )"""


def _read_max_bytes():
    return READ_MAX_BYTES_BILLED if materialized() else MAX_BYTES_BILLED


def _ensure_tables():
    answers, log = answers_table(), _sync_log_table()
    if answers in _TABLES_READY:
        return
    _client().query(f"""
        CREATE TABLE IF NOT EXISTS `{answers}` (
          event_id     STRING    NOT NULL,
          creative_id  STRING    NOT NULL,
          session_id   STRING,
          question     STRING,
          option       STRING    NOT NULL,
          responded_at TIMESTAMP NOT NULL,
          synced_at    TIMESTAMP
        )
        CLUSTER BY creative_id
        OPTIONS (description = "Respostas survey_answer do Max Attention, copiadas de creative_events_raw pelo Report Center (backend/maxattention.py). Não editar à mão.");
        CREATE TABLE IF NOT EXISTS `{log}` (
          synced_from    TIMESTAMP,
          synced_through TIMESTAMP NOT NULL,
          inserted       INT64,
          ran_at         TIMESTAMP,
          bytes_billed   INT64
        )
        OPTIONS (description = "Marca d'água do sync de ma_survey_answers. Uma linha por fatia.");
        -- Tabela criada antes do orçamento diário não tem a coluna.
        ALTER TABLE `{log}` ADD COLUMN IF NOT EXISTS bytes_billed INT64;
    """).result()
    _TABLES_READY.add(answers)


def _covered_intervals():
    """Intervalos [de, até) já copiados, fundidos. Vem do log de fatias, que
    é pequeno (uma linha por fatia, e fatias vazias viram UMA linha longa)."""
    rows = list(_client().query(
        f"SELECT synced_from, synced_through FROM `{_sync_log_table()}` WHERE synced_from IS NOT NULL",
        job_config=_job_config([], max_bytes=READ_MAX_BYTES_BILLED),
    ).result())
    return _merge_intervals((r["synced_from"], r["synced_through"]) for r in rows)


def _merge_intervals(ivs):
    out = []
    for a, b in sorted(i for i in ivs if i[0] is not None and i[1] is not None and i[0] < i[1]):
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _gaps(covered, lo, hi):
    """Trechos de [lo, hi) fora de `covered`, do MAIS RECENTE pro mais antigo."""
    gaps, cur = [], lo
    for a, b in covered:
        if b <= cur:
            continue
        if a >= hi:
            break
        if a > cur:
            gaps.append((cur, min(a, hi)))
        cur = max(cur, b)
    if cur < hi:
        gaps.append((cur, hi))
    return list(reversed(gaps))


def _lake_partitions(now):
    """(piso do backfill, dias com partição não vazia | None).

    Metadata, não varredura. O piso é a primeira partição com dado (limitado
    a `BACKFILL_DAYS`); o conjunto de dias deixa o backfill PULAR meses vazios
    sem gastar um MERGE em cada. Sem permissão no INFORMATION_SCHEMA: piso de
    730 dias e sem pulo — mais lento, mesmo resultado, e como o backfill anda
    do recente pro antigo, o que importa (campanha no ar) chega primeiro."""
    floor = now - timedelta(days=BACKFILL_DAYS)
    project, dataset, table = events_raw_table().split(".")
    try:
        rows = list(_client().query(
            f"""
            SELECT partition_id
            FROM `{project}.{dataset}.INFORMATION_SCHEMA.PARTITIONS`
            WHERE table_name = @t
              AND total_rows > 0
              AND REGEXP_CONTAINS(partition_id, r'^\\d{{8}}$')
            """,
            job_config=_job_config(
                [bigquery.ScalarQueryParameter("t", "STRING", table)],
                max_bytes=READ_MAX_BYTES_BILLED,
            ),
        ).result())
        days = set()
        for r in rows:
            try:
                days.add(datetime.strptime(r["partition_id"], "%Y%m%d").date())
            except (TypeError, ValueError):
                continue
        if days:
            first = datetime.combine(min(days), datetime.min.time(), tzinfo=timezone.utc)
            return max(floor, first), days
        # Zero partições NÃO quer dizer lake vazio: com escrita por streaming,
        # o dado recente fica em `__UNPARTITIONED__` até o buffer descarregar,
        # e metadata sem permissão pode vir vazia em vez de dar erro. Tratar
        # vazio como "nada a copiar" seria o mesmo bug do "nenhuma resposta"
        # por outro caminho. Sem informação, sem pulo.
        logger.warning("[maxattention] INFORMATION_SCHEMA sem partições; backfill sem pulo")
        return floor, None
    except Exception as e:  # noqa: BLE001 — otimização, não requisito
        logger.warning(f"[maxattention] INFORMATION_SCHEMA indisponível, backfill de {BACKFILL_DAYS} dias sem pulo: {e}")
        _SYNC_STATE["partitions_error"] = str(e)[:300]
        return floor, None


# Janela recente que o sync NUNCA pula, tenha partição listada ou não. O lake
# é escrito por streaming: o dado das últimas horas mora no streaming buffer e
# aparece em INFORMATION_SCHEMA como `__UNPARTITIONED__`, não no dia dele.
# Pular por falta de partição aqui marcaria como copiado justamente o trecho
# em que a campanha no ar está recebendo resposta.
NEVER_SKIP_RECENT = timedelta(days=3)


def _has_partition(days, since, until):
    if days is None:
        return True
    if until > _now() - NEVER_SKIP_RECENT:
        return True
    d, last = since.date(), (until - timedelta(microseconds=1)).date()
    while d <= last:
        if d in days:
            return True
        d += timedelta(days=1)
    return False


def _merge_range(since, until, max_bytes=None):
    """Copia as respostas de [since, until) do lake pra tabela. Idempotente
    (casa por event_id), então sobreposição entre rodadas é segura. Devolve
    (linhas inseridas, bytes cobrados) — o segundo alimenta o orçamento diário.

    Aqui o dedupe PODE ser por QUALIFY, ao contrário da view: a janela roda
    sobre o scan que já tem o filtro de partição constante, sem o otimizador
    precisar empurrar nada pra dentro. `event_id` nulo (não deveria existir)
    ganha uma chave derivada em vez de sumir ou de duplicar a cada rodada."""
    sql = f"""
        MERGE `{answers_table()}` T
        USING (
          SELECT event_id, creative_id, session_id, question, option, responded_at
          FROM (
            SELECT
              COALESCE(event_id, TO_HEX(MD5(CONCAT(
                creative_id, '|', IFNULL(session_id, ''), '|',
                CAST(occurred_at AS STRING), '|', IFNULL(JSON_VALUE(metadata, '$.optionLabel'), '')
              )))) AS event_id,
              creative_id,
              session_id,
              JSON_VALUE(metadata, '$.questionText') AS question,
              JSON_VALUE(metadata, '$.optionLabel')  AS option,
              occurred_at                            AS responded_at
            FROM `{events_raw_table()}`
            WHERE event_type = 'survey_answer'
              AND occurred_at >= @since
              AND occurred_at <  @until
              AND creative_id IS NOT NULL
          )
          WHERE option IS NOT NULL AND TRIM(option) != ''
          QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY responded_at) = 1
        ) S
        ON T.event_id = S.event_id
        WHEN NOT MATCHED THEN
          INSERT (event_id, creative_id, session_id, question, option, responded_at, synced_at)
          VALUES (S.event_id, S.creative_id, S.session_id, S.question, S.option, S.responded_at, CURRENT_TIMESTAMP())
    """
    params = [
        bigquery.ScalarQueryParameter("since", "TIMESTAMP", since),
        bigquery.ScalarQueryParameter("until", "TIMESTAMP", until),
    ]
    job = _client().query(sql, job_config=_job_config(params, max_bytes=max_bytes))
    job.result()
    return (int(getattr(job, "num_dml_affected_rows", None) or 0),
            int(getattr(job, "total_bytes_billed", None) or 0))


def _log_sync(since, until, inserted, billed=0):
    _client().query(
        f"""
        INSERT INTO `{_sync_log_table()}` (synced_from, synced_through, inserted, ran_at, bytes_billed)
        VALUES (@since, @until, @inserted, CURRENT_TIMESTAMP(), @billed)
        """,
        job_config=_job_config([
            bigquery.ScalarQueryParameter("since", "TIMESTAMP", since),
            bigquery.ScalarQueryParameter("until", "TIMESTAMP", until),
            bigquery.ScalarQueryParameter("inserted", "INT64", int(inserted)),
            bigquery.ScalarQueryParameter("billed", "INT64", int(billed)),
        ], max_bytes=READ_MAX_BYTES_BILLED),
    ).result()


def _day_start_brt(now):
    """Meia-noite de hoje em BRT, em UTC. O orçamento vira junto com o dia de
    quem olha a conta, não com o dia UTC (21h BRT)."""
    brt = timezone(timedelta(hours=-3))
    local = now.astimezone(brt)
    return local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)


def spent_today_bytes():
    """Bytes que o sync cobrou hoje (BRT), somando TODAS as instâncias — vem
    do log de fatias, não de memória. Erro sobe: quem chama decide (o tick
    falha fechado: sem saber o gasto, não gasta)."""
    _ensure_tables()
    rows = list(_client().query(
        f"SELECT IFNULL(SUM(bytes_billed), 0) AS b FROM `{_sync_log_table()}` WHERE ran_at >= @since",
        job_config=_job_config(
            [bigquery.ScalarQueryParameter("since", "TIMESTAMP", _day_start_brt(_now()))],
            max_bytes=READ_MAX_BYTES_BILLED,
        ),
    ).result())
    return int(rows[0]["b"] or 0) if rows else 0


def sync_answers(force=False, overlap=SYNC_OVERLAP, budget_s=SYNC_BUDGET_S, wait=True,
                 max_bytes=None, tail_only=False):
    """Traz o que chegou no lake e completa o histórico. Erro sobe.

    `tail_only` copia só a ponta e deixa os buracos pra outra rodada (é o modo
    do tick). `max_bytes` é o teto de cada MERGE.

    Ordem de trabalho, sempre do RECENTE pro antigo:
      1. a ponta: da última marca (menos a sobreposição) até agora;
      2. os buracos de [piso, agora) que o log ainda não cobre, cada um em
         fatias andando pra trás.
    Com orçamento de tempo curto, a rodada entrega primeiro o que a campanha
    no ar precisa. A primeira versão fazia o contrário (andava pra frente a
    partir do piso) e, com uma partição velha no lake, gastava a rodada inteira
    em meses vazios enquanto a tabela parcial era servida como completa.

    Devolve `{status, synced_through, covered_from, complete, inserted,
    chunks, bytes_billed}`. `covered_from` é o início do trecho CONTÍNUO que termina em
    `synced_through`: é o que dá pra afirmar sobre "não houve resposta".
    `complete` = não sobrou buraco entre o piso e agora.

      - status "fresh": nada a fazer;
      - status "synced": rodou (talvez parcial, ver `complete`);
      - status "busy": `wait=False` e outra thread desta instância já está
        sincronizando — quem lê não fica na fila atrás de um backfill.
    """
    ttl = _sync_ttl_s()
    # Espera com teto: o warmup pode estar no meio de um backfill de minutos
    # nesta instância, e a leitura não pode estourar o timeout do front
    # esperando por ele. Sem o lock, "busy": a leitura segue com o que houver
    # e o payload diz que a cópia está em andamento.
    acquired = _SYNC_LOCK.acquire(timeout=LOCK_WAIT_S) if wait else _SYNC_LOCK.acquire(blocking=False)
    if not acquired:
        return {**_sync_snapshot(), "status": "busy", "inserted": 0, "chunks": 0, "bytes_billed": 0}
    try:
        return _sync_locked(force, overlap, budget_s, ttl, max_bytes=max_bytes, tail_only=tail_only)
    except Exception as e:
        _SYNC_STATE["last_error"] = f"{type(e).__name__}: {e}"[:500]
        raise
    finally:
        _SYNC_LOCK.release()


def _sync_snapshot():
    return {
        "synced_through": _SYNC_STATE["synced_through"],
        "covered_from": _SYNC_STATE["covered_from"],
        "complete": bool(_SYNC_STATE["complete"]),
    }


def _contiguous_from(covered, through):
    for a, b in covered:
        if a <= through <= b:
            return a
    return None


def _publish_state(covered, floor, now, days):
    through = covered[-1][1] if covered else None
    # "Completo" fala do HISTÓRICO (piso → última marca). A ponta (marca →
    # agora) é sempre um trecho aberto, e o frescor dela é o TTL que governa.
    remaining = _gaps(covered, floor, through) if through else [(floor, now)]
    # Buraco em dias sem partição não é buraco: não há o que copiar ali.
    remaining = [g for g in remaining if _has_partition(days, *g)]
    _SYNC_STATE.update(
        synced_through=through,
        covered_from=_contiguous_from(covered, through) if through else None,
        complete=not remaining,
    )


def _sync_locked(force, overlap, budget_s, ttl, max_bytes=None, tail_only=False):
    checked = _SYNC_STATE["checked_at"]
    if (not force and checked is not None and _SYNC_STATE["complete"]
            and (time.monotonic() - checked) < ttl):
        return {**_sync_snapshot(), "status": "fresh", "inserted": 0, "chunks": 0, "bytes_billed": 0}

    # Histórico incompleto com a ponta fresca: leitura não-forçada só volta a
    # gastar orçamento de backfill a cada `_BACKFILL_RETRY_S`. Sem isso, cada
    # leitura (inclusive a do report do cliente) pagaria segundos de MERGE
    # até o histórico fechar.
    last = _SYNC_STATE.get("last_run")
    through_known = _SYNC_STATE["synced_through"]
    if (not force and last is not None and (time.monotonic() - last) < _BACKFILL_RETRY_S
            and through_known is not None and (_now() - through_known).total_seconds() < ttl):
        return {**_sync_snapshot(), "status": "fresh", "inserted": 0, "chunks": 0, "bytes_billed": 0}

    _ensure_tables()
    now = _now()
    covered = _covered_intervals()
    floor, days = _lake_partitions(now)
    _publish_state(covered, floor, now, days)
    through = _SYNC_STATE["synced_through"]
    if (not force and _SYNC_STATE["complete"] and through is not None
            and (now - through).total_seconds() < ttl):
        _SYNC_STATE["checked_at"] = time.monotonic()
        return {**_sync_snapshot(), "status": "fresh", "inserted": 0, "chunks": 0, "bytes_billed": 0}

    # Tick sem marca d'água seria um backfill de 730 dias disparado por
    # agendamento — exatamente o gasto que o modo existe pra impedir. O
    # primeiro backfill é da leitura/warmup.
    if tail_only and through is None:
        return {**_sync_snapshot(), "status": "no_watermark", "inserted": 0, "chunks": 0, "bytes_billed": 0}

    # Fila de trabalho, do recente pro antigo: a ponta primeiro (reabre a
    # sobreposição, onde pode ter chegado evento atrasado), depois os buracos.
    if through is None:
        work = [(floor, now)]
    else:
        tail = (max(floor, through - overlap), now)
        work = [tail] if tail_only else [tail] + _gaps(_merge_intervals(covered + [tail]), floor, now)

    t0 = time.monotonic()
    inserted = chunks = billed = 0
    done = []            # o que esta rodada de fato cobriu
    skip = None          # trecho contíguo sem partição, logado numa linha só
    out_of_budget = False

    for lo, hi in work:
        end = hi
        step = timedelta(days=SYNC_CHUNK_DAYS)
        while end > lo:
            start = max(lo, end - step)
            if not _has_partition(days, start, end):
                # Anda pra trás: o trecho novo encosta no início do acumulado.
                if skip and skip[0] == end:
                    skip = (start, skip[1])
                else:
                    if skip:
                        _log_sync(*skip, 0)
                        done.append(skip)
                    skip = (start, end)
                end = start
                continue
            if chunks and (time.monotonic() - t0) > budget_s:
                out_of_budget = True
                break
            try:
                n, b = _merge_range(start, end, max_bytes=max_bytes)
            except Exception as e:  # noqa: BLE001 — só o teto é tratado
                if _is_bytes_limit_error(e) and step > timedelta(days=1) and end - start > timedelta(days=1):
                    step = max(timedelta(days=1), step / 2)
                    continue
                raise
            _log_sync(start, end, n, b)
            done.append((start, end))
            inserted += n
            billed += b
            chunks += 1
            end = start
        if out_of_budget:
            break
    if skip:
        _log_sync(*skip, 0)
        done.append(skip)

    covered = _merge_intervals(covered + done)
    _publish_state(covered, floor, now, days)
    _SYNC_STATE["last_error"] = None
    _SYNC_STATE["last_run"] = time.monotonic()
    _SYNC_STATE["checked_at"] = time.monotonic() if _SYNC_STATE["complete"] else None
    if inserted:
        # O ramo amplo da listagem fica cacheado por horas; resposta nova
        # na tabela tem que aparecer nele sem esperar o TTL.
        _RECENT_CACHE.clear()
    snap = _sync_snapshot()
    logger.info(
        f"[maxattention] sync: {inserted} respostas novas em {chunks} fatia(s), "
        f"{billed / 1024 ** 3:.2f} GB cobrados; cobertura "
        f"{snap['covered_from'].isoformat() if snap['covered_from'] else '—'} → "
        f"{snap['synced_through'].isoformat() if snap['synced_through'] else '—'}"
        f"{'' if snap['complete'] else ' (histórico incompleto, continua na próxima)'}"
    )
    return {**snap, "status": "synced", "inserted": inserted, "chunks": chunks, "bytes_billed": billed}


def _ensure_fresh(force=False, budget_s=READ_SYNC_BUDGET_S):
    """Sync pro caminho de LEITURA. Falha não derruba a leitura: a tabela
    ainda tem tudo até a última rodada boa, e o erro vai no payload
    (`sync.error`) pro admin ver — não só no log. O que não dá pra servir é
    tabela que nunca recebeu uma rodada boa (não criada, ou backfill falhando
    desde o início): ela responderia "zero respostas" com cara de verdade.
    Aí o erro original sobe."""
    if not materialized():
        return None
    ready = answers_table() in _TABLES_READY
    try:
        # Tabela já conhecida: não espera sync de outra thread (serve o que
        # tem). Primeira leitura da instância: espera, porque pode ser o
        # backfill e a tabela ainda nem existir.
        return sync_answers(force=force, wait=force or not ready, budget_s=budget_s)
    except Exception as e:  # noqa: BLE001
        if _SYNC_STATE["synced_through"] is None:
            raise
        logger.warning(f"[maxattention] sync falhou, servindo a tabela como está: {e}")
        return None


def sync_tick():
    """Rodada curta agendada: só a ponta, com teto por MERGE e dentro do
    orçamento diário. Não espera outra thread (`busy` se o warmup estiver
    sincronizando nesta instância). Erro sobe — o endpoint registra.

    Falha fechado no orçamento: sem conseguir ler o gasto do dia, não gasta."""
    if not materialized():
        return {"status": "legacy", "inserted": 0, "chunks": 0, "bytes_billed": 0}
    budget = daily_budget_bytes()
    spent = spent_today_bytes()
    if spent >= budget:
        logger.warning(
            f"[maxattention] tick pulado: orçamento do dia esgotado "
            f"({spent / 1024 ** 3:.1f} de {budget / 1024 ** 3:.1f} GB)"
        )
        return {**_sync_snapshot(), "status": "over_budget", "inserted": 0, "chunks": 0,
                "bytes_billed": 0, "spent_bytes": spent, "budget_bytes": budget}
    r = sync_answers(force=True, overlap=SYNC_OVERLAP, budget_s=SYNC_BUDGET_S, wait=False,
                     max_bytes=tick_max_bytes(), tail_only=True)
    return {**r, "spent_bytes": spent + int(r.get("bytes_billed") or 0), "budget_bytes": budget}


def reconcile_daily():
    """Primeiro warmup do dia: reabre 3 dias do lake pra pegar resposta que
    chegou atrasada (visto: 48h). Completa buracos de histórico também. Fora
    do orçamento de propósito: é uma rodada por dia, e é o que garante que o
    total não perde resposta."""
    return sync_answers(force=True, overlap=DAILY_RECONCILE_OVERLAP, budget_s=240)


def force_fresh():
    """`refresh=true` do admin: um tick agora, a menos que a cópia tenha menos
    de `FORCED_MIN_INTERVAL_S`. Antes o refresh só furava o cache de 5 min e
    lia a mesma tabela parada — quem testava a coleta respondendo no preview
    não via o número mexer, com razão."""
    through = _SYNC_STATE["synced_through"]
    if through is not None and (_now() - through).total_seconds() < FORCED_MIN_INTERVAL_S:
        return {**_sync_snapshot(), "status": "fresh", "inserted": 0, "chunks": 0, "bytes_billed": 0}
    return sync_tick()


def sync_status():
    """Estado do sync pro payload (admin) e pro endpoint de status. `None` no
    modo legado."""
    if not materialized():
        return None
    snap = _sync_snapshot()
    iso = lambda t: t.isoformat() if t else None  # noqa: E731
    return {
        "synced_through": iso(snap["synced_through"]),
        "covered_from": iso(snap["covered_from"]),
        "complete": snap["complete"],
        "error": _SYNC_STATE.get("last_error"),
        "partitions_error": _SYNC_STATE.get("partitions_error"),
    }


def status_report():
    """Raio-x do sync pra quem está investigando SEM acesso ao BigQuery (é o
    caso de quase todo mundo que abre o modal). Só leitura: log de fatias,
    tamanho e alcance da tabela, e o estado em memória desta instância.
    `?action=maxattention_sync&dry=true` devolve isto."""
    if not materialized():
        return {"materialized": False}
    ans, log = answers_table(), _sync_log_table()
    out = {"materialized": True, "answers_table": ans, "state": sync_status()}
    try:
        covered = _covered_intervals()
        out["covered"] = [[a.isoformat(), b.isoformat()] for a, b in covered[-20:]]
        out["covered_intervals"] = len(covered)
    except Exception as e:  # noqa: BLE001
        out["covered_error"] = str(e)[:300]
    try:
        r = list(_client().query(
            f"""
            SELECT COUNT(*) AS n, COUNT(DISTINCT creative_id) AS creatives,
                   MIN(responded_at) AS first_at, MAX(responded_at) AS last_at,
                   COUNTIF(responded_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)) AS last_7d
            FROM `{ans}`
            """,
            job_config=_job_config([], max_bytes=READ_MAX_BYTES_BILLED),
        ).result())[0]
        out["answers"] = {
            "rows": int(r["n"] or 0), "creatives": int(r["creatives"] or 0),
            "first_at": r["first_at"].isoformat() if r["first_at"] else None,
            "last_at": r["last_at"].isoformat() if r["last_at"] else None,
            "last_7d": int(r["last_7d"] or 0),
        }
    except Exception as e:  # noqa: BLE001
        out["answers_error"] = str(e)[:300]
    try:
        rows = list(_client().query(
            f"""
            SELECT synced_from, synced_through, inserted, ran_at FROM `{log}`
            ORDER BY ran_at DESC LIMIT 15
            """,
            job_config=_job_config([], max_bytes=READ_MAX_BYTES_BILLED),
        ).result())
        out["last_chunks"] = [{
            "from": r["synced_from"].isoformat() if r["synced_from"] else None,
            "through": r["synced_through"].isoformat() if r["synced_through"] else None,
            "inserted": r["inserted"], "ran_at": r["ran_at"].isoformat() if r["ran_at"] else None,
        } for r in rows]
    except Exception as e:  # noqa: BLE001
        out["log_error"] = str(e)[:300]
    return out


def _synced_through_iso():
    t = _SYNC_STATE["synced_through"] if materialized() else None
    return t.isoformat() if t else None


def window_covered(since):
    """True quando a tabela cobre, sem buraco, de `since` até a última marca.
    É a condição pra afirmar "não houve resposta nessa janela"."""
    if not materialized():
        return True
    cf = _SYNC_STATE["covered_from"]
    return bool(_SYNC_STATE["complete"]) or (cf is not None and cf <= since)


# Teto de nomes de criativo devolvidos no diagnóstico de lista vazia. Serve
# pro admin reconhecer a campanha ("ah, é a peça X"), não pra listar tudo.
MAX_DIAG_NAMES = 8


# Cache do ramo AMPLO (todas as campanhas, janela curta). É a única parte
# cara da listagem e é IGUAL pra toda campanha — então roda uma vez e serve
# todos os modais. TTL longo de propósito: a pergunta que ele responde
# ("quais peças têm resposta de survey nos últimos 30 dias") muda devagar,
# e o ramo da campanha (barato) continua fresco pelo cache de 10 min do
# main.py. Em memória, por instância; o warmup do main.py aquece.
_RECENT_TTL_S = 3 * 3600
_RECENT_CACHE = {}           # recent_days -> (monotonic_ts, rows)
_RECENT_LOCK = threading.Lock()


def list_creatives(short_token=None, days=DEFAULT_LOOKBACK_DAYS, limit=200, client_name=None):
    """Compat: só a lista. Ver `list_creatives_payload`."""
    return list_creatives_payload(
        short_token=short_token, days=days, limit=limit, client_name=client_name,
    )["creatives"]


def warm_recent(days=UNSCOPED_LOOKBACK_DAYS):
    """Aquece o ramo amplo (chamado pelo warmup do main.py). Devolve quantas
    peças entraram. Erro sobe — o warmup registra e segue."""
    rows = _recent_rows(days, force=True)
    return len(rows)


def list_creatives_payload(short_token=None, days=DEFAULT_LOOKBACK_DAYS, limit=200,
                           client_name=None, refresh=False):
    """
    Criativos com resposta de survey na janela, mais recentes primeiro.

    Com `short_token`, filtra pelos que pertencem àquela campanha — pela
    coluna quando a view a preenche, senão pela convenção de nome. Sem
    ele, devolve a janela inteira (o admin busca no dropdown).

    Devolve um payload, não só a lista:

        {
          "creatives": [{creative_id, creative_name, short_token, questions,
                         options, responses, first_at, last_at, side, match}],
          "scope": "campaign" | "all",
          "short_token": "FXR5US" | "",
          "days": <janela efetivamente usada>,
          "diagnostics": None | {
              "reason": "dim_empty" | "no_dim_match" | "no_responses",
              "dim_rows": int | None,
              "dim_synced_at": iso | None,
              "dim_matched": int,
              "dim_names": [str],
          },
        }

    `diagnostics` só vem preenchido quando a lista de uma CAMPANHA sai vazia.
    Lista vazia era a resposta certa e continua sendo — mas "[]" sozinho não
    diz se a dimensão nunca carregou, se nenhuma peça leva o token no nome ou
    se as peças existem e ninguém respondeu. São três causas com três
    responsáveis diferentes (cron da plataforma / quem nomeou o criativo /
    a coleta em mídia), e o admin olhando um dropdown vazio não tem como
    distinguir. Foi exatamente esse buraco que virou "a integração quebrou".
    """
    view = survey_view()
    # refresh=true do admin ("Atualizar lista") força o sync: é o botão que
    # ele aperta depois de responder no preview pra ver a resposta entrar.
    _ensure_fresh(force=refresh)
    days = max(1, min(int(days or DEFAULT_LOOKBACK_DAYS), 730))
    limit = max(1, min(int(limit or 200), 1000))
    token = (short_token or "").strip()

    # A view pode ou não ter short_token/responses. Em vez de duas versões
    # do SQL, resolvemos com SELECT * num CTE e checagem de coluna no
    # schema — assim a mesma query serve pros dois contratos.
    has_token_col, has_responses_col, has_name_col, has_question_col, has_session_col = _view_columns(view)

    token_expr = "ANY_VALUE(short_token)" if has_token_col else "CAST(NULL AS STRING)"
    weight = _weight_expr(has_session_col, has_responses_col)
    # Sem nome, o criativo se identifica pelo id — a UI ainda lista, só não
    # consegue sugerir campanha/lado sozinha.
    name_expr = "ANY_VALUE(creative_name)" if has_name_col else "CAST(NULL AS STRING)"
    questions_expr = (
        "ARRAY_AGG(DISTINCT question IGNORE NULLS ORDER BY question)"
        if has_question_col
        else "CAST([] AS ARRAY<STRING>)"
    )

    # Filtrar por creative_id é o que torna esta query viável.
    #
    # `creative_events_raw` é clusterizada por (creative_id, event_type). A
    # primeira versão desta listagem filtrava só por event_type — a SEGUNDA
    # chave — e por isso quase não podava: 34 GiB por abertura de modal, que
    # o teto de bytes barrou (`bytesBilledLimitExceeded`), com razão.
    #
    # A campanha é resolvida antes, na `creatives_dim`, que tem centenas de
    # linhas e custa alguns KB. Com os ids em mãos, o filtro cai na chave
    # LÍDER do cluster e o scan encolhe pra fração do que era.
    # A lista é SEMPRE ampla — como a do Typeform, que mostra a pasta inteira
    # e deixa o admin buscar. A campanha entra como ORDEM e MARCA, não como
    # filtro: peças com o token no nome vêm primeiro (e com janela longa, 180
    # dias, porque campanha vive semanas); o resto da base entra com janela
    # curta (30 dias), pra peça nomeada fora da convenção continuar
    # alcançável pela busca. Antes a campanha era filtro, e campanha sem
    # peça com o token no nome não tinha lista nenhuma — o admin via
    # "Nenhum criativo encontrado" e não tinha pra onde ir.
    #
    # Custo: o ramo da campanha poda pela chave LÍDER do cluster
    # (creative_id) e é barato; o ramo amplo não tem como podar por criativo
    # e é a janela curta que o segura. É admin-only e cacheado 10 min.
    # `creative_events_raw` é clusterizada por (creative_id, event_type); a
    # primeira versão desta listagem filtrava 180 dias só por event_type e
    # custava 34 GiB por abertura de modal — a janela de 30 dias é a
    # lembrança disso.
    recent_days = min(days, UNSCOPED_LOOKBACK_DAYS)
    dim_matched = _dim_creatives_for_token(token, client_name=client_name) if token else []
    ids = [c["creative_id"] for c in dim_matched]
    id_set = set(ids)
    # creative_id → como a dimensão amarrou a peça à campanha ("name" | "client").
    dim_match_by_id = {c["creative_id"]: c["match"] for c in dim_matched}

    # Cortes de data como TIMESTAMP CONSTANTE (parâmetro), não como
    # TIMESTAMP_SUB(CURRENT_TIMESTAMP(), ...). Não é estilo: é o que decide se
    # a query roda. O teto de bytes (`MAX_BYTES_BILLED`) é aplicado sobre a
    # ESTIMATIVA, e a estimativa só poda partição com predicado que o
    # planejador consegue avaliar antes de executar — CURRENT_TIMESTAMP() não
    # é um deles. Com ele, o ramo amplo (sem creative_id pra podar cluster)
    # foi estimado como a tabela inteira: 36,5 GiB contra o teto de 32, e o
    # modal morreu com `bytesBilledLimitExceeded` no primeiro uso em
    # produção. O ramo da campanha sobrevivia só porque o filtro por id
    # encolhe a estimativa pelo cluster.
    now = _now()
    since_recent = now - timedelta(days=recent_days)
    since_campaign = now - timedelta(days=days)

    def _payload(creatives, diagnostics=None, includes_recent=True, recent_skipped=None):
        return {
            "creatives": creatives,
            "scope": "campaign" if token else "all",
            "short_token": token,
            # Janela do ramo da campanha (peças com o token no nome / do cliente).
            "days": days if token and ids else recent_days,
            # Janela do ramo amplo (todas as campanhas).
            "recent_days": recent_days,
            "includes_recent": includes_recent,
            # Quando o ramo amplo foi deixado de fora e por quê ("bytes_limit").
            "recent_skipped": recent_skipped,
            "campaign_count": sum(1 for c in creatives if c["creative_id"] in id_set),
            # Cliente usado no vínculo por cliente (None = só por token).
            "client_name": client_name or None,
            "diagnostics": diagnostics,
            "synced_through": _synced_through_iso(),
            # Estado da cópia lake → tabela: até quando, desde quando sem
            # buraco, se o histórico está completo e o último erro. É o que
            # deixa o front dizer "ainda copiando" em vez de "não há resposta".
            "sync": sync_status(),
            "window_covered": window_covered(since_recent if not (token and ids) else since_campaign),
        }

    # Duas queries, não uma: o ramo da CAMPANHA é barato (poda por
    # creative_id, chave líder do cluster) e roda sempre; o ramo AMPLO é caro
    # (dezenas de GB a frio) e é o MESMO pra toda campanha — então é
    # cacheado aqui, por horas, e compartilhado. Antes era um UNION ALL numa
    # query só, e cada modal aberto pagava o ramo amplo de novo: dezenas de
    # segundos de esqueleto na tela.
    campaign_rows = []
    if ids:
        sql = _listing_sql(view, [f"""
          SELECT * FROM {_source(view)}
          WHERE creative_id IN UNNEST(@ids)
            AND responded_at >= @since_campaign
        """], "ORDER BY last_at DESC", name_expr, token_expr, questions_expr, weight, limit)
        params = [
            bigquery.ScalarQueryParameter("since_campaign", "TIMESTAMP", since_campaign),
            bigquery.ArrayQueryParameter("ids", "STRING", ids),
        ]
        campaign_rows = list(_client().query(
            sql, job_config=_job_config(params, max_bytes=_read_max_bytes()),
        ).result())

    includes_recent = True
    recent_skipped = None
    try:
        recent_rows = _recent_rows(recent_days, force=refresh)
    except Exception as e:  # noqa: BLE001 — só o teto de bytes é tratado aqui
        if not _is_bytes_limit_error(e):
            raise
        # O ramo amplo estourou o teto: a lista da CAMPANHA não pode morrer
        # junto. Segue só com ela e avisa no payload — antes isto era um 500
        # no modal inteiro, com o Max Attention indisponível.
        logger.warning(f"[maxattention] ramo amplo estourou o teto de bytes; servindo só a campanha: {e}")
        recent_rows = []
        includes_recent = False
        recent_skipped = "bytes_limit"

    # Campanha primeiro (com a janela longa dela); do amplo, só quem não é da
    # campanha — a mesma peça não entra duas vezes.
    rows = list(campaign_rows) + [r for r in recent_rows if r["creative_id"] not in id_set]
    rows = rows[:limit]

    out = _rows_to_creatives(rows, token, dim_match_by_id)

    if not token:
        return _payload(out)

    # Diagnóstico da CAMPANHA, mesmo com a lista ampla cheia: o admin precisa
    # saber por que nenhuma peça foi marcada como sendo desta campanha —
    # dimensão vazia é uma coisa (cron da plataforma), nome fora da convenção
    # é outra (quem criou a peça), peça sem resposta é uma terceira (coleta).
    diagnostics = None
    if not dim_matched:
        stats = _dim_stats()
        diagnostics = {
            "reason": "dim_empty" if stats["rows"] == 0 else "no_dim_match",
            "dim_rows": stats["rows"],
            "dim_synced_at": stats["synced_at"],
            "dim_matched": 0,
            "dim_names": [],
        }
    elif not any(c["creative_id"] in id_set for c in out):
        names = sorted({c["creative_name"] for c in dim_matched if c["creative_name"]})
        diagnostics = {
            # "Ninguém respondeu" só é afirmação quando a tabela cobre a janela
            # inteira. Com o histórico ainda sendo copiado, o vazio é da CÓPIA,
            # não da coleta — e dizer "confira a coleta" nesse caso manda o
            # admin investigar a coisa errada (foi o que aconteceu na PPV8JF).
            "reason": "no_responses" if window_covered(since_campaign) else "sync_pending",
            "dim_rows": None,
            "dim_synced_at": None,
            "dim_matched": len(dim_matched),
            "dim_names": names[:MAX_DIAG_NAMES],
        }
    return _payload(out, diagnostics, includes_recent=includes_recent, recent_skipped=recent_skipped)


def _now():
    """Separado pra teste."""
    return datetime.now(timezone.utc)


def _recent_rows(recent_days, force=False):
    """Linhas agregadas do ramo AMPLO (todas as peças com resposta na janela
    curta), do cache quando fresco. `force` fura o cache (refresh=true do
    admin e warmup). Single-flight por lock: dois modais abrindo juntos numa
    instância fria não pagam a query duas vezes."""
    with _RECENT_LOCK:
        hit = _RECENT_CACHE.get(recent_days)
        if hit and not force and (time.monotonic() - hit[0]) < _RECENT_TTL_S:
            return hit[1]
        view = survey_view()
        has_token_col, has_responses_col, has_name_col, has_question_col, has_session_col = _view_columns(view)
        sql = _listing_sql(
            view,
            [f"""
              SELECT * FROM {_source(view)}
              WHERE responded_at >= @since_recent
            """],
            "ORDER BY last_at DESC",
            "ANY_VALUE(creative_name)" if has_name_col else "CAST(NULL AS STRING)",
            "ANY_VALUE(short_token)" if has_token_col else "CAST(NULL AS STRING)",
            "ARRAY_AGG(DISTINCT question IGNORE NULLS ORDER BY question)" if has_question_col else "CAST([] AS ARRAY<STRING>)",
            _weight_expr(has_session_col, has_responses_col),
            1000,
        )
        params = [bigquery.ScalarQueryParameter(
            "since_recent", "TIMESTAMP", _now() - timedelta(days=recent_days),
        )]
        since_recent = _now() - timedelta(days=recent_days)
        rows = list(_client().query(
            sql, job_config=_job_config(params, max_bytes=_read_max_bytes()),
        ).result())
        # Resultado de tabela ainda sem cobertura da janela NÃO entra no cache
        # de horas: foi assim que uma lista vazia, lida no meio do backfill,
        # ficaria servida por 3h mesmo depois da cópia terminar.
        if window_covered(since_recent):
            _RECENT_CACHE[recent_days] = (time.monotonic(), rows)
        return rows


def _is_bytes_limit_error(e):
    msg = str(e)
    return "bytesBilledLimitExceeded" in msg or "exceeded limit for bytes billed" in msg


def _listing_sql(view, branches, order, name_expr, token_expr, questions_expr, weight, limit):
    return f"""
        WITH src AS (
          {' UNION ALL '.join(branches)}
        )
        SELECT
          creative_id,
          {name_expr}                     AS creative_name,
          {token_expr}                    AS short_token,
          {questions_expr}                AS questions,
          -- Opções da pesquisa. É o que identifica QUAL pergunta o criativo
          -- coletou: no Tap to Choose de pergunta única não há título, e sem
          -- isto o front só sabia o lado (controle/exposto) — então sugeria o
          -- mesmo criativo pra toda pergunta da campanha. Um "Sim/Não/Talvez"
          -- não casa com um "Marca A/Marca B", e é essa comparação que separa
          -- Ad Recall de Preferência.
          -- Sem LIMIT aqui de propósito: o BigQuery recusa DISTINCT e LIMIT
          -- na MESMA agregação ("aggregate function that has both DISTINCT
          -- and LIMIT is not yet supported"), e a listagem inteira morria com
          -- isso. O corte vai no Python, onde não custa nada — o número de
          -- opções distintas de uma pergunta é pequeno por natureza.
          ARRAY_AGG(DISTINCT option IGNORE NULLS ORDER BY option) AS options,
          {weight}                        AS responses,
          MIN(responded_at)               AS first_at,
          MAX(responded_at)               AS last_at
        FROM src
        GROUP BY creative_id
        {order}
        LIMIT {limit}
    """


def _rows_to_creatives(rows, token, dim_match_by_id):
    out = []
    for r in rows:
        name = r["creative_name"] or ""
        # Sem nome, o id é o rótulo — nunca uma string vazia na UI.
        display_name = name or str(r["creative_id"])
        row_token = r["short_token"]
        out.append({
            "creative_id": r["creative_id"],
            "creative_name": display_name,
            "short_token": row_token,
            "questions": list(r["questions"] or []),
            "options": list(r["options"] or [])[:MAX_OPTIONS_LISTED],
            "responses": int(r["responses"] or 0),
            "first_at": r["first_at"].isoformat() if r["first_at"] else None,
            "last_at": r["last_at"].isoformat() if r["last_at"] else None,
            "side": detect_side(name),
            # De onde veio a amarração com a campanha — a UI mostra a
            # diferença entre "a plataforma disse", "o nome sugere" e "é do
            # mesmo cliente". None = peça de outra campanha, que está na
            # lista pra ser achada pela busca, não pra ser sugerida.
            "match": (
                "short_token"
                if token and row_token and row_token.strip().upper() == token.upper()
                else "name"
                if token and (dim_match_by_id.get(r["creative_id"]) == "name" or token_in_name(name, token))
                else dim_match_by_id.get(r["creative_id"])  # "client" | None
                if token
                else None
            ),
        })
    return out


def _view_columns(view):
    """(short_token, responses, creative_name, question, session_id) — quais
    colunas opcionais a view expõe. Lido do schema uma vez por instância.
    Com a fonte materializada o contrato é fixo e nem precisa ler."""
    if materialized():
        return _MATERIALIZED_COLUMNS
    cached = _COLUMNS_CACHE.get(view)
    if cached is not None:
        return cached
    table = _client().get_table(view)
    names = {f.name for f in table.schema}
    missing = {"creative_id", "option", "responded_at"} - names
    if missing:
        raise NotConfigured(
            f"View {view} não tem as colunas obrigatórias: {', '.join(sorted(missing))}."
        )
    result = (
        "short_token" in names,
        "responses" in names,
        "creative_name" in names,
        "question" in names,
        "session_id" in names,
    )
    _COLUMNS_CACHE[view] = result
    return result


_COLUMNS_CACHE = {}


def fetch_results(creative_id, question=None, date_from=None, date_to=None, fresh=False):
    """
    Contagens por opção de UM criativo, no mesmo contrato do proxy do
    Typeform — `{type, counts, total, first_response_at, last_response_at}` —
    pra que o front trate as duas bases pelo mesmo caminho.

    `question` restringe a uma pergunta (um criativo pode ter mais de uma).
    Datas em 'YYYY-MM-DD' e interpretadas em BRT, como no Typeform: o admin
    digita pensando no fuso de Brasília e as duas bases precisam responder
    ao mesmo filtro, senão a soma compara períodos diferentes.

    `fresh` (só admin, via `refresh=true`) força um tick antes de ler. Falha
    dele não derruba a leitura: serve a tabela como está.
    """
    view = survey_view()
    if fresh and materialized():
        try:
            force_fresh()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[maxattention] refresh do admin não sincronizou: {e}")
    _ensure_fresh(budget_s=RESULTS_SYNC_BUDGET_S)
    _, has_responses_col, _, has_question_col, has_session_col = _view_columns(view)
    weight = _weight_expr(has_session_col, has_responses_col)

    where = ["creative_id = @creative_id"]
    params = [bigquery.ScalarQueryParameter("creative_id", "STRING", str(creative_id))]
    if question and has_question_col:
        where.append("question = @question")
        params.append(bigquery.ScalarQueryParameter("question", "STRING", str(question)))
    if re.match(r"^\d{4}-\d{2}-\d{2}$", date_from or ""):
        where.append("responded_at >= TIMESTAMP(@date_from, 'America/Sao_Paulo')")
        params.append(bigquery.ScalarQueryParameter("date_from", "STRING", f"{date_from} 00:00:00"))
    if re.match(r"^\d{4}-\d{2}-\d{2}$", date_to or ""):
        where.append("responded_at <= TIMESTAMP(@date_to, 'America/Sao_Paulo')")
        params.append(bigquery.ScalarQueryParameter("date_to", "STRING", f"{date_to} 23:59:59"))

    sql = f"""
        SELECT
          option,
          {weight}          AS n,
          MIN(responded_at) AS first_at,
          MAX(responded_at) AS last_at
        FROM {_source(view, with_dim=False)}
        WHERE {' AND '.join(where)}
        GROUP BY option
        ORDER BY n DESC
        LIMIT {MAX_OPTIONS + 1}
    """

    rows = list(_client().query(
        sql, job_config=_job_config(params, max_bytes=_read_max_bytes()),
    ).result())

    truncated = len(rows) > MAX_OPTIONS
    if truncated:
        rows = rows[:MAX_OPTIONS]
        logger.warning(
            f"[maxattention] criativo {creative_id} passou de {MAX_OPTIONS} opções distintas"
        )

    counts = Counter()
    first_at = None
    last_at = None
    for r in rows:
        label = (r["option"] or "").strip()
        if not label:
            continue
        counts[label] += int(r["n"] or 0)
        if r["first_at"] and (first_at is None or r["first_at"] < first_at):
            first_at = r["first_at"]
        if r["last_at"] and (last_at is None or r["last_at"] > last_at):
            last_at = r["last_at"]

    return {
        "type": "choice",
        "counts": dict(counts),
        "total": sum(counts.values()),
        "creative_id": str(creative_id),
        "question": question or None,
        "first_response_at": first_at.isoformat() if first_at else None,
        "last_response_at": last_at.isoformat() if last_at else None,
        "truncated": truncated,
        # Até quando a tabela materializada tem o lake copiado (None no modo
        # legado). É a idade real do dado — o cache de 5 min vem por cima.
        "synced_through": _synced_through_iso(),
        "sync_complete": bool(_SYNC_STATE["complete"]) if materialized() else True,
    }
