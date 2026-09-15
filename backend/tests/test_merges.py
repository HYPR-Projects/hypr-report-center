"""Merge Reports (merges.py) — regras de agrupamento sem tocar o BigQuery.

O client do BQ é um stub FIFO: cada `query()` devolve o próximo lote de rows
da fila e registra (sql, params). O que cada bloco crava:

  list_mergeable_tokens   cada candidato traz `merge_id` (None se solto),
                          `in_other_group` e `already_in_group` coerentes
  merge_tokens            • base solto + membros de UM grupo → entra nesse
                            grupo: INSERT só de quem falta, modes do grupo
                          • tokens de 2+ grupos sem merge_groups → 409
                          • com merge_groups → funde no grupo do base:
                            DELETE dos outros grupos inteiros, INSERT de
                            todos os membros deles (+ soltos) no alvo
"""
import sys
import types

import pytest


# ─── Stubs: google.cloud.bigquery + bq_client ────────────────────────────────
class _Scalar:
    def __init__(self, name, type_, value):
        self.name, self.type_, self.value = name, type_, value


class _Array:
    def __init__(self, name, type_, values):
        self.name, self.type_, self.values = name, type_, list(values)


class _JobConfig:
    def __init__(self, query_parameters=None):
        self.query_parameters = query_parameters or []


class _Job:
    def __init__(self, rows):
        self._rows = rows

    def result(self, *a, **k):
        return list(self._rows)


class FakeBQ:
    def __init__(self):
        self.calls = []
        self.queue = []

    def query(self, sql, job_config=None, **kw):
        params = {}
        for p in (job_config.query_parameters if job_config else []):
            params[p.name] = getattr(p, "values", getattr(p, "value", None))
        self.calls.append((" ".join(sql.split()), params))
        rows = self.queue.pop(0) if self.queue else []
        return _Job(rows)

    def sql_calls(self):
        return [c[0] for c in self.calls]


@pytest.fixture
def mg(monkeypatch):
    fake = FakeBQ()
    bigquery = types.ModuleType("google.cloud.bigquery")
    bigquery.QueryJobConfig = _JobConfig
    bigquery.ScalarQueryParameter = _Scalar
    bigquery.ArrayQueryParameter = _Array
    google = types.ModuleType("google")
    cloud = types.ModuleType("google.cloud")
    cloud.bigquery = bigquery
    google.cloud = cloud
    monkeypatch.setitem(sys.modules, "google", google)
    monkeypatch.setitem(sys.modules, "google.cloud", cloud)
    monkeypatch.setitem(sys.modules, "google.cloud.bigquery", bigquery)
    stub = types.ModuleType("bq_client")
    stub.get_client = lambda: fake
    monkeypatch.setitem(sys.modules, "bq_client", stub)
    original = sys.modules.pop("merges", None)
    import merges
    merges.bq = fake
    merges._table_ensured = True
    merges._fake = fake
    yield merges
    if original is not None:
        sys.modules["merges"] = original
    else:
        sys.modules.pop("merges", None)


def _grp(mid, tokens, rmnd="merge", pdooh="latest"):
    return [
        {"merge_id": mid, "short_token": t, "client_name": "Acme",
         "rmnd_mode": rmnd, "pdooh_mode": pdooh, "created_by": "x", "created_at": None}
        for t in tokens
    ]


# ─── list_mergeable_tokens ───────────────────────────────────────────────────
def test_list_mergeable_exposes_merge_id_of_each_candidate(mg):
    f = mg._fake
    f.queue = [
        [{"short_token": "D", "client_name": "Acme"}],                     # meta do base
        [                                                                  # todos os tokens
            {"short_token": "A", "client_name": "Acme", "campaign_name": "Jan", "start_date": "2026-01-01", "end_date": "2026-01-31"},
            {"short_token": "B", "client_name": "Acme", "campaign_name": "Fev", "start_date": "2026-02-01", "end_date": "2026-02-28"},
            {"short_token": "E", "client_name": "Acme", "campaign_name": "Solto", "start_date": "2025-12-01", "end_date": "2025-12-31"},
            {"short_token": "Z", "client_name": "Outro", "campaign_name": "x", "start_date": None, "end_date": None},
        ],
        [],                                                                # base não está em grupo
        [{"short_token": "A", "merge_id": "G1", "rmnd_mode": None, "pdooh_mode": None},
         {"short_token": "B", "merge_id": "G1", "rmnd_mode": None, "pdooh_mode": None}],
    ]
    out = {c["short_token"]: c for c in mg.list_mergeable_tokens("D")}
    assert set(out) == {"A", "B", "E"}            # "Outro" cliente fora
    assert out["A"]["merge_id"] == "G1" and out["A"]["in_other_group"] and not out["A"]["already_in_group"]
    assert out["E"]["merge_id"] is None and not out["E"]["in_other_group"]


# ─── merge_tokens: base solto entra em grupo existente ───────────────────────
def test_merge_into_existing_group_inserts_only_missing_and_keeps_modes(mg):
    f = mg._fake
    f.queue = [
        [{"short_token": t, "client_name": "Acme"} for t in ("D", "A", "B")],   # metadata
        [{"short_token": "A", "merge_id": "G1", "rmnd_mode": "latest", "pdooh_mode": "merge"},
         {"short_token": "B", "merge_id": "G1", "rmnd_mode": "latest", "pdooh_mode": "merge"}],
        [],                                                                      # INSERT
        _grp("G1", ["A", "B", "D"], rmnd="latest", pdooh="merge"),               # get_merge_group
    ]
    group = mg.merge_tokens(["D", "A", "B"], "adm@hypr", rmnd_mode="merge", pdooh_mode="merge")
    assert group["merge_id"] == "G1"
    insert = [c for c in f.calls if c[0].startswith("INSERT")]
    assert len(insert) == 1
    assert insert[0][1]["tokens"] == ["D"]                 # só quem faltava
    assert insert[0][1]["mid"] == "G1"
    assert insert[0][1]["rmnd"] == "latest"                # modes do grupo, não do caller
    assert insert[0][1]["pdooh"] == "merge"


# ─── merge_tokens: dois grupos ───────────────────────────────────────────────
def test_two_groups_without_flag_raises_409(mg):
    f = mg._fake
    f.queue = [
        [{"short_token": t, "client_name": "Acme"} for t in ("A", "C")],
        [{"short_token": "A", "merge_id": "G0", "rmnd_mode": None, "pdooh_mode": None},
         {"short_token": "C", "merge_id": "G1", "rmnd_mode": None, "pdooh_mode": None}],
    ]
    with pytest.raises(mg.TokenAlreadyMergedError) as ei:
        mg.merge_tokens(["A", "C"], "adm@hypr")
    assert ei.value.code == 409
    assert not any(c[0].startswith(("INSERT", "DELETE")) for c in f.calls)


def test_fuse_groups_moves_whole_other_group_into_base_group(mg):
    f = mg._fake
    # Base A (grupo G0 = A,B). Caller marcou só C do grupo G1 (= C,D,E) e o
    # solto F. Esperado: G1 inteiro (C,D,E) + F entram em G0; G1 é apagado.
    f.queue = [
        [{"short_token": t, "client_name": "Acme"} for t in ("A", "C", "F")],       # metadata
        [{"short_token": "A", "merge_id": "G0", "rmnd_mode": "merge", "pdooh_mode": "merge"},
         {"short_token": "C", "merge_id": "G1", "rmnd_mode": "latest", "pdooh_mode": "latest"}],
        _grp("G0", ["A", "B"], rmnd="merge", pdooh="merge"),                          # get_merge_group(G0) — alvo
        _grp("G1", ["C", "D", "E"], rmnd="latest", pdooh="latest"),                   # get_merge_group(G1)
        [],                                                                           # DELETE G1
        [],                                                                           # INSERT no alvo
        _grp("G0", ["A", "B", "C", "D", "E", "F"]),                                   # get_merge_group final
    ]
    group = mg.merge_tokens(["A", "C", "F"], "adm@hypr", merge_groups=True)
    assert group["merge_id"] == "G0"
    assert [m["short_token"] for m in group["members"]] == ["A", "B", "C", "D", "E", "F"]

    deletes = [c for c in f.calls if c[0].startswith("DELETE")]
    inserts = [c for c in f.calls if c[0].startswith("INSERT")]
    assert [d[1]["mid"] for d in deletes] == ["G1"]         # só o outro grupo cai
    assert len(inserts) == 1
    assert inserts[0][1]["mid"] == "G0"
    assert inserts[0][1]["tokens"] == ["C", "D", "E", "F"]  # grupo inteiro + solto, sem A/B
    assert inserts[0][1]["rmnd"] == "merge"                 # modes do alvo prevalecem
    # DELETE antes do INSERT: falha no meio deixa tokens soltos, nunca em 2 grupos
    order = [c[0].split()[0] for c in f.calls if c[0].startswith(("DELETE", "INSERT"))]
    assert order == ["DELETE", "INSERT"]


def test_fuse_groups_with_loose_base_targets_biggest_group(mg):
    f = mg._fake
    # Base X solto; marcou A (G0 = A,B) e C (G1 = C,D,E). Alvo = G1 (maior de
    # verdade, mesmo que o caller tenha listado 1 token de cada grupo).
    f.queue = [
        [{"short_token": t, "client_name": "Acme"} for t in ("X", "A", "C")],
        [{"short_token": "A", "merge_id": "G0", "rmnd_mode": None, "pdooh_mode": None},
         {"short_token": "C", "merge_id": "G1", "rmnd_mode": None, "pdooh_mode": None}],
        _grp("G0", ["A", "B"]),               # get_merge_group(G0) — ordem alfabética
        _grp("G1", ["C", "D", "E"]),          # get_merge_group(G1)
        [], [],                               # DELETE G0, INSERT
        _grp("G1", ["C", "D", "E", "A", "B", "X"]),
    ]
    group = mg.merge_tokens(["X", "A", "C"], "adm@hypr", merge_groups=True)
    assert group["merge_id"] == "G1"
    inserts = [c for c in f.calls if c[0].startswith("INSERT")]
    assert inserts[0][1]["mid"] == "G1"
    assert inserts[0][1]["tokens"] == ["A", "B", "X"]
