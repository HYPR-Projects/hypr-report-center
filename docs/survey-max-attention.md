# Survey: somar Max Attention com Typeform

Uma pergunta de Brand Lift pode rodar em duas bases ao mesmo tempo — no
Typeform e na pesquisa nativa do Max Attention (etapa de survey do Tap to
Choose) — com o mesmo título e as mesmas opções. O cliente quer um número só.
Este documento é o mapa dessa soma: o que cada peça faz, como ligar, e o que
inspecionar quando um número parecer errado.

## O caminho do dado

```
Tap to Choose (mídia)
   └─ evento survey_answer            ← metadata.optionLabel = a resposta
      └─ prod_analytics.creative_events_raw        (lake, o2o-platform)
         └─ view ma_survey_responses               (contrato, este repo)
            └─ backend/maxattention.py             (leitor + cache)
               └─ src/shared/surveySources.js      (reconciliação + soma)
                  └─ SurveyTab                     (report do cliente)

Typeform
   └─ api.typeform.com  →  typeform_proxy  ─────────┘  (mesmo shape de saída)
```

O ponto de junção é o **shape**: `maxattention_results` devolve exatamente
`{type, counts, total, first/last_response_at}`, igual ao `typeform_proxy`.
Daí pra frente o pipeline não sabe — nem precisa saber — qual base respondeu.

## As duas agregações (não se confundem)

| Eixo | Onde | O que junta |
|---|---|---|
| entre **fontes** | `poolSideParts` (`surveySources.js`) | Typeform + Max Attention + VideoAsk no mesmo lado, mesmo mês |
| entre **meses** | `combineSurveyQuestions` (`surveyCombine.js`) | o mesmo lado, meses diferentes |

Os dois usam o mesmo reconciliador de rótulos. É por isso que "Sim" de abril
soma com "sim" de maio pelo mesmo critério que faz o Typeform somar com o Max
Attention.

## Como os rótulos são casados

Somar é trivial; decidir **o que soma com o quê** é o problema. As bases
escrevem o mesmo rótulo diferente (`Sim` / `sim` / `Talvez 🤔` / `b) Não`).
Três camadas, da mais segura à menos, e nada funde em silêncio quando a
confiança cai:

1. **canônico** — mesma string depois de tirar acento, caixa, pontuação,
   emoji e enumerador. Funde sem ruído.
2. **aproximação** — Levenshtein/token-set acima do limiar e com folga sobre o
   segundo candidato. Funde e **registra** (aparece no badge da pergunta).
3. **órfão / ambíguo** — não funde: vira bucket próprio e vira aviso.

Acima disso, um veredito estrutural: se a maior parte do volume das bases
extras não achou par, o status vira `mismatch` e o report **avisa em vez de
mostrar um total**. Aproximação só acontece ENTRE bases — dentro da mesma
base, dois rótulos são duas opções distintas por construção.

Testes em `src/shared/surveySources.test.js` (`npm test`), incluindo os casos
que precisam **falhar** em fundir.

## A unidade é RESPONDENTE, não toque

O evento `survey_answer` é emitido por montagem da peça, não por sessão:
quem recarrega responde de novo. Medido na campanha FXR5US: **383 eventos
contra 265 respondentes**, 45% a mais. O painel do Max Attention mostra os
dois números em telas diferentes — o funil diz respondentes, a distribuição
por opção conta evento.

O report conta **sessão distinta**, por dois motivos:

- lift é proporção de **pessoas**, não de toques;
- o teste de significância assume `n` de respondentes independentes — com
  `n` inflado a confiança sai superestimada, que é o pior dos dois erros,
  porque faz ruído parecer resultado.

É a mesma régua do brand lift do AdBolt (`surveyLift.ts`): *"o denominador
correto da proporção é respondentes — usar a soma inflaria n"*.

Sessão que responde duas coisas diferentes (recarregou e mudou de ideia)
conta uma vez em cada opção. Pegar só a primeira exigiria função de janela,
que derruba a poda de partição da view — troca ruim por um caso raro.

## O lift diz se é real

Antes, "+3,2 pp" com 4.000 respondentes e "+3,2 pp" com 40 saíam idênticos na
tela — e a leitura natural de um número verde grande é "funcionou". Somar
bases tornou isso mais urgente: a soma muda o `n`, e `n` é exatamente o que
decide se a diferença significa alguma coisa.

Cada card de lift agora traz uma linha:

| O que aparece | Quando |
|---|---|
| `✓ significante a 95% · ±2,1 pp` | teste z de duas proporções passa |
| `≈ dentro da margem de erro · ±4,3 pp` | tem amostra, a diferença não se sustenta |
| `· amostra baixa — menos de 60 por célula` | abaixo do piso: **não se conclui nada** |

A régua não foi inventada aqui: é a mesma de
`o2o-platform/src/modules/adbolt/services/surveyLift.ts` — piso de 60
respostas por célula (regra de negócio da HYPR, registrada lá com data) e
teste z bicaudal a 95%. Duas telas da HYPR discordando sobre o mesmo estudo
seria pior que nenhuma das duas falar.

O teste roda na **contagem bruta**, nunca na porcentagem já arredondada que
aparece no gráfico — arredondar antes de testar joga fora justamente a
precisão que o teste mede. Testes em `src/shared/surveyStats.test.js`.

## Como o vínculo é sugerido

O nome do criativo já carrega tudo:

```
ID-FXR5US_HYPR_LOREAL_..._SURVEY_AWARENESS_CONTROLE
   ^^^^^^ short_token da campanha            ^^^^^^^^ controle | exposto
```

Campanha vem do token e lado vem do sufixo. Mas o nome **não diz qual
pergunta** o criativo coletou — e no Tap to Choose de pergunta única o evento
nem carrega título. Numa campanha com Ad Recall e Preferência, os dois
criativos de controle são igualmente "FXR5US, controle", e a primeira versão
sugeria o mesmo para os dois slots.

Quem desempata são as **opções**: `Sim/Não/Talvez` não casa com
`Marca A/Marca B`. A sugestão exige evidência de que é a mesma pergunta —
opções batendo com as do Typeform daquele lado (comparadas com a mesma régua
que soma os rótulos depois), ou título de pergunta casando com o nome do
bloco. Sem nenhuma das duas, não sugere: a lista fica pro admin, porque aí
não há como saber e chutar é pior.

O modal abre sabendo o que conectar — botão "Conectar automaticamente"
resolve a campanha inteira, e cada slot tem sugestão de um clique, que diz
POR QUE está sugerindo ("opções batem com o Typeform"). **Sugestão nunca vira
configuração sozinha**: o admin confirma, e o `mismatch` acima cobre o caso
de a sugestão estar errada.

## Ligar (uma vez)

Tudo abaixo roda no repo **`hypr-report-center`** — não no `o2o-platform`.
Confundir os dois dá `cd: no such file or directory: backend`.

Numa máquina com `gcloud` autenticado em `site-hypr`. Cole bloco a bloco, sem
comentário na mesma linha do comando: no zsh interativo `#` NÃO é comentário
por padrão (`INTERACTIVE_COMMENTS` vem desligado), e um `# nota` colado junto
vira argumento do `gcloud`.

**1. Repo certo, atualizado**

```bash
cd ~/Desktop/"Jojo projects"
[ -d hypr-report-center ] || git clone https://github.com/HYPR-Projects/hypr-report-center.git
cd hypr-report-center && git checkout main && git pull
```

**2. Deploy da plataforma** — só confira que já saiu (Vercel publica no merge
da `o2o-platform`). É o cron dela que cria a `creatives_dim`.

**3. Criar a view**

```bash
bq query --use_legacy_sql=false --project_id=site-hypr < backend/sql/ma_survey_view.sql
```

O arquivo cria antes uma `creatives_dim` vazia com `IF NOT EXISTS`, então
pode rodar mesmo que o cron da plataforma ainda não tenha ticado (sem isso o
`CREATE VIEW` falharia com "Not found: Table", porque o BigQuery valida as
referências na criação).

`CREATE OR REPLACE` — rodar de novo é seguro e é o conserto padrão quando a
view muda.

**4. Dar leitura em `prod_analytics` pra service account da Cloud Function**

```bash
SA=$(gcloud functions describe report_data --gen2 --region=southamerica-east1 --format='value(serviceConfig.serviceAccountEmail)')
echo "$SA"
```

```bash
bq show --format=prettyjson site-hypr:prod_analytics > /tmp/ds.json
python3 - "$SA" <<'PYEOF'
import json, sys
sa = sys.argv[1]
ds = json.load(open("/tmp/ds.json"))
acc = ds.setdefault("access", [])
if not any(a.get("userByEmail") == sa and a.get("role") == "READER" for a in acc):
    acc.append({"role": "READER", "userByEmail": sa})
json.dump(ds, open("/tmp/ds.json", "w"), indent=2)
print("READER concedido a", sa)
PYEOF
bq update --source /tmp/ds.json site-hypr:prod_analytics
```

Grant no DATASET, não no projeto: a SA precisa ler `prod_analytics` e mais
nada. `roles/bigquery.dataViewer` no projeto inteiro resolveria numa linha e
abriria todo o `site-hypr` de brinde.

**5. Deploy do backend + env, numa tacada**

```bash
cd backend
MA_SURVEY_VIEW_INIT=site-hypr.prod_analytics.ma_survey_responses bash deploy.sh
```

O `INIT` só é necessário na primeira vez: dali em diante o `deploy.sh` captura
o valor da revisão viva e repassa sozinho. Evite criar a variável com um
`gcloud functions deploy --update-env-vars` avulso — o bloco no topo do
`deploy.sh` explica por quê (deploy com flag de env pode fazer a revisão
nascer sem as OUTRAS variáveis, que são secrets fora do git).

O deploy do backend não sai no merge: é disparo manual, pelo workflow "Deploy
backend (Cloud Function)" — que hoje falha por não haver credencial GCP
configurada no repo — ou pelo `deploy.sh` como acima.

**6. Conferir**

```bash
bq query --use_legacy_sql=false --project_id=site-hypr 'SELECT creative_name, short_token, option, COUNT(*) AS respostas FROM `site-hypr.prod_analytics.ma_survey_responses` WHERE responded_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY) AND short_token = "FXR5US" GROUP BY 1,2,3 ORDER BY respostas DESC'
```

Esperado: uma linha por opção, por criativo, com nomes terminando em
`_CONTROLE` / `_EXPOSTO`. `creative_name` NULL em tudo = a dimensão ainda não
carregou (ou o cron de export da plataforma não rodou desde o deploy dela).

Parar antes do passo 5 não quebra nada: os endpoints respondem 501 dizendo o
que falta, a seção some do modal e o Typeform segue como sempre.

## Custo

O risco não é volume de dado, é **query por pageview**: `maxattention_results`
é chamado no render do report, por cliente, por pergunta.

- cache em memória de 5 min nos resultados, 10 min na listagem (chave por
  criativo × pergunta × período, então clientes diferentes no mesmo report
  batem na mesma entrada);
- `use_query_cache` ligado — segunda linha de defesa quando a instância morre
  num cold start;
- teto de bytes por query (32 GiB). Ele já fez o trabalho dele: a primeira
  versão da LISTAGEM batia nele com `bytesBilledLimitExceeded`, e estava
  certo — eram 34 GiB por abertura de modal.

**A chave de cluster decide o custo.** `creative_events_raw` é clusterizada
por `(creative_id, event_type)`. Filtrar só por `event_type` — a SEGUNDA
chave — quase não poda:

| Query | Filtra por | Custo |
|---|---|---|
| `fetch_results` (detalhe) | `creative_id` (chave líder) | barato desde sempre |
| `list_creatives` (listagem) | era só `event_type` | 34 GiB, barrado pelo teto |

A listagem passou a resolver a campanha **antes**, na `creatives_dim` —
centenas de linhas, alguns KB — e só então consulta o lake com
`creative_id IN UNNEST(...)`, que cai na chave líder. Sem campanha (caminho
manual) não há como podar por criativo, e aí o que segura o custo é a
janela: 30 dias.

Do lado da plataforma, a dimensão usa load job (gratuito) com gate de frescor
por metadata: ~24 recargas/dia, custo zero nos demais ticks.

## A view precisa podar partição

`creative_events_raw` exige filtro em `occurred_at` (`require_partition_filter`).
A primeira versão da view deduplicava com `QUALIFY ROW_NUMBER() OVER (...)` e
isso derrubou tudo em produção:

```
Cannot query over table 'creative_events_raw' without a filter over
column(s) 'occurred_at' that can be used for partition elimination
```

Função de janela é barreira de otimização: o filtro de período que o Report
Center põe do lado de fora não desce até o scan, então o BigQuery não elimina
partição e recusa a query — toda chamada do report, não só a de conferência.

A view atual resolve com duas defesas: `SELECT DISTINCT` no lugar do `QUALIFY`
(dedupa o mesmo caso, sem barreira, então filtro de fora volta a podar
partição e cluster) e um filtro de partição **dentro** da view, que não
depende do otimizador.

Se um dia alguém for mexer nessa view: qualquer coisa que introduza janela,
ordenação global ou agregação que não seja por chave derruba a poda de novo.
O sintoma é exatamente a mensagem acima.

## Diagnóstico em um comando

```bash
bash backend/scripts/check_ma_survey.sh          # visão geral
bash backend/scripts/check_ma_survey.sh FXR5US   # detalhe de uma campanha
```

Roda as verificações em ordem (view responde → dimensão carregou → nomes
seguem a convenção → foto do que o report vai somar) e para na primeira que
falhar, dizendo o que fazer. Só leitura.

Quem tem `gcloud` na mão nem sempre é quem sabe ler o resultado — e a
alternativa era colar terminal de um lado pro outro. Um comando, uma saída,
com o veredito escrito.

**Sem `gcloud` na mão?** O mesmo script roda no CI: Actions → "Verificar
survey do Max Attention" → Run workflow, com o token da campanha como
entrada opcional. Depende da credencial GCP no repo — a mesma do
`deploy-backend.yml`, que hoje **não** está configurada.

## O erro precisa chegar em quem consegue agir

`maxattention_list_creatives` é admin-only e devolve a mensagem **real** do
BigQuery no corpo do erro. Não é descuido: o genérico
("Erro ao listar criativos") custou uma rodada inteira — o BigQuery dizia
exatamente qual era o defeito (`DISTINCT and LIMIT`), e isso ficou só no log
de uma Cloud Function que quem estava diagnosticando não conseguia abrir.

`maxattention_results` mantém o genérico, e a diferença é proposital: aquele
endpoint é aberto (o report roda no navegador do cliente), então detalhe de
erro interno não sai de lá. O log continua tendo tudo nos dois casos.

## Quando um número parecer errado

1. **Pergunta sem respostas do Max Attention** → o rótulo do evento
   (`metadata.optionLabel`) mudou de nome na origem, ou a view não enxerga o
   criativo. Rode a query de validação no fim do `ma_survey_view.sql`.
2. **Total maior do que deveria** → dedupe. A view precisa do
   `QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id)`; sem ele, re-export
   sobreposto conta duas vezes.
3. **Badge "bases divergentes"** → as duas bases não são a mesma pergunta.
   O report está certo em não somar; confira o criativo vinculado.
4. **Criativo aparece pelo id, sem nome** → `creatives_dim` ainda não
   carregou (recarrega ~1×/h) ou o cron de export não rodou desde o deploy.

## Arquivos

| Arquivo | Papel |
|---|---|
| `backend/sql/ma_survey_view.sql` | o contrato entre os dois produtos |
| `backend/maxattention.py` | leitor BigQuery + convenção de nome |
| `src/shared/surveySources.js` | reconciliação de rótulos e soma |
| `src/shared/surveyStats.js` | significância do lift (piso 60 + z-test 95%) |
| `src/shared/surveyConfig.js` | schema do `survey_data` (v1 → v4) |
| `src/shared/surveyCombine.js` | busca por fonte + agregação entre meses |
| `src/components/modals/SurveyModal.jsx` | setup e pareamento automático |
| `o2o-platform` → `docs/REPORT_CENTER_SURVEY_BRIDGE.md` | o lado produtor |
