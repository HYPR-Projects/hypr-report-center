"""Grade do cron da PubMatic × ledger (pmp_sync_runs.missing_probe_slots).

O que se crava aqui é a parte PURA do `?action=pmp_sync_status`: dado o que o
ledger tem, quais horas da grade (04h + 05h–23h BRT) ficaram sem disparo do
Cloud Scheduler. É o número que separa "a PubMatic não reportou" (grade
cheia, api_last_day parado) de "o cron parou" (buracos) — os dois estados que
o painel mostra igual e que pedem consertos opostos.

Sem I/O: o módulo é importado com o bq_client stubado.
"""
import sys
import types
from datetime import datetime, timezone

import pytest


@pytest.fixture
def runs_mod(monkeypatch):
    """Importa pmp_sync_runs com bq_client stubado (o módulo cria o client no
    import). Devolve o módulo original ao sys.modules no teardown."""
    stub = types.ModuleType("bq_client")
    stub.get_client = lambda: object()
    monkeypatch.setitem(sys.modules, "bq_client", stub)
    original = sys.modules.pop("pmp_sync_runs", None)
    import importlib
    mod = importlib.import_module("pmp_sync_runs")
    yield mod
    if original is not None:
        sys.modules["pmp_sync_runs"] = original
    else:
        sys.modules.pop("pmp_sync_runs", None)


def _utc(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc)


def _run(started_utc, actor="scheduler", source="pubmatic"):
    return {"started_at": started_utc.isoformat(), "actor": actor, "source": source}


# 03/09/2026 21:00 UTC = 18:00 BRT. Grade BRT 04..23 → UTC 07..02(+1).
NOW = _utc(2026, 9, 3, 21, 10)   # 18:10 BRT


def test_grade_das_ultimas_horas_e_a_esperada(runs_mod):
    slots = runs_mod.expected_probe_slots(NOW, hours=6)
    brt = [s.astimezone(runs_mod.BRT).strftime("%H") for s in slots]
    # Janela = 12:10..18:10 BRT. 12h fica fora (antes do início da janela);
    # 18h ainda não venceu (tolerância de 50 min). Sobram 13h..17h.
    assert brt == ["13", "14", "15", "16", "17"]


def test_slot_da_hora_corrente_so_conta_depois_da_tolerancia(runs_mod):
    late = _utc(2026, 9, 3, 21, 55)   # 18:55 BRT → o slot das 18h já venceu
    brt = [s.astimezone(runs_mod.BRT).hour for s in runs_mod.expected_probe_slots(late, hours=2)]
    assert brt == [17, 18]


def test_madrugada_fora_da_grade_nao_e_buraco(runs_mod):
    # 00h–03h BRT não têm cron; só o slot das 04h (07 UTC) e 05h em diante.
    now = _utc(2026, 9, 4, 8, 55)    # 05:55 BRT
    brt = [s.astimezone(runs_mod.BRT).hour for s in runs_mod.expected_probe_slots(now, hours=8)]
    assert brt == [22, 23, 4, 5]


def test_grade_cheia_nao_reporta_buraco(runs_mod):
    runs = [_run(_utc(2026, 9, 3, h, 0)) for h in (16, 17, 18, 19, 20)]  # 13h..17h BRT
    assert runs_mod.missing_probe_slots(runs, NOW, hours=6) == []


def test_buraco_na_grade_aparece_em_brt(runs_mod):
    runs = [_run(_utc(2026, 9, 3, h, 0)) for h in (16, 17, 19, 20)]      # falta 15h BRT
    assert runs_mod.missing_probe_slots(runs, NOW, hours=6) == ["03/09 15h"]


def test_execucao_manual_nao_prova_que_o_cron_disparou(runs_mod):
    runs = [_run(_utc(2026, 9, 3, h, 0)) for h in (16, 17, 19, 20)]
    runs.append(_run(_utc(2026, 9, 3, 18, 5), actor="joao@hypr.mobi"))
    assert runs_mod.missing_probe_slots(runs, NOW, hours=6) == ["03/09 15h"]


def test_run_de_outra_fonte_nao_cobre_slot(runs_mod):
    runs = [_run(_utc(2026, 9, 3, h, 0)) for h in (16, 17, 19, 20)]
    runs.append(_run(_utc(2026, 9, 3, 18, 0), source="xandr"))
    assert runs_mod.missing_probe_slots(runs, NOW, hours=6) == ["03/09 15h"]


def test_run_atrasado_dentro_da_tolerancia_cobre(runs_mod):
    runs = [_run(_utc(2026, 9, 3, h, 0)) for h in (16, 17, 19, 20)]
    runs.append(_run(_utc(2026, 9, 3, 18, 40)))   # 15:40 BRT — fila/cold start
    assert runs_mod.missing_probe_slots(runs, NOW, hours=6) == []


def test_aceita_started_at_datetime_e_string_z(runs_mod):
    runs = [
        {"started_at": _utc(2026, 9, 3, 16, 0), "actor": "scheduler", "source": "pubmatic"},
        {"started_at": "2026-09-03T17:00:00Z", "actor": "scheduler", "source": "pubmatic"},
        _run(_utc(2026, 9, 3, 18, 0)), _run(_utc(2026, 9, 3, 19, 0)), _run(_utc(2026, 9, 3, 20, 0)),
    ]
    assert runs_mod.missing_probe_slots(runs, NOW, hours=6) == []
