"""Serializer client-safe do Portal do Cliente (`_safe_campaign`).

Cobre o investimento consumido até hoje (`d/v_invested_to_date`), base do CPM
e CPCV efetivos "to date" do portal, e garante que a whitelist continua sem
vazar custo interno HYPR.
"""
import client_portal


def _entry(**kw):
    base = {
        "short_token": "ABC123",
        "campaign_name": "Selo",
        "start_date": "2026-09-15",
        "end_date": "2026-10-11",
        "display_viewable_impressions": 1_000_000,
        "d_client_budget": 200_000.0,
        "d_client_delivered_value": 14_400.0,
        "admin_total_cost": 5_000.0,
        "admin_ecpm": 5.0,
        "client_delivered_value": 14_400.0,
    }
    base.update(kw)
    return base


def test_invested_to_date_sai_por_midia():
    out = client_portal._safe_campaign(_entry(v_client_delivered_value=1234.567), {})
    assert out["d_invested_to_date"] == 14_400.0
    assert out["v_invested_to_date"] == 1234.57
    assert out["d_client_budget"] == 200_000.0


def test_invested_to_date_ausente_vira_none():
    e = _entry()
    e.pop("d_client_delivered_value")
    out = client_portal._safe_campaign(e, {})
    assert out["d_invested_to_date"] is None
    assert out["v_invested_to_date"] is None


def test_whitelist_nao_vaza_custo_interno():
    out = client_portal._safe_campaign(_entry(), {})
    for k in out:
        assert not k.startswith("admin_"), k
        assert "_admin_" not in k, k
    assert "client_delivered_value" not in out
