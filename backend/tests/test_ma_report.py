"""
Testes da aba Max Attention do report (backend): validação dos vínculos, a
lista de permissão da normalização (o que o cliente pode ver), o cache por
período e o cliente HTTP da Platform (chave, erros, "não configurado").
"""
import io
import json
import urllib.error

import pytest

import ma_report as ma

CID_A = "11111111-1111-4111-8111-111111111111"
CID_B = "22222222-2222-4222-8222-222222222222"


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.delenv("MA_SERVICE_KEY", raising=False)
    monkeypatch.delenv("MA_PLATFORM_URL", raising=False)
    ma.clear_caches()
    yield
    ma.clear_caches()


# ─── configuração ──────────────────────────────────────────────────────────

def test_sem_chave_nao_esta_configurado_e_diz_o_que_fazer():
    assert ma.is_configured() is False
    with pytest.raises(ma.NotConfigured) as e:
        ma._http_get_json("/x", {})
    assert "MA_SERVICE_KEY" in str(e.value)
    assert "REPORT_CENTER_SERVICE_KEY" in str(e.value)


def test_url_da_platform_precisa_ser_https(monkeypatch):
    monkeypatch.setenv("MA_PLATFORM_URL", "http://platform.exemplo.com")
    with pytest.raises(ma.NotConfigured):
        ma.platform_url()
    monkeypatch.setenv("MA_PLATFORM_URL", "https://platform.hypr.mobi/")
    assert ma.platform_url() == "https://platform.hypr.mobi"


# ─── validação dos vínculos ────────────────────────────────────────────────

def test_sanitize_links_dedup_e_posicao():
    out = ma.sanitize_links_input([
        {"creative_id": CID_A, "name": "Lojas", "template_slug": "tap-to-map", "dsp_creative_names": ["A", "B"]},
        {"creative_id": CID_A, "name": "Duplicada"},
        {"creative_id": CID_B.upper(), "public_slug": "abc_DEF-123"},
    ])
    assert [l["creative_id"] for l in out] == [CID_A, CID_B]
    assert [l["position"] for l in out] == [0, 1]
    assert out[0]["dsp_creative_names"] == ["A", "B"]
    assert out[1]["public_slug"] == "abc_DEF-123"


@pytest.mark.parametrize("bad", [
    "não é lista",
    [{"creative_id": "123"}],
    [{"creative_id": "11111111-1111-4111-8111-11111111111Z"}],
    ["string solta"],
])
def test_sanitize_links_recusa_entrada_invalida(bad):
    with pytest.raises(ValueError):
        ma.sanitize_links_input(bad)


def test_sanitize_links_limita_quantidade():
    links = [{"creative_id": f"{i:08x}-1111-4111-8111-111111111111"} for i in range(ma.MAX_PIECES + 1)]
    with pytest.raises(ValueError):
        ma.sanitize_links_input(links)


def test_slug_com_caractere_estranho_e_descartado():
    out = ma.sanitize_links_input([{"creative_id": CID_A, "public_slug": "../../etc"}])
    assert out[0]["public_slug"] == ""


@pytest.mark.parametrize("tok,ok", [("FXR5US", True), ("demo", True), ("AB", False), ("ABC-123", False), ("", False), (None, False)])
def test_valid_token(tok, ok):
    assert ma.valid_token(tok) is ok


@pytest.mark.parametrize("d,ok", [("2026-09-01", True), ("2026-02-30", False), ("2026-9-1", False), ("", False), (None, False)])
def test_valid_date(d, ok):
    assert ma.valid_date(d) is ok


# ─── BigQuery (fake) ───────────────────────────────────────────────────────

class _Job:
    def __init__(self, rows=None):
        self._rows = rows or []

    def result(self):
        return self._rows


class FakeBQ:
    def __init__(self, rows=None):
        self.calls = []
        self.rows = rows or []

    def query(self, sql, job_config=None):
        self.calls.append((sql, job_config))
        if sql.strip().upper().startswith("SELECT"):
            return _Job(self.rows)
        return _Job([])


@pytest.fixture
def fake_bq(monkeypatch):
    bq = FakeBQ()
    monkeypatch.setattr(ma, "_bq", lambda: bq)
    monkeypatch.setattr(ma, "_table_ensured", True)
    return bq


def test_save_links_usa_transacao_e_invalida_cache(fake_bq):
    ma._cset(ma._links_cache, "all", {"DEMO": []})
    saved = ma.save_links("demo", [{"creative_id": CID_A, "name": "Lojas"}], linked_by="ana@hypr.mobi")
    sql, jc = fake_bq.calls[-1]
    assert "BEGIN TRANSACTION" in sql and "COMMIT TRANSACTION" in sql
    assert "DELETE FROM" in sql and "INSERT INTO" in sql
    names = {p.name for p in jc.query_parameters}
    assert {"token", "rows", "by"} <= names
    token = next(p for p in jc.query_parameters if p.name == "token")
    assert token.value == "DEMO"
    assert saved[0]["creative_id"] == CID_A and saved[0]["linked_by"] == "ana@hypr.mobi"
    assert ma._cget(ma._links_cache, "all", ma.LINKS_TTL) is None


def test_save_links_vazio_so_apaga(fake_bq):
    ma.save_links("DEMO", [])
    sql, _ = fake_bq.calls[-1]
    assert sql.strip().startswith("DELETE FROM")
    assert "INSERT" not in sql


def test_save_links_recusa_token_invalido(fake_bq):
    with pytest.raises(ValueError):
        ma.save_links("X", [])


def test_links_for_tokens_une_meses_sem_repetir_peca(fake_bq):
    fake_bq.rows = [
        {"short_token": "ABR001", "creative_id": CID_A, "position": 0, "name": "Lojas", "dsp_creative_names": '["DSP A"]'},
        {"short_token": "MAI001", "creative_id": CID_A, "position": 0, "name": "Lojas (maio)"},
        {"short_token": "MAI001", "creative_id": CID_B, "position": 1, "name": "Carrossel"},
    ]
    out = ma.links_for_tokens(["abr001", "MAI001"])
    assert [l["creative_id"] for l in out] == [CID_A, CID_B]
    assert out[0]["name"] == "Lojas"
    assert out[0]["dsp_creative_names"] == ["DSP A"]
    pub = ma.public_link(out[0])
    assert set(pub) == {"creative_id", "name", "format", "size", "public_slug", "dsp_creative_names"}


# ─── HTTP (fake urlopen) ───────────────────────────────────────────────────

class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _item(cid, **over):
    base = {
        "id": cid, "ok": True,
        "creative": {"id": cid, "name": "Lojas Verão", "status": "published", "templateSlug": "tap-to-map",
                     "publicSlug": "lojas-verao-x1", "clientName": "Cliente Demo",
                     "size": {"width": 300, "height": 250, "preset": "300x250", "label": "300x250"},
                     "ctaText": "Ver lojas", "widgets": [], "hasOverlay": True, "mechanic": None,
                     "surveyMode": None, "game": None, "createdAt": "2026-08-01T00:00:00Z", "updatedAt": "2026-08-20T00:00:00Z"},
        "analytics": {
            "totals": {"impressionServed": 1000, "impression": 950, "viewable": 600, "uniqueSessions": 800,
                       "engagedSessions": 20, "ctaClick": 7, "pinClick": 9, "mapInteraction": 12,
                       "measurementRate": 0.95, "segredoInterno": 123},
            "rates": {"viewability": 0.63, "measurementRate": 0.95},
            "ctaByButton": {"directions": 4, "whatsapp": 2, "website": 1},
            "ctaBySurface": {"pin_card": 5, "nearest_card": 2, "header": 0, "overlay": 0, "split_creative": 0},
            "topPins": [{"pinId": "p1", "pinName": "Loja Moema", "latitude": -23.6, "longitude": -46.66, "pinClicks": 3,
                         "ctaClicks": 2, "views": 40, "ctaByButton": {"directions": 2, "whatsapp": 0, "website": 0}}],
            "scratch": None,
            "timeseries": [{"bucket": "2026-09-01", "impression": 50, "viewable": 30, "pinClick": 1, "ctaClick": 0, "engagedSessions": 2}],
            "widgets": {"items": [], "closeTo": None},
        },
        "sessionSteps": {"viewable": 590, "map_interaction": 10, "pin_click": 6, "cta_click": 5,
                         "cta_location": 4, "close_to_found": 0, "chave_nova": 99},
    }
    base.update(over)
    return base


def _fake_urlopen(payload, seen):
    def fn(req, timeout=None):
        seen.append(req)
        return _Resp(json.dumps(payload).encode())
    return fn


def test_fetch_pieces_manda_chave_e_normaliza(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen({"items": [_item(CID_A)]}, seen))
    res = ma.fetch_pieces([{"creative_id": CID_A, "dsp_creative_names": ["DSP A"]}], "2026-09-01", "2026-09-22")
    req = seen[0]
    assert req.get_header("X-service-key") == "segredo"
    assert "ids=" + CID_A in req.full_url and "from=2026-09-01" in req.full_url
    assert res["errors"] == []
    p = res["pieces"][0]
    assert p["format"] == "tap-to-map" and p["size"] == "300x250"
    assert p["width"] == 300 and p["height"] == 250
    assert p["preview_url"] == "https://platform.hypr.mobi/share/creatives/lojas-verao-x1?preview=1"
    assert p["dsp_creative_names"] == ["DSP A"]
    # Lista de permissão: nada interno atravessa.
    assert "measurementRate" not in p["totals"] and "segredoInterno" not in p["totals"]
    assert "chave_nova" not in p["steps"] and p["steps"]["pin_click"] == 6
    assert p["steps"]["cta_location"] == 4
    assert p["top_pins"][0]["name"] == "Loja Moema"
    assert p["top_pins"][0]["lat"] == -23.6 and p["top_pins"][0]["lng"] == -46.66
    assert p["daily"][0] == {"date": "2026-09-01", "impressions": 50, "viewable": 30, "pin_clicks": 1, "cta_clicks": 0, "engaged_sessions": 2}
    assert "rates" not in p


def test_fetch_pieces_cacheia_por_periodo(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen({"items": [_item(CID_A)]}, seen))
    links = [{"creative_id": CID_A}]
    ma.fetch_pieces(links, "2026-09-01", "2026-09-22")
    ma.fetch_pieces(links, "2026-09-01", "2026-09-22")
    assert len(seen) == 1
    ma.fetch_pieces(links, "2026-09-10", "2026-09-22")
    assert len(seen) == 2


def test_peca_arquivada_nao_tem_preview_e_item_com_erro_vira_errors(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    arch = _item(CID_A)
    arch["creative"]["status"] = "archived"
    payload = {"items": [arch, {"id": CID_B, "ok": False, "error": "not_found"}]}
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen(payload, []))
    res = ma.fetch_pieces([{"creative_id": CID_A}, {"creative_id": CID_B, "name": "Sumiu"}])
    assert res["pieces"][0]["preview_url"] is None
    assert res["errors"] == [{"creative_id": CID_B, "name": "Sumiu", "error": "not_found"}]


def test_session_steps_nulo_continua_valido(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen({"items": [_item(CID_A, sessionSteps=None)]}, []))
    p = ma.fetch_pieces([{"creative_id": CID_A}])["pieces"][0]
    assert p["steps"] is None


def test_erro_http_vira_platform_error(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")

    def boom(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, io.BytesIO(b'{"error":"x"}'))
    monkeypatch.setattr(ma.urllib.request, "urlopen", boom)
    with pytest.raises(ma.PlatformError) as e:
        ma.fetch_pieces([{"creative_id": CID_A}])
    assert "401" in str(e.value)


def _main_call(seen):
    """A chamada de contexto (a que leva `names`/`client`), entre as extras."""
    return next(r for r in seen if "client=" in r.full_url or "names=" in r.full_url)


def test_search_monta_contexto_e_filtra_motivos(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []
    payload = {"items": [
        {"id": CID_A, "name": "ID-DEMO_Lojas", "status": "published", "templateSlug": "tap-to-map",
         "publicSlug": "lojas", "clientName": "Cliente Demo",
         "size": {"width": 300, "height": 250, "preset": "300x250", "label": "300x250"}, "score": 180,
         "reasons": ["token", "client", "inventado"],
         "match": {"dspCreativeIds": ["123"], "name": None, "nameSimilarity": None}},
        {"id": "nao-e-uuid", "name": "lixo"},
    ]}
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen(payload, seen))
    items = ma.search_creatives(client="Cliente Demo", token="demo", names=["DSP A|x", "DSP B"])
    main = _main_call(seen)
    assert "token=DEMO" in main.full_url
    # Linha criativa (sem tamanho, maiúscula), "|" vira espaço.
    assert "names=DSP+A+X%7CDSP+B" in main.full_url
    assert len(items) == 1 and items[0]["reasons"] == ["token", "client"]
    assert items[0]["size"] == "300x250"
    assert items[0]["match_dsp_ids"] == ["123"]


def test_search_acha_peca_que_a_nota_da_platform_descartava(monkeypatch):
    """Caso MobLand: a Platform só devolve a peça na busca por TEXTO do termo
    da campanha (a nota de nome dela não passa), e o RC casa a linha."""
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []

    def fn(req, timeout=None):
        seen.append(req)
        items = []
        if "q=mobland" in req.full_url:
            items = [{"id": CID_A, "name": "MobLand - Carrossel", "reasons": ["query"], "updatedAt": "2026-05-01"},
                     {"id": CID_B, "name": "Mobland Reveal Tiros", "reasons": ["query"], "updatedAt": "2026-05-02"}]
        return _Resp(json.dumps({"items": items}).encode())
    monkeypatch.setattr(ma.urllib.request, "urlopen", fn)
    lines = [
        {"line": "HYPR_MOBLAND_PARAMOUNT_CAROUSEL", "names": ["HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300x600", "HYPR_MOBLAND_PARAMOUNT_CAROUSEL_300x250"], "impressions": 10},
        {"line": "HYPR_MOBLAND_PARAMOUNT_REVEAL_TIROS", "names": ["HYPR_MOBLAND_PARAMOUNT_REVEAL_TIROS_300x250"], "impressions": 5},
        {"line": "HYPR_MOBLAND_PARAMOUNT_REVEAL_GRAFITE", "names": ["HYPR_MOBLAND_PARAMOUNT_REVEAL_GRAFITE_300x250"], "impressions": 4},
    ]
    items = ma.search_creatives(client="Paramount", token="O3HI21", lines=lines, campaign_name="MobLand")
    by_id = {it["creative_id"]: it for it in items}
    car = by_id[CID_A]
    assert "name" in car["reasons"] and "campaign" in car["reasons"] and "query" not in car["reasons"]
    assert car["dsp_lines"] == ["HYPR_MOBLAND_PARAMOUNT_CAROUSEL"]
    # Todos os tamanhos da linha entram no vínculo, não só o primeiro.
    assert len(car["dsp_creative_names"]) == 2
    assert by_id[CID_B]["dsp_lines"] == ["HYPR_MOBLAND_PARAMOUNT_REVEAL_TIROS"]
    assert any("q=mobland" in r.full_url for r in seen)


def test_search_extra_que_falha_nao_derruba_a_principal(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")

    def fn(req, timeout=None):
        if "q=mobland" in req.full_url:
            raise urllib.error.URLError("caiu")
        return _Resp(json.dumps({"items": [{"id": CID_A, "name": "ID-O3HI21_Peça", "reasons": ["token"]}]}).encode())
    monkeypatch.setattr(ma.urllib.request, "urlopen", fn)
    items = ma.search_creatives(token="O3HI21", campaign_name="MobLand", lines=[])
    assert [it["creative_id"] for it in items] == [CID_A]


def test_search_digitada_marca_query_so_quando_bate(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    payload = {"items": [{"id": CID_A, "name": "MobLand - Carrossel", "reasons": ["query"]},
                         {"id": CID_B, "name": "Outra peça", "reasons": ["client"], "clientName": "Paramount"}]}
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen(payload, []))
    items = ma.search_creatives(q="mobland carrossel", client="Paramount")
    by_id = {it["creative_id"]: it for it in items}
    assert "query" in by_id[CID_A]["reasons"]
    assert by_id[CID_B]["reasons"] == ["client"]
    assert items[0]["creative_id"] == CID_A


def test_search_sem_contexto_nao_chama_platform(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen({"items": []}, seen))
    assert ma.search_creatives() == []
    assert seen == []


def test_formatos_ricos_seguem_o_contrato_da_platform(monkeypatch):
    """Nomes de campo do CreativeAnalyticsDTO (service.ts da Platform)."""
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    item = _item(CID_A)
    a = item["analytics"]
    a["carrossel"] = {
        "slideChanges": 40, "swipes": 55, "navSessions": 30,
        "navBySurface": {"swipe": 25, "arrow": 10, "dot": 5},
        "ctaSlide": 6, "ctaBackground": 1, "ctaButton": 3,
        "topSlides": [{"slideIndex": 2, "slideLabel": "Óculos", "views": 18, "ctaClicks": 4}],
    }
    a["survey"] = {
        "answeredSessions": 12, "avgTimeToAnswerMs": None, "ctaPayoff": 2, "ctaButton": 1,
        "ctaQuestion": 0, "ctaOption": 0, "completedSessions": 0, "avgTimeToCompleteMs": None,
        "topOptions": [{"optionId": "o1", "optionLabel": "Sim", "answers": 9, "ctaClicks": 1}],
    }
    a["play"] = {"playedSessions": 8, "completedSessions": 5, "avgScore": 12.5, "avgHits": None,
                 "avgAttempts": None, "avgPlayTimeMs": 30000, "revealSessions": 4, "replays": 2,
                 "challengeWonSessions": 1, "challengePlayed": 3, "ctaPostGame": 2, "ctaButton": 1}
    a["widgets"] = {
        "items": [
            {"widgetId": "w1", "widgetType": "close_to", "enabled": True, "views": 100, "taps": 20,
             "tapSessions": 18, "conversions": 7},
            {"widgetId": "w2", "widgetType": "countdown", "enabled": False, "views": 0, "taps": 0,
             "tapSessions": 0, "conversions": 0},
        ],
        "closeTo": {
            "views": 100, "locate": 20, "locateSessions": 18, "gpsGranted": 6, "gpsDenied": 2,
            "foundPrecise": 5, "foundApprox": 11, "foundSessions": 16, "redirects": 7,
            "redirectMap": 5, "redirectUrl": 2, "redirectSessions": 7,
            "unresolvedIdentified": 0, "unresolvedClicks": 0,
            "addresses": [{"pinId": "a1", "name": "Loja Centro", "address": "Rua X, 10",
                           "latitude": -23.5, "longitude": -46.6, "identified": 9, "clicks": 4,
                           "directions": 3, "website": 1}],
        },
    }
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen({"items": [item]}, []))
    p = ma.fetch_pieces([{"creative_id": CID_A}])["pieces"][0]

    assert p["carousel"]["top_slides"] == [{"index": 2, "label": "Óculos", "views": 18, "clicks": 4}]
    assert p["carousel"]["nav_by_surface"] == {"swipe": 25, "arrow": 10, "dot": 5}
    assert p["survey"]["top_options"] == [{"label": "Sim", "answers": 9, "clicks": 1}]
    assert p["survey"]["avgTimeToAnswerMs"] is None
    assert p["game"]["challengeWonSessions"] == 1 and p["game"]["avgHits"] is None
    assert p["game_type"] is None
    # Widget desligado e sem evento some; o ligado passa com as conversões.
    assert p["widgets"] == [{"id": "w1", "type": "close_to", "views": 100, "taps": 20,
                             "tap_sessions": 18, "conversions": 7}]
    ct = p["close_to"]
    assert ct["foundApprox"] == 11 and ct["foundPrecise"] == 5 and ct["redirectMap"] == 5
    assert ct["addresses"][0] == {"name": "Loja Centro", "address": "Rua X, 10", "lat": -23.5, "lng": -46.6,
                                  "identified": 9, "clicks": 4, "directions": 3, "website": 1}


def test_slider_legado_vira_carrossel_em_todas_as_pontas(monkeypatch, fake_bq):
    # A Platform ainda tem peças com template "slider" (carrossel antigo, mesmo
    # runtime). O report só conhece "carrossel": sem isso a peça perdia funil,
    # blocos do formato e a cor da série.
    assert ma.canonical_format("slider") == "carrossel"
    assert ma.canonical_format(" tap-to-map ") == "tap-to-map"
    assert ma.canonical_format(None) == ""
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    item = _item(CID_A)
    item["creative"]["templateSlug"] = "slider"
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen({"items": [item]}, []))
    p = ma.fetch_pieces([{"creative_id": CID_A, "template_slug": "slider"}])["pieces"][0]
    assert p["format"] == "carrossel"
    assert ma.public_link({"creative_id": CID_A, "template_slug": "slider"})["format"] == "carrossel"
    saved = ma.sanitize_links_input([{"creative_id": CID_A, "template_slug": "slider"}])
    assert saved[0]["template_slug"] == "carrossel"


# ─── contrato com a Platform (resposta completa, todos os formatos) ────────
#
# fixtures/platform_report_center_creatives.json foi gerado com os TIPOS da
# Platform (ReportCenterCreativesResponse / CreativeAnalyticsDTO /
# FunnelSessions, com `tsc` sem erro no o2o-platform): campo a mais, a menos
# ou com outro nome não compila lá. Um item por formato + peça sem funil +
# peça apagada. Se a Platform mudar o DTO, regere o fixture do mesmo jeito e
# este teste mostra o que mudou do lado do report.

import os as _os

_FIXTURE = _os.path.join(_os.path.dirname(__file__), "fixtures", "platform_report_center_creatives.json")


def _contract_links():
    ids = [it["id"] for it in json.load(open(_FIXTURE, encoding="utf-8"))["items"]]
    return [{"creative_id": cid, "name": f"peça {i}"} for i, cid in enumerate(ids)]


def test_contrato_platform_normaliza_todos_os_formatos(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    sample = json.load(open(_FIXTURE, encoding="utf-8"))
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen(sample, []))
    res = ma.fetch_pieces(_contract_links(), "2026-09-01", "2026-09-22")

    assert [e["error"] for e in res["errors"]] == ["not_found"]
    by = {p["name"]: p for p in res["pieces"]}
    assert len(by) == 7
    formats = sorted(p["format"] for p in res["pieces"])
    assert formats == ["carrossel", "freeform", "play", "scratch", "survey", "tap-to-map", "tap-to-map"]

    for p in res["pieces"]:
        # Nada fora da lista de permissão chega no navegador.
        assert "rates" not in p and "avgDwellMs" not in p and "granularity" not in p
        assert len(p["daily"]) == 22 and p["daily"][0]["date"] == "2026-09-01"
        assert p["preview_url"] and p["width"] and p["height"]

    mapa = by["Lojas Verão SP"]
    assert mapa["steps"]["cta_location"] == 2600 and mapa["steps"]["close_to_found"] == 4300
    assert [w["type"] for w in mapa["widgets"]] == ["close_to", "add_to_calendar", "countdown"]  # desligado sem evento sai
    ct = mapa["close_to"]
    assert ct["foundPrecise"] == 1600 and ct["foundApprox"] == 2900 and ct["redirectMap"] == 1300
    assert ct["addresses"][0] == {"name": "Loja Moema", "address": "Av. Ibirapuera, 3103", "lat": -23.6009,
                                  "lng": -46.6623, "identified": 1500, "clicks": 640, "directions": 450, "website": 190}
    assert mapa["calendar"] == {"adds": 830, "opens": 610}
    assert mapa["top_pins"][3]["name"] == "" and mapa["top_pins"][3]["lat"] is None  # sem nome: nunca o id interno
    assert mapa["totals"]["impressionServed"] == 212000 and mapa["has_overlay"] is True

    car = by["Vitrine Linha Solar (slider antigo)"]
    assert car["format"] == "carrossel"
    assert car["carousel"]["nav_by_surface"] == {"swipe": 14000, "arrow": 5000, "dot": 2000}
    assert car["carousel"]["top_slides"][2] == {"index": 0, "label": "", "views": 2100, "clicks": 150}

    tilt = by["Incline e descubra"]
    assert tilt["mechanic"] == "tilt" and tilt["scratch"]["tiltActivatedSessions"] == 9800
    assert tilt["steps"]["tilt_activated"] == 9800

    poll = by["Qual seu protetor?"]
    assert poll["survey_mode"] == "poll" and poll["survey"]["completedSessions"] == 4700
    assert poll["survey"]["top_options"][1] == {"label": "FPS 50", "answers": 3100, "clicks": 210}

    jogo = by["Cesta do Verão"]
    assert jogo["game_type"] == "basquete" and jogo["game"]["challengeWonSessions"] == 2100
    assert jogo["game"]["avgScore"] == 7.4

    video = by["Filme Verão 15s (Free Form)"]
    assert video["freeform"]["videoComplete"] == 17000 and video["steps"]["video_complete"] == 16100

    assert by["Mapa sem lake (funil indisponível)"]["steps"] is None


# ─── Cache por peça, lotes paralelos, servir vencido ───────────────────────

def _ids_urlopen(seen, fail_ids=()):
    """Platform falsa que responde só os ids pedidos (e cai nos `fail_ids`)."""
    import urllib.parse as up

    def fn(req, timeout=None):
        ids = up.parse_qs(up.urlparse(req.full_url).query)["ids"][0].split(",")
        seen.append(ids)
        if any(i in fail_ids for i in ids):
            raise urllib.error.URLError("caiu")
        return _Resp(json.dumps({"items": [_item(i) for i in ids]}).encode())
    return fn


def _cid(n):
    return f"{n:08d}-1111-4111-8111-111111111111"


def test_pecas_vao_em_lotes_paralelos(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []
    monkeypatch.setattr(ma.urllib.request, "urlopen", _ids_urlopen(seen))
    links = [{"creative_id": _cid(i)} for i in range(7)]
    res = ma.fetch_pieces(links)
    assert len(res["pieces"]) == 7 and res["errors"] == []
    assert sorted(len(c) for c in seen) == [1, 3, 3]
    # Ordem do vínculo preservada, apesar dos lotes.
    assert [p["creative_id"] for p in res["pieces"]] == [l["creative_id"] for l in links]


def test_peca_nova_busca_so_ela(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []
    monkeypatch.setattr(ma.urllib.request, "urlopen", _ids_urlopen(seen))
    ma.fetch_pieces([{"creative_id": CID_A}])
    ma.fetch_pieces([{"creative_id": CID_A}, {"creative_id": CID_B}])
    assert seen == [[CID_A], [CID_B]]


def test_vencido_serve_na_hora_e_atualiza_por_tras(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []
    monkeypatch.setattr(ma.urllib.request, "urlopen", _ids_urlopen(seen))
    ma.fetch_pieces([{"creative_id": CID_A}])
    key = ma._piece_key(CID_A, None, None)
    ts, entry = ma._pieces_cache[key]
    ma._pieces_cache[key] = (ts - ma.PIECES_TTL - 1, entry)  # envelhece
    res = ma.fetch_pieces([{"creative_id": CID_A}])
    assert len(res["pieces"]) == 1 and res["fetched_at"] == entry["fetched_at"]
    ma._revalidate_pool.submit(lambda: None).result(timeout=5)  # drena a fila
    for _ in range(50):
        if len(seen) == 2 and not ma._revalidating:
            break
        import time as _t
        _t.sleep(0.02)
    assert len(seen) == 2
    assert ma._pieces_cache[key][0] > ts


def test_velho_demais_espera_a_platform(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []
    monkeypatch.setattr(ma.urllib.request, "urlopen", _ids_urlopen(seen))
    ma.fetch_pieces([{"creative_id": CID_A}])
    key = ma._piece_key(CID_A, None, None)
    ts, entry = ma._pieces_cache[key]
    ma._pieces_cache[key] = (ts - ma.PIECES_STALE_TTL - 1, entry)
    ma.fetch_pieces([{"creative_id": CID_A}])
    assert len(seen) == 2


def test_lote_que_cai_vira_erro_so_das_pecas_dele(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    links = [{"creative_id": _cid(i), "name": f"P{i}"} for i in range(6)]
    monkeypatch.setattr(ma.urllib.request, "urlopen", _ids_urlopen([], fail_ids={_cid(4)}))
    res = ma.fetch_pieces(links)
    assert len(res["pieces"]) == 3
    assert sorted(e["creative_id"] for e in res["errors"]) == [_cid(3), _cid(4), _cid(5)]
    assert all(e["error"] == "missing" for e in res["errors"])


def test_refresh_fura_so_as_pecas_pedidas(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []
    monkeypatch.setattr(ma.urllib.request, "urlopen", _ids_urlopen(seen))
    ma.fetch_pieces([{"creative_id": CID_A}])
    ma.fetch_pieces([{"creative_id": CID_B}])
    ma.fetch_pieces([{"creative_id": CID_A}], refresh=True)
    ma.fetch_pieces([{"creative_id": CID_B}])
    assert seen == [[CID_A], [CID_B], [CID_A]]


def test_erro_interno_da_platform_nao_fica_no_cache(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []
    payload = {"items": [{"id": CID_A, "ok": False, "error": "internal"}]}
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen(payload, seen))
    assert ma.fetch_pieces([{"creative_id": CID_A}])["errors"][0]["error"] == "internal"
    ma.fetch_pieces([{"creative_id": CID_A}])
    assert len(seen) == 2
