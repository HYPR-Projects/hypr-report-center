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
CRON_SECRET=$(extract_env "CRON_SECRET")
SENDGRID_API_KEY=$(extract_env "SENDGRID_API_KEY")
SHEETS_ALERT_FROM=$(extract_env "SHEETS_ALERT_FROM")
ACCESS_TRACKING_IP_SALT=$(extract_env "ACCESS_TRACKING_IP_SALT")

# Xandr Curate API — capturamos da revisão ativa OU lemos do Secret Manager.
# Existem nesse jeito (não como --set-secrets) por consistência com o resto:
# o deploy do report_data usa --env-vars-file pra tudo, e --env-vars-file
# limpa secrets mountados via --set-secrets se misturarmos.
read_secret_if_missing() {
  local var_name="$1"
  local current_value="$2"
  if [ -n "$current_value" ]; then
    echo "$current_value"
    return
  fi
  gcloud secrets versions access latest --secret="$var_name" --project=site-hypr 2>/dev/null || echo ""
}
XANDR_CURATE_USER=$(extract_env "XANDR_CURATE_USER")
XANDR_CURATE_USER=$(read_secret_if_missing "XANDR_CURATE_USER" "$XANDR_CURATE_USER")
XANDR_CURATE_PASS=$(extract_env "XANDR_CURATE_PASS")
XANDR_CURATE_PASS=$(read_secret_if_missing "XANDR_CURATE_PASS" "$XANDR_CURATE_PASS")
XANDR_CURATE_MEMBER_ID=$(extract_env "XANDR_CURATE_MEMBER_ID")
XANDR_CURATE_MEMBER_ID=$(read_secret_if_missing "XANDR_CURATE_MEMBER_ID" "$XANDR_CURATE_MEMBER_ID")

# PMP_SCHEDULER_SECRET — segredo compartilhado entre Cloud Scheduler e a
# Cloud Function pra autenticar o cron job sem JWT admin. Gerado uma vez,
# armazenado no Secret Manager pra deploys futuros, e configurado no
# Scheduler como header X-Scheduler-Secret.
PMP_SCHEDULER_SECRET=$(extract_env "PMP_SCHEDULER_SECRET")
if [ -z "$PMP_SCHEDULER_SECRET" ]; then
  PMP_SCHEDULER_SECRET=$(gcloud secrets versions access latest --secret=PMP_SCHEDULER_SECRET --project=site-hypr 2>/dev/null || echo "")
fi
if [ -z "$PMP_SCHEDULER_SECRET" ]; then
  PMP_SCHEDULER_SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
  gcloud secrets describe PMP_SCHEDULER_SECRET --project=site-hypr >/dev/null 2>&1 || \
    gcloud secrets create PMP_SCHEDULER_SECRET --replication-policy=automatic --project=site-hypr >/dev/null
  printf '%s' "$PMP_SCHEDULER_SECRET" | gcloud secrets versions add PMP_SCHEDULER_SECRET --data-file=- --project=site-hypr >/dev/null
  echo "  ✨ PMP_SCHEDULER_SECRET gerado e armazenado no Secret Manager."
  echo "     Configure o Cloud Scheduler job com este valor no header X-Scheduler-Secret."
fi

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
if [ -n "$CRON_SECRET" ]; then
  echo "  ✓ CRON_SECRET capturado"
else
  echo "  ⚠ CRON_SECRET ausente — sync diário do Sheets desabilitado"
fi
if [ -n "$SENDGRID_API_KEY" ]; then
  echo "  ✓ SENDGRID_API_KEY capturado"
else
  echo "  ⚠ SENDGRID_API_KEY ausente — alertas por email pra CS desabilitados"
fi
if [ -n "$SHEETS_ALERT_FROM" ]; then
  echo "  ✓ SHEETS_ALERT_FROM capturado"
fi
if [ -n "$ACCESS_TRACKING_IP_SALT" ]; then
  echo "  ✓ ACCESS_TRACKING_IP_SALT capturado"
else
  echo "  ⚠ ACCESS_TRACKING_IP_SALT ausente — IP hash do tracking vai usar default inseguro"
  echo "    Configure: gcloud functions deploy report_data --gen2 --region=southamerica-east1 \\"
  echo "                 --update-env-vars ACCESS_TRACKING_IP_SALT=\$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
fi
if [ -n "$XANDR_CURATE_USER" ] && [ -n "$XANDR_CURATE_PASS" ] && [ -n "$XANDR_CURATE_MEMBER_ID" ]; then
  echo "  ✓ XANDR_CURATE_{USER,PASS,MEMBER_ID} capturados (PMP sync habilitado)"
else
  echo "  ⚠ XANDR_CURATE_* ausentes — sync de PMP deals desabilitado"
fi
if [ -n "$PMP_SCHEDULER_SECRET" ]; then
  echo "  ✓ PMP_SCHEDULER_SECRET capturado"
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
SHEETS_DRIVE_FOLDER_ID: '1ddnSYIYbDio5BkH3p9nq-n7evmneIHh9'
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
if [ -n "$CRON_SECRET" ]; then
  echo "CRON_SECRET: '${CRON_SECRET}'" >> "$ENV_FILE"
fi
if [ -n "$SENDGRID_API_KEY" ]; then
  echo "SENDGRID_API_KEY: '${SENDGRID_API_KEY}'" >> "$ENV_FILE"
fi
if [ -n "$SHEETS_ALERT_FROM" ]; then
  echo "SHEETS_ALERT_FROM: '${SHEETS_ALERT_FROM}'" >> "$ENV_FILE"
fi
if [ -n "$ACCESS_TRACKING_IP_SALT" ]; then
  echo "ACCESS_TRACKING_IP_SALT: '${ACCESS_TRACKING_IP_SALT}'" >> "$ENV_FILE"
fi
if [ -n "$XANDR_CURATE_USER" ]; then
  echo "XANDR_CURATE_USER: '${XANDR_CURATE_USER}'" >> "$ENV_FILE"
fi
if [ -n "$XANDR_CURATE_PASS" ]; then
  echo "XANDR_CURATE_PASS: '${XANDR_CURATE_PASS}'" >> "$ENV_FILE"
fi
if [ -n "$XANDR_CURATE_MEMBER_ID" ]; then
  echo "XANDR_CURATE_MEMBER_ID: '${XANDR_CURATE_MEMBER_ID}'" >> "$ENV_FILE"
fi
if [ -n "$PMP_SCHEDULER_SECRET" ]; then
  echo "PMP_SCHEDULER_SECRET: '${PMP_SCHEDULER_SECRET}'" >> "$ENV_FILE"
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
  --memory=2Gi \
  --cpu=1 \
  --timeout=540s \
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

# ── 5. Cloud Scheduler: pmp-xandr-daily-sync ─────────────────────────────────
# Cron diário 04:00 BRT que dispara o sync v2 (master IOs + line items +
# delivery + refresh da pmp_lines_enriched). Tornado idempotente aqui porque
# já tivemos drift em produção: o job original ficou apontando pro endpoint
# v1 (pmp_sync_xandr), que só alimenta pmp_deals_delivery — enquanto a UI
# /admin/pmp lê do v2. Resultado: cron rodando "com sucesso" diariamente sem
# atualizar a tela. Mantemos o setup no script pra qualquer redeploy
# converger pro target correto.
if [ -n "$PMP_SCHEDULER_SECRET" ] && [ -n "$XANDR_CURATE_USER" ]; then
  echo ""
  echo "▸ Garantindo Cloud Scheduler pmp-xandr-daily-sync..."

  SCHEDULER_JOB="pmp-xandr-daily-sync"
  SCHEDULER_URI="https://${REGION}-site-hypr.cloudfunctions.net/${FUNCTION_NAME}?action=pmp_sync_v2"
  SCHEDULER_BODY='{"report_interval":"last_7_days"}'
  SCHEDULER_SCHEDULE="0 4 * * *"
  SCHEDULER_TZ="America/Sao_Paulo"

  # Delete + create em vez de branchar create/update: o flag de headers mudou
  # de nome entre os dois (`--headers` no create, `--update-headers` no update)
  # no gcloud recente, e recriar do zero é mais simples que manter os dois caminhos.
  if gcloud scheduler jobs describe "$SCHEDULER_JOB" \
        --location="$REGION" --project=site-hypr >/dev/null 2>&1; then
    gcloud scheduler jobs delete "$SCHEDULER_JOB" \
      --location="$REGION" --project=site-hypr --quiet >/dev/null
  fi

  gcloud scheduler jobs create http "$SCHEDULER_JOB" \
    --location="$REGION" \
    --project=site-hypr \
    --schedule="$SCHEDULER_SCHEDULE" \
    --time-zone="$SCHEDULER_TZ" \
    --uri="$SCHEDULER_URI" \
    --http-method=POST \
    --headers="Content-Type=application/json,X-Scheduler-Secret=${PMP_SCHEDULER_SECRET}" \
    --message-body="$SCHEDULER_BODY" \
    --attempt-deadline=600s \
    --description="Sync diario Xandr Curate -> pmp_lines_enriched (v2)" \
    >/dev/null
  echo "  ✓ Job recriado ($SCHEDULER_SCHEDULE $SCHEDULER_TZ → $SCHEDULER_URI)"
fi

# ── 6. Output final ──────────────────────────────────────────────────────────
echo ""
echo "✓ Deploy concluído. URL pública:"
gcloud functions describe "$FUNCTION_NAME" \
  --region="$REGION" \
  --format="value(serviceConfig.uri)"
