"""Testes da planilha de cliente do PMP (pmp_client_sheet.py).

O ponto que mais importa aqui é o RECORTE: a planilha vai pro cliente, então
só Dia, Line, ID do Seat, Receita Bruta e Impressões podem sair. Custo,
margem e PI da line não podem vazar nem se vierem na row.

Nenhum teste faz I/O: BQ e Sheets são mockados.
"""
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

import pmp_client_sheet as pcs
import sheets_integration as si


def _member(**over):
    base = {
        "source": "pubmatic",
        "line_id": 735537,
        "line_name": "HYPR_TIM_ROCK-IN-RIO_PUBMATIC",
        "external_deal_id": "PM-ZZCX-5733",
        "deal_ids": [],
        "customer": "Tim",
        "campaign_name": "Rock in Rio",
        "group_id": None,
        "group_name": None,
        "end_date": date(2026, 9, 30),
        "last_delivery_day": date(2026, 9, 20),
    }
    base.update(over)
    return base


def _deliv(day, imps, revenue, source="pubmatic", line_id=735537, **extra):
    return {"source": source, "line_id": line_id, "day": day,
            "imps": imps, "revenue": revenue, **extra}


# ─── Recorte ─────────────────────────────────────────────────────────────────
def test_header_e_so_as_cinco_colunas_do_cliente():
    assert [label for _, label in pcs.CLIENT_COLUMNS] == [
        "Dia", "Line", "ID do Seat", "Receita Bruta (R$)", "Impressões",
    ]
    payload = pcs.build_payload([])
    assert payload == [["Dia", "Line", "ID do Seat", "Receita Bruta (R$)", "Impressões"]]


def test_campos_internos_nao_vazam_pra_planilha():
    rows = pcs.build_client_rows(
        [_member(curator_margin=999, pi_brl=300000, curator_total_cost=123)],
        [_deliv(date(2026, 9, 1), 1000, 50.0,
                curator_margin=42.0, curator_total_cost=8.0)],
    )
    assert set(rows[0]) == {"day", "line_name", "seat_id", "revenue", "imps"}
    # Mesmo que alguém enfie um campo extra na row, o payload ignora.
    rows[0]["curator_margin"] = 42.0
    payload = pcs.build_payload(rows)
    assert all(len(r) == 5 for r in payload)
    assert 42.0 not in payload[1] and 999 not in payload[1]


def test_payload_dia_vira_serial_de_data_do_sheets():
    [_, row] = pcs.build_payload(pcs.build_client_rows(
        [_member()], [_deliv(date(2026, 9, 1), 1000, 50.0)],
    ))
    # 1899-12-30 é o dia 0 do Sheets; 2026-09-01 = 46266.
    assert row[0] == (date(2026, 9, 1) - date(1899, 12, 30)).days == 46266
    assert row[1:] == ["HYPR_TIM_ROCK-IN-RIO_PUBMATIC", "PM-ZZCX-5733", 50.0, 1000]


# ─── Rows ────────────────────────────────────────────────────────────────────
def test_soma_rows_do_mesmo_dia_e_ordena():
    m2 = _member(line_id=2, line_name="A_LINE", external_deal_id="PM-B")
    rows = pcs.build_client_rows(
        [_member(), m2],
        [
            _deliv("2026-09-02", 10, Decimal("1.10")),
            _deliv("2026-09-01", 5, 0.5),
            _deliv("2026-09-01", 5, 0.5),
            _deliv("2026-09-01", 7, 0.7, line_id=2),
        ],
    )
    assert [(r["day"].isoformat(), r["line_name"], r["imps"], r["revenue"]) for r in rows] == [
        ("2026-09-01", "A_LINE", 7, 0.7),
        ("2026-09-01", "HYPR_TIM_ROCK-IN-RIO_PUBMATIC", 10, 1.0),
        ("2026-09-02", "HYPR_TIM_ROCK-IN-RIO_PUBMATIC", 10, 1.1),
    ]


def test_dia_zerado_nao_entra():
    rows = pcs.build_client_rows([_member()], [_deliv("2026-09-01", 0, 0)])
    assert rows == []


def test_casa_pelo_par_source_line_id():
    # Mesmo número de line em outra fonte não pode entrar na planilha.
    rows = pcs.build_client_rows(
        [_member()],
        [_deliv("2026-09-01", 100, 5.0), _deliv("2026-09-01", 999, 99.0, source="xandr")],
    )
    assert len(rows) == 1 and rows[0]["imps"] == 100


# ─── Seat ────────────────────────────────────────────────────────────────────
def test_seat_default_pubmatic_e_xandr():
    assert pcs.default_seat_id(_member()) == "PM-ZZCX-5733"
    assert pcs.default_seat_id(_member(external_deal_id=None, deal_ids=[111, 222])) == "111, 222"
    assert pcs.default_seat_id(_member(external_deal_id="", deal_ids=None)) == ""


def test_override_de_seat_vale_pra_todas_as_rows():
    rows = pcs.build_client_rows(
        [_member(), _member(line_id=2, external_deal_id="PM-OUTRO")],
        [_deliv("2026-09-01", 1, 1.0), _deliv("2026-09-01", 1, 1.0, line_id=2)],
        seat_override="  SEAT-DV360-42 ",
    )
    assert {r["seat_id"] for r in rows} == {"SEAT-DV360-42"}


def test_override_vazio_volta_pro_deal_id():
    [row] = pcs.build_client_rows([_member()], [_deliv("2026-09-01", 1, 1.0)], seat_override="  ")
    assert row["seat_id"] == "PM-ZZCX-5733"


# ─── unit_key ────────────────────────────────────────────────────────────────
def test_unit_key_line_e_grupo():
    assert pcs.unit_key_for(_member()) == "line:pubmatic:735537"
    assert pcs.unit_key_for(_member(source=None, line_id="31345266")) == "line:xandr:31345266"
    assert pcs.unit_key_for(_member(group_id="ab12CD_-")) == "group:ab12CD_-"


def test_parse_unit_key():
    assert pcs.parse_unit_key("line:pubmatic:735537") == {
        "kind": "line", "source": "pubmatic", "line_id": 735537}
    assert pcs.parse_unit_key("group:ab12cd34") == {"kind": "group", "group_id": "ab12cd34"}


@pytest.mark.parametrize("bad", [
    "", "line:pubmatic", "line:PubMatic:1", "line:x:12a", "group:", "group:a b",
    "group:a;DROP", "token:ABC", "line:x:1:2",
])
def test_parse_unit_key_rejeita_malformada(bad):
    with pytest.raises(ValueError):
        pcs.parse_unit_key(bad)


# ─── Janela / título ─────────────────────────────────────────────────────────
def test_sync_until_usa_o_maior_entre_fim_e_ultima_entrega():
    su = pcs.compute_sync_until([
        _member(end_date="2026-09-30", last_delivery_day=date(2026, 10, 3)),
        _member(end_date=None, last_delivery_day=None),
    ])
    assert pcs.SYNC_GRACE_DAYS == 30
    assert su == date(2026, 11, 2)  # 03/10 (última entrega) + 30 dias
    assert pcs.compute_sync_until([_member(end_date=None, last_delivery_day=None)]) is None


def test_titulo():
    assert pcs.build_title([_member()]) == "HYPR - Tim - Rock in Rio - Entrega PMP"
    assert pcs.build_title([_member(group_name="Tim RiR Fixed+Flex")]) == \
        "HYPR - Tim - Tim RiR Fixed+Flex - Entrega PMP"
    assert pcs.build_title([_member(customer=None, campaign_name=None)]) == \
        "HYPR - HYPR_TIM_ROCK-IN-RIO_PUBMATIC - Entrega PMP"


def test_format_requests_cobrem_data_moeda_e_inteiro():
    reqs = pcs._format_requests(7)
    fmts = {
        r["repeatCell"]["range"]["startColumnIndex"]: r["repeatCell"]["cell"]["userEnteredFormat"]["numberFormat"]["type"]
        for r in reqs if "repeatCell" in r
    }
    assert fmts == {pcs.DATE_COL: "DATE", pcs.REVENUE_COL: "CURRENCY", pcs.IMPS_COL: "NUMBER"}


# ─── Sync ────────────────────────────────────────────────────────────────────
@pytest.fixture
def sync_env(monkeypatch):
    integ = {
        "spreadsheet_id": "SID", "refresh_token_enc": b"x",
        "base_tab_title": None, "base_sheet_gid": 5,
        "config": {"seat_id": "SEAT-1"},
    }
    monkeypatch.setattr(si, "get_integration", lambda tid, target_type=None: integ)
    monkeypatch.setattr(si, "_mark_attempt", lambda *a: None)
    monkeypatch.setattr(si, "_resolve_refresh_token", lambda *a: "RT")
    monkeypatch.setattr(si, "_exchange_or_mark", lambda *a: "AT")
    monkeypatch.setattr(si, "_build_sheets_client", lambda at: MagicMock())
    monkeypatch.setattr(pcs, "fetch_members", lambda unit: [_member()])
    monkeypatch.setattr(pcs, "fetch_delivery", lambda unit: [_deliv("2026-09-01", 10, 1.0)])
    writes, status, until = [], [], []
    monkeypatch.setattr(si, "_write_base_de_dados",
                        lambda svc, sid, payload, *a, **kw: writes.append((sid, payload, a, kw)))
    monkeypatch.setattr(si, "_update_status", lambda *a, **kw: status.append(kw))
    monkeypatch.setattr(pcs, "_set_sync_until", lambda key, su: until.append(su))
    return {"integ": integ, "writes": writes, "status": status, "until": until}


def test_sync_escreve_com_seat_da_config_e_marca_ativo(sync_env):
    res = pcs.sync("line:pubmatic:735537")
    assert res == {"spreadsheet_id": "SID", "rows": 1}
    [(sid, payload, args, kw)] = sync_env["writes"]
    assert sid == "SID"
    assert args == ("line:pubmatic:735537", si.TARGET_PMP_LINE)
    assert kw == {"tab_name": si.BASE_TAB_TITLE, "base_gid": 5}
    assert payload[1][2] == "SEAT-1"
    assert sync_env["status"][-1]["status"] == "active"
    assert sync_env["status"][-1]["last_error"] == ""
    assert sync_env["until"] == [pcs.compute_sync_until([_member()])]


def test_sync_sem_lines_nao_escreve_e_registra(sync_env, monkeypatch):
    monkeypatch.setattr(pcs, "fetch_members", lambda unit: [])
    with pytest.raises(ValueError):
        pcs.sync("group:sumiu")
    assert sync_env["writes"] == []
    assert "Nenhuma line" in sync_env["status"][-1]["last_error"]
    assert "status" not in sync_env["status"][-1], "não rebaixa o status"


def test_sync_all_isola_erro_e_respeita_orcamento(monkeypatch):
    monkeypatch.setattr(pcs, "list_due", lambda: ["line:x:1", "line:x:2", "line:x:3"])
    calls = []

    def fake_sync(key):
        calls.append(key)
        if key == "line:x:1":
            raise RuntimeError("boom")

    monkeypatch.setattr(pcs, "sync", fake_sync)
    assert pcs.sync_all_connected() == {"due": 3, "synced": 2, "errors": 1, "deferred": 0}
    assert calls == ["line:x:1", "line:x:2", "line:x:3"]

    calls.clear()
    assert pcs.sync_all_connected(time_budget_s=-1) == {
        "due": 3, "synced": 0, "errors": 0, "deferred": 3}
    assert calls == []


# ─── Integração com o cron genérico ──────────────────────────────────────────
def test_cron_generico_nao_pega_pmp_line(monkeypatch):
    bq = MagicMock()
    bq.query.return_value.result.return_value = []
    monkeypatch.setattr(si, "_bq_client", lambda: bq)
    monkeypatch.setattr(si, "ensure_table_exists", lambda: None)
    si.list_active_integrations()
    sql = bq.query.call_args[0][0]
    params = bq.query.call_args[1]["job_config"].query_parameters
    assert "IN UNNEST(@cron_targets)" in sql
    [p] = [p for p in params if p.name == "cron_targets"]
    assert set(p.values) == {si.TARGET_TOKEN, si.TARGET_MERGE}


def test_config_json_parse():
    assert si._parse_config(None) == {}
    assert si._parse_config('{"seat_id": "S1"}') == {"seat_id": "S1"}
    assert si._parse_config("not json") == {}
    assert si._parse_config("[1,2]") == {}


def test_target_pmp_line_valido():
    assert si._validate_target_type(si.TARGET_PMP_LINE) == "pmp_line"
