"""Nomes das tabelas do Report Center na taxonomia do BigQuery.

Taxonomia: <pilar>_<camada>.<fonte>_<entidade> (organização do BigQuery,
Masterplan de Consolidação). Com BQ_TABLE_LAYOUT=taxonomy as tabelas que o
Report Center grava moram em `bidiq_app.reportcenter_*`; os nomes antigos
(`prod_assets.*`, `prod_prod_hypr_reporthub.sheets_integrations`) viraram views
apontando pra elas. Sem a variável nada muda.

Fora do mapa (seguem no nome antigo): `campaign_results` (gravada pelo dbt do
hyprster), `client_logos` (junção prod+dev), `report_owners_lookup` (tabela
externa de planilha) e tudo que o Report Center só lê.
"""
import os
import re

TAXONOMY_TABLES = {
    ("prod_assets", "audience_overrides"): ("bidiq_app", "reportcenter_audience_overrides"),
    ("prod_assets", "campaign_abs_overrides"): ("bidiq_app", "reportcenter_campaign_abs_overrides"),
    ("prod_assets", "campaign_af"): ("bidiq_app", "reportcenter_campaign_af"),
    ("prod_assets", "campaign_agency_overrides"): ("bidiq_app", "reportcenter_campaign_agency_overrides"),
    ("prod_assets", "campaign_alcance_frequencia"): ("bidiq_app", "reportcenter_campaign_reach_frequency"),
    ("prod_assets", "campaign_closure_details"): ("bidiq_app", "reportcenter_campaign_closure_details"),
    ("prod_assets", "campaign_closures"): ("bidiq_app", "reportcenter_campaign_closures"),
    ("prod_assets", "campaign_comments"): ("bidiq_app", "reportcenter_campaign_comments"),
    ("prod_assets", "campaign_country_overrides"): ("bidiq_app", "reportcenter_campaign_country_overrides"),
    ("prod_assets", "campaign_early_ends"): ("bidiq_app", "reportcenter_campaign_early_ends"),
    ("prod_assets", "campaign_looms"): ("bidiq_app", "reportcenter_campaign_looms"),
    ("prod_assets", "campaign_merge_groups"): ("bidiq_app", "reportcenter_campaign_merge_groups"),
    ("prod_assets", "campaign_notes"): ("bidiq_app", "reportcenter_campaign_notes"),
    ("prod_assets", "campaign_pauses"): ("bidiq_app", "reportcenter_campaign_pauses"),
    ("prod_assets", "campaign_share_ids"): ("bidiq_app", "reportcenter_campaign_share_ids"),
    ("prod_assets", "campaign_surveys"): ("bidiq_app", "reportcenter_campaign_surveys"),
    ("prod_assets", "client_portal_campaigns"): ("bidiq_app", "reportcenter_client_portal_campaigns"),
    ("prod_assets", "client_portal_config"): ("bidiq_app", "reportcenter_client_portal_config"),
    ("prod_assets", "label_overrides"): ("bidiq_app", "reportcenter_label_overrides"),
    ("prod_assets", "pmp_deals"): ("bidiq_app", "reportcenter_pmp_deals"),
    ("prod_assets", "pmp_deals_delivery"): ("bidiq_app", "reportcenter_pmp_deals_delivery"),
    ("prod_assets", "pmp_insertion_orders"): ("bidiq_app", "reportcenter_pmp_insertion_orders"),
    ("prod_assets", "pmp_line_delivery_daily"): ("bidiq_app", "reportcenter_pmp_line_delivery_daily"),
    ("prod_assets", "pmp_line_groups"): ("bidiq_app", "reportcenter_pmp_line_groups"),
    ("prod_assets", "pmp_line_items"): ("bidiq_app", "reportcenter_pmp_line_items"),
    ("prod_assets", "pmp_lines_enriched"): ("bidiq_app", "reportcenter_pmp_lines_enriched"),
    ("prod_assets", "pmp_sync_runs"): ("bidiq_app", "reportcenter_pmp_sync_runs"),
    ("prod_assets", "report_access_daily"): ("bidiq_app", "reportcenter_access_daily"),
    ("prod_assets", "report_access_events"): ("bidiq_app", "reportcenter_access_events"),
    ("prod_assets", "report_audit_log"): ("bidiq_app", "reportcenter_audit_log"),
    ("prod_assets", "report_core_products_override"): ("bidiq_app", "reportcenter_core_products_override"),
    ("prod_assets", "report_delivery_window"): ("bidiq_app", "reportcenter_delivery_window"),
    ("prod_assets", "report_ma_links"): ("bidiq_app", "reportcenter_maxattention_links"),
    ("prod_assets", "report_owners_overrides"): ("bidiq_app", "reportcenter_owners_overrides"),
    ("prod_assets", "report_snapshots"): ("bidiq_app", "reportcenter_snapshots"),
    ("prod_prod_hypr_reporthub", "sheets_integrations"): ("bidiq_app", "reportcenter_sheets_integrations"),
}


def _ligado() -> bool:
    return os.environ.get("BQ_TABLE_LAYOUT", "").strip().lower() == "taxonomy"


def loc(dataset: str, table: str) -> tuple:
    """(dataset, tabela) onde a tabela mora de fato."""
    if _ligado():
        return TAXONOMY_TABLES.get((dataset, table), (dataset, table))
    return (dataset, table)


def fq(dataset: str, table: str, project: str = "site-hypr") -> str:
    """`projeto.dataset.tabela` (sem crases), respeitando BQ_TABLE_LAYOUT."""
    d, t = loc(dataset, table)
    return f"{project}.{d}.{t}"


_RE_FQ = re.compile(r"(?<![\w.-])((?:[\w-]+\.)?)(prod_assets|prod_prod_hypr_reporthub)\.(\w+)\b")


def fq_sql(sql: str) -> str:
    """Troca `projeto.dataset.tabela` do mapa dentro de um SQL pronto (arquivo
    .sql ou string fixa) pelo nome físico. Tabelas fora do mapa ficam iguais."""
    if not _ligado():
        return sql
    def _troca(m):
        d, t = TAXONOMY_TABLES.get((m.group(2), m.group(3)), (m.group(2), m.group(3)))
        return f"{m.group(1)}{d}.{t}"
    return _RE_FQ.sub(_troca, sql)
