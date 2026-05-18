-- ────────────────────────────────────────────────────────────────────────
-- Daily rollup de report_access_events → report_access_daily.
--
-- Como rodar
-- ----------
-- BigQuery Console → Scheduled queries → "Create scheduled query"
--   • Region:      mesma região de prod_assets (us-central1 ou afins)
--   • Repeats:     Daily
--   • Start time:  06:30 America/Sao_Paulo (depois do pipeline de pacing)
--   • Destination: deixar VAZIO — o MERGE escreve direto na tabela alvo
--
-- Idempotência
-- ------------
-- Esta query SEMPRE recompila o dia anterior INTEIRO e usa MERGE. Roda
-- novamente sem duplicar — só sobrescreve. Útil quando uma instância
-- atrasou e events crus chegaram depois do schedule normal.
--
-- Dedup de heartbeats
-- -------------------
-- ROW_NUMBER() PARTITION BY event_id mata retries duplicados. Sem isso,
-- a métrica de tempo médio enviesa pra cima.
-- ────────────────────────────────────────────────────────────────────────

DECLARE target_day DATE DEFAULT DATE_SUB(CURRENT_DATE("America/Sao_Paulo"), INTERVAL 1 DAY);

MERGE `site-hypr.prod_assets.report_access_daily` T
USING (
  WITH dedup AS (
    SELECT *
    FROM (
      SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY created_at) AS rn
      FROM `site-hypr.prod_assets.report_access_events`
      WHERE DATE(created_at, "America/Sao_Paulo") = target_day
    )
    WHERE rn = 1
  ),
  -- Agregação por sessão. ATENÇÃO ao cálculo de duração: NÃO usamos
  -- MAX(duration_ms) cru porque o client reporta (Date.now - startedAt)
  -- em cada heartbeat — se o user deixa a aba aberta 8h sem foco e
  -- volta, o próximo heartbeat reporta 8h e infla a métrica. A
  -- alternativa correta é "tempo ATIVO" = nº de heartbeats × intervalo
  -- (heartbeat só dispara com aba visível, então cada heartbeat = 60s
  -- de engagement real). +30s baseline pra cobrir o gap antes do
  -- primeiro heartbeat (pageview inicial não conta tempo).
  --
  -- Cap em 4h pra defender de sessões patológicas que escapem do filtro.
  session_agg AS (
    SELECT
      short_token,
      session_id,
      ANY_VALUE(device_family) AS device_family,
      COALESCE(MAX(is_internal), FALSE) AS is_internal,
      LEAST(
        4 * 3600,
        COUNTIF(event_type = 'heartbeat') * 60 + 30
      ) AS active_duration_sec,
      MIN(created_at) AS started_at,
      MAX(created_at) AS last_at,
      -- Hora do primeiro pageview da sessão — usado pro hour_histogram
      MIN(IF(event_type = 'pageview', EXTRACT(HOUR FROM created_at AT TIME ZONE "America/Sao_Paulo"), NULL)) AS first_hour
    FROM dedup
    GROUP BY short_token, session_id
  ),
  pageview_agg AS (
    SELECT short_token, COUNT(*) AS total_pageviews
    FROM dedup
    WHERE event_type = 'pageview'
    GROUP BY short_token
  ),
  tab_agg AS (
    SELECT
      short_token,
      ARRAY_AGG(STRUCT(tab_id, views) ORDER BY views DESC LIMIT 10) AS top_tabs
    FROM (
      SELECT short_token, tab_id, COUNT(*) AS views
      FROM dedup
      WHERE tab_id IS NOT NULL AND event_type IN ('pageview', 'tab_change')
      GROUP BY short_token, tab_id
    )
    GROUP BY short_token
  ),
  device_agg AS (
    SELECT
      short_token,
      ARRAY_AGG(STRUCT(device_family, sessions)) AS devices
    FROM (
      SELECT short_token, device_family, COUNT(DISTINCT session_id) AS sessions
      FROM session_agg
      WHERE device_family IS NOT NULL
      GROUP BY short_token, device_family
    )
    GROUP BY short_token
  ),
  hour_agg AS (
    SELECT
      short_token,
      ARRAY_AGG(STRUCT(first_hour AS hour, sessions)) AS hour_histogram
    FROM (
      SELECT short_token, first_hour, COUNT(*) AS sessions
      FROM session_agg
      WHERE first_hour IS NOT NULL
      GROUP BY short_token, first_hour
    )
    GROUP BY short_token
  )
  SELECT
    s.short_token,
    target_day AS day,
    COALESCE(pv.total_pageviews, 0) AS total_pageviews,
    COUNT(DISTINCT s.session_id) AS unique_sessions,
    COUNTIF(s.is_internal) AS internal_sessions,
    COUNTIF(NOT s.is_internal) AS external_sessions,
    -- Tempo médio = tempo ativo médio. active_duration_sec já vem
    -- calculado por session no CTE acima (heartbeats × 60 + 30, cap 4h).
    AVG(s.active_duration_sec) AS avg_duration_sec,
    TO_JSON(ANY_VALUE(t.top_tabs)) AS top_tabs,
    TO_JSON(ANY_VALUE(d.devices)) AS devices,
    TO_JSON(ANY_VALUE(h.hour_histogram)) AS hour_histogram,
    CURRENT_TIMESTAMP() AS computed_at
  FROM session_agg s
  LEFT JOIN pageview_agg pv USING(short_token)
  LEFT JOIN tab_agg     t  USING(short_token)
  LEFT JOIN device_agg  d  USING(short_token)
  LEFT JOIN hour_agg    h  USING(short_token)
  GROUP BY s.short_token, pv.total_pageviews
) S
ON T.short_token = S.short_token AND T.day = S.day
WHEN MATCHED THEN UPDATE SET
  total_pageviews   = S.total_pageviews,
  unique_sessions   = S.unique_sessions,
  internal_sessions = S.internal_sessions,
  external_sessions = S.external_sessions,
  avg_duration_sec  = S.avg_duration_sec,
  top_tabs          = S.top_tabs,
  devices           = S.devices,
  hour_histogram    = S.hour_histogram,
  computed_at       = S.computed_at
WHEN NOT MATCHED THEN INSERT (
  short_token, day, total_pageviews, unique_sessions, internal_sessions,
  external_sessions, avg_duration_sec, top_tabs, devices, hour_histogram, computed_at
) VALUES (
  S.short_token, S.day, S.total_pageviews, S.unique_sessions, S.internal_sessions,
  S.external_sessions, S.avg_duration_sec, S.top_tabs, S.devices, S.hour_histogram, S.computed_at
);
