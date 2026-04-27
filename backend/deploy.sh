#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy da Cloud Function do HYPR Report Hub.
#
# Flags relevantes pra performance:
#   --min-instances=1   mantém 1 instância sempre quente, eliminando cold start
#                       (~2-4s) na primeira request depois de inatividade.
#                       Custo: ~US$0.40-1.20/mês a 256MB/0.25 vCPU.
#   --memory=512MB      headroom pra processar payloads pesados (totals/daily/
#                       detail somados podem passar de 5MB) sem OOM.
#   --timeout=60s       limite por request. Como agora rodamos 8 queries em
#                       paralelo, o teto cai pra ~3-5s. 60s é folga.
#   --max-instances=20  autoscaling cap pra não estourar quota do BigQuery
#                       em pico de acesso.
#
# Pré-requisitos:
#   gcloud auth login
#   gcloud config set project site-hypr
#
# Uso:
#   ./deploy.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REGION="southamerica-east1"
FUNCTION_NAME="report_data"

cd "$(dirname "$0")"

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
  --set-env-vars=GCP_PROJECT=site-hypr,BQ_DATASET_HUB=prod_prod_hypr_reporthub,BQ_TABLE=campaign_results

echo ""
echo "Deploy concluído. URL:"
gcloud functions describe "$FUNCTION_NAME" --region="$REGION" --format="value(serviceConfig.uri)"
