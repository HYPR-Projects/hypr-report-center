# Amazon DSP parada desde 13/09 — e o painel amarelo por 5 dias

**Reportado em:** 18/09/2026, 09h08, pelo indicador "Estado das bases".
**Estado no print:** Amazon `13/09` (vermelho) · DV360, StackAdapt, Yahoo `17/09`
(verde) · Consolidado (reports) `17/09` (verde) · cabeçalho **amarelo**,
"Amazon não entregou D-1".

Dois problemas independentes, e só um deles é nosso.

## 0. Resposta (18/09, medido no BigQuery)

**O connector parou de rodar.** `staging.amazon_daily_performance_metrics` tem
última ingestão em **14/09 às 05:10** e nada depois. Não é "roda e vem vazio":
não roda há dias. A cadência normal é diária, ~05h.

**Mas essa tabela não é a que entrega número no report.** Ela é Amazon Ads /
RMN: colunas `purchases_*`, `sales_*`, `units_sold_*`, e campanhas
`ID-ACYUTU_..._RMN_AMZ` (Pepsico Tostitos), `ID-9MXTRZ_..._RMND_AMAZON`
(Kimberly Clark), `HYPR_Loreal`, `HYPR_Diageo`. As impressões que o report
mostra como "Amazon" vêm de outra linha, `ID-FXR5US_HYPR_LOREAL_..._DISPLAY_
O2O_AR-LIVRE_LI-PREMIUM-LIST`, que **não existe nessa staging**.

**E o RMN já não entregava desde 31/08.** As quatro campanhas têm última
impressão em 31/08 (a da Diageo nunca teve nenhuma), todas ainda `ENABLED`. De
01/09 a 13/09 o connector escreveu linha todo dia com tudo zerado. Fazia 13 dias
que não trazia número quando finalmente parou.

Consequência prática: o ponto vermelho é verdadeiro sobre um connector
quebrado, e enganoso sobre o que o operador conclui dele. "Amazon não entregou
D-1" lê como "o report está sem entrega de DSP", e não é isso.

## 1. A fonte (upstream — NÃO corrigido aqui)

Último dado da Amazon: **13/09, um domingo**. O export pousa D-1 entre 05:02 e
05:20 (ver `dagster-freshness-fix.md`), então o último run bom foi na **segunda
14/09**, pousando o domingo; o primeiro a falhar foi **terça 15/09**. São 4 runs
seguidos sem entregar, e faltam os dias 14, 15, 16 e 17/09.

Descartado como causa: **nada neste repo** mudou na janela. Os commits de 10/09
(admin shell, PMP PubMatic) e 15/09 (Merge Reports) não tocam ingestão — e
ingestão de DSP não vive aqui de qualquer forma. `_SOURCE_RAW_TABLES` e
`_SOURCE_LANDING_TABLES` (`backend/main.py`) estão intactos desde antes.

### O que checar, nessa ordem

O report só **lê** a Amazon. Quem escreve é o export/connector da DSP; quem
orquestra é o Dagster+ (`hypr.dagster.cloud/prod`, location `hyprster`, job
`dbt_assets_freshness_06am_job`). Precisa de acesso a Dagster+ e BigQuery:

1. **Dagster+**, runs do job de 15 a 18/09. O `all_sources_ready_sensor` skipou
   (esperado, com a Amazon pendente) ou **disparou assim mesmo**? Ver hipótese
   abaixo.
2. **BigQuery**: `SELECT MAX(date) FROM site-hypr.staging.amazon_daily_performance_metrics`.
   Travado em 13/09 → o problema é antes do dbt, no export da DSP. Avançou e só
   a tratada (`prod_assets.amazon_daily_performance_metrics`) travou → o problema
   é o modelo dbt, e o diagnóstico muda inteiro.
3. **Amazon DSP**, só se o passo 2 confirmar staging travada: histórico do
   scheduled report que alimenta a staging. Por ordem de probabilidade:
   credencial/token expirado, report agendado desativado ou renomeado, mudança
   de schema nas colunas do export, entrega parada do lado deles.

### Hipótese: o gate das 06h não está mais segurando a Amazon

O `all_sources_ready_sensor` existe justamente pra **não** deixar o build rodar
sem as fontes (`dagster-freshness-fix.md`, Fix 1). Se ele estivesse segurando, o
`unified` teria congelado em 13/09 junto com a Amazon. Congelou? Não: está em
17/09. Logo o build rodou 4 vezes **sem a Amazon**, e o job é full-rebuild.

Possibilidades, em ordem de probabilidade:
- a Amazon saiu do `FRESHNESS_06AM_SOURCES` (`hyprster/models/dbt_assets.py`) e
  o gate deixou de cobri-la;
- o schedule fixo das 06h nunca foi removido e dispara por cima do sensor toda
  vez que ele skipa, o que anula o sensor inteiro;
- os retries do Fix 2 acabam lançando a run mesmo com a fonte pendente.

> Se `FRESHNESS_06AM_SOURCES` mudar lá, `_SOURCE_RAW_TABLES` em
> `backend/main.py` tem que mudar junto: o painel precisa medir exatamente o que
> o gate mede. Hoje os dois divergem, e essa divergência é a hipótese acima.

### Impacto: NENHUM nos reports (corrigido em 18/09, com o BQ na mão)

A primeira versão deste doc afirmava que a `unified` não tinha uma linha de
Amazon entre 14 e 17/09 e que reports de cliente saíram subnotificados por 4
dias. **As duas coisas estão erradas.** A consulta direta mostra:

- a `unified` TEM linhas de Amazon em 14–17/09, zeradas (a série é preenchida
  por dia, não só quando há entrega). Por isso, aliás, a detecção de
  "consolidado parcial" do #248 não acende pra Amazon: a fonte está lá dentro;
- a única campanha Amazon entregando no período era `FXR5US` (L'Oréal ·
  La Roche-Posay Aircilium), **com fim contratado em 31/08**, entregando 13 dias
  além do contratado. As outras três acabaram em 31/08 e pararam ali.

Ou seja: ninguém recebeu número parcial. A lição fica: afirmar impacto em
cliente a partir de `MAX(date)` de painel, sem abrir a base, produz alarme
falso — que é o mesmo defeito que este doc estava documentando.

## 2. O alerta que não alarmou (corrigido aqui)

Três defeitos na régua do `DataFreshnessIndicator`, todos no mesmo lugar:

| # | Defeito | Efeito | Conserto |
|---|---|---|---|
| 1 | Severidade contada em **fontes**, não em dias (`blockers.length >= 2 ? error : warn`) | 1 DSP parada há 5 dias = amarelo pra sempre; 2 DSPs atrasadas 1 dia = vermelho | `toneForDays`: >= 3 dias é vermelho, a contagem só escala |
| 2 | Cabeçalho e linha com réguas **diferentes** | linha da Amazon vermelha embaixo de cabeçalho amarelo, no mesmo popover | régua única, compartilhada |
| 3 | "Consolidado" medido só pelo **MAX global** | `17/09` verde com a Amazon faltando dentro | `unified_by_source`: fresco e incompleto vira "parcial — sem Amazon" |

O #3 é o pior dos três: o painel não estava omisso, estava **afirmando o
contrário** do que acontecia. E o dado já existia — `query_data_freshness()`
sempre foi um `GROUP BY source`, e o endpoint colapsava tudo num `max()` antes
de responder.

Some-se um quarto, menor: antes das 07h o painel engolia qualquer alerta
("aguardando rollup 06h"), inclusive fonte parada há 5 dias. Nenhum rollup das
06h explica 3 dias; o cutoff agora só cobre atraso de 1–2 dias.

É o mesmo padrão de `pubmatic-freshness-audit.md`: *um alerta que explica por
que está atrasado em vez de alarmar é um alerta desligado.* Lá o painel
normalizava D-2 com uma nota; aqui normalizava uma DSP inteira ausente com um
dot amarelo.

### Ainda em aberto

Fonte **sem campanha no ar** e connector **quebrado** continuam indistinguíveis:
nos dois casos o `MAX(date)` simplesmente não avança. É a falha #3 da auditoria
da PubMatic, agora na Amazon. Enquanto não houver contabilidade de dia zerado
por fonte, o desempate é manual: **Saúde das DSPs → Amazon → paradas**. Se
listar campanha com checklist ativo que zerou, é connector; se a Amazon não tem
nada no ar, o alerta é falso positivo.

## Régua nova

`src/v2/admin/lib/dspFreshness.js` (pura, 23 testes em `dspFreshness.test.js`,
com o estado de 18/09 congelado como regressão). Saiu do componente pelo mesmo
motivo que a do PMP saiu em 07/09: três estados decididos dentro de um `.jsx`,
sem cobertura, e um deles errado havia meses.
