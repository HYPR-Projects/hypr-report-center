# Aba Max Attention no report: como ligar e operar

A aba Max Attention mostra, dentro do report do cliente, as métricas das peças
de rich media feitas na Platform (platform.hypr.mobi). O report não recalcula
nada: ele pede as métricas ao mesmo serviço que monta o painel da Platform.

## Como os dados chegam

```
report (navegador)
  └─ GET report_data?action=ma_report&token=…&date_from=…&date_to=…
       └─ backend/ma_report.py  (cache de 10 min por token + período)
            └─ GET https://platform.hypr.mobi/api/v1/service/report-center/creatives
                 header x-service-key: <chave compartilhada>
                 └─ Postgres + BigQuery (lake) da Platform
```

- O vínculo peça → campanha fica na tabela `report_ma_links` (dataset de assets
  do RC). A tabela é criada sozinha no primeiro salvamento.
- Nada vincula sozinho: o admin confirma cada peça (mesma regra do Survey).
- O backend só repassa campos de uma lista de permissão. Métrica interna da
  Platform não chega no navegador do cliente.
- Em report mesclado, a aba soma as peças de todos os meses do grupo.

## Configuração (uma vez)

1. **Platform (Vercel, projeto o2o-platform)**: criar a env
   `REPORT_CENTER_SERVICE_KEY` com um valor aleatório longo
   (`openssl rand -base64 32`) e publicar a versão com as rotas
   `/api/v1/service/report-center/*`. Sem a env, as rotas respondem 503.
2. **Report Center (GCP site-hypr)**: criar o secret `MA_SERVICE_KEY` no
   Secret Manager com **o mesmo valor** e rodar o deploy do backend (workflow
   "Deploy backend (Cloud Function)" ou `backend/deploy.sh`). O script leva o
   valor para a Cloud Function e preserva nos deploys seguintes. Não use
   `gcloud functions deploy --update-env-vars` avulso: a revisão nova pode
   nascer sem os outros secrets (ver o topo do `deploy.sh`).
3. Opcional: `MA_PLATFORM_URL`, só para apontar para um preview da Platform
   em teste (o padrão é `https://platform.hypr.mobi`). Na primeira vez:
   `MA_PLATFORM_URL_INIT=https://<preview> bash backend/deploy.sh`; nos
   deploys seguintes o script já encontra o valor na revisão ativa. Para
   voltar ao padrão, apague a variável no console do Cloud Run (edita a
   revisão mantendo as outras) antes do próximo deploy.

Para trocar a chave: atualize a env na Vercel e o secret no Secret Manager,
publique a Platform e rode o deploy do backend. Entre um passo e outro a aba
mostra o erro para o admin e uma mensagem neutra para o cliente; nada quebra
no resto do report.

## Operação no dia a dia (admin)

- **Vincular peças**: aba Max Attention → "Gerenciar peças". A busca sugere
  peças por creid da DV360, AdBolt, token no nome e cliente, com o motivo de
  cada sugestão. Em report mesclado, escolha o mês de destino.
- **Criativos da DSP**: ao ligar a peça aos nomes de criativo da DSP, o card
  de mídia passa a usar as impressões da DSP (mesma régua da aba Display).
  Sem isso, a peça mostra os carregamentos que ela mesma contou.
- **Atualizar métricas**: o botão fura o cache de 10 min do backend.
- A aba só aparece para o cliente quando há pelo menos uma peça vinculada.

## Quando algo não aparece

| Sintoma | Causa provável |
|---|---|
| Admin vê "integração não configurada" | `MA_SERVICE_KEY` ausente na Cloud Function |
| Erro 401/403 vindo da Platform | chaves diferentes entre Vercel e Secret Manager |
| Demora ou timeout | Platform leva 15 a 25 s para 20 peças; o limite do backend é 60 s |
| "Funil indisponível" numa peça | o lake não tem sessões da peça no período (`sessionSteps` nulo) |
| Mapa aparece como esquema | o navegador não carregou o MapLibre (CDN bloqueada); os endereços seguem na tabela |
| Peça "aguardando a primeira impressão" | vinculada, mas ainda sem entrega no período |
