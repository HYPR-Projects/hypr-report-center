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
                     "publicSlug": "lojas-verao-x1", "clientName": "Cliente Demo", "size": "300x250",
                     "ctaText": "Ver lojas", "widgets": [], "hasOverlay": True, "mechanic": None,
                     "surveyMode": None, "game": None, "createdAt": "2026-08-01T00:00:00Z", "updatedAt": "2026-08-20T00:00:00Z"},
        "analytics": {
            "totals": {"impressionServed": 1000, "impression": 950, "viewable": 600, "uniqueSessions": 800,
                       "engagedSessions": 20, "ctaClick": 7, "pinClick": 9, "mapInteraction": 12,
                       "measurementRate": 0.95, "segredoInterno": 123},
            "rates": {"viewability": 0.63, "measurementRate": 0.95},
            "ctaByButton": {"directions": 4, "whatsapp": 2, "website": 1},
            "ctaBySurface": {"pin_card": 5, "nearest_card": 2, "header": 0, "overlay": 0, "split_creative": 0},
            "topPins": [{"pinId": "p1", "pinName": "Loja Moema", "lat": -23.6, "lng": -46.66, "pinClicks": 3,
                         "ctaClicks": 2, "views": 40, "ctaByButton": {"directions": 2, "whatsapp": 0, "website": 0}}],
            "scratch": None,
            "timeseries": [{"bucket": "2026-09-01", "impression": 50, "viewable": 30, "pinClick": 1, "ctaClick": 0, "engagedSessions": 2}],
            "widgets": {"items": [], "closeTo": None},
        },
        "sessionSteps": {"viewable": 590, "map_interaction": 10, "pin_click": 6, "cta_click": 5, "chave_nova": 99},
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
    assert p["preview_url"] == "https://platform.hypr.mobi/share/creatives/lojas-verao-x1?preview=1"
    assert p["dsp_creative_names"] == ["DSP A"]
    # Lista de permissão: nada interno atravessa.
    assert "measurementRate" not in p["totals"] and "segredoInterno" not in p["totals"]
    assert "chave_nova" not in p["steps"] and p["steps"]["pin_click"] == 6
    assert p["top_pins"][0]["name"] == "Loja Moema"
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


def test_search_monta_contexto_e_filtra_motivos(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []
    payload = {"items": [
        {"id": CID_A, "name": "ID-DEMO_Lojas", "status": "published", "templateSlug": "tap-to-map",
         "publicSlug": "lojas", "clientName": "Cliente Demo", "size": "300x250", "score": 180,
         "reasons": ["token", "client", "inventado"]},
        {"id": "nao-e-uuid", "name": "lixo"},
    ]}
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen(payload, seen))
    items = ma.search_creatives(client="Cliente Demo", token="demo", names=["DSP A|x", "DSP B"])
    assert "token=DEMO" in seen[0].full_url
    assert "names=DSP+A+x%7CDSP+B" in seen[0].full_url
    assert len(items) == 1 and items[0]["reasons"] == ["token", "client"]


def test_search_sem_contexto_nao_chama_platform(monkeypatch):
    monkeypatch.setenv("MA_SERVICE_KEY", "segredo")
    seen = []
    monkeypatch.setattr(ma.urllib.request, "urlopen", _fake_urlopen({"items": []}, seen))
    assert ma.search_creatives() == []
    assert seen == []
