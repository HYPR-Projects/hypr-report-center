-- View que alimenta MA_SURVEY_VIEW — respostas da pesquisa nativa do Max
-- Attention (etapa de survey do Tap to Choose) no formato que o Report
-- Center consome (backend/maxattention.py).
--
-- De onde vem
-- -----------
-- A plataforma (o2o-platform) já drena os eventos de criativo pro BigQuery,
-- no MESMO projeto do Report Center:
--
--     site-hypr.prod_analytics.creative_events_raw
--       particionada por DIA em occurred_at
--       clusterizada por creative_id, event_type
--
-- A resposta declarada é o evento `survey_answer`, 1× por sessão, e o rótulo
-- escolhido viaja em metadata.optionLabel (truncado em 120 chars na origem).
-- Em criativo de múltiplas perguntas (modo poll) o evento também carrega
-- metadata.questionText; no Tap to Choose de pergunta única, não carrega —
-- e aí `question` fica NULL, que é o esperado.
--
-- Dedupe NÃO é opcional
-- ---------------------
-- O lake tem DOIS escritores (o cron de export do Postgres e o Worker de
-- ingestão do Cloudflare) e re-export sobreposto é parte do desenho — o
-- event_id é o insertId, que dedupa só dentro da janela do streaming buffer.
-- Todo leitor da plataforma aplica o mesmo QUALIFY abaixo. Sem ele, resposta
-- repetida vira resposta a mais e o total do report infla em silêncio.
--
-- Custo
-- -----
-- O filtro por event_type casa com a chave de cluster, então a varredura fica
-- restrita aos blocos de survey_answer. O Report Center sempre filtra por
-- período (que poda partição) e, no detalhe, por creative_id.

-- ─────────────────────────────────────────────────────────────────────────
-- VARIANTE 1 — com nome do criativo (recomendada)
--
-- Depende de uma dimensão de criativos no BigQuery
-- (`prod_analytics.creatives_dim`, com creative_id + creative_name), que
-- hoje NÃO existe: o nome vive só no Cloud SQL da plataforma.
--
-- É o nome que destrava o pareamento automático, porque a convenção já
-- carrega campanha e lado:
--
--     ID-FXR5US_HYPR_LOREAL_..._SURVEY_AWARENESS_CONTROLE
--        ^^^^^^ short_token                       ^^^^^^^^ lado
--
-- Com ele, o short_token sai por regex e o admin conecta a campanha inteira
-- num clique. Sem ele, o Report Center ainda soma corretamente, mas o
-- criativo aparece pelo id e o vínculo é manual.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW `site-hypr.prod_analytics.ma_survey_responses` AS
WITH answers AS (
  SELECT
    event_id,
    creative_id,
    JSON_VALUE(metadata, '$.questionText') AS question,
    JSON_VALUE(metadata, '$.optionLabel')  AS option,
    occurred_at                            AS responded_at,
    created_at
  FROM `site-hypr.prod_analytics.creative_events_raw`
  WHERE event_type = 'survey_answer'
  QUALIFY event_id IS NULL
       OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY created_at) = 1
)
SELECT
  a.creative_id,
  COALESCE(d.creative_name, a.creative_id) AS creative_name,
  -- Token da campanha pela convenção de nome. Vira o vínculo forte no
  -- Report Center (`match: "short_token"`); NULL quando o nome não segue.
  REGEXP_EXTRACT(UPPER(COALESCE(d.creative_name, '')), r'^ID-([A-Z0-9]{4,10})_') AS short_token,
  a.question,
  a.option,
  a.responded_at
FROM answers a
LEFT JOIN `site-hypr.prod_analytics.creatives_dim` d
  ON d.creative_id = a.creative_id
WHERE a.option IS NOT NULL AND TRIM(a.option) != '';

-- ─────────────────────────────────────────────────────────────────────────
-- VARIANTE 2 — só com o lake, funciona HOJE sem tocar na plataforma
--
-- Mesmo dado, sem nome e sem token: o Report Center lista os criativos por
-- id e o admin escolhe na mão. A soma, a reconciliação de rótulos e o
-- filtro de período funcionam igual. Serve pra validar a ponta a ponta
-- antes de criar a dimensão.
--
-- Use ESTA no MA_SURVEY_VIEW se quiser ligar agora.
-- ─────────────────────────────────────────────────────────────────────────

-- CREATE OR REPLACE VIEW `site-hypr.prod_analytics.ma_survey_responses` AS
-- WITH answers AS (
--   SELECT
--     event_id,
--     creative_id,
--     JSON_VALUE(metadata, '$.questionText') AS question,
--     JSON_VALUE(metadata, '$.optionLabel')  AS option,
--     occurred_at                            AS responded_at,
--     created_at
--   FROM `site-hypr.prod_analytics.creative_events_raw`
--   WHERE event_type = 'survey_answer'
--   QUALIFY event_id IS NULL
--        OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY created_at) = 1
-- )
-- SELECT creative_id, question, option, responded_at
-- FROM answers
-- WHERE option IS NOT NULL AND TRIM(option) != '';

-- ─────────────────────────────────────────────────────────────────────────
-- Permissão
-- ---------
-- A service account do Report Center lê hoje `prod_prod_hypr_reporthub` e
-- `prod_assets`. Precisa de bigquery.dataViewer em `prod_analytics` (ou na
-- view) — sem isso os endpoints respondem 502 e o modal mostra o erro.
-- ─────────────────────────────────────────────────────────────────────────
