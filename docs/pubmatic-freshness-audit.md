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
