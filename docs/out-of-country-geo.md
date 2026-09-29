# Geo unificado (DV360 + Yahoo) e o box "Fora do BR"

**Criado:** 29/09/2026. **Repos:** `hyprster` (ingestão + dbt) e este (box).

## O que mudou

Até aqui o box "Fora do BR" só lia o Region do DV360. Agora a Yahoo também
entra, pela mesma base:

| Camada | Onde | O que é |
|---|---|---|
| Ingestão | `hyprster/models/yahoo_dsp_daily_geo_performance_metrics.py` | extreport da Yahoo com país (dim 19) e região (dim 20), 05h10, janela de 7 dias. Lê o CSV pelo cabeçalho |
| Staging | `staging.yahoo_dsp_daily_geo_performance_metrics` | o que a Yahoo devolveu, país como nome |
| Referência | seeds `geo_countries` e `geo_country_aliases` | ISO-2/ISO-3/nome EN/PT e o de-para de nome/código de DSP → ISO-2 |
| Tratado | `prod_assets.yahoo_daily_geo_performance_metrics` | dedup + país em ISO-2 |
| Unificado | `prod_assets.unified_daily_geo_performance_metrics` | dia × source × IO × line × criativo × país × região, com `short_token`, particionado por data |
| Box | `backend/out_of_country.py` | lê a unificada; se ela não existir, cai no Region cru do DV360 |

A unificada é a base de geo pra qualquer análise nova (share por UF, entrega
de campanha regional, geo de uma DSP nova). DSP que passar a reportar país
entra como mais um bloco no union do modelo dbt, e o box pega sem mudar código
aqui. A `unified_daily_regions_performance_metrics` antiga (sem país, sem
Yahoo) fica como está; ninguém a consome.

## Cobertura por DSP

O payload traz `sources[]` com, por DSP, a taxa fora e a **cobertura**:
impressões com país ÷ impressões entregues (unified de performance), do dia 1
até o último dia com geo. Abaixo de 80% (com 100 mil+ imps no mês) vira aviso
"checar dado" no box, pra uma ingestão parada não sumir calada da taxa.

`geo_backend` no payload diz qual base foi lida (`unified` ou `dv360`).

## Agregado × por DSP

O hover abre sempre no **Agregado** (todas as DSPs somadas) e tem um toggle
com uma aba por DSP. A aba de DSP é o payload inteiro recalculado só com ela
(`by_source`): taxa, gráfico diário, países, alerta e ranking dela.

O agregado para no último dia que TODAS as DSPs ativas têm. Sem esse corte,
com a Yahoo chegando um dia depois do DV360, o último ponto seria só DV360 e
a taxa combinada "saltaria" sem salto real (e dispararia o alerta). Por isso
o DV360 pode mostrar um dia a mais na aba dele do que no agregado; o
cabeçalho diz quem está segurando a data (`lagging_sources`). DSP atrasada
mais de 2 dias sai do corte, pra uma ingestão parada não congelar o box, e
vira aviso (`source_stale`).

## Checklist de ativação

1. Merge da branch no `hyprster` e deploy do Dagster+.
2. Rodar o backfill do asset `yahoo_dsp_daily_geo_performance_metrics` desde
   o começo do mês (partições diárias; cada uma já cobre 7 dias).
3. No log do 1º run, conferir o cabeçalho impresso. Se alguma métrica não
   casar com `COLUMN_CANDIDATES`, ela entra zerada com warning: ajustar a
   lista. País e impressões faltando derrubam a partição (de propósito).
4. Rodar `dbt build --select +unified_daily_geo_performance_metrics` (ou
   esperar o build das 06h). O teste de warn do modelo Yahoo lista nome de
   país que o seed não conhece: acrescentar em `geo_country_aliases.csv`.
5. Conferir no BQ:

   ```sql
   SELECT source, SUM(impressions) imps, COUNTIF(country_code IS NULL) sem_pais
   FROM `site-hypr.prod_assets.unified_daily_geo_performance_metrics`
   WHERE date >= DATE_TRUNC(CURRENT_DATE(), MONTH)
   GROUP BY 1;
   ```

6. O box troca sozinho em até 10 min depois que a tabela existir (cache
   negativo de `resolve_geo_backend`), ou no próximo cold start.

## Exclusão geo do report (retirar a entrega fora do BR)

Também passou a valer pra Yahoo (`backend/geo_exclusions.py`, ver
`geo-exclusions.md`). A conciliação geo × entrega é por DSP: se o geo da Yahoo
não fechar com a entrega, só a Yahoo fica sem ajuste novo (status
**parcial**) e o DV360 segue aplicado.

StackAdapt e Amazon continuam sem país no BQ e ficam de fora das duas coisas.
