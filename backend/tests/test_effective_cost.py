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
