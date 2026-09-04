# Auditoria: PubMatic "não atualiza" no PMP Deals

**Repo:** `hypr-report-center` (backend Cloud Function + `/admin/pmp`).
**Reportado em:** 24/08/2026 — o hub mostrava `Tim · Rock in Rio` com entrega
"há 2d" enquanto `apps.pubmatic.com`, no filtro **Yesterday**, mostrava
R$ 12.480,53 / 369.336 imps no deal `PM-ZZCX-5733`.

## O que estava errado (e o que NÃO estava)

Não era credencial, não era o cron, não era o MERGE. Era a **hora da coleta**:

1. o sync PubMatic rodava **1x/dia, às 04h BRT** (junto do full sync do Xandr);
2. às 04h a PubMatic ainda não fechou D-1 e devolve a linha **zerada**;
3. o conector descarta dia zerado **de propósito** — gravar o zero faria o dia
   virar `last_delivery_day` e o deal apareceria "no ar" sem ter entregue nada;
4. logo **D-1 nunca entrava no dia em que devia** — só no run da madrugada
   seguinte.

Estado estacionário: base sempre ~2 dias atrás, **com o job 100% verde**.

É o mesmo padrão de `dagster-freshness-fix.md`: *produtor com horário variável +
consumidor com horário fixo + nenhuma dependência entre os dois.* Lá a resposta
foi um sensor que espera a última fonte aterrissar; aqui, como não há sinal de
landing da PubMatic pra observar, a resposta é **reperguntar durante o dia**.

## Por que ninguém viu por semanas

O fix de 21/08 (ledger `pmp_sync_runs`) resolveu *"o job quebrou em silêncio"*.
Ficou de fora *"o job rodou e o dado está velho"* — e o painel de frescor
**normalizava** exatamente esse estado, com a nota:

> "Reporting com lag de D-2/D-3 — a última entrega fica atrás do sync."

`Última entrega` existia no popover, mas era linha informativa: **nunca mexia no
dot**. O painel dizia "Sync rodou hoje" em verde com a base 2 dias atrás ao
lado. Um alerta que explica por que está atrasado em vez de alarmar é um alerta
desligado.

## Falhas encontradas na auditoria

| # | Falha | Efeito | Conserto |
|---|---|---|---|
| 1 | Coleta 1x/dia, antes de a fonte fechar D-1 | base 2 dias atrás em regime permanente | `pmp_sync_pubmatic` + scheduler 4x/dia (10/14/18/22h BRT) |
| 2 | Painel media só a execução do job | "verde e velho" invisível | `api_last_day`/`lag_days` no ledger + régua de atraso de dado no dot |
| 3 | Dias zerados descartados **sem contabilidade** | não dava pra separar "deal parou" de "fonte não fechou" | `trailing_zero_days`, `api_last_day`, `lag_days` |
| 4 | `date.today()` = **UTC**, apesar do nome `today_brt` | entre 21h e 24h BRT o dia corrente vazava como dia fechado, com número parcial | `today_brt()` com offset BRT fixo |
| 5 | Sem credencial ⇒ bloco pulado **sem row no ledger** | a fonte sumia do painel — o mesmo silêncio, outra porta | run com `status='skipped'` |
| 6 | Retry de 401 no report podia estourar `HTTPError` cru | ledger com stack trace em vez de diagnóstico | `_ReportAuthError` + escada de retry explícita |
| 7 | Chain de credencial só cobria falha de **auth** | credencial que autentica e perdeu acesso ao report derrubava o sync com a ALT parada ao lado | chain avança em 401/403 do report |
| 8 | Nenhuma forma de conferir base × fonte | "a PubMatic não atualizou" virava discussão, não diagnóstico | `?action=pmp_pubmatic_audit` |

## Segunda rodada (25/08): por que 4 slots ainda era chute

No dia seguinte ao deploy, a base amanheceu de novo um dia atrás. Não era
regressão — era o desenho:

| Momento | Dado da PubMatic | D-1 | Situação |
|---|---|---|---|
| 24/08 ~08h | 22/08 | 23/08 | 1 dia atrás |
| 24/08 17h (sync manual) | **23/08** | 23/08 | em dia |
| 25/08 ~08h (só o cron 04h) | 23/08 | 24/08 | 1 dia atrás |

A linha do meio é a que ensina: **a PubMatic fecha D-1 durante o dia**, em
algum ponto entre 04h e 17h. Os 4 slots (10/14/18/22) pegavam isso — mas
deixavam um **buraco de 6h entre 04h e 10h**, que é justamente quando as
pessoas abrem o hub de manhã.

Mover 10h para 07h seria trocar um chute por outro. A pergunta real —
**a que horas a PubMatic fecha D-1?** — nunca foi respondida, e é ela que faz
o schedule continuar sendo palpite. Pior: ela provavelmente varia por dia.

### A cura: convergir em vez de adivinhar

O refresh passou a rodar **de hora em hora, das 05h às 23h BRT**. Assim o
horário de fechamento deixa de importar: a base fica fresca até ~1h depois de
a fonte fechar, seja lá quando for.

Para as sondagens horárias saírem baratas:
- o **MERGE e o refresh da enriched rodam sempre** (a PubMatic restata dias já
  fechados, e ~250 linhas é barato);
- o **push do compplan pra planilha só quando `api_last_day` avança** — senão
  seriam 19 reescritas por dia do mesmo número, numa planilha que gente olha.

### E a pergunta finalmente vira dado

Cada sondagem grava `api_last_day` no ledger. Uma semana disso **responde o
horário real de fechamento**, e aí o schedule pode ser apertado por evidência:

```sql
SELECT
  DATE(started_at, 'America/Sao_Paulo')                    AS dia,
  MIN(EXTRACT(HOUR FROM started_at AT TIME ZONE 'America/Sao_Paulo')) AS hora_em_que_D1_entrou
FROM `site-hypr.prod_assets.pmp_sync_runs`
WHERE source = 'pubmatic'
  AND status = 'ok'
  AND api_last_day = DATE_SUB(DATE(started_at, 'America/Sao_Paulo'), INTERVAL 1 DAY)
GROUP BY dia
ORDER BY dia DESC
```

Uma linha por dia com a hora em que D-1 apareceu. Se convergir (ex.: sempre
entre 08h e 09h), dá pra cortar a janela horária. Se variar muito, a janela
larga está justificada e a discussão morre.

Para ver simplesmente o que aconteceu nas últimas 48h:

```sql
SELECT started_at, status, actor, api_last_day, lag_days, rows_processed, error
FROM `site-hypr.prod_assets.pmp_sync_runs`
WHERE source = 'pubmatic'
  AND started_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY)
ORDER BY started_at DESC
```

Isso responde de uma vez: o cron rodou? a que horas? com qual credencial?
até que dia a fonte tinha dado em cada tentativa?

## Terceira rodada (03–04/09): "não atualiza desde 31/08"

Sintoma: painel em vermelho, *"Sync ok, mas o dado para em 31/08 (2 dias
atrás)"*, com a última execução às 18:30 de 03/09. A leitura natural é "a base
não atualizou de novo". Não foi isso que a evidência mostrou.

### O que os logs do `pmp-ops` de 03/09 provam

| Pergunta | Evidência (run #3 e #7 do workflow, 03/09 ~18h20–18h35 BRT) | Resposta |
|---|---|---|
| A credencial funciona? | auditoria respondeu em 4s com `credential: primary` | sim |
| O cron existe e está ligado? | `pmp-pubmatic-refresh` `ENABLED`, `0 5-23 * * *`, próximo disparo 19h | sim |
| O sync gravou o que a API devolveu? | `pmp_pubmatic_audit&days=14` → `clean: true`, `api_day_rows == bq_day_rows == 12` | sim, **base idêntica à API** |
| Até que dia a API tem dado? | `freshness.api_last_day = 2026-08-31`, `expected_last_day = 2026-09-02`, `trailing_zero_days = 2` | **a própria PubMatic devolve zero para 01 e 02/09** |
| O refresh da tabela da UI rodou? | `pmp_enriched_status` → `view_refreshed_at` 18:30 BRT | sim |

Ou seja: pipeline inteiro saudável, base igual à fonte. O que estava "parado
em 31/08" era o **Data Provider Analytics da PubMatic**, ainda sem dado para
01–02/09 às 18h25 de 03/09 — um lag de 2 dias, fora do padrão observado desde
24/08 (D-1 fechando ao longo do dia). Duas hipóteses, que só a Media Console
responde:

1. **Lag do lado da PubMatic** (virada de mês 31/08→01/09; o report de data
   provider pode ter reprocessamento). Nada a fazer aqui além de esperar e,
   se persistir, abrir ticket com a PubMatic citando o endpoint
   `/v1/analytics/data/dataprovider/74689`.
2. **O deal de agosto encerrou em 31/08 e o de setembro é outro objeto.** Um
   deal novo entra sozinho no sync (não há whitelist) — *se* aparecer no
   Data Provider Analytics da conta 74689. Se foi criado sob outro produto
   (PMP de publisher, outro seat), o report que consumimos não o enxerga.

Em ambos os casos o sync não tem o que corrigir; a auditoria diz isso em
uma linha (`clean: true` + `lag_days`). O texto do painel é que induzia ao
erro, e foi trocado (abaixo).

### Falhas reais encontradas nesta rodada

| # | Falha | Efeito | Conserto |
|---|---|---|---|
| 9 | Os 3 passos de diagnóstico do `pmp-ops` que leem o ledger usavam `bq query`, e a service account do CI não tem `bigquery.jobs.create` | **Access Denied em todos os runs desde o primeiro**, escondido pelo `continue-on-error`. A "auditoria" nunca tinha visto o ledger | `GET ?action=pmp_sync_status` (via função, que tem permissão) + workflow passa a usá-lo |
| 10 | Nada respondia "o cron ESTÁ disparando?" — o `describe` do Scheduler zera a cada deploy (o deploy.sh recria o job) e o painel só mostra a última execução | base velha por fonte lenta e base velha por cron morto têm a mesma cara | `missing_slots`: horas da grade (04h + 05h–23h BRT) sem run com `actor='scheduler'` nas últimas 72h. Vazio = cron em dia. Coberto por testes |
| 11 | Sondagem pós-deploy estourava `--max-time 300` com 0 bytes e não dizia onde o tempo foi | log inútil justamente no momento em que se quer prova | `timings_sec` por etapa na resposta do `pmp_sync_pubmatic` (ledger, sync, refresh, compplan) + curl com 560s + leitura do ledger logo depois |
| 12 | `attempt-deadline` do Scheduler era 300s com a função em 540s | execução lenta mas bem-sucedida era marcada FALHA no Scheduler enquanto o trabalho terminava | 540s |
| 13 | Painel dizia *"o dado para em X"*, lido como "a base não atualizou" | investigação apontava pro sync quando a base estava igual à API | quando o atraso foi medido contra a API, o texto diz *"a API da PubMatic só tem dado até X"*; nota da fonte explica o mesmo |
| 14 | Notas do painel e comentários ainda falavam em "10/14/18/22h" | operador comparava o painel com uma grade que não existe mais | texto atualizado para a grade horária |

### Ronda automática (o alarme que faltava)

O `pmp-ops` roda sozinho todo dia às 09:30 BRT em modo diagnóstico. O passo
**Veredito** falha o job — e o GitHub manda e-mail de falha para quem mantém o
workflow — quando qualquer destas condições vale:

- hora da grade do cron (04h + 05h–23h BRT) sem disparo do scheduler nas
  últimas 72h;
- execução da PubMatic com `error`/`skipped` nas últimas 24h;
- PubMatic parada em D-2 ou pior **e** alguma line dela entregou nos últimos
  7 dias (sem entrega na semana é fim de campanha, não atraso).

Nos dois primeiros casos o conserto é nosso (infra/credencial). No terceiro, a
base já está igual à API e a conversa é com a PubMatic ou com quem configurou
o deal. Em 19–21/08 (401 por 3 dias) e em 01–03/09 (fonte parada) esse e-mail
teria chegado no primeiro dia.

### Procedimento quando a base "não atualiza" (2 minutos, sem BigQuery)

1. Actions → **PMP ops** → `diagnosticar` com `sondar_agora` ligado.
2. No passo *ledger de execuções, grade do cron e frescor por fonte*:
   - `missing_slots` **vazio** → o cron está disparando. Siga.
   - `missing_slots` **com horas** → Cloud Scheduler parou: `gcloud scheduler
     jobs describe pmp-pubmatic-refresh` e o passo de Cloud Logging dizem o
     status; um deploy recria o job.
   - runs com `error`/`skipped` → o erro vem na própria linha (credencial,
     API, rede).
3. No passo *Auditoria*: `clean: true` e `freshness.lag_days ≥ 1` → **a base
   está igual à fonte e é a PubMatic que não reportou**. Confira na Media
   Console (filtro *Yesterday*) se o deal entregou; se entregou e a API não
   mostra, é ticket com a PubMatic. Se `findings` tem `missing_in_bq`, aí sim
   é o sync — rode `sondar_agora` de novo (MERGE idempotente).
4. `d1_close_hours` mostra, por dia, a hora em que a PubMatic fechou D-1. Se
   os dias recentes sumirem dessa lista, a fonte está atrasando mais que 1
   dia de forma consistente.

## Como auditar daqui pra frente

```
GET /?action=pmp_pubmatic_audit&days=14     # auth de admin
```

Read-only. Diffa a API contra `pmp_line_delivery_daily` e classifica:

- **`missing_in_bq`** — a API tem entrega no dia e nós não temos a row. É a
  assinatura exata deste bug. Conserta rodando o sync (MERGE idempotente).
- **`value_mismatch`** — os dois têm a row, com números diferentes. Restate da
  fonte que não reprocessamos. Também conserta rodando o sync.
- **`extra_in_bq`** — nós temos a row e a API não reporta mais nada no dia.
  Restate pra zero; o MERGE não apaga. **Precisa de decisão humana** — apagar
  entrega é irreversível.

`freshness` na resposta traz `api_last_day` / `lag_days` / `trailing_zero_days`.

## O que NÃO foi mexido (e por quê)

- **O descarte de dia zerado continua.** Ele está certo: dia zerado gravado
  viraria `last_delivery_day`. O erro era descartar em silêncio.
- **O cron das 04h continua.** O re-sync das 10/14/18/22h **não** o substitui:
  aquele é o full sync (IOs, line items, Xandr, espelho de checklists). O novo
  só repuxa a PubMatic — 1 request de report + MERGE + refresh da enriched.
- **O Xandr não mudou de comportamento.** A régua de atraso de dado só dispara
  com `api_last_day` preenchido, e o conector do Xandr não reporta frescor.

## Guarda contra o falso alarme voltar

A régua de atraso de dado só vale quando existe deal que **deveria** estar
entregando (`expectsDelivery`), julgado por **flight e workflow — nunca por dado
de entrega**. Isso é deliberado: `delivery_status` e `effectiveStatus` derivam do
`last_delivery_day`, então usá-los faria o alarme **se auto-desarmar quando o
atraso cresce** (base 10 dias velha rebaixa a line pra `stopped`, que sairia da
conta e apagaria o alerta justo no caso mais grave).

## Cobertura

`backend/tests/test_pubmatic_curate.py` (38 testes, sem I/O): corte D-1 em BRT,
contabilidade de dias zerados (incluindo zerado no meio ≠ atraso), chain de
credencial na auth e no report, propagação do frescor pro ledger, e o diff da
auditoria nas três classes.

**Sem cobertura automatizada:** a régua do `PmpFreshnessIndicator` — o repo não
tem runner de teste JS. Validada por build + lint.
