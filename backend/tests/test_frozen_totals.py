"""
Entrega dos cards congelados na lista admin (_load_frozen_totals).

A lista só usa `totals` do snapshot. Com centenas de tokens congelados, ler o
payload inteiro de cada um (um job por token) travava o rebuild da lista. Aqui:
uma query para todos, só `totals`, e o card fica igual ao que sairia do
payload completo. O BigQuery é substituído por dublês.
"""
import json

import pytest

import main


TOTALS = [
    {"media_type": "DISPLAY", "tactic_type": "O2O", "viewable_impressions": 1000,
     "clicks": 10, "effective_total_cost": 50.0, "days_with_delivery": 5,
     "actual_start_date": "2026-09-01"},
    {"media_type": "VIDEO", "tactic_type": "OOH", "viewable_impressions": 400,
     "viewable_video_view_100_complete": 300, "completions": 320, "clicks": 2,
     "effective_cost_with_over": 30.0, "effective_total_cost": 28.0,
     "days_with_delivery": 4, "actual_start_date": "2026-09-02"},
]


class FakeBQ:
    def __init__(self, rows=None, error=None):
        self.rows = rows or []
        self.error = error
        self.calls = []

    def query(self, sql, job_config=None, **_):
        self.calls.append((sql, job_config))
        if self.error:
            raise self.error
        rows = self.rows

        class Job:
            def result(self_inner):
                return rows
        return Job()


@pytest.fixture(autouse=True)
def no_ensure(monkeypatch):
    monkeypatch.setattr(main, "_ensure_snapshots_table", lambda: None)


def test_uma_query_para_todos_os_tokens(monkeypatch):
    fake = FakeBQ(rows=[
        {"short_token": "AAA111", "totals_json": json.dumps(TOTALS)},
        {"short_token": "BBB222", "totals_json": json.dumps(TOTALS[:1])},
    ])
    monkeypatch.setattr(main, "bq", fake)

    out = main._load_frozen_totals(["AAA111", "BBB222", "AAA111"])

    assert len(fake.calls) == 1
    sql, jc = fake.calls[0]
    assert "JSON_QUERY(payload_json, '$.totals')" in sql
    assert "SELECT payload_json" not in sql
    assert jc.query_parameters[0].values == ["AAA111", "BBB222"]
    assert out == {"AAA111": {"totals": TOTALS}, "BBB222": {"totals": TOTALS[:1]}}


def test_card_igual_ao_do_payload_completo(monkeypatch):
    monkeypatch.setattr(main, "bq", FakeBQ(rows=[
        {"short_token": "AAA111", "totals_json": json.dumps(TOTALS)},
    ]))
    payload_completo = {"totals": TOTALS, "daily": [{"x": 1}] * 1000, "campaign": {}}

    via_totals, via_payload = {}, {}
    main._apply_frozen_delivery_override(via_totals, main._load_frozen_totals(["AAA111"])["AAA111"])
    main._apply_frozen_delivery_override(via_payload, payload_completo)

    assert via_totals == via_payload
    assert via_totals["d_viewable_impressions"] == 1000
    assert via_totals["v_viewable_completions"] == 300


def test_sem_tokens_nao_consulta(monkeypatch):
    fake = FakeBQ()
    monkeypatch.setattr(main, "bq", fake)
    assert main._load_frozen_totals([]) == {}
    assert fake.calls == []


def test_falha_degrada_para_entrega_ao_vivo(monkeypatch):
    monkeypatch.setattr(main, "bq", FakeBQ(error=RuntimeError("boom")))
    assert main._load_frozen_totals(["AAA111"]) == {}


def test_totals_nulo_fica_de_fora(monkeypatch):
    monkeypatch.setattr(main, "bq", FakeBQ(rows=[{"short_token": "AAA111", "totals_json": None}]))
    assert main._load_frozen_totals(["AAA111"]) == {}
