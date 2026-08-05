"""
Report owners — quem é responsável por cada report.

Modelo
------
Cada report tem dois owners HYPR:
  • CP (Commercial Person) — vendedor da conta.
  • CS (Customer Success)  — operador do report.

Os owners vêm de duas fontes, na ordem de precedência:

  1. Override manual (tabela `prod_assets.report_owners_overrides`)
     — admin clicou "Gerenciar Owner" no card e definiu manualmente.

  2. Lookup automático (primeira aba da planilha de De-Para Comercial,
     lida via Google Sheets API).
     — match por `client_name` (case-insensitive). Se houver múltiplos
     registros para o mesmo cliente (mesma cliente atendida por agências
     diferentes), o lookup retorna os emails apenas se forem TODOS iguais
     entre as linhas; do contrário, retorna NULL e cabe ao admin definir
     manualmente o override.

A segunda aba da planilha expõe a lista oficial de membros HYPR (CPs e
CSs com emails) para popular dropdowns no frontend.

Decisão de arquitetura
----------------------
Usamos Google Sheets API direto em vez de BigQuery external tables porque:
  • External tables exigem nome exato da aba (range "Sheet1!A:F"). A
    planilha está em PT-BR e usa "Página1"/"Página2" — nome que muda se
    alguém criar nova aba ou traduzir.
  • A Sheets API permite ler aba por ÍNDICE (primeira, segunda) — robusto
    contra rename. Pegamos os nomes das abas via spreadsheets.get e usamos
    pra montar os ranges.
  • Latência: ~150ms por request, mitigada por cache TTL de 60s.
  • Volume: ~280 linhas no lookup, ~11 no team. Cabe em memória.

Privacidade
-----------
Owners são dados internos da HYPR. Os endpoints expostos para clientes
(/report/<token>) NUNCA retornam emails de owner. Apenas o endpoint
admin `?list=true` (já protegido por JWT) traz essa informação.
"""

import logging
import os
import re
import time
import unicodedata
from typing import Dict, List, Optional, Tuple
import httplib2
import google_auth_httplib2
from google.cloud import bigquery

import bq_client
from google.auth import default as google_auth_default
from googleapiclient.discovery import build as build_google_api


logger = logging.getLogger(__name__)


PROJECT_ID = os.environ.get("GCP_PROJECT", "site-hypr")
DATASET    = "prod_assets"
SHEET_ID   = "1nd6UtJJ5fA81D9VZRiH2ZJGHYsiiv28LPzXhNRtd2aM"

# Tabelas físicas que mantemos no BigQuery
TABLE_OVERRIDES = "report_owners_overrides"   # override manual de owner por short_token
TABLE_ALIASES   = "client_aliases"            # apelido → nome canônico (lookup fuzzy)


# ─── Normalização de client_name ─────────────────────────────────────────────
# Usada em duas pontas do match de owner:
#   1. Ao montar o dict de lookup vindo da planilha (key = nome normalizado)
#   2. Ao bater cada campaign.client_name contra esse dict
# Empata "LOREAL" com "L'Oréal" e "BOTICARIO" com "O Boticário" sem precisar
# de tabela manual. Casos onde a normalização não basta (ex: "RD" =
# "Raia Drogasil") ficam pra `client_aliases`.
_ARTICLE_PREFIX_RE = re.compile(r"^(o|a|os|as|the)\s+")
_BIZ_SUFFIX_RE     = re.compile(r"\s+(ltda|s\s*a|me|epp|eireli|inc|llc)\s*$")
_QUOTE_CHARS_RE    = re.compile(r"[‘’“”'`\"]")
_NON_ALNUM_RE      = re.compile(r"[^a-z0-9]+")
_MULTI_SPACE_RE    = re.compile(r"\s+")


def normalize_client_name(name: str) -> str:
    """Normalização agressiva pra match de cliente entre fontes diferentes.

    Regras (ordem importa):
      1. Remove aspas/apóstrofos sem deixar espaço (L'Oréal → LOreal, não L Oreal).
      2. NFKD + drop diacríticos (Boticário → Boticario, Itaú → Itau).
      3. lowercase.
      4. Qualquer não-alfanumérico vira espaço (& . - / etc.).
      5. Remove artigo PT-BR no início ("o ", "a ", "os ", "as ", "the ").
      6. Remove sufixo corporativo no fim (" ltda", " sa", " me", " epp"...).
      7. Colapsa espaços múltiplos.

    Exemplos:
      "L'Oréal"           → "loreal"
      "LOREAL"            → "loreal"
      "O Boticário"       → "boticario"
      "BOTICARIO"         → "boticario"
      "Casas Bahia S.A."  → "casas bahia"
      "Itaú Unibanco"     → "itau unibanco"
      ""                  → ""

    Não removo espaços internos de propósito: evita falso positivo entre
    nomes que têm prefixo igual (ex: "Real Madrid" vs "RealMadrid" são raros;
    pra esses casos o admin cria alias manual).
    """
    if not name:
        return ""
    s = name.strip()
    s = _QUOTE_CHARS_RE.sub("", s)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = _NON_ALNUM_RE.sub(" ", s)
    s = _MULTI_SPACE_RE.sub(" ", s).strip()
    s = _ARTICLE_PREFIX_RE.sub("", s)
    s = _BIZ_SUFFIX_RE.sub("", s)
    s = _MULTI_SPACE_RE.sub(" ", s).strip()
    return s

# Cache global da planilha. Estrutura: {"data": dict | None, "ts": float}
#
# CACHE_TTL alto (5 min) porque a planilha de De-Para Comercial muda raras
# vezes por dia. Reduz exposição ao caminho de leitura remota — onde mora a
# falha intermitente que sumiu owners do menu admin.
#
# CACHE_STALE_MAX é o teto de aceitação do fallback "stale-while-error":
# se a Sheets API falhar e tivermos cache mais velho que isso, ainda assim
# servimos o stale (1h) em vez de dict vazio. Servir owner ligeiramente
# desatualizado é muito menos ruim que sumir avatares de toda a tela.
CACHE_TTL        = 300       # 5 min — vida útil do cache "fresco"
CACHE_STALE_MAX  = 3600      # 1h   — teto pra servir stale em caso de erro
SHEETS_RETRIES   = 1         # nº de retries antes de declarar falha
SHEETS_BACKOFF_S = 0.2       # espera entre retries
# Socket timeout da Sheets API. Baixo de propósito: com 2 tentativas o pior caso
# é ~20s, e o fallback (cache stale de até 1h) cobre bem. Sem ele o httplib2 fica
# sem deadline nenhum — ver o docstring de _sheets_client().
SHEETS_TIMEOUT_S = 10
_sheet_cache: Dict[str, object] = {"data": None, "ts": 0.0}

# Client compartilhado: timeout obrigatório em toda query + pool HTTP
# dimensionado pro paralelismo real. Ver bq_client.py.
bq = bq_client.get_client()


def _full(table_name: str) -> str:
    return f"`{PROJECT_ID}.{DATASET}.{table_name}`"


def _sheets_client():
    """Cliente da Sheets API autenticado via Application Default Credentials.

    Na Cloud Function, ADC é a service account de runtime
    (453955675457-compute@developer.gserviceaccount.com), que já tem a
    planilha compartilhada. Não precisamos de JSON key.

    TIMEOUT OBRIGATÓRIO
    -------------------
    `build_google_api(credentials=...)` monta um `httplib2.Http()` default, que
    NÃO tem socket timeout — um `.execute()` pode ficar pendurado pra sempre.
    Isso é veneno: esta função roda no caminho quente de `?list=true` (planilha
    de De-Para dos owners), dentro de uma task de pool. Em 04/08 uma chamada
    presa aqui foi um dos vetores que travou a instância inteira por 16h (os
    logs mostravam "httplib2 transport does not support per-request timeout"
    segundos antes do primeiro 504).

    Passar `http=` explícito com `httplib2.Http(timeout=...)` resolve na raiz:
    o socket estoura, `execute()` levanta, e as camadas de retry + stale-cache
    abaixo absorvem. Como o `AuthorizedHttp` já carrega a credencial, `build()`
    não recebe `credentials` (os dois parâmetros são mutuamente exclusivos).
    """
    creds, _ = google_auth_default(
        scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"]
    )
    authed_http = google_auth_httplib2.AuthorizedHttp(
        creds, http=httplib2.Http(timeout=SHEETS_TIMEOUT_S)
    )
    return build_google_api("sheets", "v4", http=authed_http, cache_discovery=False)


def _fetch_sheet_data_remote() -> dict:
    """Faz a leitura efetiva da Google Sheets API. Sem cache, sem retry —
    é o "trabalho cru" chamado por `_load_sheet_data`. Pode levantar.
    """
    svc = _sheets_client().spreadsheets()

    # 1) Descobre os nomes das abas pra montar ranges robustos
    meta = svc.get(spreadsheetId=SHEET_ID, fields="sheets.properties.title").execute()
    sheets = meta.get("sheets", [])
    if len(sheets) < 2:
        raise RuntimeError(
            f"Planilha precisa ter pelo menos 2 abas (lookup + team), "
            f"encontradas: {len(sheets)}"
        )
    name_lookup = sheets[0]["properties"]["title"]
    name_team   = sheets[1]["properties"]["title"]

    # 2) Lê os ranges. Usamos ranges generosos (A:F / A:D) — o Sheets corta
    #    automaticamente nas linhas com dado.
    resp = svc.values().batchGet(
        spreadsheetId=SHEET_ID,
        ranges=[f"'{name_lookup}'!A:F", f"'{name_team}'!A:D"],
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()

    value_ranges = resp.get("valueRanges", [])
    lookup_raw = value_ranges[0].get("values", []) if len(value_ranges) > 0 else []
    team_raw   = value_ranges[1].get("values", []) if len(value_ranges) > 1 else []

    # Pula header (primeira linha)
    lookup_rows = lookup_raw[1:] if lookup_raw else []
    team_rows   = team_raw[1:]   if team_raw   else []

    return {
        "lookup_rows": lookup_rows,
        "team_rows":   team_rows,
        "sheet_names": [name_lookup, name_team],
    }


def _load_sheet_data() -> dict:
    """Lê as duas primeiras abas da planilha (por ÍNDICE, não por nome).

    Retorna dict com:
      - "lookup_rows": lista de listas (linhas da aba 1, sem header)
      - "team_rows":   lista de listas (linhas da aba 2, sem header)
      - "sheet_names": [nome_aba1, nome_aba2] (debug/log)

    Camadas de defesa, em ordem:
      1. Cache fresco (idade <= CACHE_TTL): devolve direto.
      2. Leitura remota com retry (`SHEETS_RETRIES` tentativas, backoff
         curto). Cobre blips transitórios da Sheets API (timeouts, 5xx,
         rate-limit ocasional).
      3. Stale-while-error: se a leitura remota falhar mas tivermos cache
         antigo (idade <= CACHE_STALE_MAX), devolvemos o stale e logamos.
         Owners ligeiramente velhos > avatares sumidos.
      4. Sem cache utilizável: levanta. O caller (`get_owners_lookup_dict`)
         já trata isso retornando dict vazio sem quebrar a request.

    Cloud Functions de 2ª geração mantêm processo entre invocações, então
    o cache persiste entre requests da mesma instância. Múltiplas
    instâncias têm caches independentes — daí o sintoma "F5 às vezes
    resolve" antes desse fix.
    """
    now = time.time()
    cached = _sheet_cache.get("data")
    cached_ts = float(_sheet_cache.get("ts") or 0.0)

    # 1) Cache fresco
    if cached and (now - cached_ts) < CACHE_TTL:
        return cached  # type: ignore

    # 2) Leitura remota com retry
    last_exc: Optional[Exception] = None
    for attempt in range(SHEETS_RETRIES + 1):
        try:
            data = _fetch_sheet_data_remote()
            _sheet_cache["data"] = data
            _sheet_cache["ts"]   = now
            return data
        except Exception as e:
            last_exc = e
            if attempt < SHEETS_RETRIES:
                time.sleep(SHEETS_BACKOFF_S)
            else:
                break

    # 3) Stale-while-error
    if cached and (now - cached_ts) < CACHE_STALE_MAX:
        age = int(now - cached_ts)
        logger.warning(
            f"[owners] sheets fetch falhou após {SHEETS_RETRIES + 1} tentativas, "
            f"servindo stale cache (idade={age}s). Erro: {last_exc}"
        )
        return cached  # type: ignore

    # 4) Sem cache utilizável — propaga
    logger.error(f"[owners] sheets fetch falhou e não há cache stale válido. Erro: {last_exc}")
    raise last_exc if last_exc else RuntimeError("sheets fetch falhou")


def invalidate_cache() -> None:
    """Força a próxima leitura a ir até a planilha. Útil pra testes ou se
    o admin quer garantir dado fresco depois de editar o Sheet."""
    _sheet_cache["data"] = None
    _sheet_cache["ts"]   = 0.0


# ─── Setup de schema (apenas tabela física de overrides) ─────────────────────
def setup_schema() -> dict:
    """Cria a tabela física de overrides se não existir.

    Não há mais external tables — a leitura da planilha é feita via Sheets
    API direto em runtime. Mantemos esse endpoint só pra inicializar o BQ
    quando o backend é deployado pela primeira vez num projeto novo.
    """
    results: dict = {}
    sql_overrides = f"""
        CREATE TABLE IF NOT EXISTS {_full(TABLE_OVERRIDES)} (
            short_token  STRING NOT NULL,
            cp_email     STRING,
            cs_email     STRING,
            updated_by   STRING,
            updated_at   TIMESTAMP
        )
    """
    try:
        bq.query(sql_overrides).result()
        results["overrides"] = "ok"
    except Exception as e:
        results["overrides"] = f"erro: {e}"

    # Aproveita pra validar que a planilha está acessível e devolver os
    # nomes das abas detectados (debug).
    try:
        data = _load_sheet_data()
        results["sheet_access"] = "ok"
        results["sheet_names"]  = data["sheet_names"]
        results["lookup_rows"]  = len(data["lookup_rows"])
        results["team_rows"]    = len(data["team_rows"])
    except Exception as e:
        results["sheet_access"] = f"erro: {e}"

    return results


# ─── Queries de leitura ──────────────────────────────────────────────────────
def list_team_members() -> dict:
    """Lê a segunda aba da planilha e devolve as listas únicas de CPs e CSs.

    Estrutura da aba: CP | Email CP | CS | Email CS

    Linhas inválidas (sem email, "Greenfield", "#N/A") são filtradas — não
    fazem sentido como atribuíveis. Greenfield é registrado como conta sem
    CP/CS designado e não é uma pessoa que possa "ser owner".

    Retorna: {"cps": [{name, email}], "css": [{name, email}]}
    """
    data = _load_sheet_data()
    rows = data["team_rows"]

    cps_seen: Dict[str, str] = {}  # email_lower → name
    css_seen: Dict[str, str] = {}

    for row in rows:
        # Garante 4 colunas
        cells = (list(row) + ["", "", "", ""])[:4]
        cp_name, cp_email, cs_name, cs_email = (str(c).strip() for c in cells)

        if cp_email and cp_email.lower().endswith("@hypr.mobi"):
            key = cp_email.lower()
            if key not in cps_seen:
                cps_seen[key] = cp_name or cp_email.split("@")[0]

        if cs_email and cs_email.lower().endswith("@hypr.mobi"):
            key = cs_email.lower()
            if key not in css_seen:
                css_seen[key] = cs_name or cs_email.split("@")[0]

    cps = sorted(
        [{"name": n, "email": e} for e, n in cps_seen.items()],
        key=lambda x: x["name"].lower(),
    )
    css = sorted(
        [{"name": n, "email": e} for e, n in css_seen.items()],
        key=lambda x: x["name"].lower(),
    )
    return {"cps": cps, "css": css}


def get_owners_lookup_dict() -> Dict[str, Tuple[Optional[str], Optional[str]]]:
    """Lê a primeira aba e monta dict de lookup por client_name normalizado.

    Estrutura da aba: Agência | Cliente | CP ATUAL | Email CP | CS Atual | Email CS

    Chaveamos por `normalize_client_name(client)` em vez do nome cru
    lowercased — assim "L'Oréal" e "LOREAL" colidem na mesma key e o
    admin não precisa cadastrar duas linhas idênticas na planilha.

    Lógica de agregação quando o mesmo cliente aparece em múltiplas linhas
    (atendido por agências diferentes): só retornamos email se todas as
    linhas concordarem. Se houver divergência, retornamos None — o admin
    precisa criar override manual. Isso evita atribuir owner errado.

    Retorna: {client_name_normalized: (cp_email_or_none, cs_email_or_none)}
    """
    data = _load_sheet_data()
    rows = data["lookup_rows"]

    # Agrega CPs e CSs por cliente normalizado
    by_client: Dict[str, Dict[str, set]] = {}
    for row in rows:
        cells = (list(row) + ["", "", "", "", "", ""])[:6]
        _agency, client, _cp_name, cp_email, _cs_name, cs_email = (str(c).strip() for c in cells)

        key = normalize_client_name(client)
        if not key:
            continue
        bucket = by_client.setdefault(key, {"cp": set(), "cs": set()})

        cp_lower = cp_email.lower() if cp_email else ""
        if cp_lower.endswith("@hypr.mobi"):
            bucket["cp"].add(cp_lower)

        cs_lower = cs_email.lower() if cs_email else ""
        if cs_lower.endswith("@hypr.mobi"):
            bucket["cs"].add(cs_lower)

    # Resolve: só atribui se houver consenso (1 email único)
    result: Dict[str, Tuple[Optional[str], Optional[str]]] = {}
    for key, bucket in by_client.items():
        cp = next(iter(bucket["cp"])) if len(bucket["cp"]) == 1 else None
        cs = next(iter(bucket["cs"])) if len(bucket["cs"]) == 1 else None
        result[key] = (cp, cs)
    return result


# ─── Aliases manuais (BQ table) ──────────────────────────────────────────────
# Quando a normalização não basta (ex: "RD" deve bater "Raia Drogasil"),
# o admin cadastra manualmente um alias. Ambos os lados são guardados na
# forma cru (pra exibir) e normalizada (pra match O(1)).
_aliases_table_ready = False


def _ensure_aliases_table() -> None:
    """Cria a tabela de aliases se não existir. Idempotente, lazy-init."""
    global _aliases_table_ready
    if _aliases_table_ready:
        return
    sql = f"""
        CREATE TABLE IF NOT EXISTS {_full(TABLE_ALIASES)} (
            alias_normalized      STRING NOT NULL,
            canonical_normalized  STRING NOT NULL,
            alias_raw             STRING,
            canonical_raw         STRING,
            updated_by            STRING,
            updated_at            TIMESTAMP
        )
    """
    bq.query(sql).result()
    _aliases_table_ready = True


def get_aliases_dict() -> Dict[str, str]:
    """Retorna {alias_normalized: canonical_normalized}.

    Resiliente: se a tabela ainda não existe (primeiro deploy), retorna
    dict vazio em vez de levantar — caller continua com match só por
    normalização.
    """
    sql = f"""
        SELECT alias_normalized, canonical_normalized
        FROM {_full(TABLE_ALIASES)}
    """
    try:
        rows = list(bq.query(sql).result())
    except Exception as e:
        logger.warning(f"[WARN get_aliases_dict] {e}")
        return {}
    return {r["alias_normalized"]: r["canonical_normalized"] for r in rows}


def list_aliases() -> List[dict]:
    """Lista de aliases pra UI: [{alias_raw, canonical_raw, alias_normalized,
    canonical_normalized, updated_by, updated_at_iso}, ...] ordenada por
    canonical_raw asc.
    """
    sql = f"""
        SELECT alias_normalized, canonical_normalized, alias_raw, canonical_raw,
               updated_by, updated_at
        FROM {_full(TABLE_ALIASES)}
        ORDER BY canonical_raw, alias_raw
    """
    try:
        rows = list(bq.query(sql).result())
    except Exception as e:
        logger.warning(f"[WARN list_aliases] {e}")
        return []
    out = []
    for r in rows:
        ts = r.get("updated_at")
        out.append({
            "alias_normalized":     r.get("alias_normalized"),
            "canonical_normalized": r.get("canonical_normalized"),
            "alias_raw":            r.get("alias_raw") or r.get("alias_normalized"),
            "canonical_raw":        r.get("canonical_raw") or r.get("canonical_normalized"),
            "updated_by":           r.get("updated_by"),
            "updated_at":           ts.isoformat() if ts else None,
        })
    return out


def save_alias(alias_raw: str, canonical_raw: str, updated_by: str) -> dict:
    """Upsert de alias. Normaliza ambos os lados antes de gravar.

    Retorna o dict da linha gravada (pra UI atualizar a tabela sem refetch).
    Levanta ValueError se algum dos lados normaliza pra string vazia
    (entrada inválida) ou se alias == canonical (no-op disfarçado).
    """
    _ensure_aliases_table()

    alias_n     = normalize_client_name(alias_raw)
    canonical_n = normalize_client_name(canonical_raw)

    if not alias_n or not canonical_n:
        raise ValueError("Alias e canonical não podem ser vazios após normalização.")
    if alias_n == canonical_n:
        raise ValueError("Alias e canonical são equivalentes após normalização — não precisa de mapeamento.")

    sql = f"""
        MERGE {_full(TABLE_ALIASES)} T
        USING (SELECT @alias_n AS alias_normalized) S
        ON T.alias_normalized = S.alias_normalized
        WHEN MATCHED THEN UPDATE SET
            canonical_normalized = @canonical_n,
            alias_raw            = @alias_raw,
            canonical_raw        = @canonical_raw,
            updated_by           = @by,
            updated_at           = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT
            (alias_normalized, canonical_normalized, alias_raw, canonical_raw, updated_by, updated_at)
            VALUES (@alias_n, @canonical_n, @alias_raw, @canonical_raw, @by, CURRENT_TIMESTAMP())
    """
    bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("alias_n",       "STRING", alias_n),
            bigquery.ScalarQueryParameter("canonical_n",   "STRING", canonical_n),
            bigquery.ScalarQueryParameter("alias_raw",     "STRING", alias_raw.strip()),
            bigquery.ScalarQueryParameter("canonical_raw", "STRING", canonical_raw.strip()),
            bigquery.ScalarQueryParameter("by",            "STRING", updated_by),
        ]
    )).result()

    return {
        "alias_normalized":     alias_n,
        "canonical_normalized": canonical_n,
        "alias_raw":            alias_raw.strip(),
        "canonical_raw":        canonical_raw.strip(),
        "updated_by":           updated_by,
    }


def delete_alias(alias_raw: str) -> None:
    """Remove o alias pelo seu valor normalizado."""
    _ensure_aliases_table()
    alias_n = normalize_client_name(alias_raw)
    if not alias_n:
        return
    sql = f"DELETE FROM {_full(TABLE_ALIASES)} WHERE alias_normalized = @a"
    bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("a", "STRING", alias_n)]
    )).result()


def resolve_owner_for_client(
    client_name: str,
    lookup: Dict[str, Tuple[Optional[str], Optional[str]]],
    aliases: Dict[str, str],
) -> Tuple[Optional[str], Optional[str]]:
    """Pipeline canônico de match: normaliza → resolve alias → busca lookup.

    Caller tem 3 dicts em mãos (overrides, lookup, aliases) e aplica nessa
    ordem. Esta função cuida dos passos 2-3 (normalize+alias+lookup); o
    override fica fora porque é chaveado por short_token, não por nome.

    Fallback "sem espaços": se o match direto falha, comprime espaços dos
    dois lados e tenta de novo. Cobre casos onde uma fonte escreve o nome
    colado (BQ: "GENERALMOTORS", "BANCOBV") e a outra com espaço (planilha:
    "General Motors", "Banco BV"). Só vale com match único — se duas
    entradas distintas no lookup compactam pro mesmo nome, retorna None
    (admin desambigua via alias explícito).
    """
    n = normalize_client_name(client_name or "")
    if not n:
        return (None, None)
    canonical = aliases.get(n, n)

    # 1. Match direto pela chave normalizada.
    direct = lookup.get(canonical)
    if direct is not None:
        return direct

    # 2. Fallback "compact" (sem espaços). O(N) pelo lookup mas N ~300, custo
    #    irrelevante (<1ms por chamada). Não pré-computamos índice porque
    #    isso aqui só roda no fallback — match direto cobre 90%+ dos casos.
    target = canonical.replace(" ", "")
    if target:
        matches = [k for k in lookup if k.replace(" ", "") == target]
        if len(matches) == 1:
            return lookup[matches[0]]

    return (None, None)


def get_overrides_dict() -> Dict[str, Tuple[Optional[str], Optional[str]]]:
    """Lê a tabela física de overrides e devolve dict por short_token.

    Retorna: {short_token: (cp_email_or_none, cs_email_or_none)}

    Resiliente: se a tabela ainda não existe (primeiro deploy, antes do
    setup_schema), retorna dict vazio em vez de levantar.
    """
    sql = f"""
        SELECT short_token, cp_email, cs_email
        FROM {_full(TABLE_OVERRIDES)}
    """
    try:
        rows = list(bq.query(sql).result())
    except Exception as e:
        # Tabela não existe ainda? Loga e segue.
        logger.warning(f"[WARN get_overrides_dict] {e}")
        return {}

    return {
        r["short_token"]: (r.get("cp_email"), r.get("cs_email"))
        for r in rows
    }


def resolve_owners_for_campaigns(campaigns: List[dict]) -> None:
    """Mutação in-place: enriquece cada campaign dict com cp_email/cs_email.

    Faz uma única leitura da planilha, uma da tabela de overrides e uma
    da tabela de aliases, depois aplica o merge em Python. Muito mais
    rápido que JOIN no BigQuery quando temos só ~280 entries no lookup.

    Pipeline de match (override > alias+lookup > none):
      1. Override por short_token sempre vence.
      2. Caso contrário, normaliza client_name → resolve alias (se existir)
         → busca no lookup normalizado da planilha.
      3. Sem match em nenhuma fonte: deixa None (UI mostra "—").

    Cada campaign dict precisa ter `short_token` e `client_name`.
    """
    try:
        lookup = get_owners_lookup_dict()
    except Exception as e:
        logger.warning(f"[WARN resolve_owners] lookup falhou, sem auto-attrib: {e}")
        lookup = {}

    overrides = get_overrides_dict()
    aliases   = get_aliases_dict()

    for c in campaigns:
        token = c.get("short_token")

        ov_cp, ov_cs = overrides.get(token, (None, None))
        lk_cp, lk_cs = resolve_owner_for_client(c.get("client_name"), lookup, aliases)

        c["cp_email"] = ov_cp or lk_cp
        c["cs_email"] = ov_cs or lk_cs


# ─── Mutations (admin write) ─────────────────────────────────────────────────
# Flag de bootstrap: na primeira escrita, garantimos que a tabela de
# overrides exista. CREATE TABLE IF NOT EXISTS é idempotente e custa ~200ms
# só na primeira invocação por instância da Cloud Function. Depois, o flag
# evita a query repetida.
_overrides_table_ready = False


def _ensure_overrides_table() -> None:
    """Cria a tabela física de overrides se ainda não existe.

    Chamado em lazy init dentro de save_owner_override pra evitar dependência
    de um setup_schema explícito antes do primeiro save. Idempotente.
    """
    global _overrides_table_ready
    if _overrides_table_ready:
        return
    sql = f"""
        CREATE TABLE IF NOT EXISTS {_full(TABLE_OVERRIDES)} (
            short_token  STRING NOT NULL,
            cp_email     STRING,
            cs_email     STRING,
            updated_by   STRING,
            updated_at   TIMESTAMP
        )
    """
    bq.query(sql).result()
    _overrides_table_ready = True


def save_owner_override(short_token: str, cp_email: str, cs_email: str,
                         updated_by: str) -> None:
    """Upsert no override. cp_email ou cs_email vazios são tratados como
    "remover override deste campo" — quando ambos vazios e o registro
    já existe, deletamos a linha pra cair de volta no lookup automático.
    """
    _ensure_overrides_table()

    cp = cp_email.strip().lower() if cp_email else None
    cs = cs_email.strip().lower() if cs_email else None

    if not cp and not cs:
        # Limpar override → próxima leitura pega lookup
        sql = f"""
            DELETE FROM {_full(TABLE_OVERRIDES)}
            WHERE short_token = @t
        """
        bq.query(sql, job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("t", "STRING", short_token),
            ]
        )).result()
        return

    sql = f"""
        MERGE {_full(TABLE_OVERRIDES)} T
        USING (SELECT @t AS short_token) S
        ON T.short_token = S.short_token
        WHEN MATCHED THEN UPDATE SET
            cp_email   = @cp,
            cs_email   = @cs,
            updated_by = @by,
            updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT (short_token, cp_email, cs_email, updated_by, updated_at)
            VALUES (@t, @cp, @cs, @by, CURRENT_TIMESTAMP())
    """
    bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("t",  "STRING", short_token),
            bigquery.ScalarQueryParameter("cp", "STRING", cp),
            bigquery.ScalarQueryParameter("cs", "STRING", cs),
            bigquery.ScalarQueryParameter("by", "STRING", updated_by),
        ]
    )).result()
