"""Guardrail — volumetria contratada soma as TRÊS frentes (O2O/OOH/Groundflow).

A Groundflow foi esquecida em dois lugares independentes (query_campaigns_list e
query_performers_for_period), cada um somando só O2O+OOH inline. Caso real
Tostitos JFKV9U (PEPSICO, 20-31/07/2026), contrato 50/50 O2O+RMNF:

  • Diagnóstico histórico: "Super Over" 218,9% (real 109,4%) — o numerador
    (entrega) soma todas as lines, o denominador ignorava a RMNF;
  • card: INVESTIDO R$ 63.896 numa PI de R$ 127.792, com ENTREGUE R$ 127.792
    (esse já somava as 3 frentes) → "entregue = 2× o investido";
  • Tech Cost 26,9% em vez de 13,4% → alerta "Tech Cost Alto" falso.

Números abaixo são os do BQ pra JFKV9U (CPM 14,40 / CPCV 0,36).
"""
import main


# Checklist real da Tostitos: O2O e GROUNDFLOW com volumetria idêntica,
# contratado == bônus em cada frente, OOH zerada.
_UNIT_D = 2344186.0
_UNIT_V = 83721.0
CPM, CPCV = 14.40, 0.36

TOSTITOS = {
    "cpm_amount": CPM, "cpcv_amount": CPCV,
    "contracted_o2o_display": _UNIT_D, "bonus_o2o_display": _UNIT_D,
    "contracted_ooh_display": 0.0,     "bonus_ooh_display": 0.0,
    "contracted_groundflow_display": _UNIT_D, "bonus_groundflow_display": _UNIT_D,
    "contracted_o2o_video": _UNIT_V, "bonus_o2o_video": _UNIT_V,
    "contracted_ooh_video": 0.0,     "bonus_ooh_video": 0.0,
    "contracted_groundflow_video": _UNIT_V, "bonus_groundflow_video": _UNIT_V,
}


def test_negociado_inclui_groundflow():
    """Denominador de pacing/entregue % = contratado + bônus das 3 frentes."""
    assert main.contract_volume(TOSTITOS, "display", include_bonus=True) == 9376744.0
    assert main.contract_volume(TOSTITOS, "video",   include_bonus=True) == 334884.0


def test_contratado_exclui_bonus_mas_inclui_groundflow():
    """Denominador da PI/tech cost = contratado das 3 frentes, SEM bônus."""
    assert main.contract_volume(TOSTITOS, "display", include_bonus=False) == 4688372.0
    assert main.contract_volume(TOSTITOS, "video",   include_bonus=False) == 167442.0


def test_pi_liquida_da_tostitos():
    """PI = Σ contratado × tarifa. Card mostrava metade (R$ 63.896)."""
    d = main.contract_volume(TOSTITOS, "display", include_bonus=False) * CPM / 1000
    v = main.contract_volume(TOSTITOS, "video",   include_bonus=False) * CPCV
    assert round(d + v, 2) == 127791.68


def test_pacing_da_tostitos_bate_com_o_card():
    """Entrega real na janela 20-31/07 ÷ negociado = 109,4% / 110,7% (card:
    109% / 111%). Com o bug dava 218,9% / 221,3% → status Super Over."""
    d_entregue, v_entregue = 10261167, 370551
    d_pct = d_entregue / main.contract_volume(TOSTITOS, "display", include_bonus=True) * 100
    v_pct = v_entregue / main.contract_volume(TOSTITOS, "video",   include_bonus=True) * 100
    assert round(d_pct, 1) == 109.4
    assert round(v_pct, 1) == 110.7


def test_tech_cost_da_tostitos():
    """R$ 17.185 de gasto DSP sobre a PI cheia = 13,4% (não 26,9%)."""
    pi = (main.contract_volume(TOSTITOS, "display", include_bonus=False) * CPM / 1000
          + main.contract_volume(TOSTITOS, "video", include_bonus=False) * CPCV)
    assert round(17185.0 / pi * 100, 1) == 13.4


def test_row_sem_colunas_groundflow_nao_quebra():
    """Row antiga (ou frente não vendida) → chaves ausentes/None contam 0, sem
    KeyError. Vale pro bigquery.Row (tem .get) e pro dict."""
    sem_gf = {
        "contracted_o2o_display": 1000.0, "bonus_o2o_display": None,
        "contracted_ooh_display": 500.0,
    }
    assert main.contract_volume(sem_gf, "display", include_bonus=True) == 1500.0
    assert main.contract_volume(sem_gf, "video",   include_bonus=True) == 0.0


def test_campanha_sem_groundflow_inalterada():
    """Regressão inversa: campanha O2O+OOH pura não muda de valor com o fix."""
    o2o_ooh = {
        "contracted_o2o_display": 3000000.0, "contracted_ooh_display": 1000000.0,
        "bonus_o2o_display": 200000.0,       "bonus_ooh_display": 0.0,
        "contracted_groundflow_display": 0.0, "bonus_groundflow_display": 0.0,
    }
    assert main.contract_volume(o2o_ooh, "display", include_bonus=False) == 4000000.0
    assert main.contract_volume(o2o_ooh, "display", include_bonus=True) == 4200000.0
