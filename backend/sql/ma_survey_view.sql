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
--     creative_id + event_type. Quem escreve na prática é o Worker de
--     ingestão do Cloudflare: existe uma rota de export (Postgres → BQ) no
--     repo da plataforma, mas ela NÃO tem job no Cloud Scheduler.
--
--   site-hypr.prod_analytics.creatives_dim
--     creative_id → creative_name. Recarregada ~1×/h por load job dentro do
--     cron `rollup-creative-events` (o lake de eventos não guarda nome de
--     peça). Já morou no `export-events-bq` e nunca carregava, justamente
--     porque aquela rota não é agendada.
--
-- A resposta declarada é o evento `survey_answer`, 1× por sessão, com o
-- rótulo escolhido em metadata.optionLabel (truncado em 120 chars na origem).
-- Em criativo de múltiplas perguntas o evento também carrega
-- metadata.questionText; no Tap to Choose de pergunta única não carrega — e
-- aí `question` fica NULL, que é o esperado e está previsto no leitor.
--
-- Dedupe NÃO é opcional
-- ---------------------
-- O lake é escrito pelo Worker de ingestão, e o desenho prevê um segundo
-- produtor (a rota de export do Postgres) com re-export sobreposto — o
-- event_id é o insertId, que dedupa só dentro da janela do streaming buffer.
-- Sem dedupe, resposta repetida vira resposta a mais e o total do relatório
-- do cliente infla em silêncio.
--
-- Mas o COMO importa: a versão anterior desta view deduplicava com
-- `QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ...)`, e isso quebrou
-- tudo em produção:
--
--   Cannot query over table 'creative_events_raw' without a filter over
--   column(s) 'occurred_at' that can be used for partition elimination
--
-- A tabela exige filtro de partição, e função de janela é BARREIRA de
-- otimização: o filtro que o Report Center põe do lado de fora não desce
-- até o scan, então o BigQuery não elimina partição nenhuma e recusa a
-- query. Não era só a conferência — era toda chamada do report.
--
-- Duas defesas, e as duas são de propósito:
--
--   1. SELECT DISTINCT no lugar do QUALIFY. Duplicata de re-export é a
--      MESMA linha (os dois escritores montam a linha do mesmo registro,
--      pelo mesmo `mapEventRowToLake`), diferindo só em `created_at`, que
--      não sai daqui — então DISTINCT colapsa exatamente o que o QUALIFY
--      colapsava. Sendo agregação por chave, o filtro de fora desce e a
--      poda de partição e de cluster volta a valer.
--   2. Filtro de partição DENTRO da view. Independe do otimizador: mesmo
--      que um consumidor esqueça o filtro dele, o scan já nasce podado.
--
-- A janela interna de 730 dias é teto, não recorte de produto: pesquisa de
-- campanha vive semanas. Se um dia precisar de mais, é aqui que muda.
--
-- Ressalva honesta do DISTINCT: se o lake tivesse o mesmo event_id com
-- payloads DIFERENTES, o QUALIFY escolheria um e o DISTINCT manteria os
-- dois. Não acontece por construção (mesma origem, mesmo mapeamento), e a
-- troca compra de volta a poda que a tabela exige.
--
-- Custo
-- -----
-- Com a poda restaurada: filtro por event_type casa com a chave de cluster,
-- o filtro de período do Report Center poda partição, e o detalhe por
-- creative_id poda cluster. O report ainda cacheia 5–10 min e impõe teto de
-- bytes por query.

CREATE TABLE IF NOT EXISTS `site-hypr.prod_analytics.creatives_dim` (
  creative_id   STRING NOT NULL,
  creative_name STRING,
  template_slug STRING,
  client_name   STRING,
  status        STRING,
  deleted       BOOL,
  updated_at    TIMESTAMP,
  synced_at     TIMESTAMP
)
CLUSTER BY creative_id;

CREATE OR REPLACE VIEW `site-hypr.prod_analytics.ma_survey_responses` AS
WITH answers AS (
  -- DISTINCT, não QUALIFY: ver "Dedupe NÃO é opcional" acima. `created_at`
  -- fica DE FORA de propósito — é a única coluna em que duas gravações do
  -- mesmo evento diferem, e mantê-la aqui anularia o dedupe.
  SELECT DISTINCT
    event_id,
    creative_id,
    -- Sessão do respondente. Existe porque contar EVENTO infla a base: um
    -- respondente que recarrega a peça emite `survey_answer` de novo (o
    -- guard da origem é por montagem, não por sessão). Medido na campanha
    -- FXR5US: 383 eventos contra 265 respondentes — 45% a mais.
    -- Quem consome decide a unidade; o report conta sessão distinta, porque
    -- lift é proporção de PESSOAS e o teste de significância assume n de
    -- respondentes independentes.
    session_id,
    JSON_VALUE(metadata, '$.questionText') AS question,
    JSON_VALUE(metadata, '$.optionLabel')  AS option,
    occurred_at                            AS responded_at
  FROM `site-hypr.prod_analytics.creative_events_raw`
  WHERE event_type = 'survey_answer'
    -- Filtro de partição DENTRO da view: a tabela exige um, e depender do
    -- filtro do consumidor é depender de o otimizador conseguir empurrá-lo
    -- pra cá. Teto de 730 dias.
    AND occurred_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 730 DAY)
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
  a.session_id,
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
--   SELECT creative_name, short_token, option,
--          COUNT(DISTINCT session_id) AS respondentes
--   FROM `site-hypr.prod_analytics.ma_survey_responses`
--   WHERE responded_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
--     AND short_token = 'FXR5US'
--   GROUP BY 1, 2, 3
--   ORDER BY respondentes DESC;
--
-- O que esperar: uma linha por opção, por criativo, e os nomes terminando em
-- _CONTROLE / _EXPOSTO. Se `creative_name` vier NULL em tudo, a dimensão
-- ainda não carregou (ou o `rollup-creative-events` não rodou desde o deploy
-- da plataforma).
--
-- Mais fácil que rodar isto na mão: `bash backend/scripts/check_ma_survey.sh`.
