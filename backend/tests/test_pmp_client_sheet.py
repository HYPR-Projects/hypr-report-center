"""Testes da planilha de cliente do PMP (pmp_client_sheet.py).

Dois pontos importam aqui:
  • o RECORTE: a planilha vai pro cliente, então só Dia, Token, Line, ID do
    Seat, Receita Bruta e Impressões podem sair. Custo, margem e PI da line
    não podem vazar nem se vierem na row;
  • o DEAL: conectar em qualquer line traz todas as ligadas por token do
    Command ou grupo, sem precisar agrupar nada.

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
        "linked_tokens": ["1PIT7I", "B154D4"],
        "end_date": date(2026, 9, 30),
        "last_delivery_day": date(2026, 9, 20),
    }
    base.update(over)
    return base


def _deliv(day, imps, revenue, source="pubmatic", line_id=735537, **extra):
    return {"source": source, "line_id": line_id, "day": day,
            "imps": imps, "revenue": revenue, **extra}


# ─── Recorte ─────────────────────────────────────────────────────────────────
def test_header_e_so_as_seis_colunas_do_cliente():
    header = ["Dia", "Token", "Line", "ID do Seat", "Receita Bruta (R$)", "Impressões"]
    assert [label for _, label in pcs.CLIENT_COLUMNS] == header
    assert pcs.build_payload([]) == [header]
    assert len(pcs.COLUMN_WIDTHS_PX) == len(header)


def test_campos_internos_nao_vazam_pra_planilha():
    rows = pcs.build_client_rows(
        [_member(curator_margin=999, pi_brl=300000, curator_total_cost=123)],
        [_deliv(date(2026, 9, 1), 1000, 50.0,
                curator_margin=42.0, curator_total_cost=8.0)],
    )
    assert set(rows[0]) == {"day", "tokens", "line_name", "seat_id", "revenue", "imps"}
    # Mesmo que alguém enfie um campo extra na row, o payload ignora.
    rows[0]["curator_margin"] = 42.0
    payload = pcs.build_payload(rows)
    assert all(len(r) == 6 for r in payload)
    assert 42.0 not in payload[1] and 999 not in payload[1]


def test_payload_dia_vira_serial_de_data_do_sheets():
    [_, row] = pcs.build_payload(pcs.build_client_rows(
        [_member()], [_deliv(date(2026, 9, 1), 1000, 50.0)],
    ))
    # 1899-12-30 é o dia 0 do Sheets; 2026-09-01 = 46266.
    assert row[0] == (date(2026, 9, 1) - date(1899, 12, 30)).days == 46266
    assert row[1:] == ["1PIT7I, B154D4", "HYPR_TIM_ROCK-IN-RIO_PUBMATIC", "PM-ZZCX-5733", 50.0, 1000]


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
def test_anchor_prefere_token_depois_grupo_depois_line():
    assert pcs.anchor_key_for(_member()) == "token:1PIT7I"
    assert pcs.anchor_key_for(_member(linked_tokens=None, short_token=" no2015 ",
                                      extra_short_tokens=["X1"])) == "token:NO2015"
    assert pcs.anchor_key_for(_member(linked_tokens=[], group_id="ab12CD_-")) == "group:ab12CD_-"
    assert pcs.anchor_key_for(_member(linked_tokens=[], source=None, line_id="31345266")) == \
        "line:xandr:31345266"


def test_line_tokens_normaliza_e_dedupe():
    assert pcs.line_tokens({"linked_tokens": ["a1b", "A1B", " c2 "]}) == ["A1B", "C2"]
    assert pcs.line_tokens({"short_token": "P1", "extra_short_tokens": ["E1", "p1"]}) == ["P1", "E1"]
    assert pcs.line_tokens({}) == []


def test_parse_unit_key():
    assert pcs.parse_unit_key("token:1PIT7I") == {"kind": "token", "token": "1PIT7I"}
    assert pcs.parse_unit_key("line:pubmatic:735537") == {
        "kind": "line", "source": "pubmatic", "line_id": 735537}
    assert pcs.parse_unit_key("group:ab12cd34") == {"kind": "group", "group_id": "ab12cd34"}


@pytest.mark.parametrize("bad", [
    "", "line:pubmatic", "line:PubMatic:1", "line:x:12a", "group:", "group:a b",
    "group:a;DROP", "token:abc", "token:A", "token:A B", "line:x:1:2", "merge:X",
])
def test_parse_unit_key_rejeita_malformada(bad):
    with pytest.raises(ValueError):
        pcs.parse_unit_key(bad)


# ─── Deal = fecho por token e grupo ──────────────────────────────────────────
def _l(line_id, tokens=(), group=None, source="xandr", **kw):
    return {"source": source, "line_id": line_id, "line_name": f"L{line_id}",
            "linked_tokens": list(tokens), "group_id": group, **kw}


def _ids(lines):
    return [l["line_id"] for l in lines]


def test_fecho_pega_lines_que_compartilham_token():
    all_lines = [_l(1, ["A1"]), _l(2, ["A1", "B2"]), _l(3, ["B2"]), _l(4, ["Z9"])]
    # 1 → (A1) → 2 → (B2) → 3. A 4 é outro deal.
    assert _ids(pcs.resolve_cluster(all_lines, [all_lines[0]])) == [1, 2, 3]
    assert _ids(pcs.resolve_cluster(all_lines, [all_lines[3]])) == [4]


def test_fecho_pega_o_grupo_e_atravessa_token_mais_grupo():
    all_lines = [_l(1, ["A1"]), _l(2, [], group="g"), _l(3, ["A1"], group="g"), _l(4, [], group="h")]
    assert _ids(pcs.resolve_cluster(all_lines, [all_lines[1]])) == [1, 2, 3]


def test_fecho_separa_fontes_com_mesmo_line_id():
    all_lines = [_l(7, ["A1"], source="xandr"), _l(7, ["Z9"], source="pubmatic")]
    got = pcs.resolve_cluster(all_lines, [all_lines[0]])
    assert [(l["source"], l["line_id"]) for l in got] == [("xandr", 7)]


def test_seeds_e_membros_por_ancora():
    all_lines = [_l(1, ["A1"]), _l(2, ["A1"], group="g"), _l(3, [], group="g"), _l(4, ["Z9"])]
    assert _ids(pcs.members_for_key("token:A1", all_lines)) == [1, 2, 3]
    assert _ids(pcs.members_for_key("group:g", all_lines)) == [1, 2, 3]
    assert _ids(pcs.members_for_key("line:xandr:4", all_lines)) == [4]
    assert pcs.members_for_key("token:NOPE", all_lines) == []


def test_candidate_keys_cobre_token_grupo_e_line():
    keys = pcs.candidate_keys([_l(1, ["A1", "B2"], group="g"), _l(2, ["A1"])])
    assert keys == ["token:A1", "token:B2", "group:g", "line:xandr:1", "line:xandr:2"]


def test_resolve_for_line_reaproveita_planilha_existente(monkeypatch):
    all_lines = [_l(1, ["A1"]), _l(2, ["A1", "B2"]), _l(3, ["B2"])]
    monkeypatch.setattr(pcs, "fetch_all_lines", lambda: all_lines)
    seen = {}

    def fake_find(keys):
        seen["keys"] = keys
        return "token:B2"          # já conectada a partir da line 3

    monkeypatch.setattr(pcs, "_find_existing", fake_find)
    res = pcs.resolve_for_line("xandr", 1)
    assert res["unit_key"] == "token:B2" and res["existing"] is True
    assert _ids(res["members"]) == [1, 2, 3]
    assert "token:B2" in seen["keys"]

    monkeypatch.setattr(pcs, "_find_existing", lambda keys: None)
    res = pcs.resolve_for_line("xandr", 3)
    assert res["unit_key"] == "token:B2" and res["existing"] is False

    with pytest.raises(ValueError):
        pcs.resolve_for_line("pubmatic", 1)


def test_rows_do_deal_trazem_o_token_de_cada_line():
    members = [_l(1, ["A1"]), _l(2, ["B2", "A1"])]
    rows = pcs.build_client_rows(members, [
        {"source": "xandr", "line_id": 1, "day": "2026-09-01", "imps": 10, "revenue": 1},
        {"source": "xandr", "line_id": 2, "day": "2026-09-01", "imps": 20, "revenue": 2},
    ])
    assert [(r["line_name"], r["tokens"]) for r in rows] == [("L1", "A1"), ("L2", "B2, A1")]


def test_members_summary():
    summ = pcs.members_summary([_l(1, ["A1"]), _l(2, ["A1", "B2"])])
    assert summ["tokens"] == ["A1", "B2"]
    assert [l["line_id"] for l in summ["lines"]] == [1, 2]


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
    assert pcs.build_title([_member(campaign_name=None, group_name="Tim RiR Fixed+Flex")]) == \
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
    monkeypatch.setattr(pcs, "fetch_all_lines", lambda: [_member()])
    monkeypatch.setattr(pcs, "fetch_delivery", lambda members: [_deliv("2026-09-01", 10, 1.0)])
    writes, status, until = [], [], []
    monkeypatch.setattr(si, "_write_base_de_dados",
                        lambda svc, sid, payload, *a, **kw: writes.append((sid, payload, a, kw)))
    monkeypatch.setattr(si, "_update_status", lambda *a, **kw: status.append(kw))
    monkeypatch.setattr(pcs, "_set_sync_until", lambda key, su: until.append(su))
    return {"integ": integ, "writes": writes, "status": status, "until": until}


def test_sync_escreve_com_seat_da_config_e_marca_ativo(sync_env):
    res = pcs.sync("token:1PIT7I")
    assert res == {"spreadsheet_id": "SID", "rows": 1}
    [(sid, payload, args, kw)] = sync_env["writes"]
    assert sid == "SID"
    assert args == ("token:1PIT7I", si.TARGET_PMP_LINE)
    assert kw == {"tab_name": si.BASE_TAB_TITLE, "base_gid": 5}
    assert payload[1][3] == "SEAT-1"
    assert sync_env["status"][-1]["status"] == "active"
    assert sync_env["status"][-1]["last_error"] == ""
    assert sync_env["until"] == [pcs.compute_sync_until([_member()])]


def test_sync_sem_lines_nao_escreve_e_registra(sync_env, monkeypatch):
    with pytest.raises(ValueError):
        pcs.sync("token:SUMIU")
    assert sync_env["writes"] == []
    assert "Nenhuma line" in sync_env["status"][-1]["last_error"]
    assert "status" not in sync_env["status"][-1], "não rebaixa o status"


def test_sync_all_isola_erro_e_respeita_orcamento(monkeypatch):
    monkeypatch.setattr(pcs, "list_due", lambda: ["line:x:1", "line:x:2", "line:x:3"])
    reads = []
    monkeypatch.setattr(pcs, "fetch_all_lines", lambda: reads.append(1) or [])
    calls = []

    def fake_sync(key, all_lines=None):
        calls.append(key)
        if key == "line:x:1":
            raise RuntimeError("boom")

    monkeypatch.setattr(pcs, "sync", fake_sync)
    assert pcs.sync_all_connected() == {"due": 3, "synced": 2, "errors": 1, "deferred": 0}
    assert calls == ["line:x:1", "line:x:2", "line:x:3"]
    assert reads == [1], "1 leitura da enriched pro lote todo"

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
