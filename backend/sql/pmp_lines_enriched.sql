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
-- NOTA MULTI-FONTE: a unidade agora é o PAR (source, line_id). `source` ∈
-- {'xandr','pubmatic'}. TODO JOIN/agregação carrega source, senão um line_id
-- do Xandr colidiria com um dealMetaId da PubMatic de mesmo valor numérico.
-- Legado = 'xandr' (backfill da migração 001). Ver project_pubmatic_integracao.
line_groups AS (
  SELECT
    g.source,
    g.line_id,
    g.group_id,
    g.group_name,
    g.short_token AS group_short_token,
    g.notes       AS group_notes,
    -- Total de membros do grupo (pra UI exibir "2 lines")
    COUNT(*) OVER (PARTITION BY g.group_id) AS group_member_count
  FROM `site-hypr.prod_assets.pmp_line_groups` g
),
-- Soma de delivery POR GRUPO (todas as lines do grupo somadas — pode cruzar
-- fontes: um grupo une entrega Xandr + PubMatic sob o mesmo PI).
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
  LEFT JOIN `site-hypr.prod_assets.pmp_line_delivery_daily` d
    ON d.line_id = g.line_id AND d.source = g.source
  GROUP BY g.group_id
),
delivery_agg AS (
  -- Valores em BRL. No Xandr foram convertidos na ingestão (× billing_exchange_rate);
  -- no PubMatic já vêm em BRL (billing_exchange_rate=1.0). Aqui só agregamos.
  SELECT
    source,
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
  GROUP BY source, line_id
),
delivery_7d AS (
  -- Revenue + margem + imps dos últimos 7 dias (BRL).
  -- Margin é exposto no KPI "Margem HYPR" do PMP como crescimento últ. 7d.
  SELECT
    source,
    line_id,
    SUM(curator_revenue) AS revenue_last_7d,
    SUM(curator_margin)  AS margin_last_7d,
    SUM(imps)            AS imps_last_7d
  FROM `site-hypr.prod_assets.pmp_line_delivery_daily`
  WHERE day >= DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 7 DAY)
  GROUP BY source, line_id
),
delivery_yesterday AS (
  -- Margem entregue ontem (BRL). Exposta na coluna Delivery da lista pra
  -- mostrar "quanto rendeu ontem" por line ativa.
  SELECT
    source,
    line_id,
    SUM(curator_margin)  AS margin_yesterday,
    SUM(curator_revenue) AS revenue_yesterday
  FROM `site-hypr.prod_assets.pmp_line_delivery_daily`
  WHERE day = DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 1 DAY)
  GROUP BY source, line_id
),
delivery_prev_6d AS (
  -- Média diária de margem E revenue nos 6 dias ANTES de ontem (D-7..D-2).
  -- Usadas como baseline pra setinha ↗/↘ ao lado do valor de ontem. Exclui
  -- ontem pra evitar bias do próprio dia comparado.
  SELECT
    source,
    line_id,
    SAFE_DIVIDE(SUM(curator_margin),  6) AS margin_prev_6d_avg,
    SAFE_DIVIDE(SUM(curator_revenue), 6) AS revenue_prev_6d_avg
  FROM `site-hypr.prod_assets.pmp_line_delivery_daily`
  WHERE day BETWEEN DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 7 DAY)
                AND DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 2 DAY)
  GROUP BY source, line_id
),
delivery_last AS (
  -- Margem/revenue do ÚLTIMO dia COM entrega (não "ontem"). Usado pela coluna
  -- Delivery pra fontes com lag de reporting (PubMatic entrega D-2/D-3): quando
  -- "ontem" veio vazio mas houve entrega recente, mostramos este valor.
  SELECT source, line_id, curator_margin AS margin_last_delivery,
         curator_revenue AS revenue_last_delivery
  FROM (
    SELECT source, line_id, day,
           SUM(curator_margin)  AS curator_margin,
           SUM(curator_revenue) AS curator_revenue,
           ROW_NUMBER() OVER (PARTITION BY source, line_id ORDER BY day DESC) AS rn
    FROM `site-hypr.prod_assets.pmp_line_delivery_daily`
    GROUP BY source, line_id, day
  )
  WHERE rn = 1
),
joined AS (
  SELECT
    -- Identificadores
    li.source,
    li.line_id,
    li.external_deal_id,
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
    li.pricing_strategy,
    li.revenue_type,
    li.revenue_value,
    li.curator_margin_type,
    li.curator_margin_pct,
    li.curator_margin_cpm,
    li.min_revenue_value,
    li.max_revenue_value,
    li.currency,
    -- Datas do flight: a line do Xandr traz as suas; o deal PubMatic não tem
    -- datas nativas no report, então caímos pro checklist do Command quando
    -- vinculado (ck). start_date do PubMatic vem do 1º dia de entrega (setado
    -- no conector); end_date só existe se vinculado ao Command.
    COALESCE(li.start_date, ck.start_date) AS start_date,
    COALESCE(li.end_date,   ck.end_date)   AS end_date,
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
    -- customer_override cobre fontes SEM insertion order (PubMatic): o conector
    -- grava ali o cliente parseado do nome do deal. No Xandr fica NULL e o
    -- comportamento é idêntico ao anterior (ck.client > io.customer).
    COALESCE(ck.client, io.customer, li.customer_override) AS customer,

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
    COALESCE(d7.margin_last_7d, 0)  AS margin_last_7d,
    COALESCE(d7.imps_last_7d, 0)    AS imps_last_7d,

    COALESCE(dy.margin_yesterday, 0)    AS margin_yesterday,
    COALESCE(dy.revenue_yesterday, 0)   AS revenue_yesterday,
    COALESCE(dp.margin_prev_6d_avg, 0)  AS margin_prev_6d_avg,
    COALESCE(dp.revenue_prev_6d_avg, 0) AS revenue_prev_6d_avg,
    COALESCE(dl.margin_last_delivery, 0)  AS margin_last_delivery,
    COALESCE(dl.revenue_last_delivery, 0) AS revenue_last_delivery,

    li.created_by, li.created_at, li.updated_by, li.updated_at
  FROM `site-hypr.prod_assets.pmp_line_items` li
  LEFT JOIN `site-hypr.prod_assets.pmp_insertion_orders` io
    ON io.io_id = li.io_id
  -- checklists_mirror é uma cópia US-multi do dataset hypr_sales_center
  -- (que está em us-central1). Recopiada a cada sync diário em
  -- pmp_lines.sync_checklists_mirror() (chamado pelo pmp_sync_v2 ANTES deste
  -- refresh). Sem o mirror, JOIN cross-region falha porque BQ não permite
  -- SELECT FROM datasets em regions diferentes.
  LEFT JOIN `site-hypr.prod_assets.checklists_mirror` ck
    ON UPPER(ck.short_token) = UPPER(li.short_token)
  -- Todos os JOINs de delivery/grupo casam por (source, line_id) pra não
  -- cruzar dados entre fontes com line_id numericamente coincidente.
  LEFT JOIN delivery_agg d  ON d.source  = li.source AND d.line_id  = li.line_id
  LEFT JOIN delivery_7d  d7 ON d7.source = li.source AND d7.line_id = li.line_id
  LEFT JOIN delivery_yesterday dy ON dy.source = li.source AND dy.line_id = li.line_id
  LEFT JOIN delivery_prev_6d   dp ON dp.source = li.source AND dp.line_id = li.line_id
  LEFT JOIN delivery_last      dl ON dl.source = li.source AND dl.line_id = li.line_id
  LEFT JOIN line_groups  grp ON grp.source = li.source AND grp.line_id = li.line_id
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
