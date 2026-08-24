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

## Como o vínculo é sugerido

O nome do criativo já carrega tudo:

```
ID-FXR5US_HYPR_LOREAL_..._SURVEY_AWARENESS_CONTROLE
   ^^^^^^ short_token da campanha            ^^^^^^^^ controle | exposto
```

Campanha vem do token, lado vem do sufixo, e a pergunta casa por título com a
mesma régua dos rótulos. O modal abre já sabendo o que conectar — botão
"Conectar automaticamente" resolve a campanha inteira, e cada slot tem
sugestão de um clique. **Sugestão nunca vira configuração sozinha**: o admin
confirma, e o `mismatch` acima cobre o caso de a sugestão estar errada.

## Ligar (uma vez)

1. **Deploy do o2o-platform** com a branch da dimensão. `creatives_dim` nasce
   sozinha no primeiro tick do cron de export.
2. **Criar a view**: `bq query --use_legacy_sql=false < backend/sql/ma_survey_view.sql`
3. **Permissão**: `bigquery.dataViewer` em `prod_analytics` para a service
   account do Report Center (hoje ela lê só `prod_prod_hypr_reporthub` e
   `prod_assets`).
4. **Env + deploy do backend**, numa tacada só:

   ```bash
   cd backend
   MA_SURVEY_VIEW_INIT=site-hypr.prod_analytics.ma_survey_responses bash deploy.sh
   ```

   O `INIT` só é necessário na primeira vez: dali em diante o `deploy.sh`
   captura o valor da revisão viva e o repassa sozinho. Evite criar a
   variável com um `gcloud functions deploy --update-env-vars` avulso — o
   bloco no topo do `deploy.sh` explica por quê (deploy com flag de env pode
   fazer a revisão nascer sem as OUTRAS variáveis, que são secrets fora do
   git).

   O deploy do backend não sai no merge: é disparo manual, pelo workflow
   "Deploy backend (Cloud Function)" ou rodando o `deploy.sh` de uma máquina
   com `gcloud` autenticado em `site-hypr`.

Sem o passo 4 nada quebra: os endpoints respondem 501 dizendo o que falta, a
seção some do modal e o Typeform segue como sempre.

## Custo

O risco não é volume de dado, é **query por pageview**: `maxattention_results`
é chamado no render do report, por cliente, por pergunta.

- cache em memória de 5 min nos resultados, 10 min na listagem (chave por
  criativo × pergunta × período, então clientes diferentes no mesmo report
  batem na mesma entrada);
- `use_query_cache` ligado — segunda linha de defesa quando a instância morre
  num cold start;
- teto de bytes por query (32 GiB de **estimativa**). Generoso de propósito:
  o BigQuery aplica o teto sobre a estimativa, que considera poda de partição
  mas **não** de cluster. Cap apertado mataria query que custa centavos — foi
  o que zerou um painel na plataforma.

Do lado da plataforma, a dimensão usa load job (gratuito) com gate de frescor
por metadata: ~24 recargas/dia, custo zero nos demais ticks.

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
| `src/shared/surveyConfig.js` | schema do `survey_data` (v1 → v4) |
| `src/shared/surveyCombine.js` | busca por fonte + agregação entre meses |
| `src/components/modals/SurveyModal.jsx` | setup e pareamento automático |
| `o2o-platform` → `docs/REPORT_CENTER_SURVEY_BRIDGE.md` | o lado produtor |
