-- Migração 002 — ledger de execuções do sync PMP (`pmp_sync_runs`)
-- ---------------------------------------------------------------------------
-- Contexto (21/08/2026): o painel "Sync das fontes" do /admin/pmp inferia
-- "última execução" do MAX(synced_at) das LINHAS DE ENTREGA. Isso mede o dado,
-- não o job. Como o conector pula dias zerados (de propósito — senão deal
-- encerrado apareceria "no ar"), o indicador congelava tanto quando o deal
-- acabava (falso alarme) quanto quando o sync QUEBRAVA (alarme que não toca).
-- Resultado: 3 dias de 401 na PubMatic sem ninguém notar, com um deal novo
-- (PM-ZZCX-5733, R$32k de spend) entregando fora do hub.
--
-- Esta tabela registra a TENTATIVA de cada sync, por fonte, com erro e
-- credencial usada. O backend cria a tabela on-demand
-- (`pmp_sync_runs.ensure_table()`); este arquivo é a definição de referência
-- e serve pra recriar do zero em outro ambiente.
--
-- Reversível: DROP TABLE. Sem ela, `latest_by_source()` devolve [] e o painel
-- cai no comportamento antigo (frescor derivado das linhas de entrega).

CREATE TABLE IF NOT EXISTS `site-hypr.prod_assets.pmp_sync_runs` (
  run_id         STRING    OPTIONS(description="uuid da execução"),
  source         STRING    OPTIONS(description="'xandr' | 'pubmatic'"),
  started_at     TIMESTAMP OPTIONS(description="início da execução (UTC)"),
  finished_at    TIMESTAMP OPTIONS(description="fim da execução (UTC)"),
  status         STRING    OPTIONS(description="'ok' | 'error'"),
  rows_processed INT64     OPTIONS(description="linhas diárias upsertadas"),
  deals_touched  INT64     OPTIONS(description="deals/lines vistos no report"),
  `window`       STRING    OPTIONS(description="janela sincronizada, legível"),
  actor          STRING    OPTIONS(description="'scheduler' ou email do admin"),
  credential     STRING    OPTIONS(description="conjunto de credenciais que autenticou (chain do PubMatic)"),
  error          STRING    OPTIONS(description="erro truncado em 1000 chars"),
  duration_sec   FLOAT64
)
PARTITION BY DATE(started_at)
CLUSTER BY source
OPTIONS(description="Ledger de execuções do sync PMP. Fonte de verdade do painel de frescor do /admin/pmp — mede o JOB, não o dado.");
