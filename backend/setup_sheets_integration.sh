#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Setup one-shot da integração Google Sheets.
#
# Idempotente: rode quantas vezes quiser, comandos que já foram executados
# antes simplesmente reportam "already exists" e seguem.
#
# O QUE FAZ
#   1. Habilita Drive API e Sheets API no projeto
#   2. Cria KMS keyring `report-center` + key `sheets-integration`
#      (region: southamerica-east1, mesma da Cloud Function)
#   3. Concede permissão ao SA da Cloud Function pra encrypt/decrypt
#      usando essa key
#   4. Mostra instruções pra completar setup no OAuth Consent Screen
#      (ação manual no Console — não pode ser feita via gcloud)
#
# REQUISITOS
#   gcloud auth login && gcloud config set project site-hypr
#
# USO
#   ./setup_sheets_integration.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT_ID="site-hypr"
REGION="southamerica-east1"
KMS_LOCATION="$REGION"
KEYRING_NAME="report-center"
KEY_NAME="sheets-integration"
SA_EMAIL="453955675457-compute@developer.gserviceaccount.com"

echo "▸ Projeto: $PROJECT_ID"
echo "▸ Região:  $REGION"
echo ""

# ── 1. Habilitar APIs ────────────────────────────────────────────────────────
echo "▸ Habilitando Drive API + Sheets API + KMS API..."
gcloud services enable \
  drive.googleapis.com \
  sheets.googleapis.com \
  cloudkms.googleapis.com \
  --project="$PROJECT_ID"

# ── 2. Criar KMS keyring + key ───────────────────────────────────────────────
echo ""
echo "▸ Criando KMS keyring '$KEYRING_NAME' em $KMS_LOCATION..."
gcloud kms keyrings create "$KEYRING_NAME" \
  --location="$KMS_LOCATION" \
  --project="$PROJECT_ID" \
  2>/dev/null || echo "  (keyring já existe — ok)"

echo ""
echo "▸ Criando KMS key '$KEY_NAME' (rotação anual)..."
gcloud kms keys create "$KEY_NAME" \
  --location="$KMS_LOCATION" \
  --keyring="$KEYRING_NAME" \
  --purpose="encryption" \
  --rotation-period="365d" \
  --next-rotation-time="$(date -u -d '+365 days' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v +365d +%Y-%m-%dT%H:%M:%SZ)" \
  --project="$PROJECT_ID" \
  2>/dev/null || echo "  (key já existe — ok)"

# ── 3. Conceder roles ao SA da Cloud Function ────────────────────────────────
echo ""
echo "▸ Concedendo cloudkms.cryptoKeyEncrypterDecrypter ao SA $SA_EMAIL..."
gcloud kms keys add-iam-policy-binding "$KEY_NAME" \
  --location="$KMS_LOCATION" \
  --keyring="$KEYRING_NAME" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/cloudkms.cryptoKeyEncrypterDecrypter" \
  --project="$PROJECT_ID" \
  --condition=None

# ── 4. Instruções OAuth Consent Screen ───────────────────────────────────────
cat <<'EOF'

────────────────────────────────────────────────────────────────────────
✓ Infra automatizada concluída.

PASSOS MANUAIS (não dá via gcloud):

1. OAuth Consent Screen — adicionar scope drive.file
   ────────────────────────────────────────────────
   Abrir: https://console.cloud.google.com/apis/credentials/consent?project=site-hypr

   • Em "Scopes for Google APIs" → "ADD OR REMOVE SCOPES"
   • Filtrar por "drive.file" → marcar
     `https://www.googleapis.com/auth/drive.file`
     descrição: "See, edit, create and delete only the specific Google
                 Drive files you use with this app"
   • Save and continue

2. OAuth Client — pegar Client Secret
   ──────────────────────────────────
   Abrir: https://console.cloud.google.com/apis/credentials?project=site-hypr

   • Localizar o OAuth 2.0 Client ID que termina em
     `p7bj0e8jt6s83da5teo2var5t97okqk7` (já usado pro login admin)
   • Clicar pra abrir, copiar o "Client secret"
   • Vai precisar dele no próximo passo

3. Adicionar Client Secret como envvar do Cloud Run
   ─────────────────────────────────────────────────
   No deploy.sh já capturamos JWT_SECRET / TYPEFORM_TOKEN da revisão
   ativa. O GOOGLE_OAUTH_CLIENT_SECRET segue o mesmo padrão. Antes do
   primeiro deploy desta feature, rode UMA VEZ:

     CLIENT_ID="453955675457-p7bj0e8jt6s83da5teo2var5t97okqk7.apps.googleusercontent.com"
     CLIENT_SECRET="<cole aqui>"

     gcloud run services update report-data \
       --region=southamerica-east1 \
       --update-env-vars="GOOGLE_OAUTH_CLIENT_ID=$CLIENT_ID,GOOGLE_OAUTH_CLIENT_SECRET=$CLIENT_SECRET" \
       --project=site-hypr

   A partir daí, deploy.sh captura essas envvars junto com as outras.

4. Adicionar campo no env-vars-file do deploy.sh
   ──────────────────────────────────────────────
   Já foi atualizado — não precisa mexer manualmente.

────────────────────────────────────────────────────────────────────────
EOF

echo ""
echo "✓ Setup automatizado concluído."
