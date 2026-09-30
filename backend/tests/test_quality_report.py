"""Testes da aba Quality (quality_report.py). Sem I/O: BigQuery e DV são stub."""
from datetime import date

import pytest

import doubleverify as dv
import quality_report as qr


@pytest.fixture(autouse=True)
def _clean_caches():
    for store in (qr._links_cache, qr._report_cache, qr._campaigns_cache, qr._inflight):
        store.clear()
    yield


def _with_links(monkeypatch, links):
    monkeypatch.setattr(qr, "_all_links", lambda: links)


# ─── Validação ───────────────────────────────────────────────────────────────
def test_sanitize_dedupes_and_parses_dates():
    names, f, t = qr.sanitize_input([" Camp A ", "Camp A", "Camp B"], "2026-09-01", "2026-09-30")
    assert names == ["Camp A", "Camp B"]
    assert (f, t) == (date(2026, 9, 1), date(2026, 9, 30))


def test_sanitize_empty_list_means_disconnect():
    assert qr.sanitize_input([], None, None) == ([], None, None)


@pytest.mark.parametrize("campaigns,f,t", [
    ("nope", "2026-09-01", "2026-09-30"),
    ([""], "2026-09-01", "2026-09-30"),
    (["A"], "2026-09-30", "2026-09-01"),
    (["A"], "01/09/2026", "2026-09-30"),
    (["A"], "2024-01-01", "2026-09-30"),
    ([f"C{i}" for i in range(qr.MAX_CAMPAIGNS + 1)], "2026-09-01", "2026-09-30"),
])
def test_sanitize_rejects(campaigns, f, t):
    with pytest.raises(ValueError):
        qr.sanitize_input(campaigns, f, t)


# ─── Config por visão ────────────────────────────────────────────────────────
def test_config_for_tokens_merges_group_members(monkeypatch):
    _with_links(monkeypatch, {
        "AAA111": {"campaigns": ["X", "Y"], "date_from": "2026-08-01", "date_to": "2026-08-31"},
        "BBB222": {"campaigns": ["Y", "Z"], "date_from": "2026-09-01", "date_to": "2026-09-30"},
    })
    assert qr.config_for_tokens(["aaa111"])["campaigns"] == ["X", "Y"]
    merged = qr.config_for_tokens(["AAA111", "BBB222", "CCC333"])
    assert merged == {"campaigns": ["X", "Y", "Z"], "date_from": "2026-08-01", "date_to": "2026-09-30"}
    assert qr.config_for_tokens(["CCC333"]) is None


def test_public_config_hides_audit_fields():
    cfg = {"campaigns": ["X"], "date_from": "2026-09-01", "date_to": "2026-09-30", "linked_by": "a@hypr.mobi"}
    assert qr.public_config(cfg) == {"linked": True, "campaigns": ["X"], "date_from": "2026-09-01", "date_to": "2026-09-30"}
    assert qr.public_config(None) == {"linked": False}


# ─── Relatório ───────────────────────────────────────────────────────────────
CSV = (
    '"Campaign Name","Date","Monitored Ads","Measured Impressions"\n'
    '"X","2026-09-20",10,8\n'
    '"X","2026-09-21",5,4\n'
    '"X","2026-09-19",99,99\n'
)


def test_build_report_caps_to_yesterday_filters_and_caches(monkeypatch):
    monkeypatch.setattr(dv, "yesterday_brt", lambda: date(2026, 9, 21))
    bodies = []

    def fake_run(body):
        bodies.append(body)
        return CSV

    monkeypatch.setattr(dv, "run_report", fake_run)
    cfg = {"campaigns": ["X"], "date_from": "2026-09-20", "date_to": "2026-09-30"}
    out = qr.build_report(cfg)
    assert out["from"] == "2026-09-20" and out["to"] == "2026-09-21"
    assert out["campaigns_found"] == ["X"]
    assert [r[1] for r in out["rows"]] == ["2026-09-20", "2026-09-21"]  # 19/09 fora
    dim = bodies[0]["dimensions"][0]
    assert dim["filterValues"] == ["X"] and dim["filterValuesType"] == "ExactMatch"
    assert bodies[0]["dateRange"]["to"] == "2026-09-22T00:00-03:00"
    # Segundo pedido igual vem do cache; force fura.
    qr.build_report(cfg)
    assert len(bodies) == 1
    qr.build_report(cfg, force=True)
    assert len(bodies) == 2


def test_build_report_pending_when_period_not_started(monkeypatch):
    monkeypatch.setattr(dv, "yesterday_brt", lambda: date(2026, 9, 21))
    monkeypatch.setattr(dv, "run_report", lambda body: pytest.fail("não deveria pedir à DV"))
    out = qr.build_report({"campaigns": ["X"], "date_from": "2026-10-01", "date_to": "2026-10-31"})
    assert out["pending"] is True and out["rows"] == []
