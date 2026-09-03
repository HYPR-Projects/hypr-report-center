"""Vinculação de N checklists do Command por line (pmp_lines.set_line_tokens
e amigos). Nada aqui toca BigQuery nem Xandr: o client do BQ é um stub que
grava as queries/parâmetros recebidos, e o PUT no Xandr é um callable espião.

O que cada bloco crava
──────────────────────
  normalize_tokens   UPPER/TRIM, dedupe preservando ORDEM (o 1º é o principal),
                     vazio ignorado, formato inválido levanta ValueError
  line_tokens        principal + extras sem repetição, tolerante a lixo legado
  set_line_tokens    • PUT no Xandr SÓ quando o principal muda (trocar extras
                       não mexe no Xandr)
                     • deal PubMatic nunca chama o Xandr
                     • lista vazia desvincula (code NULL, extras [])
                     • UPDATE casa o PAR (source, line_id)
                     • refresh da enriched depois do UPDATE
  find_token_conflicts
                     devolve só os tokens pedidos, casando principal OU extra
                     de OUTRAS lines
  lookup_checklists  uma entrada por token pedido, na ordem, found=False quando
                     o espelho não tem
  _jsonable          datas aninhadas em ARRAY<STRUCT> viram ISO
"""
import sys
import types
from datetime import date, datetime
from decimal import Decimal

import pytest


# ─── Stub do BigQuery ────────────────────────────────────────────────────────
class _Job:
    def __init__(self, rows):
        self._rows = rows

    def result(self, *a, **k):
        return list(self._rows)


class FakeBQ:
    """Client falso: `queue` decide o que cada query devolve (FIFO); tudo que
    foi executado fica em `calls` = [(sql, {param: value})]."""

    def __init__(self):
        self.calls = []
        self.queue = []

    def query(self, sql, job_config=None, **kw):
        params = {}
        if job_config is not None:
            for p in (job_config.query_parameters or []):
                params[p.name] = getattr(p, "values", None) if hasattr(p, "values") else p.value
        self.calls.append((" ".join(sql.split()), params))
        rows = self.queue.pop(0) if self.queue else []
        return _Job(rows)

    def sql_calls(self):
        return [c[0] for c in self.calls]


@pytest.fixture
def pl(monkeypatch):
    """Importa pmp_lines com o bq_client stubado. Reimporta a cada teste pra
    zerar o singleton `_schema_ensured`."""
    fake = FakeBQ()
    stub = types.ModuleType("bq_client")
    stub.get_client = lambda: fake
    monkeypatch.setitem(sys.modules, "bq_client", stub)
    sys.modules.pop("pmp_lines", None)
    import pmp_lines
    pmp_lines.bq = fake
    pmp_lines._schema_ensured = True   # DDL não interessa aqui
    monkeypatch.setattr(pmp_lines, "refresh_enriched_table", lambda: fake.calls.append(("REFRESH", {})))
    monkeypatch.setattr(pmp_lines, "get_line", lambda lid, src=None: {"line_id": lid, "source": src})
    pmp_lines._fake = fake
    return pmp_lines


# ─── normalize_tokens / line_tokens ──────────────────────────────────────────
def test_normalize_uppercases_trims_and_dedupes_keeping_order(pl):
    assert pl.normalize_tokens([" no2015 ", "NO2016", "no2015", "", None, "ab-1_x"]) \
        == ["NO2015", "NO2016", "AB-1_X"]


def test_normalize_rejects_bad_format(pl):
    with pytest.raises(ValueError):
        pl.normalize_tokens(["NO 2015"])
    with pytest.raises(ValueError):
        pl.normalize_tokens(["X"])            # 1 char
    with pytest.raises(ValueError):
        pl.normalize_tokens(["A" * 41])       # longo demais


def test_normalize_empty_input(pl):
    assert pl.normalize_tokens(None) == []
    assert pl.normalize_tokens([]) == []
    assert pl.normalize_tokens(["", "  "]) == []


def test_line_tokens_merges_primary_and_extras(pl):
    row = {"short_token": "no2015", "extra_short_tokens": ["NO2016", "no2015", "NO2017"]}
    assert pl.line_tokens(row) == ["NO2015", "NO2016", "NO2017"]


def test_line_tokens_tolerates_legacy_garbage(pl):
    # Token legado fora do formato não pode derrubar a leitura.
    row = {"short_token": "weird token", "extra_short_tokens": None}
    assert pl.line_tokens(row) == ["WEIRD TOKEN"]
    assert pl.line_tokens({"short_token": None}) == []


# ─── set_line_tokens ─────────────────────────────────────────────────────────
def _current(source="xandr", line_id=42, code="NO2015", extras=None):
    return [{"source": source, "line_id": line_id, "line_name": "L",
             "line_code": code, "short_token": code,
             "extra_short_tokens": extras or []}]


def test_set_tokens_adds_extra_without_touching_xandr(pl):
    fake = pl._fake
    fake.queue = [_current()]                     # _fetch_line_tokens
    puts = []
    pl.set_line_tokens("xandr", 42, ["NO2015", "no2016"], "joao@hypr",
                       xandr_put=lambda lid, code: puts.append((lid, code)))
    assert puts == []                             # principal não mudou
    upd = [c for c in fake.calls if c[0].startswith("UPDATE")][0]
    assert upd[1]["code"] == "NO2015"
    assert list(upd[1]["extras"]) == ["NO2016"]
    assert upd[1]["lid"] == 42 and upd[1]["src"] == "xandr"
    assert "COALESCE(source, 'xandr') = @src" in upd[0]
    assert fake.calls[-1][0] == "REFRESH"


def test_set_tokens_changing_primary_puts_on_xandr(pl):
    fake = pl._fake
    fake.queue = [_current(code="NO2015", extras=["NO2016"])]
    puts = []
    pl.set_line_tokens("xandr", 42, ["NO2016", "NO2015"], "joao@hypr",
                       xandr_put=lambda lid, code: puts.append((lid, code)))
    assert puts == [(42, "NO2016")]
    upd = [c for c in fake.calls if c[0].startswith("UPDATE")][0]
    assert upd[1]["code"] == "NO2016"
    assert list(upd[1]["extras"]) == ["NO2015"]


def test_set_tokens_empty_list_unlinks_everything(pl):
    fake = pl._fake
    fake.queue = [_current(code="NO2015", extras=["NO2016"])]
    puts = []
    pl.set_line_tokens("xandr", 42, [], "joao@hypr",
                       xandr_put=lambda lid, code: puts.append((lid, code)))
    assert puts == [(42, None)]
    upd = [c for c in fake.calls if c[0].startswith("UPDATE")][0]
    assert upd[1]["code"] is None
    assert list(upd[1]["extras"]) == []


def test_set_tokens_pubmatic_never_calls_xandr(pl):
    fake = pl._fake
    fake.queue = [_current(source="pubmatic", line_id=735537, code=None)]
    puts = []
    pl.set_line_tokens("pubmatic", 735537, ["NO2015", "NO2016"], "joao@hypr",
                       xandr_put=lambda lid, code: puts.append((lid, code)))
    assert puts == []
    upd = [c for c in fake.calls if c[0].startswith("UPDATE")][0]
    assert upd[1]["src"] == "pubmatic" and upd[1]["code"] == "NO2015"


def test_set_tokens_line_not_found(pl):
    pl._fake.queue = [[]]
    with pytest.raises(ValueError):
        pl.set_line_tokens("xandr", 999, ["NO2015"], "x")


def test_set_tokens_invalid_token_fails_before_any_write(pl):
    fake = pl._fake
    with pytest.raises(ValueError):
        pl.set_line_tokens("xandr", 42, ["bad token"], "x", xandr_put=lambda *a: None)
    assert fake.calls == []


# ─── find_token_conflicts ────────────────────────────────────────────────────
def test_find_conflicts_reports_only_requested_tokens(pl):
    fake = pl._fake
    fake.queue = [[
        {"source": "xandr", "line_id": 7, "line_name": "Outra",
         "short_token": "NO2016", "extra_short_tokens": ["ZZ9999", "NO2017"]},
    ]]
    out = pl.find_token_conflicts(["no2016", "NO2017"], "xandr", 42)
    assert out == [
        {"short_token": "NO2016", "source": "xandr", "line_id": 7, "line_name": "Outra"},
        {"short_token": "NO2017", "source": "xandr", "line_id": 7, "line_name": "Outra"},
    ]
    sql, params = fake.calls[0]
    assert list(params["tokens"]) == ["NO2016", "NO2017"]
    assert params["lid"] == 42 and params["src"] == "xandr"
    assert "UNNEST(li.extra_short_tokens)" in sql


def test_find_conflicts_empty_tokens_skips_query(pl):
    assert pl.find_token_conflicts([], "xandr", 1) == []
    assert pl._fake.calls == []


def test_is_token_in_use_legacy_wrapper(pl):
    pl._fake.queue = [[{"source": "xandr", "line_id": 9, "line_name": None,
                        "short_token": "AB12", "extra_short_tokens": []}]]
    assert pl.is_token_in_use("ab12", exclude_line_id=1) == 9
    pl._fake.queue = [[]]
    assert pl.is_token_in_use("AB12", exclude_line_id=1) is None


# ─── lookup_checklists ───────────────────────────────────────────────────────
def test_lookup_checklists_one_entry_per_token_in_order(pl):
    pl._fake.queue = [[
        {"short_token": "no2016", "client": "Amazon", "campaign_name": "Copa",
         "agency": "ALMAP", "cp_name": "A", "cs_name": "B",
         "investment": Decimal("250000.50"), "deal_dv360": True,
         "start_date": date(2026, 5, 1), "end_date": date(2026, 6, 30)},
    ]]
    out = pl.lookup_checklists(["NO2015", "NO2016"])
    assert out[0] == {"short_token": "NO2015", "found": False}
    assert out[1]["found"] is True
    assert out[1]["investment"] == 250000.5
    assert out[1]["start_date"] == "2026-05-01"
    assert out[1]["client"] == "Amazon"


# ─── _jsonable ───────────────────────────────────────────────────────────────
def test_jsonable_converts_nested_dates(pl):
    row = {
        "line_id": 1,
        "linked_checklists": [
            {"short_token": "A1", "start_date": date(2026, 1, 2),
             "end_date": None, "investment": Decimal("10")},
        ],
        "updated_at": datetime(2026, 1, 2, 3, 4, 5),
        "deal_ids": (1, 2),
    }
    out = pl._jsonable(row)
    assert out["linked_checklists"][0]["start_date"] == "2026-01-02"
    assert out["updated_at"] == "2026-01-02T03:04:05"
    assert out["deal_ids"] == [1, 2]
    assert out["linked_checklists"][0]["investment"] == Decimal("10")


# ─── set_line_code_local (legado) ────────────────────────────────────────────
def test_set_line_code_local_keeps_extras_and_is_source_aware(pl):
    fake = pl._fake
    pl.set_line_code_local(42, "no2015", "x", source="pubmatic")
    sql, params = fake.calls[0]
    assert params["code"] == "NO2015" and params["src"] == "pubmatic"
    assert "UNNEST(extra_short_tokens)" in sql          # preserva extras
    assert fake.calls[-1][0] == "REFRESH"
