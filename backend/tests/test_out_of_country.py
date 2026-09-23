"""Régua do box "Fora do BR" (out_of_country).

O que se crava aqui:
  - o país previsto no nome da line (Elux Chile/Peru/Colômbia) não conta
    como entrega fora — e sigla solta ("PE" de Pernambuco) não libera nada;
  - a taxa é UNEXPECTED / total, com EXPECTED e UNKNOWN à parte;
  - o alerta dispara em salto de verdade e NÃO dispara em oscilação normal.

Sem BigQuery: `build_payload` é pura. O SQL só é checado quanto à forma.
"""
from datetime import date, datetime, timedelta, timezone

import pytest

import out_of_country as ooc


# ── País previsto no nome da line ──────────────────────────────────────────

@pytest.mark.parametrize("line,expected", [
    ("ID-ABC123_HYPR_ELUX_LAVADORAS_DISPLAY_O2O_CHILE_LI-MAX", {"CL"}),
    ("ID-ABC123_ELUX_PERU-COLOMBIA_VIDEO", {"PE", "CO"}),
    ("ID-ABC123_ELUX_COLÔMBIA_VIDEO", {"CO"}),
    ("ID-ABC123_ELUX_MÉXICO_DISPLAY", {"MX"}),
    ("ID-ABC123_MARCA_COSTA_RICA_DISPLAY", {"CR"}),
    ("ID-ABC123_MARCA_ESTADOS UNIDOS_DISPLAY", {"US"}),
    # Sigla não libera: PE é Pernambuco, CO/AR aparecem por outros motivos.
    ("ID-ABC123_HYPR_VAREJO_PE_RECIFE_DISPLAY", set()),
    ("ID-ABC123_HYPR_CO_BRANDING_AR_LIVRE", set()),
    # Substring não é palavra: CHILENO/PERUANO não é o país.
    ("ID-ABC123_RESTAURANTE_CHILENO_PERUANOS", set()),
    ("", set()),
    (None, set()),
])
def test_expected_countries(line, expected):
    assert ooc.expected_countries(line) == expected


def test_sql_mirrors_aliases():
    sql = ooc.build_sql()
    for code, aliases in ooc.COUNTRY_ALIASES.items():
        assert f"country = '{code}'" in sql
        for alias in aliases:
            assert alias.replace(" ", "[^A-Z0-9]*") in sql
    # Sem chave de f-string sobrando no SQL final.
    assert "{{" not in sql and "}}" not in sql
    assert r"'^[A-Z]{2}$'" in sql
    assert r"r'\p{M}'" in sql
    assert "@d_from" in sql and "@d_to" in sql


# ── Janela do mês ──────────────────────────────────────────────────────────

def test_month_window_current_and_explicit():
    today = date(2026, 9, 23)
    assert ooc.month_window(None, today) == (date(2026, 9, 1), date(2026, 9, 30), True)
    assert ooc.month_window("2026-08", today) == (date(2026, 8, 1), date(2026, 8, 31), False)
    assert ooc.month_window("2026-12", today)[1] == date(2026, 12, 31)
    for bad in ("2026-13", "setembro", "2026-9"):
        with pytest.raises(ValueError):
            ooc.month_window(bad, today)


# ── Agregação ──────────────────────────────────────────────────────────────

MS, ME = date(2026, 9, 1), date(2026, 9, 30)


def _r(d, token, country, bucket, imps):
    return {"date": d, "short_token": token, "country": country, "bucket": bucket, "imps": imps}


def _steady_days(n_days, end, total=1_000_000, unexpected=10_000, token="AAA111"):
    """n dias estáveis até `end` (inclusive): 1% fora não previsto."""
    rows = []
    for i in range(n_days):
        d = end - timedelta(days=n_days - 1 - i)
        rows.append(_r(d, token, "BR", "BR", total - unexpected))
        rows.append(_r(d, token, "US", "UNEXPECTED", unexpected))
    return rows


def test_buckets_and_rate():
    d = date(2026, 9, 10)
    rows = [
        _r(d, "ELUX01", "BR", "BR", 700),
        _r(d, "ELUX01", "CL", "EXPECTED", 200),
        _r(d, "ELUX01", "US", "UNEXPECTED", 50),
        _r(d, "ELUX01", "UNKNOWN", "UNKNOWN", 50),
        _r(d, None, "AR", "UNEXPECTED", 1000),       # line sem token
    ]
    p = ooc.build_payload(rows, MS, ME, True)
    assert p["impressions"] == 2000
    assert p["unexpected_impressions"] == 1050
    assert p["expected_impressions"] == 200
    assert p["unknown_impressions"] == 50
    assert p["untracked_impressions"] == 1000
    assert p["rate"] == 52.5
    assert p["top_countries"][0] == {"country": "AR", "impressions": 1000}
    assert p["expected_countries"] == [{"country": "CL", "impressions": 200}]


def test_days_outside_month_only_feed_the_alert():
    # Dia 31/08 entra na janela (lookback do alerta) mas não na taxa de setembro.
    rows = [
        _r(date(2026, 8, 31), "AAA111", "US", "UNEXPECTED", 999_999),
        _r(date(2026, 9, 1), "AAA111", "BR", "BR", 100),
    ]
    p = ooc.build_payload(rows, MS, ME, True)
    assert p["impressions"] == 100
    assert p["rate"] == 0.0


def test_ranking_filters_low_volume_and_sorts_by_rate():
    d = date(2026, 9, 10)
    rows = [
        # Volume baixo: 50% de 40 impressões não entra no ranking.
        _r(d, "TINY01", "BR", "BR", 20), _r(d, "TINY01", "US", "UNEXPECTED", 20),
        _r(d, "LOW001", "BR", "BR", 95_000), _r(d, "LOW001", "US", "UNEXPECTED", 5_000),
        _r(d, "HIGH01", "BR", "BR", 50_000), _r(d, "HIGH01", "MX", "UNEXPECTED", 50_000),
        # Só fora previsto: não aparece no ranking de fora não previsto.
        _r(d, "ELUX01", "BR", "BR", 50_000), _r(d, "ELUX01", "CL", "EXPECTED", 50_000),
    ]
    meta = {"HIGH01": {"client_name": "Paramount", "campaign_name": "MobLand"}}
    p = ooc.build_payload(rows, MS, ME, False, meta)
    assert [c["short_token"] for c in p["campaigns"]] == ["HIGH01", "LOW001"]
    top = p["campaigns"][0]
    assert top["rate"] == 50.0
    assert top["client_name"] == "Paramount"
    assert top["top_countries"] == [{"country": "MX", "impressions": 50_000}]
    assert p["campaigns_with_unexpected"] == 3


def test_data_warnings_flag_silent_failures():
    d = date(2026, 9, 10)
    # country_code em formato inesperado → quase tudo UNKNOWN. Sem a guarda,
    # o box mostraria 0% fora, verde.
    rows = [_r(d, "AAA111", "UNKNOWN", "UNKNOWN", 900), _r(d, "AAA111", "BR", "BR", 100)]
    p = ooc.build_payload(rows, MS, ME, True)
    assert p["rate"] == 0.0
    assert [w["kind"] for w in p["data_warnings"]] == ["unknown_country"]
    # Join de line quebrado → volume quase todo sem token.
    rows = [_r(d, None, "BR", "BR", 900), _r(d, "AAA111", "BR", "BR", 100)]
    assert [w["kind"] for w in ooc.build_payload(rows, MS, ME, True)["data_warnings"]] == ["untracked_lines"]
    # Estado normal: nada.
    rows = [_r(d, None, "BR", "BR", 100), _r(d, "AAA111", "BR", "BR", 900), _r(d, "AAA111", "UNKNOWN", "UNKNOWN", 5)]
    assert ooc.build_payload(rows, MS, ME, True)["data_warnings"] == []


# ── Alerta ─────────────────────────────────────────────────────────────────

def test_no_alert_on_steady_days():
    p = ooc.build_payload(_steady_days(9, date(2026, 9, 22)), MS, ME, True)
    assert p["day_rate"] == 1.0
    assert p["alert"] is False
    assert p["alert_reasons"] == []


def test_global_jump_triggers_alert():
    ref = date(2026, 9, 22)
    rows = _steady_days(8, ref - timedelta(days=1))
    rows += [_r(ref, "AAA111", "BR", "BR", 900_000), _r(ref, "AAA111", "US", "UNEXPECTED", 100_000)]
    p = ooc.build_payload(rows, MS, ME, True)
    kinds = {r["kind"] for r in p["alert_reasons"]}
    assert p["alert"] is True
    assert {"global_jump", "global_baseline"} <= kinds
    assert p["day_rate"] == 10.0 and p["previous_day_rate"] == 1.0


def test_small_absolute_move_does_not_alert():
    # 0,5% → 1,2%: mais que dobra, mas não chega a 2 pontos.
    ref = date(2026, 9, 22)
    rows = _steady_days(8, ref - timedelta(days=1), unexpected=5_000)
    rows += [_r(ref, "AAA111", "BR", "BR", 988_000), _r(ref, "AAA111", "US", "UNEXPECTED", 12_000)]
    p = ooc.build_payload(rows, MS, ME, True)
    assert p["alert"] is False


def test_global_rule_needs_minimum_day_volume():
    ref = date(2026, 9, 22)
    rows = _steady_days(8, ref - timedelta(days=1))
    rows += [_r(ref, "AAA111", "BR", "BR", 5_000), _r(ref, "AAA111", "US", "UNEXPECTED", 5_000)]
    p = ooc.build_payload(rows, MS, ME, True)
    assert not any(r["kind"].startswith("global") for r in p["alert_reasons"])


def test_campaign_jump_triggers_alert_and_leads_ranking():
    ref = date(2026, 9, 22)
    rows = _steady_days(8, ref - timedelta(days=1))
    rows += [_r(ref, "AAA111", "BR", "BR", 990_000), _r(ref, "AAA111", "US", "UNEXPECTED", 10_000)]
    # Campanha nova no dia de referência: 30% fora não previsto.
    rows += [_r(ref, "NEW001", "BR", "BR", 14_000), _r(ref, "NEW001", "PY", "UNEXPECTED", 6_000)]
    p = ooc.build_payload(rows, MS, ME, True, {"NEW001": {"client_name": "Cliente X"}})
    jumps = [r for r in p["alert_reasons"] if r["kind"] == "campaign_jump"]
    assert [j["short_token"] for j in jumps] == ["NEW001"]
    assert jumps[0]["rate"] == 30.0 and jumps[0]["previous_rate"] == 0.0
    assert p["campaigns"][0]["short_token"] == "NEW001"
    assert p["campaigns"][0]["alert"] is True


def test_campaign_expected_country_never_alerts():
    # Elux começa a entregar forte no Chile: previsto pela line, sem alerta.
    ref = date(2026, 9, 22)
    rows = _steady_days(8, ref - timedelta(days=1))
    rows += [_r(ref, "AAA111", "BR", "BR", 990_000), _r(ref, "AAA111", "US", "UNEXPECTED", 10_000)]
    rows += [_r(ref, "ELUX01", "BR", "BR", 10_000), _r(ref, "ELUX01", "CL", "EXPECTED", 90_000)]
    p = ooc.build_payload(rows, MS, ME, True)
    assert p["alert"] is False


def test_past_month_never_alerts():
    ref = date(2026, 8, 30)
    rows = _steady_days(8, ref - timedelta(days=1))
    rows += [_r(ref, "AAA111", "BR", "BR", 500_000), _r(ref, "AAA111", "US", "UNEXPECTED", 500_000)]
    p = ooc.build_payload(rows, date(2026, 8, 1), date(2026, 8, 31), False)
    assert p["alert"] is False


def test_reference_day_is_last_day_with_data_not_calendar():
    # Export atrasado: sem dado de 22/09. Referência fica 21/09, sem alarme falso.
    p = ooc.build_payload(_steady_days(9, date(2026, 9, 21)), MS, ME, True)
    assert p["reference_date"] == "2026-09-21"
    assert p["alert"] is False


def test_datetime_rows_are_accepted():
    rows = [_r(datetime(2026, 9, 10, tzinfo=timezone.utc), "AAA111", "BR", "BR", 10)]
    assert ooc.build_payload(rows, MS, ME, True)["impressions"] == 10


# ── Query (forma) ──────────────────────────────────────────────────────────

class _FakeJob:
    def __init__(self, rows):
        self._rows = rows

    def result(self):
        return self._rows


class _FakeBQ:
    def __init__(self, geo_rows, meta_rows):
        self.calls = []
        self._queue = [geo_rows, meta_rows]

    def query(self, sql, job_config=None, location=None):
        self.calls.append((sql, job_config, location))
        return _FakeJob(self._queue.pop(0))


def test_query_window_includes_lookback_and_caps_bytes():
    geo = [_r(date(2026, 9, 2), "AAA111", "US", "UNEXPECTED", 10),
           _r(date(2026, 9, 2), "AAA111", "BR", "BR", 90)]
    meta = [{"short_token": "AAA111", "client_name": "C", "campaign_name": "K"}]
    fake = _FakeBQ(geo, meta)
    now = datetime(2026, 9, 3, 10, 0, tzinfo=ooc.SP_TZ)
    p = ooc.query_out_of_country(fake, None, now=now)

    sql, cfg, loc = fake.calls[0]
    params = {q.name: q.value for q in cfg.query_parameters}
    # Começo de mês: a janela volta ALERT_LOOKBACK_DAYS pra o alerta ter base.
    assert params["d_from"] == date(2026, 9, 3) - timedelta(days=ooc.ALERT_LOOKBACK_DAYS)
    assert params["d_to"] == date(2026, 9, 3)
    assert cfg.maximum_bytes_billed == int(ooc.MAX_BYTES_BILLED)
    assert loc == "US"
    assert p["rate"] == 10.0
    assert p["campaigns"] == []  # 100 impressões < RANKING_MIN_IMPS
