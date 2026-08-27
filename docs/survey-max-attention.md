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

Cada card de lift traz uma linha — **só na visão HYPR** (ver
"Quem vê o quê" abaixo):

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

## Quanto tempo o report demora pra refletir uma resposta

Não é tempo real, e a pergunta certa não é "quantos minutos" — são três coisas
somadas, e só uma delas é deste repo:

| Camada | Defasagem | Onde |
|---|---|---|
| evento → `creative_events_raw` | quem escreve é o Worker de ingestão (o2o-platform) | fora deste repo |
| cache de resultado do backend | **5 min** por criativo × pergunta × período | `_MA_RESULTS_TTL`, `_TYPEFORM_RESULTS_TTL` |
| frontend | ciclo de **60s** enquanto a aba estiver aberta e visível | `POLL_INTERVAL_MS` em `SurveyTab.jsx` |

O cache do report (3h) **não** entra na conta: ele guarda a *config* da survey
(qual criativo está amarrado), não as contagens.

**A aba atualiza sozinha.** Não há botão de "Atualizar" e não deve haver: botão
transfere pro leitor um trabalho que a máquina faz melhor, e quem não souber
que ele existe fica olhando número velho sem saber. A idade do dado é
governada pelo TTL do backend (5 min) — o ciclo só garante que, assim que o
cache vira, a tela pega na volta seguinte. Então: **dado no máximo ~5 min
velho, sem ninguém fazer nada.**

O ciclo é silencioso de propósito: não mostra spinner e não apaga o que está na
tela. Falha transitória de uma fonte não vira erro — mantém o último número bom
e tenta de novo no ciclo seguinte. Guardado por teste em
`src/dashboards/SurveyTab.autorefresh.test.js`.

Duas armadilhas na hora de conferir a olho:

1. **A unidade é sessão, não clique** (ver "A unidade é RESPONDENTE" acima).
   Responder 5× no mesmo preview move o painel da plataforma e **não** move o
   report: a sua sessão conta 1 vez por opção. Comparar os dois números lado a
   lado sem isso parece bug e não é. Esta é a armadilha que sobra depois do
   auto-refresh, e nenhuma mudança de cache resolve.
2. **Nem F5 nem o ciclo furam o cache de 5 min** — os dois servem do cache. Pra
   forçar query nova na hora existe `refresh=true`, admin-only:

       ...?action=maxattention_results&creative_id=<id>&ak=<chave>&refresh=true

   Sem credencial o parâmetro é ignorado (não recusado), pra que uma URL com
   `refresh=true` herdada por um cliente continue abrindo o report.

Se 5 min for muito pro seu caso, o knob é um só: `_MA_RESULTS_TTL` em
`main.py`. Ele é o que impede que audiência de report vire query no BigQuery, e
o custo escala com **tempo**, não com audiência (o cache é compartilhado entre
leitores) — baixar pra 120s multiplica a conta de query por ~2,5×.

## Custo

O risco não é volume de dado, é **quantas vezes a query roda**:
`maxattention_results` é chamado por cliente, por pergunta — e agora também em
em ciclo, enquanto a aba estiver aberta.

O que segura isso é o cache: com ele, o custo escala com **tempo**, não com
audiência nem com número de ciclos. Cem leitores no mesmo report, recarregando
de minuto em minuto, batem na mesma entrada — a query só roda quando o TTL
vira. É por isso que o cache é pré-requisito do auto-refresh, e não um detalhe
de performance.

- cache em memória de 5 min nos resultados, 10 min na listagem (chave por
  criativo × pergunta × período, então clientes diferentes no mesmo report
  batem na mesma entrada). O `typeform_proxy` ganhou o MESMO TTL: era o único
  sem cache, é o mais caro dos dois (pagina 1000 respostas por página, com
  token compartilhado por todo o Report Center) e sem ele o ciclo de
  auto-refresh viraria paginação nova na API do Typeform a cada volta. TTL
  igual nos dois também deixa o total somado coerente no tempo — antes as
  duas metades da soma eram de momentos diferentes;
- `use_query_cache` ligado, mas **hoje ele não pega nada**: a view filtra
  partição com `CURRENT_TIMESTAMP()`, e o BigQuery não cacheia resultado de
  query não-determinística. Ou seja, cold start re-varre de verdade — quem
  segura custo aqui é o cache em memória mais a poda. Fica ligado porque é o
  default certo e volta a valer sozinho se a view trocar por limite fixo;
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
2. **Total maior do que deveria** → dedupe. A view precisa do `SELECT
   DISTINCT` (com `created_at` fora do SELECT); sem ele, re-export sobreposto
   conta duas vezes. Não troque por `QUALIFY ROW_NUMBER()`: função de janela é
   barreira de otimização e derruba a poda de partição que a tabela exige —
   está explicado no cabeçalho do `ma_survey_view.sql`.
3. **Badge "bases divergentes"** (visão HYPR) → as duas bases não são a mesma
   pergunta. O report está certo em não somar; confira o criativo vinculado.
   O cliente não vê este aviso — se ele reportar número estranho, abra o
   report como admin antes de investigar o BigQuery.
4. **Criativo aparece pelo id, sem nome** → `creatives_dim` ainda não
   carregou (recarrega ~1×/h) ou o cron de export não rodou desde o deploy.

## Quem vê o quê

O relatório tem duas audiências no mesmo componente (`SurveyTab`, chaveado por
`isAdmin`), e a linha entre elas não é sobre confidencialidade — é sobre o que
cada um pode FAZER com a informação:

| Elemento | Cliente | HYPR |
|---|---|---|
| Pergunta, opções, percentuais, lift | ✅ | ✅ |
| Pílulas de fonte (`Standard Survey + Max Attention`) | — | ✅ |
| Aviso de reconciliação (`bases somadas`, `bases divergentes`) | — | ✅ |
| Significância e margem de erro (`±4,3 pp`) | — | ✅ |
| Totais por célula (`1.013 ctrl · 388 exp`) | — | ✅ |

De qual base veio a resposta é decisão de metodologia: pro cliente a pergunta
é uma só, com um total só, e "veio metade do Max Attention" não muda nada que
ele possa decidir. A margem de erro é a régua com que a HYPR julga o próprio
número — inclusive quando ela diz "não concluir" —, e no relatório do cliente
`amostra baixa` ao lado de um lift verde vira ruído, não cautela.

O gate é sempre no **render**, nunca no cálculo: `liftSignificance` continua
rodando pros dois, e é o mesmo objeto que alimenta a leitura interna. Quem
mexer aqui não deve "otimizar" pulando o cálculo pro cliente — o número na
tela do cliente e o número que a HYPR audita têm que sair da mesma conta.

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
