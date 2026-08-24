#!/usr/bin/env bash
# Diagnóstico de UMA rodada da integração de survey do Max Attention.
#
# Por que existe: verificar essa integração exigia rodar 4 ou 5 queries e
# interpretar cada uma. Quem está com o gcloud na mão (a integração toca
# BigQuery, Cloud Function e um cron em outro produto) não é
# necessariamente quem sabe ler o resultado — e virava ping-pong de colar
# terminal. Aqui é um comando, uma saída, com o veredito escrito.
#
#   bash backend/scripts/check_ma_survey.sh
#   bash backend/scripts/check_ma_survey.sh FXR5US    # foca numa campanha
#
# Só leitura. Não muda nada.

set -uo pipefail

PROJECT="${MA_PROJECT:-site-hypr}"
VIEW="${MA_SURVEY_VIEW:-site-hypr.prod_analytics.ma_survey_responses}"
DIM="${MA_CREATIVES_DIM:-site-hypr.prod_analytics.creatives_dim}"
TOKEN="${1:-}"

command -v bq >/dev/null || { echo "✗ 'bq' não está no PATH. Instale o Google Cloud CLI."; exit 1; }

q() { bq query --use_legacy_sql=false --project_id="$PROJECT" --format=csv --quiet "$1" 2>&1 | tail -n +2; }

echo "▸ Projeto: $PROJECT"
echo "▸ View:    $VIEW"
echo

# ── 1. A view existe e responde? ────────────────────────────────────────────
RESP=$(q "SELECT COUNT(*) FROM \`$VIEW\` WHERE responded_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)")
if ! [[ "$RESP" =~ ^[0-9]+$ ]]; then
  echo "✗ A VIEW NÃO RESPONDEU."
  echo "$RESP" | head -5
  echo
  echo "  → Se falar em 'partition elimination', a view está desatualizada. Rode:"
  echo "      bq query --use_legacy_sql=false --project_id=$PROJECT < backend/sql/ma_survey_view.sql"
  echo "  → Se falar em 'Access Denied', falta bigquery.dataViewer no dataset"
  echo "    pra service account da Cloud Function (passo 4 do docs/survey-max-attention.md)."
  exit 1
fi
echo "✓ View responde. Respostas nos últimos 30 dias: $RESP"

if [ "$RESP" -eq 0 ]; then
  echo
  echo "✗ ZERO respostas no lake nessa janela."
  echo "  → O problema não é a integração: é o Tap to Choose não estar coletando,"
  echo "    ou os eventos não estarem chegando em creative_events_raw."
  exit 1
fi

# ── 2. A dimensão de criativos carregou? ────────────────────────────────────
DIMN=$(q "SELECT COUNT(*) FROM \`$DIM\`")
SYNC=$(q "SELECT FORMAT_TIMESTAMP('%d/%m %H:%M', MAX(synced_at), 'America/Sao_Paulo') FROM \`$DIM\`")
echo "✓ Criativos na dimensão: ${DIMN:-?}   (última carga: ${SYNC:-nunca})"

if [ "${DIMN:-0}" -eq 0 ]; then
  echo
  echo "✗ DIMENSÃO VAZIA — é por isso que o modal não mostra criativo nenhum."
  echo "  Quem popula é o cron 'rollup-creative-events' do o2o-platform (~15 min)."
  echo "  → Confira se o deploy da plataforma saiu depois do PR #741."
  echo "  → Nos logs da Vercel, procure: [rollup-creative-events] creatives_dim falhou"
  echo "  As respostas estão lá ($RESP): falta só o NOME da peça."
  exit 1
fi

# ── 3. Os nomes seguem a convenção que amarra campanha e lado? ──────────────
COMTOKEN=$(q "SELECT COUNT(*) FROM \`$VIEW\` WHERE responded_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY) AND short_token IS NOT NULL")
echo "✓ Respostas com token de campanha: $COMTOKEN de $RESP"
if [ "${COMTOKEN:-0}" -eq 0 ]; then
  echo
  echo "⚠ Nenhum criativo segue 'ID-XXXXXX_...' — o vínculo vai ser manual no modal."
  echo "  Não é erro: o admin escolhe o criativo na lista em vez de um clique."
fi

# ── 4. Foto do que o report vai mostrar ─────────────────────────────────────
echo
if [ -n "$TOKEN" ]; then
  echo "▸ Campanha $TOKEN — o que o report vai somar:"
  q "SELECT creative_name, option, COUNT(*) AS respostas
     FROM \`$VIEW\`
     WHERE responded_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
       AND short_token = '$(echo "$TOKEN" | tr -cd '[:alnum:]')'
     GROUP BY 1, 2 ORDER BY respostas DESC" | column -t -s,
  echo
  echo "  Esperado: nomes terminando em _CONTROLE e _EXPOSTO, com as mesmas opções"
  echo "  dos dois lados. Opção que só aparece de um lado vira aviso no report,"
  echo "  não erro."
else
  echo "▸ Top criativos com resposta (30d):"
  q "SELECT COALESCE(creative_name, CONCAT('(sem nome) ', creative_id)) AS criativo,
            COUNT(DISTINCT option) AS opcoes, COUNT(*) AS respostas
     FROM \`$VIEW\`
     WHERE responded_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
     GROUP BY 1 ORDER BY respostas DESC LIMIT 10" | column -t -s,
  echo
  echo "  Dica: passe o token da campanha pra ver o detalhe —"
  echo "    bash backend/scripts/check_ma_survey.sh FXR5US"
fi

echo
echo "✓ TUDO DE PÉ. Abra o modal de survey da campanha: o botão"
echo "  'Conectar automaticamente' deve aparecer."
