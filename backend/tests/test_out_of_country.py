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
    # "CH" é como a operação escreve Chile (Elux: "AON CH ELUX").
    ("AON CH ELUX", {"CL"}),
    ("AON CH Mademsa", {"CL"}),
    ("ID-M4PWHT_HYPR_ELECTROLUX_AON_CH_DISPLAY", {"CL"}),
    # ...mas só como palavra solta: CHURRASCO, CHANNEL, TECH não liberam.
    ("ID-ABC123_CHURRASCO_CHANNEL_TECH_DISPLAY", set()),
])
def test_expected_countries(line, expected):
    assert ooc.expected_countries(line) == expected


def test_sql_reads_every_name_source_and_override():
    sql = ooc.build_sql()
    # Texto do match: line (unified e regiões), campanha na DSP e no checklist.
    for piece in ("m.line_names", "g.geo_line_name", "m.dsp_campaign_names", "c.checklist_campaign"):
        assert piece in sql
    assert "campaign_country_overrides" in sql
    assert "country IN UNNEST(allowed)" in sql
    # Override vem antes da regra por nome e nunca libera BR/UNKNOWN.
    assert sql.index("IN ('BR', 'UNKNOWN') THEN country") < sql.index("IN UNNEST(allowed)")


@pytest.mark.parametrize("raw,expected", [
    (["cl", "PE", " co "], ["CL", "CO", "PE"]),
    (["CL", "CL", "BR"], ["CL"]),           # BR nunca é "liberado": é o padrão
    ([], []),
])
def test_normalize_countries(raw, expected):
    assert ooc.normalize_countries(raw) == expected


@pytest.mark.parametrize("raw", ["CL", ["CHL"], ["C1"], [None], [f"A{chr(65 + i)}" for i in range(26)] + ["BB", "BC", "BD", "BE", "BF"]])
def test_normalize_countries_rejects(raw):
    with pytest.raises(ValueError):
        ooc.normalize_countries(raw)


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


def _r(d, token, country, bucket, imps, source="DV360"):
    return {"date": d, "source": source, "short_token": token, "country": country, "bucket": bucket, "imps": imps}


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
    """Responde pelo formato do SQL: geo (tem `bucket`), cobertura (lê a
    unified de performance por source/date), meta (checklist). `geo_table`
    diz se a unified de geo existe (get_table)."""

    def __init__(self, geo_rows, meta_rows, delivered_rows=(), geo_table=False):
        self.calls = []
        self.ddl = []
        self._geo, self._meta, self._delivered = geo_rows, meta_rows, list(delivered_rows)
        self._queue = None
        self.geo_table = geo_table

    def get_table(self, table_id):
        if not self.geo_table:
            raise ooc.NotFound(f"Not found: Table {table_id}")
        return object()

    def query(self, sql, job_config=None, location=None):
        if "CREATE TABLE IF NOT EXISTS" in sql:
            self.ddl.append(sql)
            return _FakeJob([])
        self.calls.append((sql, job_config, location))
        if self._queue is not None:
            return _FakeJob(self._queue.pop(0))
        if "AS bucket" in sql:
            return _FakeJob(self._geo)
        if "GROUP BY 1, 2" in sql and "unified_daily_performance" in sql and "bucket" not in sql:
            return _FakeJob(self._delivered)
        return _FakeJob(self._meta)


@pytest.fixture(autouse=True)
def _reset_geo_backend():
    ooc._geo_backend_state.update(backend=None, checked_at=0.0)
    yield


def test_query_window_includes_lookback_and_caps_bytes():
    geo = [_r(date(2026, 9, 2), "AAA111", "US", "UNEXPECTED", 10),
           _r(date(2026, 9, 2), "AAA111", "BR", "BR", 90)]
    meta = [{"short_token": "AAA111", "client_name": "C", "campaign_name": "K"}]
    fake = _FakeBQ(geo, meta)
    ooc._overrides_ready = False
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
    # A tabela de override existe antes da query principal (que a referencia).
    assert len(fake.ddl) == 1 and "campaign_country_overrides" in fake.ddl[0]


def test_box_survives_when_override_table_cannot_be_created():
    class _NoDDL(_FakeBQ):
        def query(self, sql, job_config=None, location=None):
            if "CREATE TABLE IF NOT EXISTS" in sql:
                raise PermissionError("403 bigquery.tables.create")
            return super().query(sql, job_config, location)

    geo = [_r(date(2026, 9, 2), "AAA111", "BR", "BR", 90), _r(date(2026, 9, 2), "AAA111", "US", "UNEXPECTED", 10)]
    fake = _NoDDL(geo, [])
    ooc._overrides_ready = False
    p = ooc.query_out_of_country(fake, None, now=datetime(2026, 9, 3, 10, 0, tzinfo=ooc.SP_TZ))
    assert p["rate"] == 10.0
    sql = fake.calls[0][0]
    assert "campaign_country_overrides" not in sql and "LIMIT 0" in sql


def test_sql_without_overrides_still_parses():
    sqlglot = pytest.importorskip("sqlglot")
    for flag in (True, False):
        for backend in ("unified", "dv360"):
            sqlglot.parse_one(ooc.build_sql(flag, backend), read="bigquery")
    sqlglot.parse_one(ooc.build_coverage_sql(ooc.GEO_SOURCES), read="bigquery")


# ── Base de geo: unified (DV360 + Yahoo) ou Region cru ─────────────────────

def test_unified_sql_reads_geo_table_and_joins_by_source():
    sql = ooc.build_sql(True, "unified")
    assert "unified_daily_geo_performance_metrics" in sql
    assert "dv360_daily_regions" not in sql
    assert "USING (source, line_item_id)" in sql
    # token da base de geo só entra se a unified de performance não tiver
    assert "COALESCE(m.short_token, g.geo_token)" in sql
    legacy = ooc.build_sql(True, "dv360")
    assert "dv360_daily_regions" in legacy
    assert "'DV360' AS source" in legacy


def test_backend_falls_back_while_geo_table_is_missing_and_rechecks():
    fake = _FakeBQ([], [])
    assert ooc.resolve_geo_backend(fake, now_ts=1000) == "dv360"
    fake.geo_table = True
    # negativo em cache: não recheca dentro do TTL...
    assert ooc.resolve_geo_backend(fake, now_ts=1000 + ooc._GEO_NEGATIVE_TTL - 1) == "dv360"
    # ...e troca sozinho depois dele
    assert ooc.resolve_geo_backend(fake, now_ts=1000 + ooc._GEO_NEGATIVE_TTL + 1) == "unified"
    fake.geo_table = False
    assert ooc.resolve_geo_backend(fake, now_ts=99_999) == "unified"  # positivo fica


def test_backend_check_error_keeps_legacy_path():
    class _Boom(_FakeBQ):
        def get_table(self, table_id):
            raise PermissionError("403")
    assert ooc.resolve_geo_backend(_Boom([], []), now_ts=1) == "dv360"


def test_payload_splits_by_source_and_tags_campaigns():
    d = date(2026, 9, 10)
    rows = [
        _r(d, "DIAGEO", "BR", "BR", 60_000),
        _r(d, "DIAGEO", "IN", "UNEXPECTED", 40_000),
        _r(d, "DIAGEO", "BR", "BR", 18_000, source="YAHOO"),
        _r(d, "DIAGEO", "US", "UNEXPECTED", 2_000, source="YAHOO"),
        _r(d, "LOREAL", "BR", "BR", 50_000, source="YAHOO"),
    ]
    p = ooc.build_payload(rows, MS, ME, True)
    assert p["source"] == "DV360 + Yahoo"
    by = {s["source"]: s for s in p["sources"]}
    assert by["DV360"]["rate"] == 40.0 and by["DV360"]["impressions"] == 100_000
    assert by["YAHOO"]["label"] == "Yahoo" and by["YAHOO"]["unexpected_impressions"] == 2_000
    assert p["rate"] == 24.71  # 42k / 170k, as duas fontes no mesmo balde
    camp = {c["short_token"]: c for c in p["campaigns"]}
    assert camp["DIAGEO"]["sources"] == ["DV360", "Yahoo"]
    assert "LOREAL" not in camp  # sem entrega fora


def test_coverage_warns_when_source_delivers_without_geo():
    d1, d2 = date(2026, 9, 9), date(2026, 9, 10)
    rows = [_r(d1, "AAA111", "BR", "BR", 1_000_000), _r(d2, "AAA111", "BR", "BR", 1_000_000)]
    delivered = {
        "DV360": {d1: 1_000_000, d2: 1_000_000},
        # Yahoo entregou e o geo não veio
        "YAHOO": {d1: 300_000, d2: 300_000},
    }
    p = ooc.build_payload(rows, MS, ME, True, delivered_daily=delivered)
    by = {s["source"]: s for s in p["sources"]}
    assert by["DV360"]["coverage"] == 100.0
    assert by["YAHOO"]["impressions"] == 0 and by["YAHOO"]["coverage"] == 0.0
    warn = [w for w in p["data_warnings"] if w["kind"] == "geo_coverage"]
    assert warn == [{"kind": "geo_coverage", "source": "YAHOO", "label": "Yahoo", "share": 0.0}]
    assert p["source"] == "DV360"


def test_coverage_counts_only_until_last_geo_day_and_ignores_small_volume():
    d1, d2 = date(2026, 9, 9), date(2026, 9, 10)
    rows = [_r(d1, "AAA111", "BR", "BR", 1_000_000),
            _r(d1, "AAA111", "BR", "BR", 50_000, source="YAHOO")]
    delivered = {
        # d2 ainda não tem geo de ninguém: não entra no denominador
        "DV360": {d1: 1_000_000, d2: 900_000},
        "YAHOO": {d1: 50_000, d2: 40_000},
        "STACKADAPT": {d1: 5},
    }
    p = ooc.build_payload(rows, MS, ME, True, delivered_daily=delivered)
    by = {s["source"]: s for s in p["sources"]}
    assert by["DV360"]["delivered_impressions"] == 1_000_000
    assert by["YAHOO"]["coverage"] == 100.0
    assert "STACKADAPT" not in by  # não reporta geo
    assert not [w for w in p["data_warnings"] if w["kind"] == "geo_coverage"]


def test_query_uses_unified_geo_when_table_exists():
    d = date(2026, 9, 2)
    geo = [_r(d, "AAA111", "BR", "BR", 90), _r(d, "AAA111", "US", "UNEXPECTED", 10, source="YAHOO")]
    delivered = [{"source": "DV360", "date": d, "imps": 90}, {"source": "YAHOO", "date": d, "imps": 10}]
    fake = _FakeBQ(geo, [], delivered, geo_table=True)
    ooc._overrides_ready = True
    p = ooc.query_out_of_country(fake, None, now=datetime(2026, 9, 3, 10, 0, tzinfo=ooc.SP_TZ))
    assert p["geo_backend"] == "unified"
    assert "unified_daily_geo_performance_metrics" in fake.calls[0][0]
    cov_sql, cov_cfg, _ = fake.calls[1]
    assert "'DV360', 'YAHOO'" in cov_sql
    params = {q.name: q.value for q in cov_cfg.query_parameters}
    assert params == {"m_from": date(2026, 9, 1), "m_to": date(2026, 9, 3)}
    assert {s["source"]: s["coverage"] for s in p["sources"]} == {"DV360": 100.0, "YAHOO": 100.0}


def test_coverage_query_failure_does_not_break_box():
    class _NoCoverage(_FakeBQ):
        def query(self, sql, job_config=None, location=None):
            if "GROUP BY 1, 2" in sql and "bucket" not in sql:
                raise RuntimeError("quota")
            return super().query(sql, job_config, location)
    geo = [_r(date(2026, 9, 2), "AAA111", "BR", "BR", 90)]
    ooc._overrides_ready = True
    p = ooc.query_out_of_country(_NoCoverage(geo, [], geo_table=True), None,
                                 now=datetime(2026, 9, 3, 10, 0, tzinfo=ooc.SP_TZ))
    assert p["impressions"] == 90 and p["sources"][0]["coverage"] is None


def test_save_override_empty_list_deletes_and_list_merges():
    fake = _FakeBQ([], [])
    fake._queue = [[], []]
    ooc._overrides_ready = True
    assert ooc.save_country_override(fake, "M4PWHT", ["cl", "BR"], updated_by="a@hypr.mobi") == ["CL"]
    merge_sql, cfg, _ = fake.calls[0]
    assert merge_sql.lstrip().startswith("MERGE")
    params = {q.name: getattr(q, "values", getattr(q, "value", None)) for q in cfg.query_parameters}
    assert params["countries"] == ["CL"]
    assert ooc.save_country_override(fake, "M4PWHT", []) == []
    assert fake.calls[1][0].startswith("DELETE")


# ── Visão agregada × por DSP ───────────────────────────────────────────────

def _two_sources(dv_days, yh_days, dv_rate=0.05, yh_rate=0.0, dv_total=1_000_000, yh_total=1_000_000):
    rows = []
    for d in dv_days:
        rows.append(_r(d, "DIAGEO", "BR", "BR", int(dv_total * (1 - dv_rate))))
        rows.append(_r(d, "DIAGEO", "IN", "UNEXPECTED", int(dv_total * dv_rate)))
    for d in yh_days:
        rows.append(_r(d, "LOREAL", "BR", "BR", int(yh_total * (1 - yh_rate)), source="YAHOO"))
        if yh_rate:
            rows.append(_r(d, "LOREAL", "US", "UNEXPECTED", int(yh_total * yh_rate), source="YAHOO"))
    return rows


def _days(end, n):
    return [end - timedelta(days=n - 1 - i) for i in range(n)]


def test_aggregate_cuts_at_last_day_all_sources_have():
    end = date(2026, 9, 20)
    # DV360 5% fora, Yahoo 0%: juntos 2,5%. A Yahoo ainda não chegou no dia 20.
    rows = _two_sources(_days(end, 10), _days(end - timedelta(days=1), 9))
    p = ooc.build_payload(rows, MS, ME, True)
    # Sem o corte, o dia 20 seria só DV360 (5%) contra 2,5% da véspera:
    # "salto" de 2,5 pp que não existe.
    assert p["reference_date"] == "2026-09-19"
    assert p["day_rate"] == 2.5 and p["previous_day_rate"] == 2.5
    assert p["alert"] is False
    assert all(d["date"] <= "2026-09-19" for d in p["daily"])
    # A aba do DV360 tem o próprio dia de referência.
    dv = p["by_source"]["DV360"]
    assert dv["reference_date"] == "2026-09-20" and dv["rate"] == 5.0
    assert p["by_source"]["YAHOO"]["reference_date"] == "2026-09-19"
    assert p["lagging_sources"] == [{"source": "YAHOO", "label": "Yahoo", "last_date": "2026-09-19"}]


def test_stale_source_leaves_the_cutoff_and_warns():
    end = date(2026, 9, 20)
    rows = _two_sources(_days(end, 10), _days(end - timedelta(days=6), 4))
    p = ooc.build_payload(rows, MS, ME, True)
    assert p["reference_date"] == "2026-09-20"  # não congela no dia 14
    stale = [w for w in p["data_warnings"] if w["kind"] == "source_stale"]
    assert stale == [{"kind": "source_stale", "source": "YAHOO", "label": "Yahoo", "last_date": "2026-09-14"}]


def test_by_source_is_the_full_payload_per_dsp():
    end = date(2026, 9, 20)
    rows = _two_sources(_days(end, 3), _days(end, 3), dv_rate=0.40, yh_rate=0.10, yh_total=200_000)
    delivered = {"DV360": {d: 1_000_000 for d in _days(end, 3)}, "YAHOO": {d: 400_000 for d in _days(end, 3)}}
    p = ooc.build_payload(rows, MS, ME, True, delivered_daily=delivered)
    dv, yh = p["by_source"]["DV360"], p["by_source"]["YAHOO"]
    assert (dv["rate"], yh["rate"]) == (40.0, 10.0)
    assert dv["impressions"] + yh["impressions"] == p["impressions"]
    assert dv["unexpected_impressions"] + yh["unexpected_impressions"] == p["unexpected_impressions"]
    assert [c["short_token"] for c in dv["campaigns"]] == ["DIAGEO"]
    assert [c["short_token"] for c in yh["campaigns"]] == ["LOREAL"]
    assert yh["top_countries"][0]["country"] == "US"
    # cobertura e aviso ficam na aba da própria DSP
    assert yh["sources"][0]["coverage"] == 50.0
    assert [w["kind"] for w in yh["data_warnings"]] == ["geo_coverage"]
    assert not [w for w in dv["data_warnings"] if w["kind"] == "geo_coverage"]
    assert "by_source" not in dv


def test_single_source_has_no_tabs():
    p = ooc.build_payload(_two_sources(_days(date(2026, 9, 20), 3), []), MS, ME, True)
    assert "by_source" not in p
