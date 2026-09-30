"""
Testes das partes puras do leitor do Max Attention: validação da view
(entra direto no SQL, então o formato é conferido antes) e a convenção de
nome dos criativos, que é o que amarra criativo → campanha → lado quando
a plataforma não devolve short_token.
"""
import os

import pytest

import maxattention as ma


@pytest.mark.parametrize("session,responses,esperado", [
    # Sessão distinta ganha de tudo: é a unidade que o lift e o teste de
    # significância assumem (proporção de PESSOAS).
    (True,  True,  "COUNT(DISTINCT session_id)"),
    (True,  False, "COUNT(DISTINCT session_id)"),
    # Sem sessão, view já agregada manda.
    (False, True,  "SUM(COALESCE(responses, 1))"),
    # Sem nada, sobra contar evento — infla a base, mas é o que há.
    (False, False, "COUNT(*)"),
])
def test_unidade_de_contagem_prefere_sessao(session, responses, esperado):
    assert ma._weight_expr(session, responses) == esperado


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("MA_SURVEY_VIEW", raising=False)
    monkeypatch.delenv("MA_CREATIVES_DIM", raising=False)
    for k in ("MA_SURVEY_MATERIALIZE", "MA_SURVEY_ANSWERS_TABLE", "MA_EVENTS_RAW", "MA_SURVEY_SYNC_MIN",
              "MA_SURVEY_DAILY_GB", "MA_SURVEY_TICK_MAX_GB"):
        monkeypatch.delenv(k, raising=False)
    ma._COLUMNS_CACHE.clear()
    ma._RECENT_CACHE.clear()
    ma._TABLES_READY.clear()
    ma._SYNC_STATE.update(checked_at=None, synced_through=None)


def test_sem_env_a_falha_diz_o_que_configurar():
    assert ma.is_configured() is False
    with pytest.raises(ma.NotConfigured) as e:
        ma.survey_view()
    assert "MA_SURVEY_VIEW" in str(e.value)
    assert "creative_id" in str(e.value)


def test_view_valida_passa_e_perde_as_crases(monkeypatch):
    monkeypatch.setenv("MA_SURVEY_VIEW", "`site-hypr.prod_assets.ma_survey_responses`")
    assert ma.survey_view() == "site-hypr.prod_assets.ma_survey_responses"
    assert ma.is_configured() is True


@pytest.mark.parametrize("bad", [
    "prod_assets.ma_survey",                 # faltando projeto
    "site-hypr.prod_assets.v; DROP TABLE x", # injeção
    "site-hypr.prod_assets.v WHERE 1=1",
    "a.b.c.d",
    "  ",
])
def test_view_malformada_e_recusada(monkeypatch, bad):
    # O nome da tabela não pode ser parâmetro no BQ — ele é interpolado no
    # SQL. Então qualquer coisa fora de `projeto.dataset.view` para aqui.
    monkeypatch.setenv("MA_SURVEY_VIEW", bad)
    with pytest.raises(ma.NotConfigured):
        ma.survey_view()


@pytest.mark.parametrize("name,expected", [
    ("ID-FXR5US_HYPR_LOREAL_LA-ROCHE-POSAY_SURVEY_AWARENESS_CONTROLE", "controle"),
    ("ID-FXR5US_HYPR_LOREAL_LA-ROCHE-POSAY_SURVEY_AWARENESS_EXPOSTO", "exposto"),
    ("hypr_loreal_controle_abr26", "controle"),
    ("HYPR_LOREAL_AIRLICIUM_VIDEO-IN-DISPLAY_300x250", None),
    ("", None),
    (None, None),
])
def test_detect_side_le_a_convencao_de_nome(name, expected):
    assert ma.detect_side(name) == expected


def test_detect_side_nao_chuta_em_palavra_parecida():
    # "contrato"/"centro" não são "controle". Sugestão errada de lado custa
    # mais caro que sugestão nenhuma — o admin confirma na UI.
    assert ma.detect_side("HYPR_CONTRATO_LOREAL") is None
    assert ma.detect_side("HYPR_CENTRO_SP") is None


@pytest.mark.parametrize("name,token,expected", [
    ("ID-FXR5US_HYPR_LOREAL_SURVEY_CONTROLE", "FXR5US", True),
    ("ID-FXR5US_HYPR_LOREAL_SURVEY_CONTROLE", "fxr5us", True),
    ("ID-NZLDUV_HYPR_LOREAL_COR-E-TOM", "FXR5US", False),
    # Token só casa como palavra inteira — senão "FXR5U" acharia "FXR5US"
    # e o admin veria criativo de outra campanha no dropdown.
    ("ID-FXR5USX_HYPR_LOREAL", "FXR5US", False),
    ("qualquer coisa", "", False),
])
def test_token_in_name_casa_palavra_inteira(name, token, expected):
    assert ma.token_in_name(name, token) is expected


def test_dimensao_deriva_do_dataset_da_view(monkeypatch):
    # Uma env a menos pra configurar: a dimensão mora no mesmo dataset da
    # view, e é ela que resolve a campanha antes de tocar o lake.
    monkeypatch.setenv("MA_SURVEY_VIEW", "site-hypr.prod_analytics.ma_survey_responses")
    assert ma.creatives_dim_table() == "site-hypr.prod_analytics.creatives_dim"


def test_dimensao_aceita_override(monkeypatch):
    monkeypatch.setenv("MA_SURVEY_VIEW", "site-hypr.prod_analytics.ma_survey_responses")
    monkeypatch.setenv("MA_CREATIVES_DIM", "outro.dataset.criativos")
    assert ma.creatives_dim_table() == "outro.dataset.criativos"


def test_dimensao_override_malformado_e_recusado(monkeypatch):
    # Mesmo motivo da view: o nome entra interpolado no SQL.
    monkeypatch.setenv("MA_SURVEY_VIEW", "site-hypr.prod_analytics.ma_survey_responses")
    monkeypatch.setenv("MA_CREATIVES_DIM", "dataset.tabela; DROP TABLE x")
    with pytest.raises(ma.NotConfigured):
        ma.creatives_dim_table()


def test_janela_sem_campanha_e_curta():
    # Sem token não há como podar por creative_id (a chave LÍDER do cluster),
    # então o período é o que segura o custo.
    assert ma.UNSCOPED_LOOKBACK_DAYS <= 60
    assert ma.UNSCOPED_LOOKBACK_DAYS < ma.DEFAULT_LOOKBACK_DAYS


# ── Bypass de cache: a trava é o que protege a conta do BigQuery ────────────
#
# Teste estrutural (mesmo espírito do test_pool_isolation): `refresh=true` no
# `maxattention_results` existe pra conferência manual, e o endpoint é ABERTO
# — o report roda no navegador do cliente. Se o bypass perder a checagem de
# admin, cada pageview passa a poder virar query no BigQuery, que é
# exatamente o que o cache de 5 min existe pra evitar. A regressão é silenciosa
# (nada quebra, só a fatura sobe), então fica guardada aqui.

_MAIN_PY = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "main.py"
)


def _ma_results_handler_source():
    """Trecho do handler de `maxattention_results` em main.py."""
    with open(_MAIN_PY, encoding="utf-8") as f:
        source = f.read()
    start = source.index('request.args.get("action") == "maxattention_results"')
    end = source.index('action") == "typeform_proxy"', start)
    return source[start:end]


def test_bypass_de_cache_do_ma_results_e_admin_only():
    block = _ma_results_handler_source()
    assert '_ma_results_cache.pop' in block, (
        "o bypass de cache saiu do handler de maxattention_results"
    )
    # A condição que autoriza o pop tem que mencionar authenticate_admin.
    guard = block[: block.index("_ma_results_cache.pop")]
    condicao = guard.rsplit('if request.args.get("refresh")', 1)
    assert len(condicao) == 2, "o pop não está mais guardado por `refresh=true`"
    assert "authenticate_admin" in condicao[1], (
        "bypass de cache sem checagem de admin: um endpoint aberto passaria a "
        "aceitar query no BigQuery por pageview"
    )


# ── Lista vazia precisa dizer POR QUÊ ───────────────────────────────────────
#
# O caso real (campanha PPV8JF, set/2026): o modal abria, o backend respondia
# 200 com `[]`, e o admin via "Nenhum criativo encontrado" — sem saber se a
# dimensão não tinha carregado, se a peça fora nomeada fora da convenção ou
# se ninguém tinha respondido. Três causas, três responsáveis, um único
# sintoma. Estes testes fixam o contrato do diagnóstico que separa os três.

from datetime import datetime, timedelta, timezone


class _FakeJob:
    def __init__(self, rows):
        self._rows = rows

    def result(self):
        return list(self._rows)


class _FakeClient:
    """Despacha pelo SQL: dimensão (match por token), estatística da
    dimensão, e o lake (a view). Grava o que foi consultado pra o teste
    afirmar que o lake NÃO foi varrido quando não devia."""

    def __init__(self, dim_rows=(), dim_stats=None, lake_rows=(), campaign_rows=None):
        self.dim_rows = list(dim_rows)
        self.dim_stats = dim_stats or {"n": 0, "synced_at": None}
        # `lake_rows` alimenta o ramo AMPLO; `campaign_rows` o da campanha.
        # Sem `campaign_rows`, o ramo da campanha devolve as linhas de
        # `lake_rows` cujo creative_id está nos ids pedidos.
        self.lake_rows = list(lake_rows)
        self.campaign_rows = campaign_rows
        self.queries = []

    def query(self, sql, job_config=None):
        self.queries.append(sql)
        if "creatives_dim" in sql and "SELECT creative_id, creative_name, client_name" in sql:
            return _FakeJob([{"client_name": None, **r} for r in self.dim_rows])
        if "creatives_dim" in sql and "COUNT(*) AS n" in sql:
            return _FakeJob([self.dim_stats])
        if "creative_id IN UNNEST(@ids)" in sql:
            if self.campaign_rows is not None:
                return _FakeJob(self.campaign_rows)
            ids = set()
            if job_config is not None:
                for p in job_config.query_parameters:
                    if p.name == "ids":
                        ids = set(p.values)
            return _FakeJob([r for r in self.lake_rows if r["creative_id"] in ids])
        return _FakeJob(self.lake_rows)


@pytest.fixture
def ma_env(monkeypatch):
    monkeypatch.setenv("MA_SURVEY_VIEW", "site-hypr.prod_analytics.ma_survey_responses")
    # Os testes de listagem abaixo exercitam a lógica dos ramos sobre a view
    # (modo legado). A fonte materializada tem os testes dela no fim do arquivo.
    monkeypatch.setenv("MA_SURVEY_MATERIALIZE", "0")
    # (short_token, responses, creative_name, question, session_id)
    monkeypatch.setattr(ma, "_view_columns", lambda view: (True, False, True, True, True))


def _install(monkeypatch, client):
    monkeypatch.setattr(ma, "_client", lambda: client)
    return client


def test_dimensao_vazia_e_diagnosticada_e_a_lista_ampla_continua(ma_env, monkeypatch):
    client = _install(monkeypatch, _FakeClient(dim_rows=[], dim_stats={"n": 0, "synced_at": None}))
    p = ma.list_creatives_payload(short_token="PPV8JF")
    assert p["creatives"] == []
    assert p["scope"] == "campaign"
    assert p["includes_recent"] is True
    assert p["recent_days"] == ma.UNSCOPED_LOOKBACK_DAYS
    assert p["diagnostics"]["reason"] == "dim_empty"
    assert p["diagnostics"]["dim_rows"] == 0
    # Sem peça da campanha na dimensão, o lake ainda é consultado — pelo ramo
    # AMPLO (janela curta), sem o filtro de ids que não existe.
    lake = [q for q in client.queries if "ma_survey_responses" in q]
    assert len(lake) == 1                      # só o ramo amplo — campanha não tem ids
    assert "UNNEST(@ids)" not in lake[0]
    assert "@since_recent" in lake[0]
    # Corte de data como parâmetro TIMESTAMP constante, nunca CURRENT_TIMESTAMP:
    # é o que deixa a estimativa podar partição e passar no teto de bytes.
    assert "CURRENT_TIMESTAMP" not in lake[0]


def test_nome_fora_da_convencao_e_diagnosticado_com_estado_da_dimensao(ma_env, monkeypatch):
    synced = datetime(2026, 9, 21, 12, 30, tzinfo=timezone.utc)
    _install(monkeypatch, _FakeClient(dim_rows=[], dim_stats={"n": 412, "synced_at": synced}))
    p = ma.list_creatives_payload(short_token="PPV8JF")
    d = p["diagnostics"]
    assert d["reason"] == "no_dim_match"
    assert d["dim_rows"] == 412
    assert d["dim_synced_at"] == synced.isoformat()
    assert d["dim_matched"] == 0


def test_peca_existe_mas_nao_respondeu_lista_os_nomes(ma_env, monkeypatch):
    dim = [
        {"creative_id": "c1", "creative_name": "ID-PPV8JF_HYPR_DIAGEO_SELO_SURVEY_CONTROLE"},
        {"creative_id": "c2", "creative_name": "ID-PPV8JF_HYPR_DIAGEO_SELO_SURVEY_EXPOSTO"},
    ]
    now = datetime(2026, 9, 20, 10, 0, tzinfo=timezone.utc)
    outra = {
        "creative_id": "z9", "creative_name": "HYPR_NINTENDO_FY27_SURVEY_AWARENESS_CONTROLE",
        "short_token": None, "questions": [], "options": ["Sim", "Não"],
        "responses": 1023, "first_at": now, "last_at": now,
    }
    client = _install(monkeypatch, _FakeClient(dim_rows=dim, lake_rows=[outra]))
    p = ma.list_creatives_payload(short_token="PPV8JF")
    d = p["diagnostics"]
    assert d["reason"] == "no_responses"
    assert d["dim_matched"] == 2
    assert d["dim_names"] == sorted(c["creative_name"] for c in dim)
    # A lista ampla vem MESMO ASSIM — a peça de outra campanha está lá pra
    # ser achada pela busca, só não marcada como desta campanha.
    assert [c["creative_id"] for c in p["creatives"]] == ["z9"]
    assert p["creatives"][0]["match"] is None
    assert p["campaign_count"] == 0
    # Dois ramos, duas queries: campanha (podada pelos ids, janela longa) e
    # amplo (janela curta, cacheado e compartilhado entre campanhas).
    lake = [q for q in client.queries if "ma_survey_responses" in q]
    assert len(lake) == 2
    assert "creative_id IN UNNEST(@ids)" in lake[0] and "@since_campaign" in lake[0]
    assert "UNNEST(@ids)" not in lake[1] and "@since_recent" in lake[1]


def test_peca_da_campanha_vem_marcada_e_sem_diagnostico(ma_env, monkeypatch):
    now = datetime(2026, 9, 20, 10, 0, tzinfo=timezone.utc)
    dim = [{"creative_id": "c1", "creative_name": "ID-PPV8JF_HYPR_DIAGEO_SELO_SURVEY_CONTROLE"}]
    lake = [
        {
            "creative_id": "c1",
            "creative_name": "ID-PPV8JF_HYPR_DIAGEO_SELO_SURVEY_CONTROLE",
            "short_token": "PPV8JF",
            "questions": [],
            "options": ["Sim", "Não"],
            "responses": 265,
            "first_at": now,
            "last_at": now,
        },
        {
            "creative_id": "z9",
            "creative_name": "HYPR_NINTENDO_FY27_SURVEY_AWARENESS_CONTROLE",
            "short_token": None,
            "questions": [],
            "options": ["Sim", "Não"],
            "responses": 1023,
            "first_at": now,
            "last_at": now,
        },
    ]
    _install(monkeypatch, _FakeClient(dim_rows=dim, lake_rows=lake))
    p = ma.list_creatives_payload(short_token="PPV8JF")
    assert p["diagnostics"] is None
    assert p["campaign_count"] == 1
    assert len(p["creatives"]) == 2
    c1, z9 = p["creatives"]
    assert c1["match"] == "short_token" and c1["side"] == "controle" and c1["responses"] == 265
    assert z9["match"] is None
    # Compat: o wrapper antigo continua devolvendo só a lista.
    assert ma.list_creatives(short_token="PPV8JF") == p["creatives"]


def test_peca_da_campanha_sem_token_na_view_casa_pelo_id_da_dimensao(ma_env, monkeypatch):
    # A view deriva short_token só do prefixo "ID-TOKEN_"; a dimensão casa o
    # token em qualquer posição. Quem veio pelo id da dimensão é da campanha.
    now = datetime(2026, 9, 20, 10, 0, tzinfo=timezone.utc)
    dim = [{"creative_id": "c1", "creative_name": "HYPR_DIAGEO_PPV8JF_SELO_SURVEY_EXPOSTO"}]
    lake = [{
        "creative_id": "c1", "creative_name": "HYPR_DIAGEO_PPV8JF_SELO_SURVEY_EXPOSTO",
        "short_token": None, "questions": [], "options": [], "responses": 3,
        "first_at": now, "last_at": now,
    }]
    _install(monkeypatch, _FakeClient(dim_rows=dim, lake_rows=lake))
    p = ma.list_creatives_payload(short_token="PPV8JF")
    assert p["creatives"][0]["match"] == "name"
    assert p["campaign_count"] == 1


def test_sem_campanha_encolhe_a_janela_e_marca_o_escopo(ma_env, monkeypatch):
    client = _install(monkeypatch, _FakeClient(lake_rows=[]))
    p = ma.list_creatives_payload(short_token="", days=180)
    assert p["scope"] == "all"
    assert p["days"] == ma.UNSCOPED_LOOKBACK_DAYS
    assert p["recent_days"] == ma.UNSCOPED_LOOKBACK_DAYS
    # Sem campanha não há diagnóstico de dimensão: a pergunta é outra.
    assert p["diagnostics"] is None
    # E a dimensão nem é consultada — não há token pra casar.
    assert not any("creatives_dim" in q for q in client.queries)
    lake = [q for q in client.queries if "ma_survey_responses" in q]
    assert len(lake) == 1 and "UNNEST(@ids)" not in lake[0]


def test_dim_stats_degrada_sem_synced_at(ma_env, monkeypatch):
    class _Flaky(_FakeClient):
        def query(self, sql, job_config=None):
            self.queries.append(sql)
            if "MAX(synced_at)" in sql:
                raise RuntimeError("Unrecognized name: synced_at")
            if "COUNT(*) AS n" in sql:
                return _FakeJob([{"n": 7}])
            return _FakeJob([])

    _install(monkeypatch, _Flaky())
    assert ma._dim_stats() == {"rows": 7, "synced_at": None}


def test_cortes_de_data_sao_parametros_timestamp_constantes(ma_env, monkeypatch):
    # O teto de bytes é aplicado sobre a ESTIMATIVA, e a estimativa não poda
    # partição com CURRENT_TIMESTAMP(). Em produção o ramo amplo foi estimado
    # como a tabela inteira (36,5 GiB > 32) e o modal morreu com
    # bytesBilledLimitExceeded. Os cortes têm que chegar como TIMESTAMP.
    captured = {}

    class _Capture(_FakeClient):
        def query(self, sql, job_config=None):
            if "ma_survey_responses" in sql:
                captured.setdefault("params", {}).update({p.name: p for p in job_config.query_parameters})
                captured["sql"] = captured.get("sql", "") + sql
            return super().query(sql, job_config)

    fixed_now = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(ma, "_now", lambda: fixed_now)
    dim = [{"creative_id": "c1", "creative_name": "ID-PPV8JF_X_CONTROLE"}]
    _install(monkeypatch, _Capture(dim_rows=dim, lake_rows=[]))
    ma.list_creatives_payload(short_token="PPV8JF", days=180)

    assert "CURRENT_TIMESTAMP" not in captured["sql"]
    p = captured["params"]
    assert p["since_recent"].type_ == "TIMESTAMP"
    assert p["since_campaign"].type_ == "TIMESTAMP"
    assert p["since_recent"].value == fixed_now - timedelta(days=ma.UNSCOPED_LOOKBACK_DAYS)
    assert p["since_campaign"].value == fixed_now - timedelta(days=180)


def test_ramo_amplo_estourando_o_teto_degrada_pra_so_campanha(ma_env, monkeypatch):
    now = datetime(2026, 9, 20, 10, 0, tzinfo=timezone.utc)
    dim = [{"creative_id": "c1", "creative_name": "ID-PPV8JF_X_CONTROLE"}]
    lake = [{
        "creative_id": "c1", "creative_name": "ID-PPV8JF_X_CONTROLE", "short_token": "PPV8JF",
        "questions": [], "options": ["Sim"], "responses": 10, "first_at": now, "last_at": now,
    }]

    class _Capped(_FakeClient):
        def query(self, sql, job_config=None):
            if "ma_survey_responses" in sql and "@since_recent" in sql:
                self.queries.append(sql)
                raise RuntimeError(
                    "500 Query exceeded limit for bytes billed: 34359738368. "
                    "39253442560 or higher required.; reason: bytesBilledLimitExceeded"
                )
            return super().query(sql, job_config)

    client = _install(monkeypatch, _Capped(dim_rows=dim, lake_rows=lake))
    p = ma.list_creatives_payload(short_token="PPV8JF")
    # A campanha veio; o ramo amplo não, e o payload diz isso.
    assert [c["creative_id"] for c in p["creatives"]] == ["c1"]
    assert p["includes_recent"] is False
    assert p["recent_skipped"] == "bytes_limit"
    assert p["diagnostics"] is None
    lake = [q for q in client.queries if "ma_survey_responses" in q]
    assert len(lake) == 2
    assert "@since_campaign" in lake[0] and "@since_recent" in lake[1]


def test_outro_erro_do_bigquery_nao_e_engolido(ma_env, monkeypatch):
    class _Broken(_FakeClient):
        def query(self, sql, job_config=None):
            if "ma_survey_responses" in sql:
                raise RuntimeError("Access Denied: prod_analytics")
            return super().query(sql, job_config)

    _install(monkeypatch, _Broken(dim_rows=[{"creative_id": "c1", "creative_name": "ID-PPV8JF_X"}]))
    with pytest.raises(RuntimeError, match="Access Denied"):
        ma.list_creatives_payload(short_token="PPV8JF")


def test_sem_peca_da_campanha_e_teto_estourado_devolve_vazio_explicado(ma_env, monkeypatch):
    # O caso PPV8JF depois do primeiro deploy: zero peças na dimensão, o
    # único ramo era o amplo, e ele estourou o teto → 500 no modal. Agora:
    # lista vazia, diagnóstico da campanha e o aviso de que o amplo não veio.
    class _Capped(_FakeClient):
        def query(self, sql, job_config=None):
            if "ma_survey_responses" in sql:
                self.queries.append(sql)
                raise RuntimeError("reason: bytesBilledLimitExceeded, message: Query exceeded limit for bytes billed")
            return super().query(sql, job_config)

    _install(monkeypatch, _Capped(dim_rows=[], dim_stats={"n": 843, "synced_at": None}))
    p = ma.list_creatives_payload(short_token="PPV8JF")
    assert p["creatives"] == []
    assert p["includes_recent"] is False
    assert p["recent_skipped"] == "bytes_limit"
    assert p["diagnostics"]["reason"] == "no_dim_match"
    assert p["diagnostics"]["dim_rows"] == 843


# ── Vínculo pelo CLIENTE (o caso Nintendo) ──────────────────────────────────
#
# Campanha PS604Q, cliente Nintendo. As peças de survey existem e estão no
# ar — `HYPR_NINTENDO_FY27_SURVEY_..._CONTROLE` — mas sem o token no nome.
# Por token, a campanha não tinha lista; a busca ampla estourou o teto; o
# admin viu vazio com peça publicada na plataforma. O cliente da campanha é
# o vínculo que faltava.

@pytest.mark.parametrize("a,b,expected", [
    ("NINTENDO", "Nintendo", True),
    ("L'Oréal", "LOREAL", True),
    ("Diageo", "Diageo Brasil", True),
    ("Kenvue", "Nintendo", False),
    ("VW", "Volkswagen", False),      # curto demais pra containment
    ("", "Nintendo", False),
    (None, None, False),
])
def test_same_client_e_frouxo_mas_nao_chuta(a, b, expected):
    assert ma.same_client(a, b) is expected


def test_dimensao_casa_por_token_ou_por_cliente_e_ordena_token_primeiro(ma_env, monkeypatch):
    dim = [
        {"creative_id": "n1", "creative_name": "HYPR_NINTENDO_FY27_SURVEY_AWARENESS_CORE_CONTROLE", "client_name": "Nintendo"},
        {"creative_id": "n2", "creative_name": "HYPR_NINTENDO_FY27_SURVEY_AWARENESS_CORE_EXPOSTO", "client_name": "Nintendo"},
        {"creative_id": "t1", "creative_name": "ID-PS604Q_HYPR_NINTENDO_X", "client_name": None},
        {"creative_id": "o1", "creative_name": "HYPR_BOTICARIO_GLAMOUR_SURVEY", "client_name": "Boticário"},
    ]

    class _Dim(_FakeClient):
        def query(self, sql, job_config=None):
            if "creatives_dim" in sql and "client_name" in sql:
                self.queries.append(sql)
                return _FakeJob(dim)
            return super().query(sql, job_config)

    _install(monkeypatch, _Dim())
    got = ma._dim_creatives_for_token("PS604Q", client_name="NINTENDO")
    assert [(c["creative_id"], c["match"]) for c in got] == [
        ("t1", "name"), ("n1", "client"), ("n2", "client"),
    ]


def test_sem_token_no_nome_a_campanha_acha_as_pecas_pelo_cliente(ma_env, monkeypatch):
    now = datetime(2026, 9, 20, 10, 0, tzinfo=timezone.utc)
    dim = [
        {"creative_id": "n1", "creative_name": "HYPR_NINTENDO_FY27_SURVEY_AWARENESS_CORE_CONTROLE", "client_name": "Nintendo"},
        {"creative_id": "n2", "creative_name": "HYPR_NINTENDO_FY27_SURVEY_AWARENESS_CORE_EXPOSTO", "client_name": "Nintendo"},
    ]
    lake = [
        {"creative_id": "n1", "creative_name": dim[0]["creative_name"], "short_token": None,
         "questions": [], "options": ["Sim", "Não"], "responses": 1023, "first_at": now, "last_at": now},
        {"creative_id": "n2", "creative_name": dim[1]["creative_name"], "short_token": None,
         "questions": [], "options": ["Sim", "Não"], "responses": 888, "first_at": now, "last_at": now},
        {"creative_id": "z9", "creative_name": "Audible_TapToChoose_300x250", "short_token": None,
         "questions": [], "options": [], "responses": 11500, "first_at": now, "last_at": now},
    ]

    class _Dim(_FakeClient):
        def query(self, sql, job_config=None):
            if "creatives_dim" in sql and "client_name" in sql:
                return _FakeJob(dim)
            return super().query(sql, job_config)

    client = _install(monkeypatch, _Dim(lake_rows=lake))
    p = ma.list_creatives_payload(short_token="PS604Q", client_name="NINTENDO")
    assert p["diagnostics"] is None
    assert p["campaign_count"] == 2
    assert p["client_name"] == "NINTENDO"
    by_id = {c["creative_id"]: c for c in p["creatives"]}
    assert by_id["n1"]["match"] == "client" and by_id["n1"]["side"] == "controle"
    assert by_id["n2"]["match"] == "client" and by_id["n2"]["side"] == "exposto"
    assert by_id["z9"]["match"] is None
    # E o lake foi podado pelos ids da dimensão (chave líder do cluster).
    lake_q = [q for q in client.queries if "ma_survey_responses" in q]
    assert "creative_id IN UNNEST(@ids)" in lake_q[0]


def test_sem_cliente_o_vinculo_e_so_por_token(ma_env, monkeypatch):
    dim = [{"creative_id": "n1", "creative_name": "HYPR_NINTENDO_FY27_SURVEY", "client_name": "Nintendo"}]

    class _Dim(_FakeClient):
        def query(self, sql, job_config=None):
            if "creatives_dim" in sql and "client_name" in sql:
                self.queries.append(sql)
                return _FakeJob(dim)
            return super().query(sql, job_config)

    client = _install(monkeypatch, _Dim())
    assert ma._dim_creatives_for_token("PS604Q") == []
    # Sem cliente, o SQL nem pede as linhas com client_name preenchido.
    assert "client_name IS NOT NULL" not in client.queries[-1]


def test_ramo_amplo_e_cacheado_e_compartilhado_entre_campanhas(ma_env, monkeypatch):
    # É a parte cara (dezenas de GB) e é igual pra toda campanha: roda uma
    # vez e serve todos os modais. O ramo da campanha roda sempre (barato).
    now = datetime(2026, 9, 20, 10, 0, tzinfo=timezone.utc)
    dim_a = [{"creative_id": "a1", "creative_name": "ID-AAAAAA_X_CONTROLE"}]
    lake = [{
        "creative_id": "a1", "creative_name": "ID-AAAAAA_X_CONTROLE", "short_token": "AAAAAA",
        "questions": [], "options": [], "responses": 5, "first_at": now, "last_at": now,
    }, {
        "creative_id": "z9", "creative_name": "OUTRA", "short_token": None,
        "questions": [], "options": [], "responses": 7, "first_at": now, "last_at": now,
    }]
    client = _install(monkeypatch, _FakeClient(dim_rows=dim_a, lake_rows=lake))

    p1 = ma.list_creatives_payload(short_token="AAAAAA")
    p2 = ma.list_creatives_payload(short_token="AAAAAA")
    recent = [q for q in client.queries if "ma_survey_responses" in q and "@since_recent" in q]
    campaign = [q for q in client.queries if "ma_survey_responses" in q and "@since_campaign" in q]
    assert len(recent) == 1        # cacheado
    assert len(campaign) == 2      # sempre fresco
    assert [c["creative_id"] for c in p1["creatives"]] == ["a1", "z9"]
    assert p1["creatives"] == p2["creatives"]

    # refresh=True fura o cache do ramo amplo.
    ma.list_creatives_payload(short_token="AAAAAA", refresh=True)
    recent = [q for q in client.queries if "ma_survey_responses" in q and "@since_recent" in q]
    assert len(recent) == 2

    # warm_recent aquece e devolve a contagem.
    assert ma.warm_recent() == 2


# ── Fonte materializada (o conserto do bytesBilledLimitExceeded) ────────────
#
# PPV8JF, 29/09/2026: "Query exceeded limit for bytes billed: 51539607552.
# 67857547264 or higher required". A estimativa de qualquer leitura que
# atravessa a view acompanha o tamanho do lake, e o lake cresce todo dia —
# subir o teto (32 → 48) só adiou. Agora só o sync lê o lake, em fatias; toda
# leitura vai na tabela pequena.

class _FakeDML:
    def __init__(self, n):
        self.num_dml_affected_rows = n

    def result(self):
        return []


class _SyncClient:
    """Simula o BigQuery do sync: marca d'água no log, partição mais antiga,
    MERGE devolvendo linhas afetadas. Grava (sql, params) de tudo."""

    def __init__(self, through=None, first_partition="20260901", merge_rows=0,
                 lake_rows=(), fail_merge=None):
        self.through = through
        self.first_partition = first_partition
        self.merge_rows = merge_rows
        self.lake_rows = list(lake_rows)
        self.fail_merge = fail_merge
        self.calls = []

    def query(self, sql, job_config=None):
        params = {p.name: getattr(p, "value", getattr(p, "values", None))
                  for p in (job_config.query_parameters if job_config else [])}
        self.calls.append((sql, params, job_config))
        if "CREATE TABLE IF NOT EXISTS" in sql:
            return _FakeJob([])
        if "SELECT synced_from, synced_through" in sql:
            if self.through is None:
                return _FakeJob([])
            first = datetime.strptime(self.first_partition, "%Y%m%d").replace(tzinfo=timezone.utc)
            return _FakeJob([{"synced_from": first, "synced_through": self.through}])
        if "INFORMATION_SCHEMA.PARTITIONS" in sql:
            d = datetime.strptime(self.first_partition, "%Y%m%d").date()
            out = []
            while d <= ma._now().date():
                out.append({"partition_id": d.strftime("%Y%m%d")})
                d += timedelta(days=1)
            return _FakeJob(out)
        if sql.lstrip().startswith("MERGE"):
            if self.fail_merge:
                err = self.fail_merge(params)
                if err:
                    raise err
            return _FakeDML(self.merge_rows)
        if "INSERT INTO" in sql:
            return _FakeDML(1)
        return _FakeJob(self.lake_rows)

    def merges(self):
        return [(s, p) for s, p, _ in self.calls if s.lstrip().startswith("MERGE")]

    def reads(self):
        return [(s, p, jc) for s, p, jc in self.calls
                if "ma_survey_answers`" in s and "MERGE" not in s and "CREATE" not in s]


@pytest.fixture
def mat_env(monkeypatch):
    monkeypatch.setenv("MA_SURVEY_VIEW", "site-hypr.prod_analytics.ma_survey_responses")
    now = datetime(2026, 9, 29, 15, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(ma, "_now", lambda: now)
    return now


def test_materializacao_e_o_default_e_as_tabelas_derivam_da_view(mat_env):
    assert ma.materialized() is True
    assert ma.answers_table() == "site-hypr.prod_assets.ma_survey_answers"
    assert ma.events_raw_table() == "site-hypr.prod_analytics.creative_events_raw"
    # Contrato fixo: não precisa ler schema de view nenhuma.
    assert ma._view_columns("qualquer") == ma._MATERIALIZED_COLUMNS


def test_backfill_anda_do_recente_pro_antigo_em_fatias(mat_env, monkeypatch):
    client = _install(monkeypatch, _SyncClient(through=None, first_partition="20260901", merge_rows=3))
    r = ma.sync_answers()
    assert r["status"] == "synced" and r["complete"] is True
    merges = client.merges()
    # 29/09 15h → 01/09 em fatias de 7 dias, a primeira é a mais recente, e
    # as fatias encostam uma na outra, sem buraco.
    assert merges[0][1]["until"] == mat_env
    assert merges[-1][1]["since"] == datetime(2026, 9, 1, tzinfo=timezone.utc)
    for (_, a), (_, b) in zip(merges, merges[1:]):
        assert a["since"] == b["until"]
    assert all(p["until"] - p["since"] <= timedelta(days=ma.SYNC_CHUNK_DAYS) for _, p in merges)
    assert len(merges) == 5
    assert r["inserted"] == 15
    assert r["synced_through"] == mat_env
    assert r["covered_from"] == datetime(2026, 9, 1, tzinfo=timezone.utc)
    # Cada fatia grava a própria marca d'água: parar no meio é seguro.
    logs = [c for c in client.calls if "INSERT INTO" in c[0]]
    assert len(logs) == len(merges)


def test_merge_le_o_lake_so_com_corte_constante_e_dedupe_por_event_id(mat_env, monkeypatch):
    client = _install(monkeypatch, _SyncClient(through=mat_env - timedelta(hours=3)))
    ma.sync_answers()
    (sql, params), = client.merges()
    assert "creative_events_raw" in sql
    assert "event_type = 'survey_answer'" in sql
    # Corte de partição como parâmetro: é o que deixa a estimativa podar.
    assert "occurred_at >= @since" in sql and "occurred_at <  @until" in sql
    assert "TIMESTAMP_SUB(CURRENT_TIMESTAMP()" not in sql
    assert "PARTITION BY event_id" in sql
    assert "WHEN NOT MATCHED THEN" in sql and "WHEN MATCHED" not in sql
    # Incremental: da marca d'água menos a sobreposição até agora.
    assert params["since"] == mat_env - timedelta(hours=3) - ma.SYNC_OVERLAP
    assert params["until"] == mat_env


def test_sync_recente_nao_toca_o_lake(mat_env, monkeypatch):
    client = _install(monkeypatch, _SyncClient(through=mat_env - timedelta(minutes=10)))
    r = ma.sync_answers()
    assert r["status"] == "fresh"
    assert client.merges() == []
    # E a segunda chamada nem vai ao BigQuery: frescor lembrado em memória.
    n = len(client.calls)
    ma.sync_answers()
    assert len(client.calls) == n


def test_fatia_estourando_o_teto_cai_pela_metade(mat_env, monkeypatch):
    def fail(params):
        if params["until"] - params["since"] > timedelta(days=2):
            return RuntimeError("Query exceeded limit for bytes billed: 51539607552. 67857547264 or higher required.")
        return None

    client = _install(monkeypatch, _SyncClient(through=None, first_partition="20260922", fail_merge=fail))
    r = ma.sync_answers()
    assert r["complete"] is True
    ok = [p for _, p in client.merges() if p["until"] - p["since"] <= timedelta(days=2)]
    assert ok[0]["until"] == mat_env
    assert ok[-1]["since"] == datetime(2026, 9, 22, tzinfo=timezone.utc)


def test_outro_erro_no_sync_sobe(mat_env, monkeypatch):
    _install(monkeypatch, _SyncClient(fail_merge=lambda p: RuntimeError("Access Denied: prod_assets")))
    with pytest.raises(RuntimeError, match="Access Denied"):
        ma.sync_answers()


def test_orcamento_de_tempo_para_no_meio_e_continua_depois(mat_env, monkeypatch):
    clock = iter(range(0, 10_000, 100))
    monkeypatch.setattr(ma.time, "monotonic", lambda: next(clock))
    client = _install(monkeypatch, _SyncClient(through=None, first_partition="20260101"))
    r = ma.sync_answers(budget_s=150)
    assert r["complete"] is False
    assert 1 <= len(client.merges()) < 10
    # Parcial não conta como fresco: a próxima leitura continua o backfill.
    assert ma._SYNC_STATE["checked_at"] is None


def test_leituras_vao_na_tabela_pequena_com_teto_baixo(mat_env, monkeypatch):
    now = mat_env
    rows = [{"option": "Sim", "n": 40, "first_at": now, "last_at": now},
            {"option": "Não", "n": 60, "first_at": now, "last_at": now}]
    client = _install(monkeypatch, _SyncClient(through=now - timedelta(minutes=5), lake_rows=rows))
    data = ma.fetch_results("c1")
    assert data["counts"] == {"Sim": 40, "Não": 60}
    assert data["synced_through"] == (now - timedelta(minutes=5)).isoformat()
    (sql, _, jc), = client.reads()
    assert "creative_events_raw" not in sql
    assert "ma_survey_responses" not in sql       # a view não entra mais na leitura
    # O detalhe não usa nome/token: sem join, 10 MB mínimos em vez de 20.
    assert "creatives_dim" not in sql
    assert jc.maximum_bytes_billed == int(ma.READ_MAX_BYTES_BILLED)
    assert client.merges() == []


def test_listagem_materializada_nao_varre_o_lake(mat_env, monkeypatch):
    now = mat_env
    lake = [{
        "creative_id": "c1", "creative_name": "ID-PPV8JF_X_CONTROLE", "short_token": "PPV8JF",
        "questions": [], "options": ["Sim"], "responses": 10, "first_at": now, "last_at": now,
    }]

    class _Client(_SyncClient):
        def query(self, sql, job_config=None):
            if "creatives_dim" in sql and "SELECT creative_id, creative_name, client_name" in sql:
                self.calls.append((sql, {}, job_config))
                return _FakeJob([{"creative_id": "c1", "creative_name": "ID-PPV8JF_X_CONTROLE", "client_name": None}])
            return super().query(sql, job_config)

    client = _install(monkeypatch, _Client(through=now - timedelta(minutes=5), lake_rows=lake))
    p = ma.list_creatives_payload(short_token="PPV8JF")
    assert [c["creative_id"] for c in p["creatives"]] == ["c1"]
    assert p["includes_recent"] is True
    assert p["synced_through"] == (now - timedelta(minutes=5)).isoformat()
    assert not any("FROM `site-hypr.prod_analytics.creative_events_raw`" in s for s, _, _ in client.calls)
    assert len(client.reads()) == 2               # campanha + amplo, ambos na tabela


def test_sync_falhando_depois_de_uma_rodada_boa_nao_derruba_a_leitura(mat_env, monkeypatch):
    now = mat_env
    rows = [{"option": "Sim", "n": 1, "first_at": now, "last_at": now}]
    client = _install(monkeypatch, _SyncClient(through=now - timedelta(hours=5), lake_rows=rows,
                                               fail_merge=lambda p: RuntimeError("concurrent update")))
    data = ma.fetch_results("c1")
    assert data["total"] == 1
    assert len(client.merges()) == 1              # tentou, falhou, serviu a tabela


def test_tabela_que_nunca_sincronizou_nao_finge_zero(mat_env, monkeypatch):
    # Sem nenhuma rodada boa, a tabela responderia "0 respostas" com cara de
    # verdade. O erro original tem que chegar no admin.
    _install(monkeypatch, _SyncClient(through=None, fail_merge=lambda p: RuntimeError("Access Denied: prod_analytics")))
    with pytest.raises(RuntimeError, match="Access Denied"):
        ma.fetch_results("c1")


def test_modo_legado_segue_lendo_a_view(mat_env, monkeypatch):
    monkeypatch.setenv("MA_SURVEY_MATERIALIZE", "0")
    monkeypatch.setattr(ma, "_view_columns", lambda view: (True, False, True, True, True))
    client = _install(monkeypatch, _SyncClient(lake_rows=[]))
    ma.fetch_results("c1")
    (sql, _, jc), = client.calls
    assert "`site-hypr.prod_analytics.ma_survey_responses`" in sql
    assert jc.maximum_bytes_billed == int(ma.MAX_BYTES_BILLED)


# ── Simulação do lake: o bug do "nenhuma resposta" pós-deploy ────────────────
#
# 29/09/2026, primeiro uso depois do deploy da materialização: sem erro
# nenhum, o modal dizia "Nenhum criativo registrou resposta de survey nos
# últimos 30 dias, em campanha nenhuma" — com a DIAGEO Selo recebendo
# respostas. O backfill andava do MAIS ANTIGO pro mais novo com orçamento de
# tempo; bastava uma partição velha no lake (ou o INFORMATION_SCHEMA falhar e
# o piso virar 730 dias) pra rodada gastar o orçamento em meses vazios, e a
# tabela parcial era servida como se fosse completa.

class _LakeSim:
    """BigQuery de mentira com semântica suficiente pro sync: lake por
    evento, MERGE por [since, until) e dedupe por event_id, log de fatias."""

    def __init__(self, events, partitions=None, merge_cost_s=10, clock=None):
        self.events = list(events)           # dicts com event_id, creative_id, occurred_at, option
        self.partitions = partitions         # None = INFORMATION_SCHEMA indisponível
        self.answers = {}
        self.log = []                        # (from, through, inserted)
        self.merge_cost_s = merge_cost_s
        self.clock = clock
        self.merges = []

    def query(self, sql, job_config=None):
        params = {p.name: getattr(p, "value", getattr(p, "values", None))
                  for p in (job_config.query_parameters if job_config else [])}
        s = sql.lstrip()
        if "CREATE TABLE IF NOT EXISTS" in s:
            return _FakeJob([])
        if "INFORMATION_SCHEMA.PARTITIONS" in s:
            if self.partitions is None:
                raise RuntimeError("Access Denied: INFORMATION_SCHEMA")
            if "MIN(partition_id)" in s:
                return _FakeJob([{"p": min(self.partitions) if self.partitions else None}])
            return _FakeJob([{"partition_id": p} for p in sorted(self.partitions)])
        if "MAX(synced_through)" in s and "synced_from" not in s:
            return _FakeJob([{"t": max((t for _, t, _ in self.log), default=None)}])
        if "synced_from" in s and s.startswith("SELECT"):
            return _FakeJob([{"synced_from": f, "synced_through": t} for f, t, _ in self.log])
        if s.startswith("MERGE"):
            if self.clock is not None:
                self.clock[0] += self.merge_cost_s
            since, until = params["since"], params["until"]
            self.merges.append((since, until))
            n = 0
            for e in self.events:
                if since <= e["occurred_at"] < until and e["event_id"] not in self.answers:
                    self.answers[e["event_id"]] = e
                    n += 1
            return _FakeDML(n)
        if s.startswith("INSERT INTO"):
            if "rows" in params:
                for r in params["rows"]:
                    self.log.append((r["synced_from"], r["synced_through"], r["inserted"]))
            else:
                self.log.append((params["since"], params["until"], params.get("inserted")))
            return _FakeDML(1)
        return _FakeJob([])


def _answer(i, when, creative="c1"):
    return {"event_id": f"e{i}", "creative_id": creative, "occurred_at": when, "option": "Sim"}


@pytest.fixture
def sim_clock(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(ma.time, "monotonic", lambda: clock[0])
    return clock


def test_backfill_curto_ja_traz_o_recente_mesmo_com_particao_velha(mat_env, monkeypatch, sim_clock):
    now = mat_env
    recent = [_answer(i, now - timedelta(days=1, hours=i)) for i in range(50)]
    stray = [_answer(999, datetime(2025, 1, 3, tzinfo=timezone.utc))]   # relógio torto no client
    parts = {"20250103"} | {(now - timedelta(days=d)).strftime("%Y%m%d") for d in range(0, 4)}
    sim = _install(monkeypatch, _LakeSim(recent + stray, partitions=parts, clock=sim_clock))
    r = ma.sync_answers(budget_s=15)          # orçamento curto: 1–2 fatias
    assert len([e for e in sim.answers if e != "e999"]) == 50
    # A primeira fatia é a MAIS RECENTE.
    assert sim.merges[0][1] == now


def test_backfill_sem_information_schema_tambem_comeca_pelo_recente(mat_env, monkeypatch, sim_clock):
    now = mat_env
    recent = [_answer(i, now - timedelta(days=3)) for i in range(10)]
    sim = _install(monkeypatch, _LakeSim(recent, partitions=None, clock=sim_clock))
    r = ma.sync_answers(budget_s=15)
    assert len(sim.answers) == 10
    assert r["complete"] is False             # 730 dias não cabem em 15s
    assert r["covered_from"] is not None and r["covered_from"] <= now - timedelta(days=3)


def test_cobertura_parcial_nao_vira_nenhuma_resposta(mat_env, monkeypatch, sim_clock):
    # Enquanto o histórico não está coberto, a listagem diz isso — em vez de
    # afirmar que ninguém respondeu.
    sim = _install(monkeypatch, _LakeSim([], partitions=None, clock=sim_clock))
    p = ma.list_creatives_payload(short_token="")
    assert p["sync"]["complete"] is False
    assert p["sync"]["covered_from"] is not None


def test_backfill_pula_meses_sem_particao_sem_gastar_merge(mat_env, monkeypatch, sim_clock):
    now = mat_env
    ev = [_answer(1, now - timedelta(days=2)), _answer(2, datetime(2026, 3, 10, 12, tzinfo=timezone.utc))]
    parts = {(now - timedelta(days=2)).strftime("%Y%m%d"), "20260310"}
    sim = _install(monkeypatch, _LakeSim(ev, partitions=parts, clock=sim_clock))
    r = ma.sync_answers(budget_s=60)
    assert r["complete"] is True
    assert set(sim.answers) == {"e1", "e2"}
    # Só fatias com partição de verdade viram MERGE: 2, não ~30.
    assert len(sim.merges) <= 3


def test_retoma_backfill_de_log_antigo_sem_refazer_do_comeco(mat_env, monkeypatch, sim_clock):
    # Estado real de produção depois do deploy anterior: log com fatias velhas
    # (backfill que andava pra frente) e nada do recente. A próxima rodada
    # tem que ir DIRETO no recente.
    now = mat_env
    recent = [_answer(i, now - timedelta(days=5)) for i in range(7)]
    sim = _install(monkeypatch, _LakeSim(recent, partitions=None, clock=sim_clock))
    t0 = datetime(2024, 9, 30, 15, tzinfo=timezone.utc)
    sim.log = [(t0 + timedelta(days=7 * k), t0 + timedelta(days=7 * (k + 1)), 0) for k in range(12)]
    ma.sync_answers(force=True, budget_s=15)
    assert len(sim.answers) == 7
    assert sim.merges[0][1] == now


def test_streaming_buffer_nao_e_pulado_mesmo_sem_particao_listada(mat_env, monkeypatch, sim_clock):
    # Resposta de uma hora atrás ainda está no streaming buffer: o
    # INFORMATION_SCHEMA não lista a partição de hoje. Tem que ser copiada.
    now = mat_env
    ev = [_answer(1, now - timedelta(hours=1)), _answer(2, now - timedelta(days=10))]
    parts = {(now - timedelta(days=10)).strftime("%Y%m%d")}      # hoje fora da lista
    sim = _install(monkeypatch, _LakeSim(ev, partitions=parts, clock=sim_clock))
    ma.sync_answers(budget_s=60)
    assert set(sim.answers) == {"e1", "e2"}


def test_information_schema_vazio_nao_vira_lake_vazio(mat_env, monkeypatch, sim_clock):
    now = mat_env
    ev = [_answer(1, now - timedelta(days=5))]
    sim = _install(monkeypatch, _LakeSim(ev, partitions=set(), clock=sim_clock))
    r = ma.sync_answers(budget_s=15)
    assert set(sim.answers) == {"e1"}
    assert r["complete"] is False            # sem metadata, 730 dias não cabem numa rodada


# ── Tick: custo com teto ─────────────────────────────────────────────────────
#
# O caso real (30/09): o sync só rodava no warmup de 3h ou quando alguém abria
# o report depois de 60 min de cópia parada — 06h31 → 08h46 sem cópia, e a
# resposta dada no Tap to Choose ficava no lake. O tick de 5 min resolve a
# latência; estes testes travam o que impede ele de virar conta: só a ponta,
# teto por MERGE, orçamento diário lido do log (vale pra todas as instâncias).

class _BilledDML(_FakeDML):
    def __init__(self, n, billed):
        super().__init__(n)
        self.total_bytes_billed = billed


class _TickClient(_SyncClient):
    def __init__(self, spent=0, billed=700 * 1024 ** 2, fail_spent=None, **kw):
        super().__init__(**kw)
        self.spent = spent
        self.billed = billed
        self.fail_spent = fail_spent

    def query(self, sql, job_config=None):
        if "SUM(bytes_billed)" in sql:
            params = {p.name: p.value for p in job_config.query_parameters}
            self.calls.append((sql, params, job_config))
            if self.fail_spent:
                raise self.fail_spent
            return _FakeJob([{"b": self.spent}])
        if sql.lstrip().startswith("MERGE"):
            params = {p.name: p.value for p in job_config.query_parameters}
            self.calls.append((sql, params, job_config))
            return _BilledDML(self.merge_rows, self.billed)
        return super().query(sql, job_config)

    def merge_configs(self):
        return [jc for s, _, jc in self.calls if s.lstrip().startswith("MERGE")]

    def logs(self):
        return [p for s, p, _ in self.calls if "INSERT INTO" in s]


def test_tick_copia_so_a_ponta_com_teto_por_merge(mat_env, monkeypatch):
    client = _install(monkeypatch, _TickClient(through=mat_env - timedelta(minutes=5), merge_rows=4))
    r = ma.sync_tick()
    (sql, params), = client.merges()
    assert params["since"] == mat_env - timedelta(minutes=5) - ma.SYNC_OVERLAP
    assert params["until"] == mat_env
    (jc,) = client.merge_configs()
    assert int(jc.maximum_bytes_billed) == ma.tick_max_bytes()
    assert r["inserted"] == 4
    assert r["bytes_billed"] == 700 * 1024 ** 2
    # O gasto vai pro log: é de lá que as outras instâncias leem o orçamento.
    assert client.logs()[-1]["billed"] == 700 * 1024 ** 2


def test_tick_nao_faz_backfill_de_buraco(mat_env, monkeypatch, sim_clock):
    now = mat_env
    ev = [_answer(1, now - timedelta(minutes=30)), _answer(2, now - timedelta(days=20))]
    sim = _install(monkeypatch, _LakeSim(ev, partitions=None, clock=sim_clock))
    # Log com a ponta coberta até 10 min atrás e um buraco de 30 dias antes.
    sim.log = [(now - timedelta(days=5), now - timedelta(minutes=10), 0)]
    monkeypatch.setattr(ma, "spent_today_bytes", lambda: 0)
    ma.sync_tick()
    assert set(sim.answers) == {"e1"}
    assert len(sim.merges) == 1


def test_tick_sem_marca_dagua_nao_vira_backfill(mat_env, monkeypatch):
    client = _install(monkeypatch, _TickClient(through=None))
    r = ma.sync_tick()
    assert r["status"] == "no_watermark"
    assert client.merges() == []


def test_tick_para_quando_o_orcamento_do_dia_acaba(mat_env, monkeypatch):
    monkeypatch.setenv("MA_SURVEY_DAILY_GB", "50")
    client = _install(monkeypatch, _TickClient(through=mat_env - timedelta(minutes=5),
                                               spent=50 * 1024 ** 3))
    r = ma.sync_tick()
    assert r["status"] == "over_budget"
    assert client.merges() == []


def test_orcamento_conta_desde_a_meia_noite_brt(mat_env, monkeypatch):
    client = _install(monkeypatch, _TickClient(through=mat_env - timedelta(minutes=5)))
    ma.sync_tick()
    (params,) = [p for s, p, _ in client.calls if "SUM(bytes_billed)" in s]
    # 29/09 15h UTC = 12h BRT → dia começou 29/09 03h UTC.
    assert params["since"] == datetime(2026, 9, 29, 3, 0, tzinfo=timezone.utc)


def test_tick_falha_fechado_sem_ler_o_gasto(mat_env, monkeypatch):
    client = _install(monkeypatch, _TickClient(through=mat_env - timedelta(minutes=5),
                                               fail_spent=RuntimeError("Access Denied")))
    with pytest.raises(RuntimeError):
        ma.sync_tick()
    assert client.merges() == []


def test_tick_com_merge_acima_do_teto_falha_sem_retentar(mat_env, monkeypatch):
    calls = []

    def fail(params):
        calls.append(params)
        return RuntimeError("Query exceeded limit for bytes billed: 8589934592.")

    client = _install(monkeypatch, _TickClient(through=mat_env - timedelta(minutes=5), fail_merge=fail))
    client.query = _SyncClient.query.__get__(client)   # MERGE pelo caminho que falha
    with pytest.raises(RuntimeError, match="bytes billed"):
        ma.sync_tick()
    assert len(calls) == 1


def test_refresh_do_admin_forca_tick_mesmo_com_tabela_fresca(mat_env, monkeypatch):
    rows = [{"option": "Sim", "n": 3, "first_at": mat_env, "last_at": mat_env}]
    client = _install(monkeypatch, _TickClient(through=mat_env - timedelta(minutes=10), lake_rows=rows))
    ma.fetch_results("c1")
    assert client.merges() == []                  # leitura normal: 10 min < TTL
    ma.fetch_results("c1", fresh=True)
    assert len(client.merges()) == 1


def test_refresh_do_admin_nao_repete_sync_de_menos_de_um_minuto(mat_env, monkeypatch):
    client = _install(monkeypatch, _TickClient(through=mat_env - timedelta(seconds=20)))
    ma._SYNC_STATE["synced_through"] = mat_env - timedelta(seconds=20)
    r = ma.force_fresh()
    assert r["status"] == "fresh"
    assert client.merges() == []


def test_reconciliacao_diaria_reabre_tres_dias(mat_env, monkeypatch):
    client = _install(monkeypatch, _TickClient(through=mat_env - timedelta(hours=1)))
    ma.reconcile_daily()
    params = [p for _, p in client.merges()]
    assert params[0]["since"] == mat_env - timedelta(hours=1) - timedelta(days=3)


def _main_source():
    return open(os.path.join(os.path.dirname(__file__), "..", "main.py"), encoding="utf-8").read()


def test_endpoint_do_tick_exige_cron_ou_admin():
    src = _main_source()
    start = src.index('request.args.get("action") == "maxattention_sync_tick"')
    block = src[start: start + 1500]
    guard = block[: block.index("maxattention.sync_tick()")]
    assert "hmac.compare_digest" in guard and "authenticate_admin" in guard


def test_warmup_nao_reabre_um_dia_a_cada_rodada():
    # Reabrir 1 dia a cada 3h custava ~5 GB por warmup; a reconciliação é
    # uma vez por dia e o resto é tick.
    src = _main_source()
    start = src.index("def warmup_caches")
    block = src[start: start + 6000]
    assert "DEEP_SYNC_OVERLAP" not in block
    assert "maxattention.reconcile_daily()" in block and "maxattention.sync_tick()" in block
