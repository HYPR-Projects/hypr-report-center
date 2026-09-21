# Auditoria: Xandr Curate parada há 3 dias no PMP Deals

**Repo:** `hypr-report-center` (backend Cloud Function + `/admin/pmp`).
**Reportado em:** 21/09/2026 — o painel "Sync das fontes" mostrava a Xandr em
vermelho com *"Sync falhando há 3 dias"*, última execução 21/09 04:00, último
sync OK 18/09 04:00, última entrega 17/09. No popover, o erro cru:

```
HTTP 401 POST /auth: Your password has expired and must be reset
```

## Causa raiz

A senha do usuário de API da Xandr expirou. A Xandr força reset a cada 90 dias
em usuário de API e o `/auth` passa a devolver 401 — **não é bug nosso e não
passa sozinho**: o cron das 04h vai continuar batendo e falhando até alguém
trocar `XANDR_CURATE_PASS` no Secret Manager e redeployar.

**Isso o código não conserta.** O que a auditoria encontrou foi o resto: por que
3 dias, e o que quebrou junto sem precisar.

## O que a auditoria encontrou

### 1. O painel dizia a verdade sem dizer o que fazer

*"Sync falhando há 3 dias"* é a mesma frase para um timeout, um 5xx da API e uma
senha expirada — três coisas com consertos diferentes (as duas primeiras passam
no próximo run; a terceira nunca passa). O erro cru estava no popover, mas ler
`HTTP 401 POST /auth` e saber que a ação é *resetar senha no console da Xandr →
Secret Manager → redeploy* exige conhecer este arquivo.

Pior: a régua de erro transitório (amarelo quando a execução anterior rodou OK
há menos de 3h) teria **amarelado uma senha expirada** se a falha tivesse
começado durante uma sondagem — o estado em que a ação é mais urgente era o que
tinha mais chance de ser suavizado.

### 2. A Xandr nunca reportou frescor ao ledger

O `pmp_sync_runs` ganhou `api_last_day` / `lag_days` / `trailing_zero_days` em
24/08/2026 justamente porque *"o job rodou"* nunca foi *"a base está fresca"*.
Só a PubMatic passou a preencher. A Xandr gravava NULL nos três, e o painel —
que sabe disso — se limitava a `"Sync rodou hoje"`.

Consequência: **uma Xandr rodando verde com a API travada em D-5 tem exatamente
a mesma cara de uma Xandr em dia.** O alarme de 18/09 só tocou porque a falha
foi barulhenta (401 no ledger). Uma falha silenciosa do lado da fonte teria
repetido o caso da PubMatic de agosto.

### 3. A falha da Xandr derrubava o que não dependia dela

No `pmp_sync_v2` a exceção da Xandr era `raise`. Subia e levava junto, no mesmo
run:

| o que parava | depende da Xandr? |
|---|---|
| `sync_checklists_mirror()` (espelho de checklists do Command) | não |
| `refresh_enriched_table()` | não |
| `compplan_sheet.sync_if_connected()` | não |
| o sync da PubMatic dentro do run das 04h | não |

A PubMatic estava coberta pelo `pmp-pubmatic-refresh` de hora em hora (que
também refaz a enriched), então o dano real foi o **espelho de checklists, que
só roda aqui** — 3 dias sem atualizar, com a auto-vinculação Command ↔ line
cega nesse período.

### 4. Janela de 7 dias era a margem de recuperação

O MERGE é idempotente, então a janela do report **é** a capacidade de
auto-conserto: o primeiro run bom reprocessa tudo que couber nela. A PubMatic
tinha aprendido isso em agosto e usa 21 dias; a Xandr seguia em `last_7_days`.
Com 3 dias de queda sobrou margem — com 8 não sobraria, e só um backfill manual
traria a entrega de volta.

Pior, a janela estava fixada em **dois lugares**: no `--message-body` do Cloud
Scheduler e no `syncPmpV2` do frontend. Alargar no código não mudaria nada — o
cron continuaria mandando os 7 dias antigos por cima.

### 5. Corte D-1 em UTC (mesmo bug que a PubMatic já tinha corrigido)

`parse_csv_line_level` usava `date.today()`, que na Cloud Function é UTC. Entre
21h e 24h BRT o UTC já é amanhã, então o **dia corrente brasileiro** passava
pelo filtro e entrava na base como dia fechado, com número parcial. Inofensivo
enquanto o único run era às 04h; o botão "Sincronizar agora" cai na janela.

### 6. Rotacionar a senha e redeployar **não** trocava a senha

Achado depois, verificando o procedimento que a própria mensagem de erro manda
seguir. O `deploy.sh` captura os secrets da revisão ativa (`extract_env`) e o
`read_secret_if_missing` só consulta o Secret Manager **quando a revisão não
tem o valor**. Para senha isso é exatamente o contrário do que se quer:

1. você atualiza `XANDR_CURATE_PASS` no Secret Manager;
2. redeploya;
3. o `extract_env` acha a senha **velha** na revisão viva e ela ganha;
4. a função sobe com a senha velha. Deploy verde, smoke check de `healthz`
   verde, sync tomando 401 de novo.

Silencioso e circular: o conserto recomendado no erro não conserta. Vale igual
para o par da PubMatic, que tem a mesma forma. Agora as credenciais que
rotacionam usam `read_secret_first` — Secret Manager ganha quando tem valor, a
revisão ativa é o fallback — e o deploy imprime quando os dois divergem.

**Efeito colateral a conhecer:** se alguém tiver trocado uma credencial direto
na revisão sem atualizar o Secret Manager, o próximo deploy vai puxar o valor
do Secret Manager por cima. A linha `↻ VAR: usando o Secret Manager (difere da
revisão ativa)` aparece no log quando isso acontece.

### 7. `bigquery.Client()` cru no import

`xandr_curate` era o último módulo do backend fora do singleton do
`bq_client.py`. Duas consequências: as queries daqui (o MERGE da entrega, entre
elas) rodavam **sem `job_timeout_ms`** — o pendurado que o `bq_client` nasceu
pra matar; e importar o módulo exigia credencial default, o que mantinha o
parsing e o corte D-1 fora de teste.

## O que mudou

| # | Mudança | Onde |
|---|---|---|
| 1 | `XandrAuthError` para 401/403 no `/auth` e corpos que citam credencial, com o procedimento colado na mensagem (cabe nos 240 chars do popover) | `xandr_curate.py` |
| 1 | Régua do painel classifica erro de credencial antes da régua de transitório: vermelho desde a primeira falha, com *"Credencial recusada pela fonte — resetar a senha e atualizar o secret"* | `pmpFreshness.js` |
| 2 | `measure_freshness()` + gravação de `api_last_day`/`lag_days`/`trailing_zero_days` no ledger | `xandr_curate.py`, `main.py` |
| 2 | Texto do atraso nomeia a fonte (era `"a API da PubMatic"` cravado na frase) | `pmpFreshness.js` |
| 3 | Falha da Xandr vira best-effort: registra no ledger e o resto do run continua. A resposta segue **502** — non-2xx é o gatilho do alert policy do GCP | `main.py` |
| 4 | `XANDR_REPORT_INTERVAL = "last_14_days"`, em um lugar só; scheduler e frontend deixam de fixar a janela | `main.py`, `deploy.sh`, `api.js` |
| 5 | `today_brt()` no corte D-1 | `xandr_curate.py` |
| 6 | `read_secret_first` para as credenciais que rotacionam (Xandr + PubMatic): Secret Manager ganha da revisão ativa | `deploy.sh` |
| 7 | `_bq_client()` preguiçoso via `bq_client.get_client()` | `xandr_curate.py` |
| 8 | Alerta diário por email do ledger PMP (`pmp-sync-alert`, 08h BRT) | `pmp_alerts.py`, `main.py`, `deploy.sh` |
| 9 | Credential chain da Xandr + retry de token recusado, e `credential` no ledger | `xandr_curate.py`, `main.py`, `deploy.sh` |

Cobertura nova: `backend/tests/test_xandr_curate.py` (15 casos) e 4 casos em
`pmpFreshness.test.js`.

## Alerta ativo (item 8)

O ledger acabou com o silêncio no banco; continuava dependendo de alguém abrir
o painel. `pmp-sync-alert` roda às **08h BRT** (depois do cron das 04h, antes de
a operação usar o número) e manda um email enquanto o problema existir.

A régua é a **mesma que o painel usa pra pintar vermelho** — amarelo não vira
email, senão o alerta toca no estado normal da manhã e em duas semanas vira
regra de filtro no Gmail, que é o silêncio voltando pela porta dos fundos:

| estado | email? |
|---|---|
| último run `error` (diz se é credencial) | sim |
| último run `skipped` (sem credencial) | sim |
| nenhuma execução em 26h (cron morto) | sim |
| run ok, fonte ≥2 dias atrás | sim |
| run ok, fonte 1 dia atrás | **não** — é a manhã antes de a fonte fechar D-1 |
| dias que faltam vieram como zero explícito | **não** — a line é que não entregou |
| `lag_days` NULL (fonte não mede) | **não** — "não sei" não vira alarme |

Destinatários em `PMP_ALERT_TO` (separados por vírgula); sem ela cai no
`SHEETS_ALERT_FROM`. Sem dedup, igual ao `sheets_alerts`: uma quebra de uma
semana manda sete emails, que é o comportamento desejado.

## Chain de credenciais e token recusado (item 9)

Mesma forma do `pubmatic_curate.CREDENTIAL_SETS`. Duas coisas diferentes, que
eram as duas fatais:

**Falha na AUTENTICAÇÃO** → tenta o próximo par da chain, loga qual assumiu e
grava o rótulo em `pmp_sync_runs.credential`. O painel já sabia renderizar
*"autenticado pela credencial de fallback — a primária precisa ser reativada no
seat"* desde agosto; pra Xandr esse aviso era código morto, porque ela nunca
reportava credencial nenhuma. Quando todas falham, o erro lista **cada uma** —
com uma credencial só, levanta o erro original sem embrulho, senão o prefixo
come os 240 chars do popover justo na parte acionável.

**Recusa DEPOIS da autenticação** (401/403 numa chamada com token válido) →
`_authed` tenta três passos, do mais provável pro mais grave: token do cache,
token novo da mesma credencial (o caso comum — o token vale 2h e o report é
async, com poll de até 3min), e só então o próximo par da chain. Antes não
havia nenhum: o run inteiro morria e só voltava no cron do dia seguinte.

5xx e timeout **não** entram nesse caminho — sobem na primeira. Re-autenticar
num 503 só queimaria o limite de 10 auths/5min da Xandr, que é o motivo de o
token ser cacheado.

## O que continua em aberto

- **O reset da senha é manual e não tem dono.** Expira a cada 90 dias, então
  isto volta ~dez/2026. O painel agora diz o que fazer; ninguém é avisado sem
  abrir o painel (o rodapé ainda manda "reportar no #data-pipelines").
- **A chain da Xandr está no código, mas falta o usuário pra ligá-la.** O
  conector já percorre `XANDR_CURATE_USER/PASS` → `XANDR_CURATE_USER_ALT/
  PASS_ALT` (item 9) e degrada pra credencial única quando o par ALT não
  existe, que é o estado de hoje. O que falta é humano: a conta tem dois
  usuários associados, mas em **members diferentes** (`14843` Hypr (Gama) e
  `13053` HYPR VENTURES / CURATOR). O sync lê o Curator Analytics do member
  13053, então o usuário do 14843 autentica e depois não enxerga nada daqui —
  seria uma chain que troca um erro por outro. É preciso um **segundo usuário
  de API no member 13053**, pedido pro rep da Xandr. Com ele em mãos: criar os
  dois secrets e redeployar, sem mexer em código.
- **O push do compplan roda com Xandr velha.** Durante a queda, o
  `pmp-pubmatic-refresh` continua empurrando a planilha quando a PubMatic
  avança, levando junto os números congelados da Xandr — sem marca de que são
  velhos. Já era assim antes desta mudança.
- **A Xandr pode passar a amarelar todo dia — e isso é informação, não ruído.**
  Com o frescor ligado, se a API não tiver D-1 às 04h o painel vai dizer
  *"Sync ok, mas a API da Xandr só tem dado até … (1 dia atrás)"* até o run
  seguinte. É verdade: a base **está** um dia atrás. Só que com um cron 1x/dia
  não dá pra medir a hora em que a Xandr fecha o dia (o `d1_close_hours` do
  `?action=pmp_sync_status` é da PubMatic e precisa de várias sondagens). Se o
  amarelo aparecer todo dia, o conserto é o mesmo da PubMatic — sondar mais
  tarde ou de hora em hora — e **não** inventar uma tolerância em
  `SOURCE_CLOSE_HOUR_BRT` sem medida (a régua é explícita: fonte sem medida não
  ganha tolerância).
- **O alert policy do GCP para o `pmp-xandr-daily-sync` nunca foi confirmado.**
  O `pmp_sync_v2` devolve 502 quando a Xandr falha, mas ninguém verificou se
  existe policy de non-2xx escutando esse job. Com o `pmp-sync-alert` no ar
  isso deixa de ser o único sinal, e vira checagem de rotina em vez de
  dependência.
