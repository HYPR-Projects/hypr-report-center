"""Régua de tempo do FATURAMENTO (budget_prop / over / CPM efetivo).

Regra: "hoje" é a data em BRT e a campanha só conta como encerrada pro
faturamento DEPOIS do último dia (`billing_end < today_brt`, estrito). No
último dia o dado de entrega ainda vai só até D-1, então o teto do over segue
pró-rata (elapsed = total−1); o budget cheio vale a partir do dia seguinte.

Bug coberto: o container do Cloud Run roda em UTC e `date.today()` virava o
dia às 21h BRT. Na noite do último dia do voo o faturamento já tratava a
campanha como encerrada (budget CHEIO) e às 00h BRT voltava pro pró-rata — o
CPM efetivo/rentabilidade da aba Display pulava e voltava.
"""
import datetime as _dt
from datetime import date, timezone

import clients
import main


START, END = date(2026, 7, 1), date(2026, 7, 31)   # 31 dias
CPM, CPCV = 10.0, 0.5
CONTR_IMPS, CONTR_VIEWS = 3_100_000, 310_000       # budgets R$31.000 e R$155.000
DISPLAY_BUDGET = CONTR_IMPS * CPM / 1000
VIDEO_BUDGET = CONTR_VIEWS * CPCV

# Over nas duas mídias: entrega acima do contrato inteiro.
PERF = [
    dict(tactic_type="O2O", media_type="DISPLAY", actual_start_date=START,
         days_with_delivery=30, impressions=3_300_000, viewable_impressions=3_200_000,
         clicks=1_000, completions=0, effective_total_cost=0.0),
    dict(tactic_type="O2O", media_type="VIDEO", actual_start_date=START,
         days_with_delivery=30, impressions=400_000, viewable_impressions=380_000,
         clicks=0, completions=320_000, effective_total_cost=0.0),
]
CHECK = dict(
    cpm_amount=CPM, cpcv_amount=CPCV,
    contracted_o2o_display_impressions=CONTR_IMPS, contracted_ooh_display_impressions=0,
    contracted_o2o_video_completions=CONTR_VIEWS, contracted_ooh_video_completions=0,
    bonus_o2o_display_impressions=0, bonus_ooh_display_impressions=0,
    bonus_o2o_video_completions=0, bonus_ooh_video_completions=0,
)
INFO = dict(_start_date_raw=START, _end_date_raw=END)


def _fixed_instant(utc_dt):
    """`datetime` cujo now(tz) devolve um instante UTC fixo convertido pro tz."""
    class _Fixed(_dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return utc_dt.astimezone(tz) if tz else utc_dt.replace(tzinfo=None)
    return _Fixed


def _container_utc_date(d):
    """`date` cujo today() é a data UTC do container (o valor que o bug usava)."""
    class _D(date):
        @classmethod
        def today(cls):
            return cls(d.year, d.month, d.day)
    return _D


def _costs(today_brt, monkeypatch):
    monkeypatch.setattr(main, "_today_brt", lambda: today_brt)
    totals = main._compute_totals(PERF, CHECK, INFO)
    return {t["media_type"]: t for t in totals}


def _card(today_brt):
    """Mesmo cálculo do card do menu admin (query_campaigns_list)."""
    d = main.effective_cost_front(False, 3_200_000, DISPLAY_BUDGET, CONTR_IMPS, CPM, CPCV,
                                  START, 0, START, END, today_brt)
    v = main.effective_cost_front(True, 320_000, VIDEO_BUDGET, CONTR_VIEWS, CPM, CPCV,
                                  START, 30, START, END, today_brt)
    return round(d, 2), round(v, 2)


def test_today_brt_vira_o_dia_a_meia_noite_de_brasilia(monkeypatch):
    # 31/jul 22h BRT == 1/ago 01h UTC → ainda é 31/jul
    monkeypatch.setattr(main, "datetime", _fixed_instant(_dt.datetime(2026, 8, 1, 1, 0, tzinfo=timezone.utc)))
    assert main._today_brt() == date(2026, 7, 31)
    # 1/ago 00h05 BRT == 1/ago 03h05 UTC → 1/ago
    monkeypatch.setattr(main, "datetime", _fixed_instant(_dt.datetime(2026, 8, 1, 3, 5, tzinfo=timezone.utc)))
    assert main._today_brt() == date(2026, 8, 1)


def test_ultimo_dia_do_voo_segue_pro_rata(monkeypatch):
    """No último dia o over trava no budget pró-rata (30/31), não no cheio."""
    rows = _costs(END, monkeypatch)
    assert rows["DISPLAY"]["effective_total_cost"] == round(DISPLAY_BUDGET / 31 * 30, 2)   # 30.000
    assert rows["VIDEO"]["effective_total_cost"] == round(VIDEO_BUDGET / 31 * 30, 2)
    assert abs(rows["DISPLAY"]["effective_cpm_amount"] - 9.375) < 1e-3                   # 30.000/3,2M
    # card do menu admin na mesma régua
    assert _card(END) == (rows["DISPLAY"]["effective_total_cost"], rows["VIDEO"]["effective_total_cost"])


def test_dia_seguinte_ao_fim_fatura_budget_cheio(monkeypatch):
    rows = _costs(date(2026, 8, 1), monkeypatch)
    assert rows["DISPLAY"]["effective_total_cost"] == DISPLAY_BUDGET                      # 31.000
    assert rows["VIDEO"]["effective_total_cost"] == VIDEO_BUDGET
    assert abs(rows["DISPLAY"]["effective_cpm_amount"] - 9.6875) < 1e-3
    assert _card(date(2026, 8, 1)) == (DISPLAY_BUDGET, VIDEO_BUDGET)


def test_noite_do_ultimo_dia_nao_vira_encerrada_pelo_utc(monkeypatch):
    """31/jul 22h BRT: o container já está em 1/ago UTC. O faturamento tem que
    seguir no pró-rata do último dia — com date.today() virava budget cheio."""
    monkeypatch.setattr(main, "datetime", _fixed_instant(_dt.datetime(2026, 8, 1, 1, 0, tzinfo=timezone.utc)))
    monkeypatch.setattr(main, "date", _container_utc_date(date(2026, 8, 1)))
    rows = {t["media_type"]: t for t in main._compute_totals(PERF, CHECK, INFO)}
    assert rows["DISPLAY"]["effective_total_cost"] == round(DISPLAY_BUDGET / 31 * 30, 2)
    assert rows["VIDEO"]["effective_total_cost"] == round(VIDEO_BUDGET / 31 * 30, 2)


def test_meio_do_voo_a_noite_nao_ganha_um_dia(monkeypatch):
    """15/jul 22h BRT (16/jul UTC): elapsed = 14 dias, não 15."""
    monkeypatch.setattr(main, "datetime", _fixed_instant(_dt.datetime(2026, 7, 16, 1, 0, tzinfo=timezone.utc)))
    monkeypatch.setattr(main, "date", _container_utc_date(date(2026, 7, 16)))
    rows = {t["media_type"]: t for t in main._compute_totals(PERF, CHECK, INFO)}
    assert rows["DISPLAY"]["effective_total_cost"] == round(DISPLAY_BUDGET / 31 * 14, 2)


def test_clients_ativa_no_ultimo_dia_a_noite(monkeypatch):
    """Lista de clientes: campanha no último dia segue ativa às 22h BRT."""
    monkeypatch.setattr(clients, "datetime", _fixed_instant(_dt.datetime(2026, 8, 1, 1, 0, tzinfo=timezone.utc)))
    assert clients._today_brt() == date(2026, 7, 31)
    out = clients.aggregate_clients_from_campaigns([
        dict(short_token="AAAAAA", client_name="Cliente X", end_date="2026-07-31"),
    ])
    assert out[0]["active_campaigns"] == 1
