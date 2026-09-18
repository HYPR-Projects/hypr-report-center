#!/usr/bin/env bash
# Sonda de aterrissagem por DSP: separa "a fonte parou de entregar" de
# "a integração quebrou".
#
# Por que existe
# ──────────────
# O painel "Estado das bases" mede MAX(date) por fonte. Quando esse número para
# de andar, os dois cenários são INDISTINGUÍVEIS ali: uma DSP sem campanha no ar
# e um connector quebrado produzem exatamente a mesma tela. Em 18/09/2026 a
# pergunta apareceu literalmente assim — "a Amazon não atualiza desde 13/09
# porque não teve mais entrega ou porque está com erro de integração?" — e não
# havia como responder sem alguém abrir o BigQuery.
#
# É a falha #3 da auditoria da PubMatic (docs/pubmatic-freshness-audit.md),
# reaparecendo nas DSPs: dia zerado descartado sem contabilidade.
#
# A pergunta que decide é uma só: A LINHA DO DIA EXISTE NA STAGING?
#   - dia presente  → a fonte entregou o arquivo; se o volume é zero, não houve
#                     entrega e está tudo certo com a integração;
#   - dia ausente   → a fonte não escreveu nada. Isso é integração, não mercado.
# O cruzamento com o checklist fecha o caso: campanha no ar sem dado é erro,
# ponto final, independente do resto.
#
#   bash backend/scripts/check_dsp_landing.sh              # Amazon (default)
#   bash backend/scripts/check_dsp_landing.sh stackadapt
#   bash backend/scripts/check_dsp_landing.sh yahoo
#
# Só leitura. Não muda nada.

set -uo pipefail

PROJECT="${DSP_PROJECT:-site-hypr}"
ASSETS="${DSP_DATASET_ASSETS:-prod_assets}"
SRC_IN="${1:-amazon}"
SRC_KEY=$(echo "$SRC_IN" | tr '[:upper:]' '[:lower:]')

# Espelho de _SOURCE_RAW_TABLES / _SOURCE_LANDING_TABLES em backend/main.py.
# Se mudar lá, muda aqui — a sonda tem de medir o que o painel mede.
case "$SRC_KEY" in
  amazon)     RAW="staging.amazon_daily_performance_metrics";     TRT="amazon_daily_performance_metrics";     LABEL="Amazon" ;;
  stackadapt) RAW="staging.stackadapt_campaign_daily_metrics";    TRT="stackadapt_daily_performance_metrics"; LABEL="StackAdapt" ;;
  yahoo)      RAW="staging.yahoo_dsp_daily_performance_metrics";  TRT="yahoo_daily_performance_metrics";      LABEL="Yahoo" ;;
  *) echo "✗ Fonte '$SRC_IN' desconhecida. Use: amazon | stackadapt | yahoo"; exit 1 ;;
esac

UNIFIED="$PROJECT.$ASSETS.unified_daily_performance_metrics"
CHECKLIST="$PROJECT.$ASSETS.checklist_info"

command -v bq >/dev/null || { echo "✗ 'bq' não está no PATH. Instale o Google Cloud CLI."; exit 1; }

# --format=csv + tail -n +2 descarta o cabeçalho; --quiet tira a barra de
# progresso que polui o log do Actions.
q()  { bq query --use_legacy_sql=false --project_id="$PROJECT" --format=csv --quiet "$1" 2>&1 | tail -n +2; }

# ── 0. Preflight de permissão ───────────────────────────────────────────────
# CRÍTICO: sem isto, um erro de credencial DA SONDA é indistinguível de
# "a tabela sumiu" e vira veredito de integração — foi exatamente o que a
# primeira execução (run #1, 18/09/2026) imprimiu, com a conta do CI sem
# bigquery.jobUser. Diagnóstico que erra o culpado é pior que diagnóstico
# nenhum: manda cobrar a DSP por um problema de IAM nosso.
PING=$(bq query --use_legacy_sql=false --project_id="$PROJECT" --format=csv --quiet \
       "SELECT 1" 2>&1 | tail -n +2)
if ! [[ "$PING" =~ ^1$ ]]; then
  echo "✗ A SONDA NÃO CONSEGUE CONSULTAR O BIGQUERY — isto NÃO é diagnóstico da fonte."
  echo
  echo "$PING" | head -3 | sed 's/^/   /'
  echo
  SA=$(gcloud config get-value account 2>/dev/null)
  echo "   Conta em uso: ${SA:-<desconhecida>}"
  echo
  echo "   A conta precisa de DOIS acessos, só leitura:"
  echo "     gcloud projects add-iam-policy-binding $PROJECT \\"
  echo "       --member=\"serviceAccount:$SA\" \\"
  echo "       --role=\"roles/bigquery.jobUser\""
  echo
  echo "     bq add-iam-policy-binding --member=\"serviceAccount:$SA\" \\"
  echo "       --role=\"roles/bigquery.dataViewer\" $PROJECT:staging"
  echo "     bq add-iam-policy-binding --member=\"serviceAccount:$SA\" \\"
  echo "       --role=\"roles/bigquery.dataViewer\" $PROJECT:$ASSETS"
  echo
  echo "   Depois é só redisparar este workflow. Nada aqui grava nada."
  exit 1
fi

# MAX(date) agnóstico de tipo físico (DATE, TIMESTAMP ou STRING), mesma tática
# do _max_date_expr no backend e do sensor do Dagster.
MAXEXPR='MAX(SAFE_CAST(SUBSTR(CAST(date AS STRING), 1, 10) AS DATE))'

echo "═══════════════════════════════════════════════════════════════"
echo " Sonda de aterrissagem · $LABEL"
echo " Projeto: $PROJECT   ·   hoje (BRT): $(TZ=America/Sao_Paulo date +%d/%m/%Y\ %H:%M)"
echo "═══════════════════════════════════════════════════════════════"
echo

# ── 1. Onde exatamente congelou ─────────────────────────────────────────────
# Três camadas, três culpados possíveis. Sem separar, "a base não atualizou"
# manda cobrar a DSP quando o problema pode ser o dbt ou a consolidação.
echo "▸ 1. ONDE CONGELOU"
RAW_MAX=$(q "SELECT $MAXEXPR FROM \`$PROJECT.$RAW\`")
TRT_MAX=$(q "SELECT $MAXEXPR FROM \`$PROJECT.$ASSETS.$TRT\`")
UNI_MAX=$(q "SELECT MAX(date) FROM \`$UNIFIED\` WHERE UPPER(source) = '$(echo "$LABEL" | tr '[:lower:]' '[:upper:]')'")
TODAY=$(q "SELECT CURRENT_DATE('America/Sao_Paulo')")

echo "   staging (o que a DSP escreve) : ${RAW_MAX:-<vazio/erro>}"
echo "   tratada (modelo dbt)          : ${TRT_MAX:-<vazio/erro>}"
echo "   unified (o que o report serve) : ${UNI_MAX:-<vazio/erro>}"
echo "   hoje (BRT)                     : ${TODAY:-?}"
echo

# ── 2. O DISCRIMINADOR: o dia existe na staging? ────────────────────────────
# Se a linha do dia existe com volume zero, a fonte entregou e não houve
# entrega — integração OK. Se o dia não existe, a fonte não escreveu nada.
echo "▸ 2. LINHAS POR DIA NA STAGING (últimos 12 dias)"
echo "   Dia presente com 0 imps = fonte entregou, sem delivery (normal)."
echo "   Dia AUSENTE             = a fonte não escreveu nada (integração)."
q "
  SELECT
    FORMAT_DATE('%d/%m (%a)', d) AS dia,
    IFNULL(CAST(n AS STRING), 'AUSENTE') AS linhas
  FROM UNNEST(GENERATE_DATE_ARRAY(
         DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 12 DAY),
         DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 1 DAY))) AS d
  LEFT JOIN (
    SELECT SAFE_CAST(SUBSTR(CAST(date AS STRING), 1, 10) AS DATE) AS dd, COUNT(*) AS n
    FROM \`$PROJECT.$RAW\`
    GROUP BY dd
  ) t ON t.dd = d
  ORDER BY d
" | sed 's/^/   /'
echo

# ── 3. Penhasco ou rampa? ───────────────────────────────────────────────────
# Campanha acabando cai aos poucos; cano quebrado cai de uma vez, do volume
# cheio pra zero, de um dia pro outro.
echo "▸ 3. ENTREGA DIÁRIA NO UNIFIED (21 dias) — penhasco vs rampa"
q "
  SELECT
    FORMAT_DATE('%d/%m (%a)', date) AS dia,
    FORMAT('%''d', SUM(impressions))      AS imps,
    FORMAT('%.2f', SUM(total_cost))       AS custo,
    COUNT(DISTINCT short_token)           AS campanhas
  FROM \`$UNIFIED\`
  WHERE date >= DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 21 DAY)
    AND UPPER(source) = '$(echo "$LABEL" | tr '[:lower:]' '[:upper:]')'
    AND short_token IS NOT NULL
  GROUP BY date ORDER BY date
" | sed 's/^/   /'
echo

# ── 4. Tem campanha que DEVERIA estar entregando? ───────────────────────────
# É o que fecha o caso. Campanha com checklist ativo (end_date no futuro) que
# entregou na janela e sumiu = erro de integração, sem margem pra interpretação.
echo "▸ 4. CAMPANHAS NO AR SEM DADO (checklist ativo, entrega interrompida)"
LIVE=$(q "
  WITH entregou AS (
    SELECT short_token, MAX(date) AS last_date, SUM(impressions) AS imps
    FROM \`$UNIFIED\`
    WHERE date >= DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 21 DAY)
      AND UPPER(source) = '$(echo "$LABEL" | tr '[:lower:]' '[:upper:]')'
      AND short_token IS NOT NULL AND impressions > 0
    GROUP BY short_token
  )
  SELECT COUNT(*)
  FROM entregou e
  JOIN \`$CHECKLIST\` c USING (short_token)
  WHERE c.end_date >= CURRENT_DATE('America/Sao_Paulo')
    AND e.last_date < DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 1 DAY)
")
q "
  WITH entregou AS (
    SELECT short_token, MAX(date) AS last_date, SUM(impressions) AS imps
    FROM \`$UNIFIED\`
    WHERE date >= DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 21 DAY)
      AND UPPER(source) = '$(echo "$LABEL" | tr '[:lower:]' '[:upper:]')'
      AND short_token IS NOT NULL AND impressions > 0
    GROUP BY short_token
  )
  SELECT
    e.short_token AS token,
    c.client_name AS cliente,
    c.campaign_name AS campanha,
    FORMAT_DATE('%d/%m', e.last_date) AS ult_entrega,
    FORMAT_DATE('%d/%m', c.end_date)  AS fim_contratado
  FROM entregou e
  JOIN \`$CHECKLIST\` c USING (short_token)
  WHERE c.end_date >= CURRENT_DATE('America/Sao_Paulo')
    AND e.last_date < DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 1 DAY)
  ORDER BY e.last_date DESC, e.imps DESC
  LIMIT 40
" | sed 's/^/   /'
echo "   → total: ${LIVE:-?} campanha(s) no ar sem dado em D-1"
echo

# ── 5. Veredito ─────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════"
echo " VEREDITO"
echo "═══════════════════════════════════════════════════════════════"

if [ -z "${RAW_MAX:-}" ] || ! [[ "${RAW_MAX:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo " ~ A staging \`$PROJECT.$RAW\` respondeu, mas sem data válida."
  echo
  echo "   O preflight passou, então a sonda LÊ o BigQuery — o problema está na"
  echo "   tabela: vazia, renomeada, ou com a coluna de data em outro formato."
  echo "   Tabela vazia ou renomeada É integração. Formato de coluna diferente"
  echo "   é bug DESTA SONDA (o espelho de _SOURCE_RAW_TABLES saiu de sincronia"
  echo "   com backend/main.py). Confira qual dos dois antes de cobrar a DSP:"
  echo "     bq show --schema $PROJECT.$RAW"
  exit 0
fi

BEHIND=$(q "SELECT DATE_DIFF(CURRENT_DATE('America/Sao_Paulo'), DATE '$RAW_MAX', DAY)")

if [ "${BEHIND:-0}" -le 1 ]; then
  echo " ✓ A staging está em dia (último dia: $RAW_MAX, $BEHIND dia(s) atrás)."
  if [ "$RAW_MAX" != "${TRT_MAX:-}" ]; then
    echo " ⚠ Mas a TRATADA parou em ${TRT_MAX:-<vazio>} — a fonte entregou e o"
    echo "   modelo dbt não rodou. Problema é o build, não a DSP."
  elif [ "${UNI_MAX:-}" != "$RAW_MAX" ]; then
    echo " ⚠ Mas o UNIFIED parou em ${UNI_MAX:-<vazio>} — a fonte e a tratada"
    echo "   estão prontas e a consolidação não pegou. 'Reconstruir agora' resolve."
  fi
  exit 0
fi

echo " A staging parou em $RAW_MAX ($BEHIND dias atrás)."
echo
if [ "${LIVE:-0}" -gt 0 ]; then
  echo " ✗ ERRO DE INTEGRAÇÃO — não é fim de entrega."
  echo "   Existem ${LIVE} campanha(s) com checklist ATIVO (fim contratado no"
  echo "   futuro) que entregavam e pararam. Campanha no ar sem dado não é"
  echo "   mercado, é cano quebrado. Lista no passo 4."
  echo
  echo "   Onde olhar, nessa ordem:"
  echo "     1. o export/scheduled report da DSP: credencial expirada, report"
  echo "        desativado ou renomeado, mudança de schema nas colunas;"
  echo "     2. o job que grava a staging (Dagster, location hyprster);"
  echo "     3. confirmar no console da DSP que houve entrega no período."
else
  echo " ~ INCONCLUSIVO pelo checklist, mas a leitura dos passos 2 e 3 decide:"
  echo "     dias AUSENTES na staging  → a fonte não escreveu: INTEGRAÇÃO;"
  echo "     dias presentes com 0 imps → a fonte entregou: SEM DELIVERY, ok;"
  echo "     queda em penhasco no 3    → integração (fim de campanha faz rampa)."
  echo
  echo "   Nenhuma campanha com checklist ativo parada. Isso ENFRAQUECE a"
  echo "   hipótese de erro, mas não a mata: checklist desatualizado (end_date"
  echo "   no passado) some daqui do mesmo jeito."
fi
