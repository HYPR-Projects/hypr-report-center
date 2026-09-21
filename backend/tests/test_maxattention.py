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
    ma._COLUMNS_CACHE.clear()


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

    def __init__(self, dim_rows=(), dim_stats=None, lake_rows=()):
        self.dim_rows = list(dim_rows)
        self.dim_stats = dim_stats or {"n": 0, "synced_at": None}
        self.lake_rows = list(lake_rows)
        self.queries = []

    def query(self, sql, job_config=None):
        self.queries.append(sql)
        if "creatives_dim" in sql and "REGEXP_CONTAINS" in sql:
            return _FakeJob(self.dim_rows)
        if "creatives_dim" in sql and "COUNT(*) AS n" in sql:
            return _FakeJob([self.dim_stats])
        return _FakeJob(self.lake_rows)


@pytest.fixture
def ma_env(monkeypatch):
    monkeypatch.setenv("MA_SURVEY_VIEW", "site-hypr.prod_analytics.ma_survey_responses")
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
    assert len(lake) == 1
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
    # O lake foi consultado uma vez, com os dois ramos: campanha (podado
    # pelos ids, janela longa) e amplo (NOT IN, janela curta).
    lake = [q for q in client.queries if "ma_survey_responses" in q]
    assert len(lake) == 1
    assert "creative_id IN UNNEST(@ids)" in lake[0]
    assert "creative_id NOT IN UNNEST(@ids)" in lake[0]
    assert "UNION ALL" in lake[0]


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
                captured["params"] = {p.name: p for p in job_config.query_parameters}
                captured["sql"] = sql
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
            if "ma_survey_responses" in sql and "NOT IN UNNEST(@ids)" in sql:
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
    assert "NOT IN UNNEST(@ids)" in lake[0] and "NOT IN UNNEST(@ids)" not in lake[1]


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
