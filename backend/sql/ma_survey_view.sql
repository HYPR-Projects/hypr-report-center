-- View que alimenta MA_SURVEY_VIEW — respostas da pesquisa nativa do Max
-- Attention (etapa de survey do Tap to Choose), no formato que
-- `backend/maxattention.py` consome.
--
-- Rodar UMA vez (é DDL, não precisa entrar em cron):
--   bq query --use_legacy_sql=false < backend/sql/ma_survey_view.sql
--
-- De onde vem
-- -----------
-- A plataforma (o2o-platform) já drena os eventos de criativo pro BigQuery,
-- no MESMO projeto do Report Center — não há pipeline novo nesta integração:
--
--   site-hypr.prod_analytics.creative_events_raw
--     particionada por DIA em occurred_at, clusterizada por
--     creative_id + event_type. Escrita por dois produtores: o cron de
--     export (Postgres → BQ) e o Worker de ingestão do Cloudflare.
--
--   site-hypr.prod_analytics.creatives_dim
--     creative_id → creative_name. Recarregada ~1×/h por load job no mesmo
--     cron de export (o lake de eventos não guarda nome de peça).
--
-- A resposta declarada é o evento `survey_answer`, 1× por sessão, com o
-- rótulo escolhido em metadata.optionLabel (truncado em 120 chars na origem).
-- Em criativo de múltiplas perguntas o evento também carrega
-- metadata.questionText; no Tap to Choose de pergunta única não carrega — e
-- aí `question` fica NULL, que é o esperado e está previsto no leitor.
--
-- Dedupe NÃO é opcional
-- ---------------------
-- Com DOIS escritores e re-export sobreposto por desenho, o event_id só
-- dedupa dentro da janela do streaming buffer. Todo leitor da plataforma
-- aplica o mesmo QUALIFY abaixo. Sem ele, resposta repetida vira resposta a
-- mais e o total que vai pro cliente infla sem erro nenhum — o pior tipo de
-- defeito num número de relatório.
--
-- Custo
-- -----
-- O filtro por event_type casa com a chave de cluster, então a varredura fica
-- nos blocos de survey_answer. O Report Center sempre filtra por período
-- (poda partição), no detalhe filtra por creative_id, cacheia 5–10 min e
-- ainda impõe teto de bytes por query.

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
  -- LEFT JOIN de propósito: peça sem linha na dimensão (recém-criada, antes
  -- da próxima recarga) ainda mostra as respostas dela, só sem nome. A
  -- dimensão nunca esconde dado de evento.
  d.creative_name,
  -- Token da campanha pela convenção de nome. É o vínculo forte no Report
  -- Center (`match: "short_token"`); NULL quando o nome não segue a convenção,
  -- e aí o admin escolhe o criativo na lista.
  REGEXP_EXTRACT(UPPER(COALESCE(d.creative_name, '')), r'^ID-([A-Z0-9]{4,10})_') AS short_token,
  a.question,
  a.option,
  a.responded_at
FROM answers a
LEFT JOIN `site-hypr.prod_analytics.creatives_dim` d
  ON d.creative_id = a.creative_id
WHERE a.option IS NOT NULL AND TRIM(a.option) != '';

-- Permissão
-- ---------
-- A service account do Report Center lê hoje `prod_prod_hypr_reporthub` e
-- `prod_assets`. Precisa de bigquery.dataViewer em `prod_analytics` (ou só na
-- view + nas duas tabelas). Sem isso os endpoints respondem 502 e o modal
-- mostra o erro — não falha silenciosa.
--
-- Validar depois de criar:
--
--   SELECT creative_name, short_token, option, COUNT(*) AS respostas
--   FROM `site-hypr.prod_analytics.ma_survey_responses`
--   WHERE responded_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
--     AND short_token = 'FXR5US'
--   GROUP BY 1, 2, 3
--   ORDER BY respostas DESC;
--
-- O que esperar: uma linha por opção, por criativo, e os nomes terminando em
-- _CONTROLE / _EXPOSTO. Se `creative_name` vier NULL em tudo, a dimensão
-- ainda não carregou (ou o cron de export não rodou desde o deploy).
