-- Migração 003 — N checklists do Command por line (PI somado)
-- ---------------------------------------------------------------------------
-- Objetivo: permitir que uma MESMA line/deal de pagamento carregue mais de um
-- short_token do Hypr Command. Caso real: o cliente aproveita o deal e roda
-- campanhas diferentes (checklists diferentes, valores diferentes) em cima
-- dele. Até aqui o modelo aceitava 1 token por line (`short_token`, espelho do
-- campo `code` da line no Xandr) e o PI era o `investment` daquele checklist.
--
-- Modelo:
--   • `short_token` continua sendo o token PRINCIPAL — é o que vai pro campo
--     `code` da line no Xandr e o sync diário continua sobrescrevendo.
--   • `extra_short_tokens` guarda os DEMAIS tokens vinculados. É campo manual
--     (mesma classe de status/notes/overrides): o sync NUNCA toca nele.
--   • `pmp_lines_enriched` junta [short_token] + extra_short_tokens, casa cada
--     um com `checklists_mirror` e SOMA os `investment` → `pi_brl`. Todo o
--     cálculo de consumo (% entrega, health, pacing, projeção) passa a usar
--     o PI somado sem mudar de fórmula.
--
-- Aditiva e idempotente (ADD COLUMN IF NOT EXISTS). O backend também roda este
-- ALTER antes de cada refresh da enriched (pmp_lines.ensure_schema), então a
-- migração se auto-aplica no primeiro sync após o deploy.
--
-- Reversível: ALTER TABLE ... DROP COLUMN extra_short_tokens.

ALTER TABLE `site-hypr.prod_assets.pmp_line_items`
  ADD COLUMN IF NOT EXISTS extra_short_tokens ARRAY<STRING>;
