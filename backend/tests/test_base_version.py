"""
Versão da base que fura os caches ao vivo (report + lista + clientes).

O checklist_info é regravado toda hora sem mudar de conteúdo; o last_modified
dele só pode servir de gatilho pro fingerprint, senão cada regravação idêntica
derruba o cache de todo mundo (ver o bloco "checklist_info versiona por
CONTEÚDO" em main.py). Aqui o BigQuery é substituído por dublês.
"""
import pytest

import main


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    main._base_version_cache.clear()
    main._last_seen_base_version["v"] = None
    main._checklist_fp_memo.update(lm=None, fp=None)
    main._list_cache.clear()
    main._clients_cache.clear()
    main._report_cache.clear()
    yield
    main._base_version_cache.clear()
    main._last_seen_base_version["v"] = None
    main._checklist_fp_memo.update(lm=None, fp=None)
    main._list_cache.clear()
    main._clients_cache.clear()
    main._report_cache.clear()


class FakeBase:
    """last_modified e conteúdo controláveis, com contagem de scans."""

    def __init__(self):
        self.cr_lm = 1000
        self.ck_lm = 5000
        self.ck_fp = 111
        self.fp_fails = False
        self.scans = 0

    def last_modified(self, dataset, table, location=None):
        return self.cr_lm if table == main.TABLE else self.ck_lm

    def fingerprint(self, dataset, table, location=None):
        self.scans += 1
        return None if self.fp_fails else self.ck_fp


@pytest.fixture
def base(monkeypatch):
    fb = FakeBase()
    monkeypatch.setattr(main, "_table_last_modified", fb.last_modified)
    monkeypatch.setattr(main, "_table_content_fingerprint", fb.fingerprint)
    return fb


def check():
    """Uma checagem nova (como se os 60s do cache de versão tivessem passado)."""
    main._base_version_cache.clear()
    main._bust_stale_caches_if_base_changed()


def warm_caches():
    main._cache_set(main._list_cache, "all", ["lista"])
    main._cache_set(main._clients_cache, "all", {"clients": []})
    main._cache_set(main._report_cache, "ABC123", {"campaign": {}})


def cached():
    return "all" in main._list_cache and "ABC123" in main._report_cache


def test_regravacao_identica_do_checklist_nao_fura(base):
    check()  # 1ª checagem só registra
    warm_caches()
    base.ck_lm = 6000  # job regravou, conteúdo igual
    check()
    assert cached()


def test_contrato_editado_fura(base):
    check()
    warm_caches()
    base.ck_lm, base.ck_fp = 6000, 222
    check()
    assert not cached()
    assert "all" not in main._clients_cache


def test_fingerprint_so_roda_quando_a_tabela_e_regravada(base):
    check()
    check()
    check()
    assert base.scans == 1
    base.ck_lm = 6000
    check()
    assert base.scans == 2


def test_campaign_results_segue_furando_por_last_modified(base):
    check()
    warm_caches()
    base.cr_lm = 2000
    check()
    assert not cached()


def test_fingerprint_falhou_fura_como_antes(base):
    check()
    warm_caches()
    base.ck_lm, base.fp_fails = 6000, True
    check()
    assert not cached()  # conservador: não arrisca servir contrato velho


def test_last_modified_ilegivel_ignora_o_componente(base, monkeypatch):
    check()
    warm_caches()
    monkeypatch.setattr(
        main, "_table_last_modified",
        lambda d, t, location=None: base.cr_lm if t == main.TABLE else None,
    )
    check()
    assert cached()
