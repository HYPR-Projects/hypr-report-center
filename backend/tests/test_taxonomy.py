"""Taxonomia do BigQuery: nomes antigos → bidiq_app.reportcenter_* (BQ_TABLE_LAYOUT)."""
from google.cloud import bigquery

import bq_client
import taxonomy


def test_desligado_nao_muda_nada(monkeypatch):
    monkeypatch.delenv("BQ_TABLE_LAYOUT", raising=False)
    assert taxonomy.fq("prod_assets", "campaign_closures") == "site-hypr.prod_assets.campaign_closures"
    sql = "SELECT * FROM `site-hypr.prod_assets.report_snapshots`"
    assert taxonomy.fq_sql(sql) == sql
    assert bq_client._map_table("site-hypr.prod_assets.pmp_line_items") == "site-hypr.prod_assets.pmp_line_items"


def test_ligado_troca_so_o_que_esta_no_mapa(monkeypatch):
    monkeypatch.setenv("BQ_TABLE_LAYOUT", "taxonomy")
    assert taxonomy.fq("prod_assets", "campaign_closures") == "site-hypr.bidiq_app.reportcenter_campaign_closures"
    assert taxonomy.fq("prod_prod_hypr_reporthub", "sheets_integrations") == "site-hypr.bidiq_app.reportcenter_sheets_integrations"
    # fora do mapa: lido de outros sistemas / gravado pelo hyprster
    assert taxonomy.fq("prod_assets", "checklist_info") == "site-hypr.prod_assets.checklist_info"
    assert taxonomy.fq("prod_prod_hypr_reporthub", "campaign_results") == "site-hypr.prod_prod_hypr_reporthub.campaign_results"
    sql = taxonomy.fq_sql(
        "MERGE `site-hypr.prod_assets.report_access_daily` T USING prod_assets.report_access_events S "
        "JOIN `site-hypr.prod_assets.checklist_info` c ON TRUE, prod_assets.INFORMATION_SCHEMA.COLUMNS"
    )
    assert "bidiq_app.reportcenter_access_daily" in sql
    assert "bidiq_app.reportcenter_access_events" in sql
    assert "prod_assets.checklist_info" in sql
    assert "prod_assets.INFORMATION_SCHEMA" in sql


def test_identificadores_do_client(monkeypatch):
    monkeypatch.setenv("BQ_TABLE_LAYOUT", "taxonomy")
    assert (bq_client._map_table("site-hypr:prod_assets.pmp_line_delivery_daily$20260930")
            == "site-hypr:bidiq_app.reportcenter_pmp_line_delivery_daily$20260930")
    ref = bigquery.TableReference(bigquery.DatasetReference("site-hypr", "prod_assets"), "pmp_line_items")
    novo = bq_client._map_table(ref)
    assert (novo.dataset_id, novo.table_id) == ("bidiq_app", "reportcenter_pmp_line_items")
    tb = bigquery.Table("site-hypr.prod_assets.report_snapshots")
    bq_client._map_table(tb)
    assert (tb.dataset_id, tb.table_id) == ("bidiq_app", "reportcenter_snapshots")


def test_mapa_tem_as_36_tabelas():
    assert len(taxonomy.TAXONOMY_TABLES) == 36
    assert all(d == "bidiq_app" and t.startswith("reportcenter_") for d, t in taxonomy.TAXONOMY_TABLES.values())
