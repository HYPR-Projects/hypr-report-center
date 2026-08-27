#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Setup one-shot da Opção A do deploy de backend: Workload Identity Federation.
#
# POR QUE ESTE SCRIPT EXISTE
#   `.github/workflows/deploy-backend.yml` foi escrito em 24/08/2026 pra
#   impedir que um fix de backend fique parado esperando alguém abrir o
#   laptop. Ele nunca recebeu credencial, então nunca impediu nada: os runs
#   falham no guard "Conferir se há credencial configurada", e o repo segue
#   sem caminho automatizado pro backend.
#
#   O `docs/deploy-backend-ci.md` descreve o setup em prosa. Isto é a mesma
#   coisa executável — descobrir o número do projeto, o nome do SA de runtime
#   e a sintaxe do principalSet na mão é onde esse setup costuma travar.
#
# O QUE ISTO CONCEDE (leia antes de rodar)
#   Ao final, o repositório GitHub HYPR-Projects/hypr-report-center passa a
#   poder deployar a Cloud Function de produção, SEM chave de longa duração
#   guardada no GitHub. A confiança é federada: o Google valida o token OIDC
#   que o Actions emite e o troca por credencial de curta duração.
#
#   Duas camadas independentes limitam ESSE repo, e as duas são de propósito:
#     1. `--attribute-condition` no provider — o Google só aceita token cujo
#        claim `repository` seja exatamente este repo. Sem ela, QUALQUER repo
#        do GitHub no mundo poderia pedir credencial deste projeto. É o erro
#        clássico de setup de WIF, e ele é silencioso.
#     2. o binding de `workloadIdentityUser` usa `attribute.repository/<repo>`,
#        não o pool inteiro — mesmo que a condição do provider seja afrouxada
#        depois, o binding continua estreito.
#
# IDEMPOTENTE
#   Rode quantas vezes quiser: o que já existe é reportado e mantido.
#
# REQUISITOS
#   gcloud auth login && gcloud config set project site-hypr
#   Papel: quem roda precisa poder criar service account, pool WIF e conceder
#   papéis no projeto (Owner, ou Security Admin + Service Account Admin).
#
# USO
#   bash backend/setup_wif_deploy.sh        # confirma antes de aplicar
#   bash backend/setup_wif_deploy.sh -y     # sem confirmação
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT_ID="site-hypr"
# Número do projeto: entra literal no caminho do provider e no principalSet
# (os dois exigem NÚMERO, não o id). Confirmado abaixo contra o projeto real —
# se divergir, o script para em vez de gerar caminhos que falham depois.
PROJECT_NUMBER="453955675457"
REPO="HYPR-Projects/hypr-report-center"

POOL="github"
PROVIDER="github-provider"
DEPLOY_SA="deploy-report-data@${PROJECT_ID}.iam.gserviceaccount.com"
# SA de runtime da function. O `deploy.sh` não passa `--service-account`, então
# a function roda como o SA default de compute — o mesmo que o
# setup_sheets_integration.sh já usa.
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# Papéis: os MESMOS que o deploy.sh exige de um operador humano. Nada aqui é
# permissão nova — é a mesma permissão saindo do laptop de alguém pra um lugar
# auditável.
PROJECT_ROLES=(
  "roles/cloudfunctions.developer"    # deploy da function
  "roles/run.admin"                   # revisão ativa, liveness probe, traffic split
  "roles/cloudscheduler.admin"        # reconciliar os cron jobs
  "roles/secretmanager.secretAccessor" # fallback do read_secret_if_missing
)

ASSUME_YES=0
[ "${1:-}" = "-y" ] && ASSUME_YES=1

command -v gcloud >/dev/null || { echo "✗ 'gcloud' não está no PATH."; exit 1; }

echo "▸ Projeto:     $PROJECT_ID ($PROJECT_NUMBER)"
echo "▸ Repositório: $REPO"
echo "▸ SA de deploy: $DEPLOY_SA"
echo

# Confere o número do projeto ANTES de montar caminho nenhum: um número errado
# gera provider e principalSet sintaticamente válidos que nunca autenticam, e o
# erro aparece só no primeiro deploy, como "permission denied" genérico.
REAL_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)" 2>/dev/null || echo "")
if [ -z "$REAL_NUMBER" ]; then
  echo "✗ Não consegui ler o projeto $PROJECT_ID."
  echo "  → gcloud auth login && gcloud config set project $PROJECT_ID"
  exit 1
fi
if [ "$REAL_NUMBER" != "$PROJECT_NUMBER" ]; then
  echo "✗ Número do projeto divergente: script diz $PROJECT_NUMBER, GCP diz $REAL_NUMBER."
  echo "  → atualize PROJECT_NUMBER neste script (e confira o SA de runtime)."
  exit 1
fi
echo "✓ Número do projeto confere."

if [ "$ASSUME_YES" -eq 0 ]; then
  echo
  echo "Isto vai permitir que o GitHub Actions de $REPO deploye a Cloud"
  echo "Function de PRODUÇÃO (report_data). Continuar? [y/N]"
  read -r resp
  case "$resp" in y|Y|yes|s|S|sim) ;; *) echo "Abortado."; exit 0;; esac
fi

# ── 1. APIs ──────────────────────────────────────────────────────────────────
echo
echo "▸ Habilitando APIs (sts, iamcredentials)..."
gcloud services enable sts.googleapis.com iamcredentials.googleapis.com \
  --project="$PROJECT_ID"

# ── 2. Service account de deploy ─────────────────────────────────────────────
echo
if gcloud iam service-accounts describe "$DEPLOY_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "✓ SA de deploy já existe: $DEPLOY_SA"
else
  echo "▸ Criando SA de deploy..."
  gcloud iam service-accounts create "deploy-report-data" \
    --project="$PROJECT_ID" \
    --display-name="Deploy report_data (GitHub Actions)"
fi

# ── 3. Papéis no projeto ─────────────────────────────────────────────────────
echo
for role in "${PROJECT_ROLES[@]}"; do
  echo "▸ Concedendo $role..."
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$DEPLOY_SA" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null
done

# ── 4. serviceAccountUser no SA de RUNTIME ───────────────────────────────────
# Sem isto o deploy falha com "must have iam.serviceAccounts.actAs": deployar
# uma function que roda COMO outro SA é agir em nome dele.
echo
echo "▸ Concedendo iam.serviceAccountUser em $RUNTIME_SA..."
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:$DEPLOY_SA" \
  --role="roles/iam.serviceAccountUser" \
  --quiet >/dev/null

# ── 5. Pool + provider ───────────────────────────────────────────────────────
# Gotcha: pool e provider deletados ficam em soft-delete por 30 dias e o NOME
# não pode ser reusado nesse período. Se um `create` falhar dizendo que já
# existe mas o `describe` não achar, foi isso — use outro nome.
echo
if gcloud iam workload-identity-pools describe "$POOL" \
     --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  echo "✓ Pool '$POOL' já existe."
else
  echo "▸ Criando pool '$POOL'..."
  gcloud iam workload-identity-pools create "$POOL" \
    --project="$PROJECT_ID" --location=global \
    --display-name="GitHub Actions"
fi

echo
if gcloud iam workload-identity-pools providers describe "$PROVIDER" \
     --project="$PROJECT_ID" --location=global \
     --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  echo "✓ Provider '$PROVIDER' já existe — atualizando a condição de repo..."
  ACTION="update-oidc"
else
  echo "▸ Criando provider '$PROVIDER'..."
  ACTION="create-oidc"
fi

# `attribute-condition` é a trava que impede outro repo de pedir credencial
# deste projeto. Ela NÃO é opcional.
gcloud iam workload-identity-pools providers "$ACTION" "$PROVIDER" \
  --project="$PROJECT_ID" --location=global \
  --workload-identity-pool="$POOL" \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository=='${REPO}'"

# ── 6. Deixar o repo impersonar o SA de deploy ───────────────────────────────
# principalSet escopado por attribute.repository, não pelo pool inteiro: se a
# condição do provider for afrouxada algum dia, este binding segue estreito.
PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}"
echo
echo "▸ Permitindo que $REPO impersone o SA de deploy..."
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --project="$PROJECT_ID" \
  --member="$PRINCIPAL" \
  --role="roles/iam.workloadIdentityUser" \
  --quiet >/dev/null

# ── 7. O que colar no GitHub ─────────────────────────────────────────────────
PROVIDER_PATH="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

cat <<EOF

─────────────────────────────────────────────────────────────────────────────
✓ Lado do GCP pronto.

Falta o lado do GitHub. Em:

  https://github.com/${REPO}/settings/variables/actions

criar duas VARIÁVEIS (aba "Variables", não "Secrets" — nenhum dos dois valores
é sigiloso, e é por isso que a Opção A não deixa credencial no repo):

  GCP_WORKLOAD_IDENTITY_PROVIDER
  ${PROVIDER_PATH}

  GCP_DEPLOY_SERVICE_ACCOUNT
  ${DEPLOY_SA}

Depois, rodar o workflow "Deploy backend (Cloud Function)" na aba Actions.
Ele roda a suíte inteira como gate e faz smoke check em ?action=healthz — se
passar, a revisão nova está servindo de verdade.
─────────────────────────────────────────────────────────────────────────────
EOF
