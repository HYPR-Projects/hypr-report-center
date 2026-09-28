"""Testes do conector DoubleVerify (doubleverify.py). Nada aqui faz I/O: o HTTP
é trocado por stub e o CSV é fixture no formato real que a DV devolve."""
from datetime import date, timedelta

import pytest

import doubleverify as dv


def _csv(rows):
    head = ["Brand Name", "Campaign Name", "Date"] + [name for _, _, name in dv.METRICS]
    lines = [",".join(f'"{h}"' for h in head)]
    for brand, camp, day, vals in rows:
        cells = [f'"{brand}"', f'"{camp}"', f'"{day}"']
        cells += [str(vals.get(name, "")) for _, _, name in dv.METRICS]
        lines.append(",".join(cells))
    return "\n".join(lines) + "\n"


# ─── Janela ──────────────────────────────────────────────────────────────────
def test_default_window_is_30_closed_days_and_prev_same_size(monkeypatch):
    monkeypatch.setattr(dv, "yesterday_brt", lambda: date(2026, 9, 27))
    f, t, pf, pt = dv.resolve_window(None, None)
    assert (f, t) == (date(2026, 8, 29), date(2026, 9, 27))
    assert pt == f - timedelta(days=1)
    assert (pt - pf) == (t - f)


def test_window_caps_to_yesterday(monkeypatch):
    monkeypatch.setattr(dv, "yesterday_brt", lambda: date(2026, 9, 27))
    _, t, _, _ = dv.resolve_window("2026-09-20", "2026-09-28")
    assert t == date(2026, 9, 27)


def test_window_rejects_inverted_and_too_long(monkeypatch):
    monkeypatch.setattr(dv, "yesterday_brt", lambda: date(2026, 9, 27))
    with pytest.raises(ValueError):
        dv.resolve_window("2026-09-20", "2026-09-10")
    with pytest.raises(ValueError):
        dv.resolve_window("2024-01-01", "2026-09-10")


def test_request_body_uses_brt_offset_and_exclusive_end():
    b = dv.build_request_body(date(2026, 9, 20), date(2026, 9, 26))
    assert b["dateRange"] == {"from": "2026-09-20T00:00-03:00", "to": "2026-09-27T00:00-03:00"}
    assert b["requestType"] == 1
    assert [d["id"] for d in b["dimensions"]] == [dv.DIM_BRAND, dv.DIM_CAMPAIGN, dv.DIM_DATE]
    assert len(b["metrics"]) == len(dv.METRICS)


# ─── CSV ─────────────────────────────────────────────────────────────────────
def test_parse_csv_indexes_and_drops_out_of_window_and_empty_rows():
    text = _csv([
        ("Pepsi - BR", "Camp A", "2026-09-19", {"Monitored Ads": 5}),     # fora
        ("Pepsi - BR", "Camp A", "2026-09-21", {"Monitored Ads": 10, "Measured Impressions": 8}),
        ("Pepsi - BR", "Camp A", "2026-09-20", {"Monitored Ads": 4}),
        ("Quaker - BR", "Camp A", "2026-09-20", {"Requests": 8, "Blocks": 8}),
        ("Quaker - BR", "Camp B", "2026-09-20", {}),                      # vazia
    ])
    p = dv.parse_csv(text, date(2026, 9, 20), date(2026, 9, 26))
    assert p["brands"] == ["Pepsi - BR", "Quaker - BR"]
    # Mesmo nome de campanha em brands diferentes = campanhas diferentes.
    assert p["campaigns"] == [{"name": "Camp A", "brand": 0}, {"name": "Camp A", "brand": 1}]
    assert [r[2] for r in p["rows"]] == ["2026-09-20", "2026-09-20", "2026-09-21"]
    mi = 3 + dv.METRIC_KEYS.index("monitored_ads")
    assert sorted(r[mi] for r in p["rows"]) == [0, 4, 10]
    assert p["columns"] == dv.METRIC_KEYS


def test_parse_csv_without_header_raises():
    with pytest.raises(dv.DoubleVerifyError):
        dv.parse_csv("", date(2026, 9, 20), date(2026, 9, 26))


# ─── Pedido assíncrono ───────────────────────────────────────────────────────
class _FakeApi:
    def __init__(self, statuses, csv_text="x"):
        self.statuses = list(statuses)
        self.csv_text = csv_text
        self.calls = []

    def json(self, method, path, **kw):
        self.calls.append((method, path))
        if method == "POST":
            return {"id": "abc~1:uuid", "status": "Queued"}
        return {"status": self.statuses.pop(0), "message": "boom"}

    def http(self, method, path, **kw):
        self.calls.append((method, path))
        return 200, self.csv_text.encode("utf-8")


def test_run_report_polls_until_success_and_quotes_id(monkeypatch):
    api = _FakeApi(["In Progress", "Success"], csv_text="﻿Date\n")
    monkeypatch.setattr(dv, "_json", api.json)
    monkeypatch.setattr(dv, "_http", api.http)
    out = dv.run_report({}, sleep=lambda s: None)
    assert out == "Date\n"
    assert api.calls[-1] == ("GET", "/requests/abc~1%3Auuid/data")


def test_run_report_failed_status_raises(monkeypatch):
    api = _FakeApi(["Failed"])
    monkeypatch.setattr(dv, "_json", api.json)
    with pytest.raises(dv.DoubleVerifyError, match="boom"):
        dv.run_report({}, sleep=lambda s: None)


def test_run_report_times_out(monkeypatch):
    api = _FakeApi(["In Progress"] * 100)
    monkeypatch.setattr(dv, "_json", api.json)
    ticks = iter(range(0, 10_000, 100))
    with pytest.raises(dv.DoubleVerifyError, match="demorou"):
        dv.run_report({}, sleep=lambda s: None, clock=lambda: next(ticks))


def test_not_configured_without_token(monkeypatch):
    monkeypatch.delenv("DV_API_TOKEN", raising=False)
    assert not dv.is_configured()
    with pytest.raises(dv.DoubleVerifyError):
        dv._token()
