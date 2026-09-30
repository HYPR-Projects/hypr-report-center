"""Régua do Analytics › Saúde das DSPs (dsp_analytics).

O que se crava aqui:
  - o custo vem do consolidado tratado, nunca da staging da Yahoo (que soma
    cada reingestão do dia);
  - ABS é por line, na ordem fee DV360 → lista de clientes → override, e o
    nome da line (ABS/NO-ABS) não classifica;
  - survey vem marcado, não excluído (a tela decide);
  - a janela é D-1 em BRT e o período anterior tem o mesmo tamanho.

Sem BigQuery: `build_payload` é pura e o SQL só é checado quanto à forma.
"""
import re
from datetime import date, datetime, timezone

import pytest

import dsp_analytics as da


NOW = datetime(2026, 9, 30, 15, 0, tzinfo=timezone.utc)  # 12h BRT


# ── Janela ─────────────────────────────────────────────────────────────────

def test_default_window_is_last_30_closed_days():
    d_from, d_to, prev_from, prev_to = da.resolve_window(now=NOW)
    assert d_to == date(2026, 9, 29)          # ontem em BRT
    assert (d_to - d_from).days == 29
    assert prev_to == date(2026, 8, 30)
    assert (prev_to - prev_from).days == 29


def test_window_to_in_future_is_capped_to_yesterday():
    _, d_to, _, _ = da.resolve_window("2026-09-01", "2026-12-31", now=NOW)
    assert d_to == date(2026, 9, 29)


def test_brt_midnight_edge():
    # 02h UTC do dia 1º = 23h BRT do dia 30: "ontem" ainda é 29.
    now = datetime(2026, 10, 1, 2, 0, tzinfo=timezone.utc)
    _, d_to, _, _ = da.resolve_window(now=now)
    assert d_to == date(2026, 9, 29)


def test_month_window_prev_period_same_length():
    d_from, d_to, prev_from, prev_to = da.resolve_window("2026-09-01", "2026-09-29", now=NOW)
    assert (prev_from, prev_to) == (date(2026, 8, 3), date(2026, 8, 31))


@pytest.mark.parametrize("f,t", [
    ("2026-09-10", "2026-09-01"),   # invertido
    ("2025-01-01", "2026-09-29"),   # > MAX_RANGE_DAYS
    ("01/09/2026", None),           # formato
])
def test_invalid_windows(f, t):
    with pytest.raises(ValueError):
        da.resolve_window(f, t, now=NOW)


# ── ABS ────────────────────────────────────────────────────────────────────

# Grafias reais do checklist_info em 30/09/2026.
@pytest.mark.parametrize("client", [
    "Kenvue", "Diageo", "Mercedes-Benz", "Mercedes Benz", "JLR", "Colgate",
    "O Boticario", "O Boticário", "Santander", "Mondelez", "PepsiCo",
    "Pepsico", "Unilever", "Amazon",
])
def test_abs_client_list_matches_checklist_spellings(client):
    assert re.search(da.ABS_CLIENT_RE, client.upper())


@pytest.mark.parametrize("client", [
    "Atacadão", "Mercado Livre", "Itaú", "Amazonas Energia", "Raízen", "",
])
def test_abs_client_list_does_not_leak(client):
    assert not re.search(da.ABS_CLIENT_RE, client.upper())


def test_abs_order_fee_then_client_then_override():
    sql = da.build_series_sql()
    i_fee = sql.index("THEN 'fee'")
    i_cli = sql.index("THEN 'cliente'")
    i_ovr = sql.index("THEN 'override'")
    assert i_fee < i_cli < i_ovr
    # A fee só vale pro DV360: line_id da Yahoo pode colidir com o do DV360.
    assert "l.source = 'DV360' AND fl.line_item_id = l.line_id" in sql
    # Cliente vem do checklist (nome da campanha HYPR), com o da DSP de reserva.
    assert "COALESCE(c.client_name, l.dsp_client" in sql


@pytest.mark.parametrize("name,tag", [
    ("ID-77G3NN_HYPR_DECA_NO-ABS_VIDEO_O2O", "NO-ABS"),
    ("ID-X_HYPR_KENVUE_NOABS_DISPLAY", "NO-ABS"),
    ("ID-X_HYPR_KENVUE_ABS_DISPLAY", "ABS"),
    ("ID-X_HYPR_KENVUE_DISPLAY_LI-STANDARD", None),
    ("ID-X_HYPR_TABS_DISPLAY", None),            # substring não conta
    (None, None),
])
def test_name_tag(name, tag):
    assert da.name_tag(name) == tag


# ── SQL ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("build", [
    da.build_series_sql, da.build_lines_sql, da.build_line_daily_sql,
])
def test_sql_reads_treated_unified_never_staging(build):
    sql = build()
    assert "bidiq_mart.unified_daily_performance" in sql
    assert "staging." not in sql
    assert "yahoo_dsp_daily_performance_metrics" not in sql


def test_survey_is_flagged_not_excluded():
    sql = da.build_series_sql()
    assert "AS is_survey" in sql
    assert "NOT REGEXP_CONTAINS" not in sql


def test_viewable_completions_computed_per_raw_row():
    sql = da.build_series_sql()
    assert "video_view_100_complete * (viewable_impressions / impressions)" in sql


def test_fee_is_prorated_within_day_and_line():
    sql = da.build_series_sql()
    assert "PARTITION BY l.date, l.source, l.line_id" in sql


# ── Payload ────────────────────────────────────────────────────────────────

def _m(**kw):
    base = dict(imp=0, meas=0, view=0, clk=0, cost=0.0, vst=0, v100=0, vcomp=0.0, fee=0.0)
    base.update(kw)
    return base


WINDOW = (date(2026, 9, 1), date(2026, 9, 2), date(2026, 8, 30), date(2026, 8, 31))


def test_build_payload_dictionaries_and_order():
    series = [
        dict(date=date(2026, 9, 2), source="YAHOO", media="DISPLAY", is_abs=True, is_survey=False,
             short_token="AAA111", io_name="HYPR_DIAGEO", **_m(imp=1000, view=500, cost=0.5)),
        dict(date=date(2026, 9, 1), source="DV360", media="VIDEO", is_abs=False, is_survey=True,
             short_token=None, io_name="IO X", **_m(imp=10, cost=0.01)),
        # sem imp nem custo: descartada
        dict(date=date(2026, 9, 1), source="DV360", media="DISPLAY", is_abs=False, is_survey=False,
             short_token="BBB222", io_name="IO Y", **_m()),
    ]
    prev = [dict(source="DV360", media="DISPLAY", is_abs=False, is_survey=False,
                 short_token="BBB222", io_name="IO Y", **_m(imp=5, cost=0.2))]
    lines = [dict(source="YAHOO", media="DISPLAY", line_id="987", short_token="AAA111",
                  io_name="HYPR_DIAGEO", is_survey=False, abs_reason="cliente",
                  line_name="ID-AAA111_HYPR_DIAGEO_NO-ABS_DISPLAY",
                  first_date=date(2026, 9, 1), last_date=date(2026, 9, 2), **_m(imp=1000, cost=0.5))]
    meta = [dict(short_token="AAA111", client_name="Diageo", campaign_name="Dia dos Pais")]

    p = da.build_payload(series, prev, lines, meta, WINDOW)

    assert p["dates"] == ["2026-09-01", "2026-09-02"]
    assert p["sources"] == ["DV360", "YAHOO"]
    assert len(p["series"]) == 2
    first = dict(zip(p["series_cols"], p["series"][0]))
    assert first["d"] == 0 and first["s"] == "DV360" and first["sv"] == 1 and first["abs"] == 0
    tok = p["tokens"][first["tk"]]
    assert tok["t"] is None and tok["client"] == "Sem campanha"
    second = dict(zip(p["series_cols"], p["series"][1]))
    assert p["tokens"][second["tk"]] == {"t": "AAA111", "client": "Diageo", "campaign": "Dia dos Pais"}
    assert p["ios"][second["io"]] == "HYPR_DIAGEO"

    line = dict(zip(p["line_cols"], p["lines"][0]))
    assert line["key"] == "YAHOO|987|0"
    assert line["abs"] == 1 and line["reason"] == "cliente"
    assert line["tag"] == "NO-ABS"                      # divergência nome × lista
    assert line["first"] == "2026-09-01" and line["last"] == "2026-09-02"

    prow = dict(zip(p["prev_cols"], p["prev"][0]))
    assert prow["imp"] == 5 and prow["cost"] == 0.2
    assert p["prev_from"] == "2026-08-30" and p["from"] == "2026-09-01"
    assert "Amazon" in p["abs_clients"]


def test_payload_columns_have_same_metric_tail():
    for cols in (da.SERIES_COLS, da.PREV_COLS, da.LINE_COLS, da.LINE_DAILY_COLS):
        assert cols[-len(da.METRIC_COLS):] == da.METRIC_COLS


# ── Chaves de line ─────────────────────────────────────────────────────────

def test_parse_line_keys_dedupes_and_validates():
    assert da.parse_line_keys("DV360|1|0, DV360|1|0,YAHOO|2|1") == ["DV360|1|0", "YAHOO|2|1"]
    for bad in ("", "DV360|1", "DV360|1|2", "|1|0"):
        with pytest.raises(ValueError):
            da.parse_line_keys(bad)
    with pytest.raises(ValueError):
        da.parse_line_keys(",".join(f"DV360|{i}|0" for i in range(da.MAX_LINE_KEYS + 1)))


# ── Leitura com BQ falso ───────────────────────────────────────────────────

class _FakeJob:
    def __init__(self, rows):
        self._rows = rows

    def result(self):
        return self._rows


class _FakeBQ:
    def __init__(self):
        self.calls = []

    def query(self, sql, job_config=None, location=None):
        self.calls.append((sql, location))
        if "short_token IN UNNEST(@tokens)" in sql:
            return _FakeJob([dict(short_token="AAA111", client_name="Kenvue", campaign_name="Neutrogena")])
        if "MIN(date) AS first_date" in sql:
            return _FakeJob([dict(source="DV360", media="DISPLAY", line_id="1", short_token="AAA111",
                                  io_name="IO", is_survey=False, abs_reason="fee", line_name="L",
                                  first_date=date(2026, 9, 1), last_date=date(2026, 9, 1),
                                  **_m(imp=100, cost=0.1, fee=0.05))])
        row = dict(source="DV360", media="DISPLAY", is_abs=True, is_survey=False,
                   short_token="AAA111", io_name="IO")
        return _FakeJob([
            dict(date=date(2026, 9, 1), **row, **_m(imp=100, cost=0.1, fee=0.05)),
            # período anterior (31/08): vai pro bloco prev, agregado sem data
            dict(date=date(2026, 8, 31), **row, **_m(imp=40, cost=0.04)),
            dict(date=date(2026, 8, 30), **row, **_m(imp=60, cost=0.06)),
        ])


class _FakeBigquery:
    class QueryJobConfig:
        def __init__(self, query_parameters=None):
            self.query_parameters = query_parameters or []

    @staticmethod
    def ScalarQueryParameter(name, typ, value):
        return (name, typ, value)

    @staticmethod
    def ArrayQueryParameter(name, typ, value):
        return (name, typ, value)


def test_query_dsp_analytics_end_to_end_with_fake_bq():
    bq = _FakeBQ()
    p = da.query_dsp_analytics(bq, _FakeBigquery, "2026-09-01", "2026-09-01", now=NOW)
    assert all(loc == "US" for _, loc in bq.calls)
    assert len(bq.calls) == 3                     # série+anterior, lines, meta
    assert p["tokens"][0]["client"] == "Kenvue"
    assert len(p["series"]) == 1
    prev = dict(zip(p["prev_cols"], p["prev"][0]))
    assert prev["imp"] == 100 and round(prev["cost"], 2) == 0.1
    assert p["prev_from"] == "2026-08-31" and p["prev_to"] == "2026-08-31"
    line = dict(zip(p["line_cols"], p["lines"][0]))
    assert line["fee"] == 0.05 and line["reason"] == "fee"


def test_split_series_separates_window_and_aggregates_prev():
    base = dict(source="YAHOO", media="VIDEO", is_abs=False, is_survey=False, short_token="T", io_name="IO")
    rows = [
        dict(date=date(2026, 9, 2), **base, **_m(imp=10)),
        dict(date=date(2026, 8, 20), **base, **_m(imp=3, cost=1.0)),
        dict(date="2026-08-21", **base, **_m(imp=4, cost=2.0)),
        dict(date=date(2026, 8, 21), **{**base, "is_abs": True}, **_m(imp=5)),
    ]
    series, prev = da.split_series(rows, date(2026, 9, 1))
    assert [r["imp"] for r in series] == [10]
    by_abs = {p["is_abs"]: p for p in prev}
    assert by_abs[False]["imp"] == 7 and by_abs[False]["cost"] == 3.0
    assert by_abs[True]["imp"] == 5


# ── Tática da line ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("name,tactic", [
    # formas reais vistas no consolidado (jun-set/26)
    ("ID-5BIBN3_HYPR_ABBRACCIO-V2_CPG_NO-ABS_DISPLAY_O2O_ITALIAN-FOOD_LI-TOP-PERFORMANCE-HIGH", "tp_high"),
    ("ID-KQXFS2_HYPR_ZAMP_DISPLAY_O2O_RETARGETING BK_LI-TOP-PERFORMANCE-HIGH-2", "tp_high"),
    ("ID-A4M4JN_HYPR_O-BOTICÁRIO_DISPLAY_O2O_STANDARD_TAP TO SCRATCH_TOP-PERFORMANCE-HIGH", "tp_high"),
    ("ID-0DM7HQ_HYPR_AUDI-V2_NO-ABS_DISPLAY_O2O_F1-FANS_LI-TOP-PERFORMANCE-LOW", "tp_low"),
    ("ID-M66HS0_HYPR_AUDI-V2_DISPLAY_O2O_DOWNLOADED-APPS_LI-LI-TOP-PERFORMANCE-LOW", "tp_low"),
    ("ID-L4QXCI_HYPR_KFC-V2_DISPLAY_O2O_GEOFENCING_LI-TOP-PERFORMANCE-LOW2", "tp_low"),
    ("ID-L9BFZB_HYPR_AMAZON-V2_ABS_DISPLAY_O2O_PROMO-SEEKERS_LI-TOP-PERFORMANCE", "tp"),
    ("ID-WD8B7S_HYPR_VOLVO-V2_DISPLAY_O2O_INVENTARIO-AUTO_LI-TOP-PERFORMANCE-MID", "tp"),
    ("ID-OZ2OAD_HYPR_B3-V2_DISPLAY_O2O_AUTOMOTIVO_LI-PREMIUM-LIST", "premium_list"),
    ("ID-WWI076_HYPR_JLR-V2_DISPLAY_O2O_SEE-ACADEMIAS_LI-PREMIUM-LIST-CPM", "premium_list"),
    ("ID-JAI424_HYPR_PANCO-V2_DISPLAY_O2O_SUPERMERCADOS_LI-PL", "premium_list"),
    ("ID-ER60LZ_HYPR_GWM-V2_DISPLAY_O2O_GWM VISITORS_LI-MAX-VIEWABLE", "max_viewable"),
    ("ID-1G4I1C_HYPR_PATRIA_DISPLAY_O2O_DOWNLOADED-APPS_LI-1-MAX-VIEWS", "max_views"),
    ("ID-N4Z46P_HYPR_AVON-V2_VIDEO_O2O_SELFCARE_LI-STANDARD", "standard"),
    ("ID-GWQHMC_HYPR_ITAU-V2_DISPLAY_O2O_GROWTH-INVESTORS_LI-BOOST-CPM", "boost_cpm"),
    ("ID-31QHTN_HYPR_GRUPO-NOS_DISPLAY_O2O_GEOFENCING_LI-SITELIST-PREMIUM", "premium"),
    # sem tática
    ("ID-L9BFZB_HYPR_AMAZON-V2_ABS_DISPLAY_O2O_TECNOLOGIA_LI-1", "none"),
    ("ID-X_HYPR_MARCA_DISPLAY_O2O_STANDARD_LI-2", "none"),       # STANDARD de formato
    ("ID-X_HYPR_MARCA_DISPLAY_O2O_LI-PLUS", "none"),              # PL não é prefixo
    ("ID-X_HYPR_DESKTOP-PERFORMANCE", "none"),
    ("", "none"),
    (None, "none"),
])
def test_tactic_of(name, tactic):
    assert da.tactic_of(name) == tactic


def test_tactic_sql_follows_python_rules_in_order():
    sql = da.build_series_sql()
    assert "AS tactic" in sql
    positions = [sql.index(f"THEN '{k}'") for k, _, _ in da.TACTICS]
    assert positions == sorted(positions)          # High/Low antes do TP genérico
    assert "ELSE 'none'" in sql
    # a tática entra no GROUP BY da série e do período anterior
    assert "GROUP BY date, source, media, is_abs, is_survey, short_token, io_name, tactic" in sql
    assert "tactic" in da._PREV_DIMS


def test_payload_carries_tactic_and_catalog():
    series = [dict(date=date(2026, 9, 1), source="DV360", media="DISPLAY", is_abs=False, is_survey=False,
                   short_token="A", io_name="IO", tactic="tp_high", **_m(imp=10, cost=1.0))]
    lines = [dict(source="DV360", media="DISPLAY", line_id="1", short_token="A", io_name="IO",
                  is_survey=False, abs_reason=None, tactic=None, line_name="L",
                  first_date=date(2026, 9, 1), last_date=date(2026, 9, 1), **_m(imp=10, cost=1.0))]
    p = da.build_payload(series, [], lines, [], WINDOW)
    assert dict(zip(p["series_cols"], p["series"][0]))["tc"] == "tp_high"
    assert dict(zip(p["line_cols"], p["lines"][0]))["tc"] == "none"
    keys = [t["key"] for t in p["tactics"]]
    assert keys[:4] == ["tp_high", "tp_low", "tp", "premium_list"] and keys[-1] == "none"
