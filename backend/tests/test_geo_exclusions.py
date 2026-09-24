"""Exclusão de entrega fora do BR no report (geo_exclusions).

O que se crava aqui:
  - a fonte ajustada multiplica cada métrica pela fração certa (cliques pela
    fração de cliques, custo cliente pela mídia) e mantém inteiro o que é
    inteiro;
  - token sem ajuste não paga o JOIN, e sem nenhum token a tabela crua passa;
  - o refresh só publica fração de token conciliado e mantém a última boa de
    quem não fechou;
  - auto-freeze não congela campanha com ajuste ativo (a estimativa do dia
    que falta no Region ainda vai mudar).

Sem BigQuery: o SQL é checado quanto à forma; a validação numérica foi feita
no BQ em 24/09/2026 (8 campanhas, conciliação entre 0,01% e 0,15%).
"""
import pytest

import geo_exclusions as ge


class FakeJob:
    def __init__(self, rows):
        self._rows = rows

    def result(self):
        return self._rows


class FakeBQ:
    def __init__(self, rows=None, fail=False):
        self.rows = rows or []
        self.fail = fail
        self.queries = []

    def query(self, sql, job_config=None, location=None):
        self.queries.append(sql)
        if self.fail:
            raise RuntimeError("boom")
        return FakeJob(self.rows)


@pytest.fixture(autouse=True)
def reset_cache():
    ge.invalidate_active_cache()
    yield
    ge.invalidate_active_cache()


def set_active(tokens):
    ge._active_cache["tokens"] = frozenset(tokens)
    ge._active_cache["ts"] = 1e18  # nunca expira no teste


# ── Fonte ajustada ─────────────────────────────────────────────────────────

def test_unified_ajusta_cada_metrica_pela_sua_fracao():
    sql = ge.adjusted_sql("`p.d.unified`", "unified")
    assert "FROM `p.d.unified` t" in sql
    assert "CAST(ROUND(t.impressions * (1 - IFNULL(a.f_imps, 0))) AS INT64) AS impressions" in sql
    assert "CAST(ROUND(t.viewable_impressions * (1 - IFNULL(a.f_viewable, 0))) AS INT64) AS viewable_impressions" in sql
    # clique fora tem CTR de bot: usa a fração de cliques, não a de impressões
    assert "CAST(ROUND(t.clicks * (1 - IFNULL(a.f_clicks, 0))) AS INT64) AS clicks" in sql
    assert "t.video_view_100_complete * (1 - IFNULL(a.f_video, 0))" in sql
    # custo DSP (admin) fica cheio: o dinheiro foi gasto, e a visão de custo
    # do mês/tech cost precisa dele inteiro
    assert "AS total_cost" not in sql
    for key in ("short_token", "date", "line_item_id", "creative_id"):
        assert f"a.{key} = t.{key}" in sql


def test_campaign_results_custo_cliente_segue_a_midia():
    sql = ge.adjusted_sql("`p.d.cr`", "campaign_results")
    frac = "IF(t.media_type = 'VIDEO', a.f_video, a.f_viewable)"
    assert f"t.effective_total_cost * (1 - IFNULL({frac}, 0)) AS effective_total_cost" in sql
    assert f"t.effective_cost_with_over * (1 - IFNULL({frac}, 0)) AS effective_cost_with_over" in sql
    # vídeo viewable é FLOAT na campaign_results
    assert "t.viewable_video_view_100_complete * (1 - IFNULL(a.f_video, 0)) AS viewable_video_view_100_complete" in sql
    # contrato não é entrega: não se mexe
    for col in ("total_invested", "deal_cpm_amount", "effective_cpm_amount"):
        assert f"AS {col}" not in sql


def test_fonte_com_time_travel_ganha_subquery_antes_do_alias():
    base = "`p.d.u` FOR SYSTEM_TIME AS OF TIMESTAMP('2026-09-20')"
    sql = ge.adjusted_sql(base, "unified")
    assert f"FROM (SELECT * FROM {base}) t" in sql


def test_sem_token_ajustado_devolve_a_tabela_crua():
    set_active([])
    assert ge.adjusted_source(FakeBQ(), "`t`", "unified", "ABC123") == "`t`"
    assert ge.adjusted_source(FakeBQ(), "`t`", "unified") == "`t`"


def test_token_sem_ajuste_nao_paga_o_join():
    set_active(["O3HI21"])
    assert ge.adjusted_source(FakeBQ(), "`t`", "unified", "ABC123") == "`t`"


def test_token_ajustado_e_lista_recebem_a_fonte_ajustada():
    set_active(["O3HI21"])
    assert "LEFT JOIN" in ge.adjusted_source(FakeBQ(), "`t`", "unified", "o3hi21")
    assert "LEFT JOIN" in ge.adjusted_source(FakeBQ(), "`t`", "campaign_results")


def test_leitura_dos_tokens_falhou_mantem_o_ultimo_valor():
    ge._active_cache["tokens"] = frozenset(["O3HI21"])
    ge._active_cache["ts"] = 0  # expirado
    assert ge.active_tokens(FakeBQ(fail=True)) == frozenset(["O3HI21"])


def test_leitura_dos_tokens_falhou_sem_historico_nao_ajusta():
    assert ge.active_tokens(FakeBQ(fail=True)) == frozenset()


# ── Refresh ────────────────────────────────────────────────────────────────

def test_refresh_publica_so_token_conciliado_e_guarda_o_ultimo_bom():
    sql = ge.build_refresh_script(tolerance=0.005)
    assert "<= 0.005 THEN 'ok'" in sql
    publish = sql[sql.index(f"CREATE OR REPLACE TABLE {ge.ADJ_TABLE}"):]
    # fração nova só pra quem conciliou
    assert "FROM new_adj\nWHERE short_token IN (SELECT short_token FROM new_status WHERE status = 'ok')" in publish
    # quem não fechou (ou ficou fora do cálculo) mantém a publicada; quem saiu da config some
    assert f"FROM {ge.ADJ_TABLE}\nWHERE short_token IN (SELECT short_token FROM cfg_all)" in publish
    assert "NOT IN (SELECT short_token FROM new_status WHERE status = 'ok')" in publish


def test_refresh_nao_conta_pais_nao_resolvido_nem_liberado():
    sql = ge.build_refresh_script()
    # código não-ISO (NULL, 'BRA') não é prova de entrega fora
    assert "REGEXP_CONTAINS(IFNULL(cc, ''), r'^[A-Z]{2}$')" in sql
    assert "cc NOT IN UNNEST(allowed)" in sql
    # BR sempre + países liberados no drawer do box Fora do BR
    assert "ARRAY_CONCAT(['BR'], IFNULL(o.countries, []))" in sql
    assert ge.OVERRIDES_TABLE in sql


def test_refresh_marca_estimativa_do_dia_sem_region():
    sql = ge.build_refresh_script()
    assert "'line_window'" in sql and "'line_day'" in sql and "'exact'" in sql
    # conciliação só nas chaves exatas que existem na unified
    assert "a.method = 'exact' AND a.u_imps > 0" in sql


def test_refresh_if_stale_sem_config_nao_roda(monkeypatch):
    monkeypatch.setattr(ge, "ensure_tables", lambda bq: None)
    monkeypatch.setattr(ge, "has_config", lambda bq: False)
    set_active([])
    called = []
    monkeypatch.setattr(ge, "refresh", lambda bq: called.append(1))
    assert ge.refresh_if_stale(FakeBQ()) is None
    assert not called


def test_refresh_if_stale_so_roda_quando_fonte_mudou(monkeypatch):
    monkeypatch.setattr(ge, "has_config", lambda bq: True)
    monkeypatch.setattr(ge, "needs_refresh", lambda bq: False)
    monkeypatch.setattr(ge, "refresh", lambda bq: pytest.fail("não devia rodar"))
    assert ge.refresh_if_stale(FakeBQ()) is None
    monkeypatch.setattr(ge, "needs_refresh", lambda bq: True)
    monkeypatch.setattr(ge, "refresh", lambda bq: [{"short_token": "X", "status": "ok"}])
    assert ge.refresh_if_stale(FakeBQ()) == [{"short_token": "X", "status": "ok"}]


# ── Config ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw", ["", None, "abc", "O3HI21; DROP", "A" * 20])
def test_token_invalido_recusado(raw):
    with pytest.raises(ValueError):
        ge.normalize_token(raw)


def test_token_normalizado_em_maiusculo():
    assert ge.normalize_token(" o3hi21 ") == "O3HI21"


def test_janela_invertida_recusada(monkeypatch):
    monkeypatch.setattr(ge, "ensure_tables", lambda bq: None)
    with pytest.raises(ValueError):
        ge.save_exclusion(FakeBQ(), "O3HI21", date_from="2026-09-30", date_to="2026-09-01")


def test_save_sem_janela_grava_nulo(monkeypatch):
    monkeypatch.setattr(ge, "ensure_tables", lambda bq: None)
    fake = FakeBQ()
    out = ge.save_exclusion(fake, "o3hi21", reason="setup sem geo")
    assert out == {"short_token": "O3HI21", "date_from": None, "date_to": None}
    assert "MERGE" in fake.queries[0]


# ── Integração com o main ──────────────────────────────────────────────────

def test_geo_sql_troca_as_duas_tabelas_sem_recursao():
    import main
    set_active(["O3HI21"])
    raw = f"SELECT * FROM {main.table_ref()} JOIN {main.UNIFIED_REF} USING (x)"
    out = main._geo_sql(raw)
    # cada tabela aparece uma vez, dentro do próprio wrapper
    assert out.count(main.table_ref()) == 1
    assert out.count(main.UNIFIED_REF) == 1
    assert out.count("LEFT JOIN") == 2
    assert "\x00" not in out


def test_geo_sql_sem_ajuste_nao_mexe():
    import main
    set_active([])
    raw = f"SELECT * FROM {main.table_ref()}"
    assert main._geo_sql(raw) == raw


def test_auto_freeze_pula_campanha_com_ajuste_ativo():
    import main
    set_active(["FITP2U"])
    ok, reason = main._stability_ok("FITP2U", 40_000)
    assert ok is False
    assert "exclusão geo" in reason


def test_status_guarda_o_custo_dsp_fora_do_br_e_a_versao():
    sql = ge.build_refresh_script()
    assert "SUM(u.cost * IFNULL(a.f_cost, 0)) AS removed_cost" in sql
    assert f"{ge.SCRIPT_VERSION} AS script_version" in sql


def test_resumo_pro_card_so_de_token_ativo(monkeypatch):
    set_active(["O3HI21"])
    rows = [
        {"short_token": "O3HI21", "removed_imps": 12860878.6, "removed_viewable": 11036294.7,
         "removed_cost": 6040.21, "status": "ok"},
        {"short_token": "RPLJP9", "removed_imps": 1, "removed_viewable": 1,
         "removed_cost": 1, "status": "blocked"},
    ]
    out = ge.summary_by_token(FakeBQ(rows=rows))
    assert out == {"O3HI21": {"impressions": 12860879, "viewable": 11036295,
                              "cost": 6040.21, "status": "ok"}}


def test_resumo_sem_token_ativo_nem_consulta():
    set_active([])
    fake = FakeBQ(rows=[{"short_token": "X"}])
    assert ge.summary_by_token(fake) == {}
    assert fake.queries == []


# ── Velocidade do toggle ───────────────────────────────────────────────────

def test_recalculo_parcial_preserva_os_outros_tokens():
    sql = ge.build_refresh_script()
    assert "DECLARE scope ARRAY<STRING> DEFAULT @scope;" in sql
    assert "WHERE NOT scoped OR e.short_token IN UNNEST(scope)" in sql
    # status dos tokens fora do cálculo é reaproveitado, com colunas explícitas
    assert f"SELECT {ge._STATUS_COLS} FROM {ge.STATUS_TABLE}\nWHERE scoped" in sql
    # frações dos tokens fora do cálculo (ou que não fecharam) ficam
    assert "AND short_token NOT IN (SELECT short_token FROM new_status WHERE status = 'ok')" in sql


def test_recalculo_le_a_copia_compacta_particionada():
    sql = ge.build_refresh_script()
    assert ge.COMPACT_TABLE in sql
    assert ge.REGIONS_TABLE not in sql  # a original não é particionada (~19 GB por leitura)
    compact = ge.build_compact_sql()
    assert "PARTITION BY date" in compact and "CLUSTER BY line_item_id" in compact
    assert ge.REGIONS_TABLE in compact


def test_refresh_parcial_vira_total_com_status_de_versao_antiga(monkeypatch):
    monkeypatch.setattr(ge, "ensure_tables", lambda bq: None)
    monkeypatch.setattr(ge, "_last_modified_ms", lambda bq, d, t: 1)
    monkeypatch.setattr(ge, "_status_is_current", lambda bq: False)
    seen = {}

    class CaptureBQ(FakeBQ):
        def query(self, sql, job_config=None, location=None):
            seen["params"] = {p.name: p.values for p in job_config.query_parameters}
            return FakeJob([])

    ge.refresh(CaptureBQ(), scope=["rpljp9"])
    assert seen["params"]["scope"] == []


def test_refresh_parcial_manda_so_o_token(monkeypatch):
    monkeypatch.setattr(ge, "ensure_tables", lambda bq: None)
    monkeypatch.setattr(ge, "_last_modified_ms", lambda bq, d, t: 1)
    monkeypatch.setattr(ge, "_status_is_current", lambda bq: True)
    seen = {}

    class CaptureBQ(FakeBQ):
        def query(self, sql, job_config=None, location=None):
            seen["params"] = {p.name: p.values for p in job_config.query_parameters}
            return FakeJob([])

    ge.refresh(CaptureBQ(), scope=["rpljp9"])
    assert seen["params"]["scope"] == ["RPLJP9"]


def test_desligar_apaga_config_fracoes_e_status_sem_recalcular(monkeypatch):
    monkeypatch.setattr(ge, "ensure_tables", lambda bq: None)
    set_active(["RPLJP9"])
    fake = FakeBQ()
    assert ge.delete_exclusion(fake, "rpljp9") == "RPLJP9"
    sql = fake.queries[0]
    for table in (ge.CONFIG_TABLE, ge.ADJ_TABLE, ge.STATUS_TABLE):
        assert f"DELETE FROM {table} WHERE short_token = @token" in sql
    assert ge._active_cache["tokens"] is None  # cache derrubado na hora


def test_refresh_true_descarta_o_cache_geo_da_instancia():
    import main
    set_active(["RPLJP9"])
    main._cache_set(main._base_version_cache, "v", (1, 2, 3))
    main._fresh_read_prelude()
    assert ge._active_cache["tokens"] is None
    assert "v" not in main._base_version_cache
