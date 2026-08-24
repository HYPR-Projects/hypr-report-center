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
MAX_BYTES_BILLED = str(32 * 1024 ** 3)  # 32 GiB de ESTIMATIVA

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


def _client():
    return bq_client.get_client()


def _job_config(params):
    return bigquery.QueryJobConfig(
        query_parameters=params,
        maximum_bytes_billed=MAX_BYTES_BILLED,
        # Cache de query do BigQuery: resultado idêntico dentro de 24h não
        # re-varre nem cobra. Some com o TTL do backend, é a segunda linha de
        # defesa quando o cache em memória da instância morre num cold start.
        use_query_cache=True,
    )


def list_creatives(short_token=None, days=DEFAULT_LOOKBACK_DAYS, limit=200):
    """
    Criativos com resposta de survey na janela, mais recentes primeiro.

    Com `short_token`, filtra pelos que pertencem àquela campanha — pela
    coluna quando a view a preenche, senão pela convenção de nome. Sem
    ele, devolve a janela inteira (o admin busca no dropdown).

    Devolve [{creative_id, creative_name, short_token, questions,
              responses, first_at, last_at, side, match}].
    """
    view = survey_view()
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

    where = ["responded_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)"]
    params = [bigquery.ScalarQueryParameter("days", "INT64", days)]
    if token:
        # Coluna quando existe, convenção de nome sempre — um criativo
        # nomeado certo não some só porque a view não amarra a campanha.
        clauses = []
        if has_name_col:
            clauses.append(r"REGEXP_CONTAINS(UPPER(creative_name), @token_re)")
            params.append(
                bigquery.ScalarQueryParameter(
                    "token_re", "STRING",
                    r"(^|[^A-Z0-9])" + re.escape(token.upper()) + r"([^A-Z0-9]|$)",
                )
            )
        if has_token_col:
            clauses.append("UPPER(short_token) = @token")
            params.append(bigquery.ScalarQueryParameter("token", "STRING", token.upper()))
        # Sem nome NEM coluna de token não há como filtrar por campanha — em
        # vez de devolver a base inteira fingindo que filtrou, devolve tudo da
        # janela e a UI deixa o admin escolher.
        if clauses:
            where.append("(" + " OR ".join(clauses) + ")")

    sql = f"""
        SELECT
          creative_id,
          {name_expr}                     AS creative_name,
          {token_expr}                    AS short_token,
          {questions_expr}                AS questions,
          {weight}                        AS responses,
          MIN(responded_at)               AS first_at,
          MAX(responded_at)               AS last_at
        FROM `{view}`
        WHERE {' AND '.join(where)}
        GROUP BY creative_id
        ORDER BY last_at DESC
        LIMIT {limit}
    """

    rows = _client().query(sql, job_config=_job_config(params)).result()

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
            "responses": int(r["responses"] or 0),
            "first_at": r["first_at"].isoformat() if r["first_at"] else None,
            "last_at": r["last_at"].isoformat() if r["last_at"] else None,
            "side": detect_side(name),
            # De onde veio a amarração com a campanha — a UI mostra a
            # diferença entre "a plataforma disse" e "o nome sugere".
            "match": (
                "short_token"
                if token and row_token and row_token.strip().upper() == token.upper()
                else "name" if token and token_in_name(name, token) else None
            ),
        })
    return out


def _view_columns(view):
    """(short_token, responses, creative_name, question, session_id) — quais
    colunas opcionais a view expõe. Lido do schema uma vez por instância."""
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
        FROM `{view}`
        WHERE {' AND '.join(where)}
        GROUP BY option
        ORDER BY n DESC
        LIMIT {MAX_OPTIONS + 1}
    """

    rows = list(_client().query(sql, job_config=_job_config(params)).result())

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
    }
