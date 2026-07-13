"""Garante que o faturável do CARD do menu admin (client_delivered_value,
via effective_cost_front) produz o MESMO número que o "Custo Efetivo · Total"
da Visão Geral do report (Σ effective_total_cost de _compute_totals).

Bug original: card mostrava a MAIS que o report no meio do voo quando uma frente
entregava adiantada — o card usava `min(entrega×neg, contrato CHEIO)` por mídia,
que não trava o over no budget pró-rata como o report faz. Ex.: Diageo I4U4HR
(2026-07-07) card R$ 256.064 vs report R$ 248.565,17.
"""
import datetime
from datetime import date

import main


class _FrozenDate(date):
    @classmethod
    def today(cls):
        return cls(2026, 7, 7)


def _sum_totals_cost(totals, media):
    return round(sum(
        t["effective_total_cost"] for t in totals if t["media_type"] == media
    ), 2)


# ── Dados REAIS do Diageo I4U4HR em 2026-07-07 (UNIFIED + checklist_info) ──
# Entrega por frente (viewable display / viewable completions video).
I4U4HR_PERF = [
    dict(tactic_type="O2O", media_type="DISPLAY", actual_start_date=date(2026, 5, 20),
         days_with_delivery=48, impressions=4646902, viewable_impressions=4646902,
         clicks=0, completions=0, effective_total_cost=2716.99),
    dict(tactic_type="OOH", media_type="DISPLAY", actual_start_date=date(2026, 6, 3),
         days_with_delivery=28, impressions=4290276, viewable_impressions=4290276,
         clicks=0, completions=0, effective_total_cost=1426.72),
    dict(tactic_type="O2O", media_type="VIDEO", actual_start_date=date(2026, 5, 18),
         days_with_delivery=48, impressions=217544, viewable_impressions=217544,
         clicks=0, completions=192369, effective_total_cost=713.15),
    dict(tactic_type="OOH", media_type="VIDEO", actual_start_date=date(2026, 6, 3),
         days_with_delivery=28, impressions=185887, viewable_impressions=185887,
         clicks=0, completions=161432, effective_total_cost=191.83),
]
I4U4HR_CHECK = dict(
    cpm_amount=14.4, cpcv_amount=0.36,
    contracted_o2o_display_impressions=6076389, contracted_ooh_display_impressions=6076389,
    contracted_o2o_video_completions=243056, contracted_ooh_video_completions=243056,
    bonus_o2o_display_impressions=0, bonus_ooh_display_impressions=0,
    bonus_o2o_video_completions=0, bonus_ooh_video_completions=0,
)
I4U4HR_INFO = dict(_start_date_raw=date(2026, 5, 19), _end_date_raw=date(2026, 7, 19))


def _card_delivered(perf, check, info, today):
    """Reproduz o cálculo do card (client_delivered_value) via effective_cost_front,
    per-frente, arredondando cada frente (igual o loop de query_campaigns_list)."""
    start = info["_start_date_raw"]; end = info["_end_date_raw"]
    cpm = check["cpm_amount"]; cpcv = check["cpcv_amount"]
    total = 0.0
    for row in perf:
        is_video = row["media_type"] == "VIDEO"
        tac = row["tactic_type"].lower()
        if is_video:
            contr = check[f"contracted_{tac}_video_completions"]
            bonus = check[f"bonus_{tac}_video_completions"]
            budget = contr * cpcv
            delivered = row["completions"]
        else:
            contr = check[f"contracted_{tac}_display_impressions"]
            bonus = check[f"bonus_{tac}_display_impressions"]
            budget = contr * cpm / 1000
            delivered = row["viewable_impressions"]
        total += round(main.effective_cost_front(
            is_video, delivered, budget, contr + bonus, cpm, cpcv,
            row["actual_start_date"], row["days_with_delivery"], start, end, today,
        ), 2)
    return round(total, 2)


def test_i4u4hr_card_matches_report(monkeypatch):
    """Report (_compute_totals) e card (effective_cost_front) batem entre si e
    com o valor da tela (R$ 248.565,17). O card ANTIGO dava R$ 256.063,72."""
    monkeypatch.setattr(main, "date", _FrozenDate)
    totals = main._compute_totals(I4U4HR_PERF, I4U4HR_CHECK, I4U4HR_INFO)
    report_total = _sum_totals_cost(totals, "DISPLAY") + _sum_totals_cost(totals, "VIDEO")
    card_total = _card_delivered(I4U4HR_PERF, I4U4HR_CHECK, I4U4HR_INFO, _FrozenDate(2026, 7, 7))

    assert abs(report_total - 248565.17) < 0.005   # bate com a tela do report
    assert abs(card_total - report_total) < 0.005  # card alinhado ao report
    # sanity: o card ANTIGO (min(entrega×neg, contrato cheio) por mídia) dava mais
    old_card = round(min(8937178 * 14.4 / 1000, (6076389 + 6076389) * 14.4 / 1000)
                     + min(353801 * 0.36, (243056 + 243056) * 0.36), 2)
    assert old_card > card_total               # confirma que o bug inflava


def test_helper_matches_compute_totals_when_over(monkeypatch):
    """Guard anti-drift genérico: campanha ENDED multi-frente com vídeo em
    over-delivery. is_ended=True → determinístico independ? do date.today()."""
    monkeypatch.setattr(main, "date", _FrozenDate)
    perf = [
        dict(tactic_type="O2O", media_type="DISPLAY", actual_start_date=date(2025, 1, 1),
             days_with_delivery=30, impressions=1000000, viewable_impressions=900000,
             clicks=500, completions=0, effective_total_cost=10.0),
        dict(tactic_type="O2O", media_type="VIDEO", actual_start_date=date(2025, 1, 1),
             days_with_delivery=30, impressions=500000, viewable_impressions=480000,
             clicks=0, completions=470000, effective_total_cost=10.0),  # over: >contrato
    ]
    check = dict(
        cpm_amount=20.0, cpcv_amount=0.5,
        contracted_o2o_display_impressions=1000000, contracted_ooh_display_impressions=0,
        contracted_o2o_video_completions=400000, contracted_ooh_video_completions=0,
        bonus_o2o_display_impressions=0, bonus_ooh_display_impressions=0,
        bonus_o2o_video_completions=0, bonus_ooh_video_completions=0,
    )
    info = dict(_start_date_raw=date(2025, 1, 1), _end_date_raw=date(2025, 1, 30))
    totals = main._compute_totals(perf, check, info)
    report_total = _sum_totals_cost(totals, "DISPLAY") + _sum_totals_cost(totals, "VIDEO")
    card_total = _card_delivered(perf, check, info, _FrozenDate(2026, 7, 7))
    assert card_total == report_total
    # vídeo entregou 470k > 400k contratado (ended) → over → travado no budget
    v_cost = _sum_totals_cost(totals, "VIDEO")
    assert v_cost == round(400000 * 0.5, 2)     # budget cheio, não 470k×0.5


def test_bonus_delivery_not_billed(monkeypatch):
    """Bônus NÃO entra no efetivo. Caso real Amazon 4WA4TV: contratado 15.625.000
    + bônus 15.625.000, entrega 30.355.085 (todo o contrato + parte do bônus).
    O efetivo trava no budget contratado (R$225.000), NÃO fatura a entrega do
    bônus (bug: dava R$437k = 30,3M × CPM). Regressão do fix de limiar do `over`."""
    monkeypatch.setattr(main, "date", _FrozenDate)
    perf = [
        dict(tactic_type="O2O", media_type="DISPLAY", actual_start_date=date(2026, 6, 1),
             days_with_delivery=30, impressions=31582463, viewable_impressions=30355085,
             clicks=261470, completions=0, effective_total_cost=0.0),
    ]
    check = dict(
        cpm_amount=14.4, cpcv_amount=0.0,
        contracted_o2o_display_impressions=15625000, contracted_ooh_display_impressions=0,
        contracted_o2o_video_completions=0, contracted_ooh_video_completions=0,
        bonus_o2o_display_impressions=15625000, bonus_ooh_display_impressions=0,
        bonus_o2o_video_completions=0, bonus_ooh_video_completions=0,
    )
    info = dict(_start_date_raw=date(2026, 6, 1), _end_date_raw=date(2026, 6, 30))
    totals = main._compute_totals(perf, check, info)
    report_total = _sum_totals_cost(totals, "DISPLAY")
    card_total = _card_delivered(perf, check, info, _FrozenDate(2026, 7, 7))
    # efetivo travado no contrato, não na entrega (que inclui bônus)
    assert report_total == round(15625000 * 14.4 / 1000, 2)   # == 225.000, NÃO 437k
    assert card_total == report_total                          # card alinhado
    # CPM efetivo reflete o bônus (cai de 14,40): 225000/30.355.085*1000 ≈ 7,41
    row = [r for r in totals if r["media_type"] == "DISPLAY"][0]
    assert abs(row["effective_cpm_amount"] - 7.4123) < 0.01
    # o valor BUGADO (entrega × CPM, contando o bônus) seria muito maior
    assert 30355085 * 14.4 / 1000 > report_total * 1.9


def test_early_end_over_bills_full_budget(monkeypatch):
    """Encerramento antecipado + OVER → efetivo trava no budget CHEIO já no
    dia seguinte ao encerramento real, não pró-rata até o término original.

    Caso real Minesol NO2015 (2026-07-13): voo 1/jun–31/jul (61d), encerrada
    antecipadamente, entrega em over do contrato inteiro (R$314k a faturar
    bruto vs R$298.444 contratados). BUG: `row_is_ended` usava o end ORIGINAL
    → budget_prop = 298.444 × 42/61 = R$205.486 em 13/jul, subindo ~R$4.9k/dia
    com a campanha parada, até só chegar nos 298.444 em 31/jul."""
    class _Jul13(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(main, "date", _Jul13)
    cpm = 14.4
    contracted = 20725278   # × 14.4/1000 ≈ R$ 298.444 (budget contratado)
    perf = [
        dict(tactic_type="O2O", media_type="DISPLAY", actual_start_date=date(2026, 6, 1),
             days_with_delivery=35, impressions=22500000, viewable_impressions=21813005,
             clicks=15000, completions=0, effective_total_cost=0.0),  # 21,8M × 14,4 ≈ R$314k > contrato
    ]
    check = dict(
        cpm_amount=cpm, cpcv_amount=0.0,
        contracted_o2o_display_impressions=contracted, contracted_ooh_display_impressions=0,
        contracted_o2o_video_completions=0, contracted_ooh_video_completions=0,
        bonus_o2o_display_impressions=1500000, bonus_ooh_display_impressions=0,
        bonus_o2o_video_completions=0, bonus_ooh_video_completions=0,
    )
    budget_full = round(contracted * cpm / 1000, 2)
    info_no_early = dict(_start_date_raw=date(2026, 6, 1), _end_date_raw=date(2026, 7, 31))
    info_early    = dict(info_no_early, early_end_date="2026-07-05")

    # SEM early end (campanha "no ar"): comportamento pró-rata preservado
    pro_rata = _sum_totals_cost(main._compute_totals(perf, check, info_no_early), "DISPLAY")
    assert abs(pro_rata - round(budget_full / 61 * 42, 2)) < 0.01   # 42/61 decorridos
    assert pro_rata < budget_full

    # COM early end passado: fatura o budget cheio IMEDIATAMENTE (fix)
    totals = main._compute_totals(perf, check, info_early)
    assert _sum_totals_cost(totals, "DISPLAY") == budget_full
    # bônus segue fora do faturável (limiar = budget contratado, PR #151)
    assert budget_full < round(21813005 * cpm / 1000, 2)

    # Card admin (effective_cost_front) na MESMA régua
    card = round(main.effective_cost_front(
        False, 21813005, contracted * cpm / 1000, contracted + 1500000, cpm, 0.0,
        date(2026, 6, 1), 35, date(2026, 6, 1), date(2026, 7, 31), _Jul13(2026, 7, 13),
        early_end=date(2026, 7, 5),
    ), 2)
    assert card == budget_full

    # Pacing NÃO muda com early end (Opção B): mesmo valor nas duas variantes
    p_no  = [r["pacing"] for r in main._compute_totals(perf, check, info_no_early)]
    p_yes = [r["pacing"] for r in totals]
    assert p_no == p_yes


def test_early_end_under_bills_delivery(monkeypatch):
    """Encerramento antecipado + UNDER → efetivo = entrega × negociado
    (refaturamento pelo entregue), estável — early end não infla nada."""

    class _Jul13(date):
        @classmethod
        def today(cls):
            return cls(2026, 7, 13)

    monkeypatch.setattr(main, "date", _Jul13)
    perf = [
        dict(tactic_type="O2O", media_type="DISPLAY", actual_start_date=date(2026, 6, 1),
             days_with_delivery=20, impressions=6000000, viewable_impressions=5000000,
             clicks=2500, completions=0, effective_total_cost=0.0),
    ]
    check = dict(
        cpm_amount=20.0, cpcv_amount=0.0,
        contracted_o2o_display_impressions=10000000, contracted_ooh_display_impressions=0,
        contracted_o2o_video_completions=0, contracted_ooh_video_completions=0,
        bonus_o2o_display_impressions=0, bonus_ooh_display_impressions=0,
        bonus_o2o_video_completions=0, bonus_ooh_video_completions=0,
    )
    info = dict(_start_date_raw=date(2026, 6, 1), _end_date_raw=date(2026, 7, 31),
                early_end_date="2026-07-05")
    report_total = _sum_totals_cost(main._compute_totals(perf, check, info), "DISPLAY")
    assert report_total == round(5000000 * 20.0 / 1000, 2)   # entrega × CPM, não budget


def test_helper_matches_compute_totals_when_under(monkeypatch):
    """Sub-delivery ended → custo = entrega × negociado (não o budget)."""
    monkeypatch.setattr(main, "date", _FrozenDate)
    perf = [
        dict(tactic_type="O2O", media_type="DISPLAY", actual_start_date=date(2025, 1, 1),
             days_with_delivery=30, impressions=800000, viewable_impressions=700000,
             clicks=350, completions=0, effective_total_cost=10.0),
    ]
    check = dict(
        cpm_amount=20.0, cpcv_amount=0.5,
        contracted_o2o_display_impressions=1000000, contracted_ooh_display_impressions=0,
        contracted_o2o_video_completions=0, contracted_ooh_video_completions=0,
        bonus_o2o_display_impressions=0, bonus_ooh_display_impressions=0,
        bonus_o2o_video_completions=0, bonus_ooh_video_completions=0,
    )
    info = dict(_start_date_raw=date(2025, 1, 1), _end_date_raw=date(2025, 1, 30))
    totals = main._compute_totals(perf, check, info)
    report_total = _sum_totals_cost(totals, "DISPLAY")
    card_total = _card_delivered(perf, check, info, _FrozenDate(2026, 7, 7))
    assert card_total == report_total
    assert report_total == round(700000 * 20.0 / 1000, 2)   # 700k × CPM
