"""
Testes das partes puras do leitor do Max Attention: validação da view
(entra direto no SQL, então o formato é conferido antes) e a convenção de
nome dos criativos, que é o que amarra criativo → campanha → lado quando
a plataforma não devolve short_token.
"""
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
