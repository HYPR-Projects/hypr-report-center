#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy da Cloud Function do HYPR Report Hub.
#
# Sobre envvars:
#   gcloud functions deploy NÃO preserva envvars existentes — qualquer flag
#   (--set-env-vars OU --update-env-vars) que não inclua uma variável faz a
#   nova revisão nascer sem ela. Como JWT_SECRET e TYPEFORM_TOKEN são
#   secrets gerenciados manualmente (fora do git), o script captura os
#   valores atuais da revisão em produção e re-passa no deploy via arquivo
#   YAML temporário (mais seguro que --set-env-vars na linha de comando,
#   que vazaria no histórico do shell).
#
# Sobre traffic split:
#   Após rollback manual, o serviço pode ficar com config de "não rotear
#   automaticamente para a última revisão". Por isso, ao final do deploy
#   forçamos `update-traffic --to-latest` para garantir 100% na nova.
#
# Flags de performance:
#   --min-instances=1   elimina cold start (~US$0.40-1.20/mês)
#   --memory=512MB      headroom pra payloads grandes
#   --concurrency=10    múltiplos requests por instância (queries são I/O-bound)
#
# Pré-requisitos:
#   gcloud auth login && gcloud config set project site-hypr
#
# Uso:
#   ./deploy.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REGION="southamerica-east1"
FUNCTION_NAME="report_data"
SERVICE_NAME="report-data"

cd "$(dirname "$0")"

# ── 1. Capturar secrets da revisão atualmente em produção ────────────────────
echo "▸ Capturando envvars da revisão ativa em produção..."

ACTIVE_REV=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --format="value(status.traffic[0].revisionName)" 2>/dev/null || echo "")

if [ -z "$ACTIVE_REV" ]; then
  echo "✗ Não consegui identificar a revisão ativa. Abortando."
  exit 1
fi
echo "  revisão ativa: $ACTIVE_REV"

# Extrai valor de uma envvar específica via JSON parse (mais robusto que grep)
extract_env() {
  local var_name="$1"
  gcloud run revisions describe "$ACTIVE_REV" \
    --region="$REGION" \
    --format=json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
# Estrutura para 'gcloud run revisions describe':
#   spec.containers[0].env[].{name,value}
# (diferente de 'gcloud run services describe', que tem spec.template.spec.*)
env = data.get('spec', {}).get('containers', [{}])[0].get('env', [])
for e in env:
    if e.get('name') == '$var_name':
        print(e.get('value', ''))
        break
"
}

JWT_SECRET=$(extract_env "JWT_SECRET")
TYPEFORM_TOKEN=$(extract_env "TYPEFORM_TOKEN")
GOOGLE_OAUTH_CLIENT_ID=$(extract_env "GOOGLE_OAUTH_CLIENT_ID")
GOOGLE_OAUTH_CLIENT_SECRET=$(extract_env "GOOGLE_OAUTH_CLIENT_SECRET")

if [ -z "$JWT_SECRET" ]; then
  echo "✗ JWT_SECRET não encontrado na revisão $ACTIVE_REV. Abortando."
  echo "  (sem ele o login admin quebra em loop)"
  exit 1
fi
echo "  ✓ JWT_SECRET capturado"
if [ -n "$TYPEFORM_TOKEN" ]; then
  echo "  ✓ TYPEFORM_TOKEN capturado"
else
  echo "  ⚠ TYPEFORM_TOKEN ausente (proxy de survey pode falhar)"
fi
if [ -n "$GOOGLE_OAUTH_CLIENT_ID" ] && [ -n "$GOOGLE_OAUTH_CLIENT_SECRET" ]; then
  echo "  ✓ GOOGLE_OAUTH_CLIENT_{ID,SECRET} capturados"
else
  echo "  ⚠ GOOGLE_OAUTH_CLIENT_{ID,SECRET} ausentes — Sheets integration desabilitada"
  echo "    Veja setup_sheets_integration.sh, passo 3."
fi

# ── 2. Montar arquivo YAML com todas as envvars ──────────────────────────────
ENV_FILE=$(mktemp -t envs.XXXXXX.yaml)
trap "rm -f $ENV_FILE" EXIT

cat > "$ENV_FILE" <<EOF
GCP_PROJECT: site-hypr
BQ_DATASET_HUB: prod_prod_hypr_reporthub
BQ_TABLE: campaign_results
LOG_EXECUTION_ID: 'true'
JWT_SECRET: '${JWT_SECRET}'
EOF

if [ -n "$TYPEFORM_TOKEN" ]; then
  echo "TYPEFORM_TOKEN: '${TYPEFORM_TOKEN}'" >> "$ENV_FILE"
fi
if [ -n "$GOOGLE_OAUTH_CLIENT_ID" ]; then
  echo "GOOGLE_OAUTH_CLIENT_ID: '${GOOGLE_OAUTH_CLIENT_ID}'" >> "$ENV_FILE"
fi
if [ -n "$GOOGLE_OAUTH_CLIENT_SECRET" ]; then
  echo "GOOGLE_OAUTH_CLIENT_SECRET: '${GOOGLE_OAUTH_CLIENT_SECRET}'" >> "$ENV_FILE"
fi

# ── 3. Deploy ────────────────────────────────────────────────────────────────
echo ""
echo "▸ Iniciando deploy (2-4 min)..."

gcloud functions deploy "$FUNCTION_NAME" \
  --gen2 \
  --runtime=python311 \
  --region="$REGION" \
  --source=. \
  --entry-point=report_data \
  --trigger-http \
  --allow-unauthenticated \
  --memory=512MB \
  --cpu=1 \
  --timeout=60s \
  --min-instances=1 \
  --max-instances=20 \
  --concurrency=10 \
  --env-vars-file="$ENV_FILE"

# ── 4. Rotear 100% do tráfego para a revisão recém-deployada ─────────────────
echo ""
echo "▸ Roteando 100% do tráfego para a nova revisão..."
gcloud run services update-traffic "$SERVICE_NAME" \
  --region="$REGION" \
  --to-latest

# ── 5. Output final ──────────────────────────────────────────────────────────
echo ""
echo "✓ Deploy concluído. URL pública:"
gcloud functions describe "$FUNCTION_NAME" \
  --region="$REGION" \
  --format="value(serviceConfig.uri)"
