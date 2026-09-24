# Retirar do report a entrega fora do BR (exclusão geo)

Ajuste excepcional criado em 24/09/2026 depois do erro de setup de setembro
(lines sem geo targeting em open exchange). Tira do report do cliente a entrega
DV360 feita fora do Brasil, campanha por campanha, sem mexer na base e sem
congelar o report. Código: `backend/geo_exclusions.py`.

## Como ligar

No menu admin, abra o drawer da campanha → **Entrega fora do Brasil** →
**Retirar do report a entrega fora do BR**. O backend recalcula na hora (até
1 min) e mostra quanto saiu, a conciliação e quanto foi estimado.

Por API (admin JWT):

```
POST ?action=save_geo_exclusion   {"short_token": "O3HI21", "reason": "..."}
POST ?action=delete_geo_exclusion {"short_token": "O3HI21"}
POST ?action=refresh_geo_exclusions
GET  ?action=geo_exclusions
```

`date_from`/`date_to` são opcionais. Sem eles, toda entrega fora do BR da
campanha sai, inclusive a de dias futuros.

## O que sai e o que fica

- Sai: impressões, viewable, cliques, vídeo e custo entregues em país que não
  é BR nem está em **Países liberados** do mesmo drawer. Cada métrica sai pela
  sua própria fração (o CTR fora chega a 5%, então cliques saem mais que
  impressões).
- Fica: país não resolvido pelo DV360, e linhas de DSPs sem país no BQ
  (Yahoo, StackAdapt, Amazon). O status mostra esse volume como "sem país".
- O box **Fora do BR** do admin continua mostrando a entrega real. Ele é o
  monitor da operação.

## Garantias

- **Conciliação:** a fração só é publicada se o Region do DV360 bater com a
  entrega (unified) dentro de 0,5% nas chaves dia × line × criativo. Se não
  bater, o report fica com o último ajuste que bateu, ou sem ajuste.
- **Dia sem Region:** quando o Region não tem o dia (12/09/2026 faltou, ver
  `dv360-regions-gap-backfill.md`), a fração é estimada pela line no período e
  aparece como "estimado" no status. Quando o dia for reprocessado, o próximo
  recálculo troca a estimativa pelo número exato sozinho.
- **Recálculo automático:** o cron de warmup (a cada 3h, 06h30–18h30)
  recalcula quando o Region, a unified, o campaign_results, a config ou os
  países liberados mudam.
- **Auto-freeze:** campanha com ajuste ativo não é congelada automaticamente
  (travaria a estimativa). Congele manualmente depois que o dia faltante for
  reprocessado. Report já congelado não mostra o ajuste: descongele antes.

## Onde vale

Report do cliente (totais, pacing, gráfico diário, detalhamento), portal,
Google Sheets (lê o report), card da lista admin, Top Performers, drawer de
linhas e sparkline de clientes.

## Tabelas (prod_assets, criadas sob demanda)

| Tabela | Conteúdo |
|---|---|
| `campaign_geo_exclusions` | config: token, janela opcional, motivo, quem ligou |
| `campaign_geo_adjustments` | frações por token × dia × line × criativo |
| `campaign_geo_exclusion_status` | status do último recálculo por token |

## Desligar tudo em emergência

Desligue o toggle das campanhas (ou `delete_geo_exclusion`). Sem nenhuma
config, a tabela de frações é esvaziada no recálculo e o report volta a ler as
tabelas cruas, sem JOIN.
