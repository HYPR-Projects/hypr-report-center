"""
Régua de tempo do pacing (_pacing_elapsed_days / _today_brt).

Caso que motivou: 30/09/2026, último dia de Mastercard U9TAW5 (voo 25–30/09).
Display tinha 14.349.079 viewable até D-1 contra 14.527.778 negociados. A
regra antiga (`today >= end → contrato cheio`) dava pacing 98,8% e pintava o
card de Under, embora a campanha ainda tivesse o dia 30 inteiro pra entregar
e a projeção fosse 118,5%.
"""
from datetime import date, datetime, timedelta, timezone

import main


def test_ultimo_dia_do_voo_nao_cobra_o_dia_de_hoje():
    start, end = date(2026, 9, 25), date(2026, 9, 30)
    total = (end - start).days + 1
    # Hoje = último dia: o dado vai até 29/09 → 5 dias fechados, não 6.
    assert main._pacing_elapsed_days(start, total, end) == 5


def test_depois_do_fim_o_esperado_vira_o_contrato_cheio():
    start, end = date(2026, 9, 25), date(2026, 9, 30)
    total = (end - start).days + 1
    assert main._pacing_elapsed_days(start, total, date(2026, 10, 1)) == total
    assert main._pacing_elapsed_days(start, total, date(2026, 10, 20)) == total


def test_meio_do_voo_e_antes_do_inicio():
    start = date(2026, 9, 4)
    total = 27
    assert main._pacing_elapsed_days(start, total, date(2026, 9, 4)) == 0
    assert main._pacing_elapsed_days(start, total, date(2026, 9, 3)) == 0
    assert main._pacing_elapsed_days(start, total, date(2026, 9, 18)) == 14
    assert main._pacing_elapsed_days(None, total, date(2026, 9, 18)) == 0


def test_pacing_mastercard_no_ultimo_dia():
    start, end = date(2026, 9, 25), date(2026, 9, 30)
    total = (end - start).days + 1
    neg, delivered = 14_527_778, 14_349_079
    elapsed = main._pacing_elapsed_days(start, total, end)
    pacing = delivered / (neg / total * elapsed) * 100
    assert round(pacing, 1) == 118.5


def test_today_brt_nao_vira_o_dia_as_21h(monkeypatch):
    # 30/09 22:30 BRT = 01/10 01:30 UTC. O container (UTC) já estaria em 01/10.
    instante = datetime(2026, 10, 1, 1, 30, tzinfo=timezone.utc)

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return instante.astimezone(tz) if tz else instante.replace(tzinfo=None)

    monkeypatch.setattr(main, "datetime", FrozenDatetime)
    assert main._today_brt() == date(2026, 9, 30)
    assert instante.date() == date(2026, 9, 30) + timedelta(days=1)
