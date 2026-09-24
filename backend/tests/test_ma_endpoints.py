"""
Roteamento dos endpoints da aba Max Attention em `report_data`: validação de
parâmetros, portão admin, "não configurado" e o anexo dos vínculos no payload
servido. As dependências externas (BigQuery, Platform) são substituídas.
"""
import json

import flask
import pytest

import main
import ma_report

CID = "11111111-1111-4111-8111-111111111111"
app = flask.Flask(__name__)


def call(path, method="GET", body=None, headers=None):
    with app.test_request_context(path, method=method, json=body, headers=headers or {}):
        rv = main.report_data(flask.request)
    resp, status = rv[0], rv[1]
    data = resp.get_json() if hasattr(resp, "get_json") else json.loads(resp)
    return status, data


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.delenv("MA_SERVICE_KEY", raising=False)
    ma_report.clear_caches()
    monkeypatch.setattr(main, "authenticate_admin", lambda req: None)
    yield
    ma_report.clear_caches()


def test_ma_report_recusa_token_invalido():
    status, data = call("/?action=ma_report&token=x")
    assert status == 400


def test_ma_report_recusa_periodo_invalido(monkeypatch):
    status, _ = call("/?action=ma_report&token=DEMO01&date_from=2026-02-30")
    assert status == 400


def test_ma_report_sem_config_devolve_links_e_configured_false(monkeypatch):
    monkeypatch.setattr(ma_report, "links_for_tokens", lambda toks: [{"creative_id": CID, "name": "Lojas", "template_slug": "tap-to-map"}])
    called = []
    monkeypatch.setattr(ma_report, "fetch_pieces", lambda *a, **k: called.append(1))
    status, data = call("/?action=ma_report&token=DEMO01")
    assert status == 200
    assert data["configured"] is False
    assert data["links"][0]["creative_id"] == CID and data["links"][0]["format"] == "tap-to-map"
    assert data["pieces"] == [] and called == []


def test_ma_report_configurado_busca_pecas(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "k")
    monkeypatch.setattr(ma_report, "links_for_tokens", lambda toks: [{"creative_id": CID}])
    seen = {}

    def fake_fetch(links, date_from, date_to):
        seen.update(date_from=date_from, date_to=date_to)
        return {"pieces": [{"creative_id": CID}], "errors": [], "fetched_at": "2026-09-23T10:00:00+00:00"}
    monkeypatch.setattr(ma_report, "fetch_pieces", fake_fetch)
    status, data = call("/?action=ma_report&token=DEMO01&date_from=2026-09-01&date_to=2026-09-22")
    assert status == 200 and data["configured"] is True
    assert data["pieces"][0]["creative_id"] == CID
    assert seen == {"date_from": "2026-09-01", "date_to": "2026-09-22"}


def test_ma_report_erro_da_platform_vira_502_sem_detalhe_interno(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "k")
    monkeypatch.setattr(ma_report, "links_for_tokens", lambda toks: [{"creative_id": CID}])

    def boom(*a, **k):
        raise ma_report.PlatformError("Platform HTTP 500 em /x: stacktrace interno")
    monkeypatch.setattr(ma_report, "fetch_pieces", boom)
    status, data = call("/?action=ma_report&token=DEMO01")
    assert status == 502
    assert "stacktrace" not in data["error"]


def test_visao_agregada_usa_todos_os_membros(monkeypatch):
    monkeypatch.setattr(main, "_safe_get_merges", lambda: {"ABR001": {"merge_id": "m1"}})
    monkeypatch.setattr(main.merges, "get_merge_group", lambda mid: {"members": [{"short_token": "ABR001"}, {"short_token": "MAI001"}]})
    assert main._ma_tokens_for_view("ABR001", "aggregated") == ["ABR001", "MAI001"]
    assert main._ma_tokens_for_view("ABR001", "MAI001") == ["MAI001"]
    assert main._ma_tokens_for_view("ABR001", "") == ["ABR001"]


def test_ma_links_e_save_exigem_admin():
    assert call("/?action=ma_links&token=DEMO01")[0] == 401
    assert call("/?action=ma_links_save", method="POST", body={"short_token": "DEMO01", "links": []})[0] == 401
    assert call("/?action=ma_search&token=DEMO01&q=x")[0] == 401


def test_ma_links_save_admin_valida_e_salva(monkeypatch):
    monkeypatch.setattr(main, "authenticate_admin", lambda req: {"email": "ana@hypr.mobi", "admin": True})
    got = {}

    def fake_save(token, links, linked_by=None):
        got.update(token=token, links=links, by=linked_by)
        return [{"creative_id": CID}]
    monkeypatch.setattr(ma_report, "save_links", fake_save)
    monkeypatch.setattr(main.audit_log, "safe_write_event", lambda **k: got.setdefault("audit", k))
    status, data = call("/?action=ma_links_save", method="POST", body={"short_token": "DEMO01", "links": [{"creative_id": CID}]})
    assert status == 200 and data["links"][0]["creative_id"] == CID
    assert got["by"] == "ana@hypr.mobi" and got["audit"]["event_type"] == "ma_links_saved"


def test_ma_links_save_erro_de_validacao_vira_400(monkeypatch):
    monkeypatch.setattr(main, "authenticate_admin", lambda req: {"email": "ana@hypr.mobi", "admin": True})

    def bad(*a, **k):
        raise ValueError("links[0].creative_id inválido")
    monkeypatch.setattr(ma_report, "save_links", bad)
    status, data = call("/?action=ma_links_save", method="POST", body={"short_token": "DEMO01", "links": [{"creative_id": "x"}]})
    assert status == 400 and "creative_id" in data["error"]


def test_ma_search_sem_config_e_501_com_instrucao(monkeypatch):
    monkeypatch.setattr(main, "authenticate_admin", lambda req: {"email": "ana@hypr.mobi", "admin": True})
    report = {"campaign": {"client_name": "PARAMOUNT", "campaign_name": "MobLand"}, "detail": [
        {"creative_name": "HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300X250", "creative_size": "300x250", "impressions": 7}]}
    monkeypatch.setattr(main, "_get_report_cached", lambda tok, force_refresh=False: (report, True))
    status, data = call("/?action=ma_search&token=DEMO01&q=lojas")
    assert status == 501 and data["configured"] is False
    assert "MA_SERVICE_KEY" in data["error"]
    # Sem chave, as linhas da DSP ainda chegam (vêm do report, não da Platform).
    assert data["context"]["lines"][0]["line"] == "HYPR_MOBLAND_PARAMOUNT_CAROUSEL"


def test_ma_search_usa_cliente_e_linhas_do_report(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "k")
    monkeypatch.setattr(main, "authenticate_admin", lambda req: {"email": "ana@hypr.mobi", "admin": True})
    report = {"campaign": {"client_name": "Paramount", "campaign_name": "MobLand"}, "detail": [
        {"creative_name": "HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300x600", "creative_size": "300x600", "impressions": 10},
        {"creative_name": "HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300x250", "creative_size": "300x250", "impressions": 5},
    ]}
    monkeypatch.setattr(main, "_get_report_cached", lambda tok, force_refresh=False: (report, True))
    # A lista de campanhas não é consultada quando o report já diz o cliente.
    monkeypatch.setattr(main, "_client_name_for_token", lambda tok: (_ for _ in ()).throw(AssertionError("não devia")))
    got = {}

    def fake_search(**kw):
        got.update(kw)
        return []
    monkeypatch.setattr(ma_report, "search_creatives", fake_search)
    status, data = call("/?action=ma_search&token=O3HI21")
    assert status == 200
    assert got["client"] == "Paramount" and got["campaign_name"] == "MobLand"
    assert [e["line"] for e in got["lines"]] == ["HYPR_MOBLAND_PARAMOUNT_CAROUSEL"]
    ctx = data["context"]
    assert ctx["client"] == "Paramount" and ctx["terms"] == ["mobland", "paramount"]
    assert ctx["lines"][0]["impressions"] == 15 and len(ctx["dsp_creative_names"]) == 2


def test_attach_max_attention_nunca_derruba_o_report(monkeypatch):
    def boom(tokens):
        raise RuntimeError("bq fora")
    monkeypatch.setattr(ma_report, "links_for_tokens", boom)
    data = {"campaign": {"short_token": "DEMO01"}}
    assert main._attach_max_attention(data, ["DEMO01"]) == data


def test_attach_max_attention_anexa_links_publicos(monkeypatch):
    monkeypatch.setattr(ma_report, "links_for_tokens", lambda toks: [{"creative_id": CID, "name": "Lojas", "linked_by": "ana@hypr.mobi"}])
    out = main._attach_max_attention({"campaign": {}}, ["DEMO01"])
    link = out["max_attention"]["links"][0]
    assert link["creative_id"] == CID and "linked_by" not in link
    assert out["max_attention"]["configured"] is False


def test_attach_data_freshness(monkeypatch):
    monkeypatch.setattr(main, "_base_version", lambda: (1758622320000, 1))
    assert main._attach_data_freshness({})["data_updated_at"] == 1758622320000
    monkeypatch.setattr(main, "_base_version", lambda: (None, None))
    assert "data_updated_at" not in main._attach_data_freshness({})
