"""
Stale-while-revalidate do `?list=true` (ver _get_campaigns_list_cached).

Quando a base muda (ou o TTL vence), o menu admin recebe a última lista boa na
hora e a query fria roda em background. Mutação admin continua derrubando tudo:
o que acabou de ser salvo nunca volta velho. O BigQuery é substituído por dublês.
"""
import threading

import pytest

import main


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    def reset():
        main._list_cache.clear()
        main._list_stale.clear()
        main._clients_cache.clear()
        main._list_rebuild_running["v"] = False
    reset()
    monkeypatch.setattr(main, "_bust_stale_caches_if_base_changed", lambda: None)
    monkeypatch.setattr(main, "_fresh_read_prelude", lambda: None)
    yield
    reset()


class FakeQuery:
    """query_campaigns_list controlável: conta chamadas e pode segurar a
    execução até o teste liberar (simula a query fria)."""

    def __init__(self):
        self.calls = 0
        self.value = ["nova"]
        self.gate = None
        self.started = threading.Event()
        self.done = threading.Event()

    def __call__(self):
        self.calls += 1
        self.started.set()
        if self.gate is not None:
            self.gate.wait(5)
        self.done.set()
        return list(self.value)


@pytest.fixture
def query(monkeypatch):
    fq = FakeQuery()
    monkeypatch.setattr(main, "query_campaigns_list", fq)
    return fq


def bust_like_base_change():
    """O que _bust_stale_caches_if_base_changed faz com a lista."""
    main._list_cache.pop("all", None)


def wait_rebuild():
    for _ in range(200):
        if not main._list_rebuild_running["v"]:
            return
        threading.Event().wait(0.01)
    raise AssertionError("rebuild em background não terminou")


def test_sem_copia_stale_espera_a_query(query):
    data, hit = main._get_campaigns_list_cached(allow_stale=True)
    assert data == ["nova"] and hit is False
    assert query.calls == 1


def test_base_mudou_serve_stale_e_reconstroi_em_background(query):
    main._store_campaigns_list(["velha"])
    bust_like_base_change()
    query.gate = threading.Event()

    data, hit = main._get_campaigns_list_cached(allow_stale=True)
    assert data == ["velha"] and hit == "stale"

    # Enquanto reconstrói, quem chega também leva a stale — sem 2ª query.
    data, hit = main._get_campaigns_list_cached(allow_stale=True)
    assert hit == "stale"

    query.gate.set()
    wait_rebuild()
    assert query.calls == 1
    data, hit = main._get_campaigns_list_cached(allow_stale=True)
    assert data == ["nova"] and hit is True


def test_sem_allow_stale_segue_sincrono(query):
    """Portal, clientes e demais chamadores não recebem lista velha: eles
    cacheiam payload derivado por horas em cima dela."""
    main._store_campaigns_list(["velha"])
    bust_like_base_change()
    data, hit = main._get_campaigns_list_cached()
    assert data == ["nova"] and hit is False


def test_mutacao_admin_derruba_a_copia_stale(query):
    main._store_campaigns_list(["velha"])
    main._cache_invalidate_token("ABC123")
    data, hit = main._get_campaigns_list_cached(allow_stale=True)
    assert data == ["nova"] and hit is False


def test_force_refresh_ignora_stale(query):
    main._store_campaigns_list(["velha"])
    bust_like_base_change()
    data, hit = main._get_campaigns_list_cached(force_refresh=True, allow_stale=True)
    assert data == ["nova"] and hit is False


def test_stale_velha_demais_nao_serve(query, monkeypatch):
    main._store_campaigns_list(["velha"])
    bust_like_base_change()
    ts, val = main._list_stale["all"]
    main._list_stale["all"] = (ts - main._LIST_STALE_MAX_AGE - 1, val)
    data, hit = main._get_campaigns_list_cached(allow_stale=True)
    assert data == ["nova"] and hit is False


def test_rebuild_que_falha_mantem_stale_e_libera_a_flag(query, monkeypatch):
    main._store_campaigns_list(["velha"])
    bust_like_base_change()

    def boom():
        raise RuntimeError("bq caiu")
    monkeypatch.setattr(main, "query_campaigns_list", boom)

    data, hit = main._get_campaigns_list_cached(allow_stale=True)
    assert hit == "stale"
    wait_rebuild()
    data, hit = main._get_campaigns_list_cached(allow_stale=True)
    assert data == ["velha"] and hit == "stale"


def test_mutacao_durante_rebuild_descarta_o_resultado(query):
    main._store_campaigns_list(["velha"])
    bust_like_base_change()
    query.gate = threading.Event()
    query.value = ["pre-mutacao"]

    main._get_campaigns_list_cached(allow_stale=True)
    assert query.started.wait(5)
    main._cache_invalidate_token("ABC123")  # admin salvou algo no meio
    query.gate.set()
    wait_rebuild()

    assert "all" not in main._list_cache and "all" not in main._list_stale
