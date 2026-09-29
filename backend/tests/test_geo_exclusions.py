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

def test_refresh_publica_so_dsp_conciliada_e_guarda_o_ultimo_bom():
    sql = ge.build_refresh_script(tolerance=0.005)
    assert "<= 0.005 THEN 'ok'" in sql
    pub = sql[sql.index("CREATE TEMP TABLE pub_adj"):sql.index("CREATE TEMP TABLE new_status")]
    # conciliação e publicação por token × DSP: Yahoo que não fecha não
    # derruba o DV360 que fecha
    assert "GROUP BY 1, 2" in sql[sql.index("CREATE TEMP TABLE src_status"):]
    assert "FROM new_adj a JOIN src_status s USING (short_token, source)\n    WHERE s.status = 'ok'" in pub
    # a DSP que não fechou mantém a fração publicada dela
    assert "s.short_token = p.short_token AND s.source = p.source AND s.status = 'ok'" in pub
    # token fora do cálculo mantém tudo; quem saiu da config some
    assert "p.short_token IN (SELECT short_token FROM cfg_all)" in pub
    # linha anterior à v3 (sem source) é DV360
    assert "COALESCE(source, 'DV360') AS source" in sql
    # uma linha por chave: o JOIN do report nunca duplica
    assert "PARTITION BY short_token, date, line_item_id, creative_id ORDER BY source" in pub
    publish = sql[sql.index(f"CREATE OR REPLACE TABLE {ge.ADJ_TABLE}"):]
    assert "FROM pub_adj;" in publish


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
    assert "IF(method = 'exact' AND u_imps > 0, u_imps, 0)" in sql


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
    assert "SUM(cost * IFNULL(f_cost, 0)) AS removed_cost" in sql
    assert f"{ge.SCRIPT_VERSION} AS script_version" in sql
    # números do admin sobre o que ficou publicado, não sobre o cálculo novo
    assert "FROM u LEFT JOIN pub_adj a USING (short_token, date, line_item_id, creative_id)" in sql


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
    # frações dos tokens fora do cálculo ficam
    assert "AND p.short_token NOT IN (SELECT short_token FROM cfg)" in sql


def test_recalculo_le_a_copia_compacta_particionada():
    sql = ge.build_refresh_script()
    assert ge.COMPACT_TABLE in sql
    assert ge.REGIONS_TABLE not in sql  # a original não é particionada (~19 GB por leitura)
    compact = ge.build_compact_sql()
    assert "PARTITION BY date" in compact and "CLUSTER BY line_item_id" in compact
    # com a base unificada: DV360 + Yahoo, com a DSP
    assert ge.GEO_TABLE in compact and ge.REGIONS_TABLE not in compact
    assert "SELECT date, source," in compact
    # sem ela: Region cru, só DV360, como antes
    legacy = ge.build_compact_sql(from_geo=False)
    assert ge.REGIONS_TABLE in legacy and "'DV360' AS source" in legacy


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


# ── Yahoo (v3): geo por DSP ─────────────────────────────────────────────────

def test_geo_casa_line_com_a_dsp_dela():
    sql = ge.build_refresh_script()
    # DSP da line vem da unified; line só no campaign_results casa com qualquer uma
    assert "ANY_VALUE(source) AS source" in sql
    assert "AND (l.source IS NULL OR l.source = r.source)" in sql
    assert "COALESCE(e.source, d.source, w.source) AS source" in sql


def test_status_parcial_quando_uma_dsp_fecha_e_outra_nao():
    sql = ge.build_refresh_script()
    assert "COUNTIF(s.status = 'ok') > 0 AND COUNTIF(s.status = 'blocked') > 0 THEN 'partial'" in sql
    assert "TO_JSON_STRING(ARRAY_AGG(STRUCT(" in sql and "AS source_detail" in sql
    assert "source_detail" in ge._STATUS_COLS


def test_scripts_parseiam_no_dialeto_bigquery():
    sqlglot = pytest.importorskip("sqlglot")
    sqlglot.parse(ge.build_refresh_script(), read="bigquery")
    for flag in (True, False):
        sqlglot.parse_one(ge.build_compact_sql(flag), read="bigquery")


def test_tabelas_ganham_as_colunas_da_v3():
    bq = FakeBQ()
    ge._ready = False
    ge.ensure_tables(bq)
    ddl = bq.queries[0]
    assert f"ALTER TABLE {ge.ADJ_TABLE} ADD COLUMN IF NOT EXISTS source STRING" in ddl
    assert f"ALTER TABLE {ge.STATUS_TABLE} ADD COLUMN IF NOT EXISTS source_detail STRING" in ddl


@pytest.mark.parametrize("raw,expected", [
    (None, []),
    ("", []),
    ('[{"source":"DV360","status":"ok"},{"source":"YAHOO","status":"blocked"}]',
     [{"source": "DV360", "status": "ok"}, {"source": "YAHOO", "status": "blocked"}]),
    ("não é json", []),
    ('{"source":"DV360"}', []),
])
def test_source_detail_vira_lista(raw, expected):
    assert ge._parse_source_detail(raw) == expected


class _MetaBQ(FakeBQ):
    """get_table com schema/descrição controlados, e last_modified por tabela."""

    def __init__(self, compact_cols=None):
        super().__init__()
        self.compact_cols = compact_cols

    def get_table(self, table_id):
        from types import SimpleNamespace
        if table_id.endswith(ge.COMPACT_TABLE_ID):
            if self.compact_cols is None:
                raise ge.NotFound("compact")
            return SimpleNamespace(schema=[SimpleNamespace(name=c) for c in self.compact_cols])
        raise ge.NotFound(table_id)

    def query(self, sql, job_config=None, location=None):
        if f"CREATE OR REPLACE TABLE {ge.COMPACT_TABLE}" in sql:
            self.compact_cols = ["date", "source", "line_item_id"] + (
                [ge.COMPACT_GEO_MARKER] if ge.COMPACT_GEO_MARKER in sql else [])
        return super().query(sql, job_config, location)


def _lm(geo_exists):
    def f(bq, ds, table):
        if table == ge.GEO_TABLE_ID:
            return 10 if geo_exists else None
        return 5
    return f


def test_compacta_antiga_sem_source_e_refeita(monkeypatch):
    monkeypatch.setattr(ge, "_last_modified_ms", _lm(True))
    assert ge._compact_needs_rebuild(_MetaBQ(compact_cols=["date", "line_item_id", "cc"])) is True


def test_compacta_do_region_e_refeita_quando_a_unificada_aparece(monkeypatch):
    monkeypatch.setattr(ge, "_last_modified_ms", _lm(True))
    from_regions = ["date", "source"]
    from_geo = ["date", "source", ge.COMPACT_GEO_MARKER]
    assert ge._compact_needs_rebuild(_MetaBQ(compact_cols=from_regions)) is True
    assert ge._compact_needs_rebuild(_MetaBQ(compact_cols=from_geo)) is False
    monkeypatch.setattr(ge, "_last_modified_ms", _lm(False))
    assert ge._compact_needs_rebuild(_MetaBQ(compact_cols=from_regions)) is False


def test_sync_monta_da_unificada_e_marca_a_origem(monkeypatch):
    monkeypatch.setattr(ge, "_last_modified_ms", _lm(True))
    bq = _MetaBQ(compact_cols=["date", "line_item_id"])  # formato antigo
    assert ge.sync_compact(bq) is True
    assert ge.GEO_TABLE in bq.queries[-1]
    # a cópia nova já sai marcada: o próximo sync não refaz
    assert ge._compact_needs_rebuild(bq) is False


def test_sync_sem_unificada_segue_no_region(monkeypatch):
    monkeypatch.setattr(ge, "_last_modified_ms", _lm(False))
    bq = _MetaBQ(compact_cols=None)
    assert ge.sync_compact(bq, force=True) is True
    assert ge.REGIONS_TABLE in bq.queries[-1] and ge.GEO_TABLE not in bq.queries[-1]
    assert ge._compact_needs_rebuild(bq) is False
