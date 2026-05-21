-- View materializada (TABLE refresh-by-query) pra a UI v2 do PMP Deals.
--
-- Junta: pmp_line_items + pmp_insertion_orders + hypr_sales_center.checklists
-- + delivery agregada de pmp_line_delivery_daily.
--
-- Não é VIEW pura porque queremos calcular health/pacing/projections sem
-- recompute em cada query da UI. Refresh é feito por job (after sync) via
-- `CREATE OR REPLACE TABLE` — barato (~250 linhas).
--
-- Coalesce hierarchy:
--   PI:        override manual > checklist.investment > NULL
--   Customer:  override manual > checklist.client     > io.customer > parsed do nome
--   Campaign:  override manual > checklist.campaign_name > line.name
--   Agency:    override manual > checklist.agency     > NULL
--   CP/CS:     checklist (sempre)
--
-- Health:
--   green:    state=active, days_elapsed_pct ~ pct_a_receber dentro de ±20%
--   amber:    pacing >120% ou <80%
--   red:      pacing <50% ou >150% ou status=Pausado
--   neutral:  sem PI cadastrado (não dá pra calcular pacing)
--
-- Pacing days_elapsed_pct (% do flighting já decorrido):
--   (TODAY - start_date) / (end_date - start_date)
--   Clamp [0, 1]. Quando end_date null, dias_decorridos não calculado.

CREATE OR REPLACE TABLE `site-hypr.prod_assets.pmp_lines_enriched` AS
WITH
-- Grupos de lines: N lines sob mesmo PI compartilhado (A/B Fixed vs Flex).
-- Cada line aparece com seu group_id; lines fora de grupo ficam NULL.
line_groups AS (
  SELECT
    g.line_id,
    g.group_id,
    g.group_name,
    g.short_token AS group_short_token,
    g.notes       AS group_notes,
    -- Total de membros do grupo (pra UI exibir "2 lines")
    COUNT(*) OVER (PARTITION BY g.group_id) AS group_member_count
  FROM `site-hypr.prod_assets.pmp_line_groups` g
),
-- Soma de delivery POR GRUPO (todas as lines do grupo somadas).
-- Lines fora de grupo: agregação trivial (= seus próprios valores).
group_delivery_agg AS (
  SELECT
    g.group_id,
    SUM(d.imps)                   AS group_imps,
    SUM(d.viewable_imps)          AS group_viewable_imps,
    SUM(d.clicks)                 AS group_clicks,
    SUM(d.curator_net_media_cost) AS group_curator_net_media_cost,
    SUM(d.curator_tech_fees)      AS group_curator_tech_fees,
    SUM(d.curator_total_cost)     AS group_curator_total_cost,
    SUM(d.curator_revenue)        AS group_curator_revenue,
    SUM(d.curator_margin)         AS group_curator_margin,
    MIN(d.day)                    AS group_first_delivery_day,
    MAX(d.day)                    AS group_last_delivery_day
  FROM `site-hypr.prod_assets.pmp_line_groups` g
  LEFT JOIN `site-hypr.prod_assets.pmp_line_delivery_daily` d ON d.line_id = g.line_id
  GROUP BY g.group_id
),
delivery_agg AS (
  -- Valores já convertidos pra BRL na ingestão (parse_csv_line_level multiplica
  -- por billing_exchange_rate do dia). Aqui só agregamos.
  SELECT
    line_id,
    SUM(imps)                   AS imps,
    SUM(viewable_imps)          AS viewable_imps,
    SUM(clicks)                 AS clicks,
    SUM(curator_net_media_cost) AS curator_net_media_cost,
    SUM(curator_tech_fees)      AS curator_tech_fees,
    SUM(curator_total_cost)     AS curator_total_cost,
    SUM(curator_revenue)        AS curator_revenue,
    SUM(curator_margin)         AS curator_margin,
    AVG(billing_exchange_rate)  AS avg_exchange_rate,
    MIN(day)                    AS first_delivery_day,
    MAX(day)                    AS last_delivery_day,
    MAX(synced_at)              AS last_synced_at
  FROM `site-hypr.prod_assets.pmp_line_delivery_daily`
  GROUP BY line_id
),
delivery_7d AS (
  -- Revenue dos últimos 7 dias (BRL, já convertido na ingestão).
  SELECT
    line_id,
    SUM(curator_revenue) AS revenue_last_7d,
    SUM(imps)            AS imps_last_7d
  FROM `site-hypr.prod_assets.pmp_line_delivery_daily`
  WHERE day >= DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 7 DAY)
  GROUP BY line_id
),
joined AS (
  SELECT
    -- Identificadores
    li.line_id,
    li.line_name,
    li.line_code,
    li.short_token,
    li.io_id,
    io.io_name,
    li.advertiser_id,
    li.deal_ids,
    li.deal_count,

    -- Estado
    li.state,
    li.line_item_subtype,
    li.bid_type,
    li.bid_type_source,
    li.revenue_type,
    li.revenue_value,
    li.curator_margin_type,
    li.curator_margin_pct,
    li.curator_margin_cpm,
    li.min_revenue_value,
    li.max_revenue_value,
    li.currency,
    li.start_date,
    li.end_date,
    li.xandr_last_modified,

    -- Workflow / overrides
    COALESCE(li.status, 'Pendente') AS status,
    li.notes,
    COALESCE(li.is_archived, FALSE) AS is_archived,

    -- COALESCE de campos enriquecidos
    COALESCE(li.client_pi_amount_override, ck.investment) AS pi_brl,
    li.client_pi_amount_override IS NOT NULL AS pi_overridden,

    COALESCE(li.campaign_name_override, ck.campaign_name, li.line_name) AS campaign_name,
    COALESCE(li.agency_override, ck.agency) AS agency,
    COALESCE(ck.client, io.customer) AS customer,

    ck.cp_name, ck.cp_email,
    ck.cs_name, ck.cs_email,
    ck.cpm AS command_cpm,
    ck.cpcv AS command_cpcv,
    ck.deal_dv360 AS command_deal_dv360,
    ck.start_date AS command_start_date,
    ck.end_date   AS command_end_date,
    ck.id         AS checklist_id,

    -- Delivery agregada
    COALESCE(d.imps, 0)                   AS imps,
    COALESCE(d.viewable_imps, 0)          AS viewable_imps,
    COALESCE(d.clicks, 0)                 AS clicks,
    COALESCE(d.curator_net_media_cost, 0) AS curator_net_media_cost,
    COALESCE(d.curator_tech_fees, 0)      AS curator_tech_fees,
    COALESCE(d.curator_total_cost, 0)     AS curator_total_cost,
    COALESCE(d.curator_revenue, 0)        AS curator_revenue,
    COALESCE(d.curator_margin, 0)         AS curator_margin,
    d.avg_exchange_rate                   AS avg_exchange_rate,

    -- Grupo (NULL se line não está agrupada)
    grp.group_id,
    grp.group_name,
    grp.group_short_token,
    grp.group_member_count,
    grp.group_notes,

    -- Agregados POR GRUPO (mesmos valores em todas as lines do grupo).
    -- Lines fora de grupo: NULL nesses campos (UI usa os per-line normais).
    gd.group_imps,
    gd.group_viewable_imps,
    gd.group_clicks,
    gd.group_curator_total_cost,
    gd.group_curator_revenue,
    gd.group_curator_margin,
    gd.group_first_delivery_day,
    gd.group_last_delivery_day,
    d.first_delivery_day,
    d.last_delivery_day,
    d.last_synced_at,

    COALESCE(d7.revenue_last_7d, 0) AS revenue_last_7d,
    COALESCE(d7.imps_last_7d, 0)    AS imps_last_7d,

    li.created_by, li.created_at, li.updated_by, li.updated_at
  FROM `site-hypr.prod_assets.pmp_line_items` li
  LEFT JOIN `site-hypr.prod_assets.pmp_insertion_orders` io
    ON io.io_id = li.io_id
  -- checklists_mirror é uma cópia US-multi do dataset hypr_sales_center
  -- (que está em us-central1). Atualizada diariamente via `bq cp -f`
  -- (rodada pelo Cloud Scheduler, ver fase 4 do PMP). Sem o mirror, JOIN
  -- cross-region falha porque BQ não permite SELECT FROM datasets em
  -- regions diferentes.
  LEFT JOIN `site-hypr.prod_assets.checklists_mirror` ck
    ON UPPER(ck.short_token) = UPPER(li.short_token)
  LEFT JOIN delivery_agg d  ON d.line_id  = li.line_id
  LEFT JOIN delivery_7d  d7 ON d7.line_id = li.line_id
  LEFT JOIN line_groups  grp ON grp.line_id = li.line_id
  LEFT JOIN group_delivery_agg gd ON gd.group_id = grp.group_id
)
SELECT
  *,
  -- Métricas derivadas
  SAFE_DIVIDE(curator_margin, curator_revenue) AS effective_margin_pct,
  SAFE_DIVIDE(curator_revenue * 1000.0, imps)  AS ecpm,
  -- % entrega = margem HYPR ÷ PI (régua de negócio definida pelo time).
  -- Faturamento bruto pode passar do PI mesmo quando a margem ainda não bateu;
  -- o que conta pro "% entregue" é quanto a HYPR efetivamente ganhou contra
  -- o valor contratado no PI.
  SAFE_DIVIDE(curator_margin, pi_brl)          AS pct_a_receber,
  -- % entrega DO GRUPO = margem agregada ÷ PI compartilhado.
  -- NULL pra lines fora de grupo.
  SAFE_DIVIDE(group_curator_margin, pi_brl)    AS group_pct_a_receber,
  -- Margem % efetiva do grupo
  SAFE_DIVIDE(group_curator_margin, group_curator_revenue) AS group_effective_margin_pct,

  -- Pacing / días
  DATE_DIFF(end_date, start_date, DAY) + 1 AS total_days,
  DATE_DIFF(CURRENT_DATE('America/Sao_Paulo'), start_date, DAY) AS days_elapsed,
  DATE_DIFF(end_date, CURRENT_DATE('America/Sao_Paulo'), DAY) AS days_remaining,
  SAFE_DIVIDE(
    DATE_DIFF(CURRENT_DATE('America/Sao_Paulo'), start_date, DAY),
    DATE_DIFF(end_date, start_date, DAY) + 1
  ) AS days_elapsed_pct,

  -- Projeção: se rodando no ritmo atual, quanto vai entregar total?
  CASE
    WHEN revenue_last_7d > 0 AND end_date IS NOT NULL
      AND DATE_DIFF(end_date, CURRENT_DATE('America/Sao_Paulo'), DAY) > 0
    THEN curator_revenue + (revenue_last_7d / 7.0) * DATE_DIFF(end_date, CURRENT_DATE('America/Sao_Paulo'), DAY)
    ELSE curator_revenue
  END AS projected_revenue_at_end,

  -- Health pill (verde / amarelo / vermelho / neutral)
  CASE
    -- Sem PI no Command nem override = não dá pra avaliar pacing
    WHEN pi_brl IS NULL OR pi_brl <= 0 THEN 'neutral'
    WHEN status = 'Pausado' THEN 'red'
    WHEN status = 'Cancelado' THEN 'red'
    -- Já passou do PI (margem HYPR > PI contratado = over-delivery preocupante)
    WHEN curator_margin > pi_brl * 1.15 THEN 'red'
    WHEN curator_margin > pi_brl * 1.05 THEN 'amber'
    -- Comparar % entregue (margem ÷ PI) vs % de tempo decorrido (pacing real)
    WHEN end_date IS NOT NULL AND start_date IS NOT NULL
      AND DATE_DIFF(end_date, start_date, DAY) > 0
      THEN CASE
        WHEN SAFE_DIVIDE(curator_margin, pi_brl)
             < 0.5 * SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE('America/Sao_Paulo'), start_date, DAY),
                                  DATE_DIFF(end_date, start_date, DAY) + 1)
          THEN 'red'
        WHEN SAFE_DIVIDE(curator_margin, pi_brl)
             < 0.8 * SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE('America/Sao_Paulo'), start_date, DAY),
                                  DATE_DIFF(end_date, start_date, DAY) + 1)
          THEN 'amber'
        ELSE 'green'
      END
    ELSE 'neutral'
  END AS health,

  -- Delivery status (estado real, não o `state` do Xandr).
  -- Resposta à pergunta "essa line tá rodando?":
  --   live      → entregou nas últimas 24h (verde forte)
  --   running   → 24-72h
  --   slowing   → 3-7d
  --   stopped   → 8-30d, mas state=active no Xandr (precisa atenção)
  --   scheduled → state=active, zero imps, start_date no futuro
  --   paused    → status workflow = Pausado (manual)
  --   ended     → 31-90d ou state=inactive recente
  --   archived  → >90d (histórico, oculto por default)
  --   unknown   → nunca rodou e não está agendada
  CASE
    WHEN status = 'Pausado'  THEN 'paused'
    WHEN status = 'Cancelado' THEN 'archived'
    WHEN last_delivery_day IS NOT NULL THEN
      CASE
        WHEN last_delivery_day >= DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 1 DAY)
          THEN 'live'
        WHEN last_delivery_day >= DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 3 DAY)
          THEN 'running'
        WHEN last_delivery_day >= DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 7 DAY)
          THEN 'slowing'
        WHEN last_delivery_day >= DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 30 DAY)
          THEN
            CASE WHEN state = 'active' THEN 'stopped' ELSE 'ended' END
        WHEN last_delivery_day >= DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 90 DAY)
          THEN 'ended'
        ELSE 'archived'
      END
    -- Nunca rodou:
    WHEN state = 'active' AND start_date > CURRENT_DATE('America/Sao_Paulo')
      THEN 'scheduled'
    WHEN state = 'inactive' THEN 'archived'
    ELSE 'unknown'
  END AS delivery_status,

  -- Horas desde a última entrega — útil pro UI exibir "há Xh"
  CASE
    WHEN last_delivery_day IS NOT NULL THEN
      TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP(last_delivery_day, 'America/Sao_Paulo'), HOUR)
    ELSE NULL
  END AS hours_since_last_delivery,

  -- Snapshot pra UI
  CURRENT_TIMESTAMP() AS view_refreshed_at
FROM joined;
