"""Testes do alerta de integrações Sheets (`sheets_alerts`).

Foco no fix do ponto cego (jun/2026): o alerta passou a cobrir também
status='error'/'revoked', não só 'active' atrasado. Cobrem a classificação da
mensagem por status e a query (que tem que incluir error/revoked).
"""
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock

import sheets_alerts as sa


def _hours_ago(h):
    return datetime.now(timezone.utc) - timedelta(hours=h)


# ─── _status_reason ──────────────────────────────────────────────────────────
def test_reason_revoked_pede_reconectar():
    r = sa._status_reason({"status": "revoked", "last_synced_at": None})
    assert "revogado" in r and "reconectar" in r


def test_reason_error_menciona_erro():
    r = sa._status_reason({"status": "error", "last_synced_at": _hours_ago(30)})
    assert "erro" in r


def test_reason_active_stale_menciona_sem_sincronizar():
    r = sa._status_reason({"status": "active", "last_synced_at": _hours_ago(40)})
    assert "sincronizar" in r


# ─── _build_email_body ───────────────────────────────────────────────────────
def test_email_body_diferencia_statuses_e_orienta_tentar_de_novo():
    items = [
        {"status": "revoked", "target_type": "merge", "target_id": "M1",
         "spreadsheet_url": "http://x", "last_synced_at": None},
        {"status": "error", "target_type": "token", "target_id": "T1",
         "spreadsheet_url": "http://y", "last_synced_at": _hours_ago(5)},
    ]
    body = sa._build_email_body(items)

    # diferencia os dois motivos
    assert "revogado" in body["text"]
    assert "erro" in body["text"]
    # orienta a ação NÃO-destrutiva primeiro
    assert "Tentar de novo" in body["text"]
    assert "Tentar de novo" in body["html"]
    # lista os dois alvos
    assert "M1" in body["html"] and "T1" in body["html"]


# ─── find_stale_integrations (query cobre error/revoked) ─────────────────────
def test_query_cobre_error_revoked_e_active_stale(monkeypatch):
    captured = {}

    class _FakeJob:
        def result(self):
            return []

    fake_client = MagicMock()
    fake_client.query.side_effect = lambda sql, *a, **k: (captured.__setitem__("sql", sql) or _FakeJob())
    monkeypatch.setattr(sa, "_bq_client", lambda: fake_client)

    sa.find_stale_integrations()

    sql = captured["sql"]
    assert "status IN ('error', 'revoked')" in sql, "blind spot: error/revoked tem que entrar no alerta"
    assert "status = 'active'" in sql
    # threshold interpolado no SQL (não fica literal "{STALE_THRESHOLD_HOURS}")
    assert f"INTERVAL {sa.STALE_THRESHOLD_HOURS} HOUR" in sql
