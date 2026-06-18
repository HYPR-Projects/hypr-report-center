# Defeito upstream: `checklist_info` mantém volumetria de frente removida no Command

**Status:** aberto — fix da fonte (hyprster/Command). Mitigado no Report Hub via override de core products (ver abaixo).
**Severidade:** alta — números errados em report client-facing de campanha encerrada.
**Descoberto:** 2026-06-18, caso BRF / Sadia – NBA House (token `W0MICH`).

## Sintoma

Campanha tinha 2 core products (O2O + OOH). Ao encerrar, o CS removeu OOH no Command
(checklist passou a listar só O2O). Mesmo assim a frente OOH continuou aparecendo no
report (tab Video/Display OOH, com "valores negociados"), e "voltava" depois de qualquer
ajuste de front.

## Causa-raiz

`site-hypr.prod_assets.checklist_info` do token **ainda tinha** a volumetria OOH:

```
short_token = W0MICH
contracted_ooh_display_impressions = 1.302.079
contracted_ooh_video_completions   =    52.083
```

O Report Hub deriva a presença de uma frente do contrato (`contracted_<frente>_* > 0`)
e lê isso **ao vivo** de `checklist_info` — inclusive em report congelado
(`_overlay_live_contracts`). Logo, enquanto a coluna não for zerada, a frente reaparece.

A materialização `Command → checklist_info` (pipeline hyprster) é **aditiva**: quando uma
frente é removida da campanha, as colunas `contracted_<frente>_*` / `bonus_<frente>_*`
**não são zeradas/NULLed** — ficam com o valor antigo. O Command remove a frente da lista
de produtos, mas a volumetria por-frente persiste na fonte e é materializada fielmente.

Por isso:
- Ajuste só no front é sobrescrito no próximo read ao vivo.
- `UPDATE` manual em `checklist_info` é sobrescrito pela pipeline no próximo run.

## Fix da fonte (este ticket)

Na materialização de `checklist_info` (hyprster / dbt), garantir que, para cada token,
as colunas de uma frente **não mais contratada** sejam emitidas como `0`/`NULL`:

- `contracted_{o2o,ooh,groundflow}_{display_impressions,video_completions}`
- `bonus_{o2o,ooh,groundflow}_{display_impressions,video_completions}`

Ou seja: o registro materializado deve refletir o **estado atual** dos produtos do Command,
não a união histórica. Idealmente, o Command zera a volumetria por-frente ao deselecionar
o produto, e a pipeline reflete.

Investigar também se o Command guarda a volumetria por-frente em campo próprio que não é
limpo no de-select (origem provável do valor stale).

## Mitigação no Report Hub (já implementada)

Override de core products ativos por token (`prod_assets.report_core_products_override`),
curado pelo admin no drawer da campanha. Quando presente, `_fetch_contracts` zera o
contratado/bônus das frentes fora do set — o Report Hub passa a ser autoritativo para
campanha encerrada, imune ao drift da pipeline. Não substitui o fix da fonte (campanhas
sem override continuam dependendo do `checklist_info` correto).
