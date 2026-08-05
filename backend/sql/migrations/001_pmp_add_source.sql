-- Migração 001 — eixo `source` no modelo PMP (Xandr Curate + PubMatic)
-- ---------------------------------------------------------------------------
-- Objetivo: permitir que o PMP Deals sirva entregas de MAIS DE UMA fonte de
-- curadoria (hoje só Xandr Curate; agora também PubMatic) sob o mesmo modelo,
-- e que o agrupamento (pmp_line_groups) una lines das duas fontes sob um PI.
--
-- Estratégia de chave (ver project_pubmatic_integracao na memória):
--   • Mantemos `line_id INT64` — o PubMatic tem `dealMetaId` numérico
--     (ex: 735537), então NÃO precisamos migrar a chave pra STRING.
--   • Identidade real da unidade passa a ser o PAR (source, line_id).
--   • `source` ∈ {'xandr','pubmatic'}. Linhas legadas = 'xandr' (backfill).
--
-- IMPORTANTE — esta migração é ADITIVA e idempotente (ADD COLUMN IF NOT EXISTS),
-- mas NÃO deve ser aplicada isolada em produção: o refresh de
-- `pmp_lines_enriched` precisa passar a carregar `source` em todos os JOINs
-- ANTES de existirem linhas pubmatic, senão uma colisão de line_id entre
-- fontes cruzaria dados. Aplicar junto com o novo pmp_lines_enriched.sql.
--
-- Reversível: cada coluna some com ALTER TABLE ... DROP COLUMN.

-- ── pmp_line_items ──────────────────────────────────────────────────────────
ALTER TABLE `site-hypr.prod_assets.pmp_line_items`
  ADD COLUMN IF NOT EXISTS source STRING;
-- Fallback de cliente pra fontes SEM insertion order (PubMatic). No Xandr o
-- customer vem de io.customer; o PubMatic não tem IO, então o conector grava
-- aqui o cliente parseado do nome do deal. Também serve de override manual.
ALTER TABLE `site-hypr.prod_assets.pmp_line_items`
  ADD COLUMN IF NOT EXISTS customer_override STRING;
-- Deal id textual do PubMatic (ex: PM-QUHQ-3967) — o `line_id` guarda o
-- dealMetaId numérico; este guarda o id legível pra UI e auditoria.
ALTER TABLE `site-hypr.prod_assets.pmp_line_items`
  ADD COLUMN IF NOT EXISTS external_deal_id STRING;

UPDATE `site-hypr.prod_assets.pmp_line_items`
  SET source = 'xandr' WHERE source IS NULL;

-- ── pmp_line_delivery_daily ─────────────────────────────────────────────────
ALTER TABLE `site-hypr.prod_assets.pmp_line_delivery_daily`
  ADD COLUMN IF NOT EXISTS source STRING;
-- Receita de dados/audiência do PubMatic (dataRevenue). No Xandr fica NULL.
-- Guardada pra auditoria; NÃO entra no líquido (que é curator_margin).
ALTER TABLE `site-hypr.prod_assets.pmp_line_delivery_daily`
  ADD COLUMN IF NOT EXISTS data_revenue NUMERIC;

UPDATE `site-hypr.prod_assets.pmp_line_delivery_daily`
  SET source = 'xandr' WHERE source IS NULL;

-- ── pmp_line_groups ─────────────────────────────────────────────────────────
-- Grupo passa a chavear membro por (source, line_id). Backfill 'xandr' pros
-- grupos existentes (todos são Xandr hoje).
ALTER TABLE `site-hypr.prod_assets.pmp_line_groups`
  ADD COLUMN IF NOT EXISTS source STRING;

UPDATE `site-hypr.prod_assets.pmp_line_groups`
  SET source = 'xandr' WHERE source IS NULL;

-- ── DEFAULT 'xandr' — compat com código AINDA NÃO deployado ──────────────────
-- Crítico: o backend deployado insere SEM a coluna source (sync diário da Xandr,
-- criação de grupo). Sem default, esses inserts gravariam source=NULL e as
-- linhas sumiriam dos JOINs do enriched (que casam por source). Com default,
-- todo insert do código antigo cai em 'xandr' automaticamente.
ALTER TABLE `site-hypr.prod_assets.pmp_line_items`          ALTER COLUMN source SET DEFAULT 'xandr';
ALTER TABLE `site-hypr.prod_assets.pmp_line_delivery_daily` ALTER COLUMN source SET DEFAULT 'xandr';
ALTER TABLE `site-hypr.prod_assets.pmp_line_groups`         ALTER COLUMN source SET DEFAULT 'xandr';

-- Nota: pmp_insertion_orders NÃO recebe `source` — é um conceito exclusivo do
-- Xandr. Linhas PubMatic ficam com io_id NULL e customer via customer_override.
