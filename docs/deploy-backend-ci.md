# Deploy do backend pelo GitHub Actions

**Workflow:** `.github/workflows/deploy-backend.yml` · disparo **manual**
(`workflow_dispatch`) na aba Actions.

## Por que existe

O frontend publica sozinho no merge (Vercel). O backend não tinha caminho fora
de uma máquina com `gcloud` autenticado — e em 24/08/2026 isso custou caro: o
fix de frescor da PubMatic foi mergeado, o painel novo subiu na hora, e a
correção da **coleta** ficou parada esperando alguém abrir o laptop.

Metade de um conserto em produção é pior que nenhum: a tela passa a dizer que
está tudo certo com o pipeline ainda quebrado.

## O que o workflow faz

1. instala `requirements.txt` + `requirements-dev.txt`;
2. autentica no GCP;
3. roda **a suíte inteira** (`pytest tests/ -q`) — gate de verdade, falhou não publica;
4. roda `backend/deploy.sh`;
5. **smoke check** em `?action=healthz`, com retry — confirma que a revisão nova
   *serve*, não só que subiu.

A autenticação vem **antes** dos testes de propósito: vários módulos do backend
constroem o client do BigQuery no import, então sem credencial a suíte nem
chega a colher.

O `deploy.sh` é auto-suficiente — captura os secrets da revisão viva
(`extract_env`) e cai no Secret Manager quando falta. O CI **não** precisa
carregar `PUBMATIC_*`, `XANDR_*` nem `PMP_SCHEDULER_SECRET`.

## Setup (uma vez)

### Opção A — Workload Identity Federation (recomendada)

Sem chave de longa duração no repo. Do lado do GCP, criar um pool + provider
para `HYPR-Projects/hypr-report-center` e ligá-lo a uma service account de
deploy. Depois, em **Settings → Secrets and variables → Actions → Variables**:

| Variável | Valor |
|---|---|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<n>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `deploy-report-data@site-hypr.iam.gserviceaccount.com` |

São **variáveis**, não secrets — nenhum dos dois valores é sigiloso.

### Opção B — chave de service account

Mais simples, porém é credencial de longa duração no repo. Em
**Settings → Secrets → Actions**, criar o secret `GCP_SA_KEY` com o JSON da
service account. O workflow usa este caminho automaticamente quando
`GCP_WORKLOAD_IDENTITY_PROVIDER` não está definido.

### Papéis da service account

Os mesmos que o `deploy.sh` exige de um operador humano:

- `roles/cloudfunctions.developer` — deploy da function
- `roles/run.admin` — ler a revisão ativa, aplicar liveness probe e traffic split
- `roles/cloudscheduler.admin` — reconciliar os jobs (`pmp-xandr-daily-sync`,
  `pmp-pubmatic-refresh`, `auto-freeze-daily`, warmup)
- `roles/secretmanager.secretAccessor` — fallback do `read_secret_if_missing`
- `roles/iam.serviceAccountUser` — na service account de runtime da function

## Auto-deploy em push

Fica **desligado** de propósito: o repo mergeia direto na `main`, e auto-deploy
transformaria todo merge que toca `backend/` numa publicação sem querer. Para
ligar, três linhas em `on:`:

```yaml
  push:
    branches: [main]
    paths: ['backend/**']
```

## O caminho manual continua valendo

```bash
gcloud auth login && gcloud config set project site-hypr
cd backend && ./deploy.sh
```
