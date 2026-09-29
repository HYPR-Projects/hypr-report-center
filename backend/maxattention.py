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
BigQuery no MESMO projeto — `site-hypr.prod_analytics.creative_events_raw`,
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
# Quem lê o lake é só o sync, incremental a partir de uma marca d'água e em
# fatias de poucos dias — cada fatia estima só as partições dela, então o
# custo por rodada não cresce com o histórico.
#
# Quem roda o sync:
#   - o warmup do main.py (a cada 3h, horário comercial), com sobreposição de
#     1 dia pra pegar evento que chegou atrasado no lake;
#   - a própria leitura, quando a última rodada tem mais de
#     `MA_SURVEY_SYNC_MIN` (default 60) — best-effort: se o sync falhar, a
#     leitura serve o que já está na tabela e o erro vai pro log;
#   - `refresh=true` do admin, que força.
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

_SYNC_LOCK = threading.Lock()
# checked_at: monotonic da última vez que confirmamos frescor (evita ir ao
# BigQuery a cada leitura). synced_through: marca d'água conhecida.
_SYNC_STATE = {"checked_at": None, "synced_through": None}
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


def _source(view):
    """O que vai depois do FROM nas leituras: a view (modo legado) ou a tabela
    materializada com o MESMO contrato de colunas da view.

    Dedupe por event_id aqui, na leitura: MERGE só de INSERT pode rodar em
    paralelo entre instâncias, e duas rodadas simultâneas gravariam a mesma
    resposta duas vezes. A contagem por sessão distinta já absorveria isso,
    mas contagem certa não deveria depender de qual unidade está em uso. Na
    tabela pequena, função de janela custa nada."""
    if not materialized():
        return f"`{view}`"
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
          ran_at         TIMESTAMP
        )
        OPTIONS (description = "Marca d'água do sync de ma_survey_answers. Uma linha por fatia.");
    """).result()
    _TABLES_READY.add(answers)


def _synced_through():
    rows = list(_client().query(
        f"SELECT MAX(synced_through) AS t FROM `{_sync_log_table()}`",
        job_config=_job_config([], max_bytes=READ_MAX_BYTES_BILLED),
    ).result())
    return rows[0]["t"] if rows else None


def _backfill_start(now):
    """Primeira partição com dado no lake, pra o backfill não gastar dezenas
    de fatias em meses vazios. Metadata, não varredura. Sem permissão no
    INFORMATION_SCHEMA, cai na janela cheia — mais lento, mesmo resultado."""
    floor = now - timedelta(days=BACKFILL_DAYS)
    project, dataset, table = events_raw_table().split(".")
    try:
        rows = list(_client().query(
            f"""
            SELECT MIN(partition_id) AS p
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
        p = rows[0]["p"] if rows else None
        if p:
            first = datetime.strptime(p, "%Y%m%d").replace(tzinfo=timezone.utc)
            return max(floor, first)
    except Exception as e:  # noqa: BLE001 — otimização, não requisito
        logger.warning(f"[maxattention] INFORMATION_SCHEMA indisponível, backfill de {BACKFILL_DAYS} dias: {e}")
    return floor


def _merge_range(since, until):
    """Copia as respostas de [since, until) do lake pra tabela. Idempotente
    (casa por event_id), então sobreposição entre rodadas é segura.

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
    job = _client().query(sql, job_config=_job_config(params))
    job.result()
    return int(getattr(job, "num_dml_affected_rows", None) or 0)


def _log_sync(since, until, inserted):
    _client().query(
        f"""
        INSERT INTO `{_sync_log_table()}` (synced_from, synced_through, inserted, ran_at)
        VALUES (@since, @until, @inserted, CURRENT_TIMESTAMP())
        """,
        job_config=_job_config([
            bigquery.ScalarQueryParameter("since", "TIMESTAMP", since),
            bigquery.ScalarQueryParameter("until", "TIMESTAMP", until),
            bigquery.ScalarQueryParameter("inserted", "INT64", int(inserted)),
        ], max_bytes=READ_MAX_BYTES_BILLED),
    ).result()


def sync_answers(force=False, overlap=SYNC_OVERLAP, budget_s=SYNC_BUDGET_S, wait=True):
    """Traz o que chegou no lake desde a última rodada. Erro sobe.

    Devolve `{status, synced_through, inserted, chunks, complete}`:
      - status "fresh": nada a fazer (rodada recente, por esta ou outra
        instância — a marca d'água é compartilhada, está no BigQuery);
      - status "synced": rodou; `complete=False` quando o orçamento de tempo
        acabou antes de alcançar o agora (backfill longo) e a próxima rodada
        continua;
      - status "busy": `wait=False` e outra thread desta instância já está
        sincronizando — quem lê não fica na fila atrás de um backfill.
    """
    ttl = _sync_ttl_s()
    if not _SYNC_LOCK.acquire(blocking=wait):
        return {"status": "busy", "synced_through": _SYNC_STATE["synced_through"],
                "inserted": 0, "chunks": 0, "complete": False}
    try:
        return _sync_locked(force, overlap, budget_s, ttl)
    finally:
        _SYNC_LOCK.release()


def _sync_locked(force, overlap, budget_s, ttl):
    checked = _SYNC_STATE["checked_at"]
    if not force and checked is not None and (time.monotonic() - checked) < ttl:
        return {"status": "fresh", "synced_through": _SYNC_STATE["synced_through"],
                "inserted": 0, "chunks": 0, "complete": True}

    _ensure_tables()
    now = _now()
    through = _synced_through()
    if through is not None:
        _SYNC_STATE["synced_through"] = through
    if not force and through is not None and (now - through).total_seconds() < ttl:
        _SYNC_STATE.update(checked_at=time.monotonic(), synced_through=through)
        return {"status": "fresh", "synced_through": through,
                "inserted": 0, "chunks": 0, "complete": True}

    cur = _backfill_start(now) if through is None else through - overlap
    step = timedelta(days=SYNC_CHUNK_DAYS)
    t0 = time.monotonic()
    inserted = chunks = 0
    while cur < now:
        if chunks and (time.monotonic() - t0) > budget_s:
            break
        end = min(cur + step, now)
        try:
            n = _merge_range(cur, end)
        except Exception as e:  # noqa: BLE001 — só o teto é tratado
            if _is_bytes_limit_error(e) and step > timedelta(days=1):
                step = max(timedelta(days=1), step / 2)
                continue
            raise
        _log_sync(cur, end, n)
        inserted += n
        chunks += 1
        through = end if through is None or end > through else through
        cur = end

    complete = cur >= now
    if inserted:
        # O ramo amplo da listagem fica cacheado por horas; resposta nova
        # na tabela tem que aparecer nele sem esperar o TTL.
        _RECENT_CACHE.clear()
    _SYNC_STATE.update(checked_at=time.monotonic() if complete else None, synced_through=through)
    logger.info(
        f"[maxattention] sync: {inserted} respostas novas em {chunks} fatia(s), "
        f"até {through.isoformat() if through else '—'}{'' if complete else ' (parcial, continua na próxima)'}"
    )
    return {"status": "synced", "synced_through": through,
            "inserted": inserted, "chunks": chunks, "complete": complete}


def _ensure_fresh(force=False):
    """Sync best-effort pro caminho de LEITURA. Falha não derruba a leitura:
    a tabela ainda tem tudo até a última rodada boa, e dado de uma hora atrás
    é melhor que erro na tela do cliente. O que não dá pra servir é tabela que
    nunca recebeu uma rodada boa (não criada, ou backfill falhando): ela
    responderia "zero respostas" com cara de verdade. Aí o erro original
    sobe, que é o que explica o problema."""
    if not materialized():
        return None
    ready = answers_table() in _TABLES_READY
    try:
        # Tabela já conhecida: não espera sync de outra thread (serve o que
        # tem). Primeira leitura da instância: espera, porque pode ser o
        # backfill e a tabela ainda nem existir.
        return sync_answers(force=force, wait=force or not ready)
    except Exception as e:  # noqa: BLE001
        if _SYNC_STATE["synced_through"] is None:
            raise
        logger.warning(f"[maxattention] sync falhou, servindo a tabela como está: {e}")
        return None


def _synced_through_iso():
    t = _SYNC_STATE["synced_through"] if materialized() else None
    return t.isoformat() if t else None


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
            "reason": "no_responses",
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
        rows = list(_client().query(
            sql, job_config=_job_config(params, max_bytes=_read_max_bytes()),
        ).result())
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

    # Diagnóstico da CAMPANHA, mesmo com a lista ampla cheia: o admin precisa
    # saber por que nenhuma peça foi marcada como sendo desta campanha —
    # dimensão vazia é uma coisa (cron da plataforma), nome fora da convenção
    # é outra (quem criou a peça), peça sem resposta é uma terceira (coleta).
    if not dim_matched:
        stats = _dim_stats()
        reason = "dim_empty" if stats["rows"] == 0 else "no_dim_match"
        return _payload(out, {
            "reason": reason,
            "dim_rows": stats["rows"],
            "dim_synced_at": stats["synced_at"],
            "dim_matched": 0,
            "dim_names": [],
        })
    if not any(c["creative_id"] in id_set for c in out):
        names = sorted({c["creative_name"] for c in dim_matched if c["creative_name"]})
        return _payload(out, {
            "reason": "no_responses",
            "dim_rows": None,
            "dim_synced_at": None,
            "dim_matched": len(dim_matched),
            "dim_names": names[:MAX_DIAG_NAMES],
        })
    return _payload(out)


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


def fetch_results(creative_id, question=None, date_from=None, date_to=None):
    """
    Contagens por opção de UM criativo, no mesmo contrato do proxy do
    Typeform — `{type, counts, total, first_response_at, last_response_at}` —
    pra que o front trate as duas bases pelo mesmo caminho.

    `question` restringe a uma pergunta (um criativo pode ter mais de uma).
    Datas em 'YYYY-MM-DD' e interpretadas em BRT, como no Typeform: o admin
    digita pensando no fuso de Brasília e as duas bases precisam responder
    ao mesmo filtro, senão a soma compara períodos diferentes.
    """
    view = survey_view()
    _ensure_fresh()
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
        FROM {_source(view)}
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
    }
