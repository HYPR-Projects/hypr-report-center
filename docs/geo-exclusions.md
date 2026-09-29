# Retirar do report a entrega fora do BR (exclusão geo)

Ajuste excepcional criado em 24/09/2026 depois do erro de setup de setembro
(lines sem geo targeting em open exchange). Tira do report do cliente a entrega
feita fora do Brasil, campanha por campanha, sem mexer na base e sem
congelar o report. Vale pra DV360 e, desde 29/09/2026, pra Yahoo (as DSPs com
país no BQ, pela `unified_daily_geo_performance_metrics`; ver
`out-of-country-geo.md`). Código: `backend/geo_exclusions.py`.

## Como ligar

No menu admin, abra o drawer da campanha → **Entrega fora do Brasil** →
**Retirar do report a entrega fora do BR**. Ligar recalcula só aquela
campanha (segundos, com contador na tela); desligar apaga as frações na hora.
O drawer mostra quanto saiu (display e vídeo), o custo DSP fora do BR, a
conciliação e quanto foi estimado. A lista do admin recarrega junto; o report
do cliente em outras abas atualiza em até 1 min.

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

- Sai: impressões, viewable, cliques, vídeo e o valor entregue ao cliente
  (entrega × CPM/CPCV negociado) em país que não é BR nem está em **Países
  liberados** do mesmo drawer. Cada métrica sai pela sua própria fração (o CTR
  fora chega a 5%, então cliques saem mais que impressões).
- **Custo DSP não sai.** O Gasto do admin, o Tech ADM e o Tech Cost continuam
  com o custo cheio, porque o dinheiro foi gasto. Embaixo do Gasto, o card
  mostra **Fora do BR (oculto)**: a parte desse custo que foi entregue fora e
  não aparece como entrega pro cliente. O drawer mostra o mesmo valor.
- Fica: país não resolvido pela DSP, e linhas de DSPs sem país no BQ
  (StackAdapt, Amazon). O status mostra esse volume como "sem país".
- O box **Fora do BR** do admin continua mostrando a entrega real. Ele é o
  monitor da operação e, desde 29/09/2026, já enxerga a Yahoo também (lê a
  `unified_daily_geo_performance_metrics`, ver `out-of-country-geo.md`).

## Garantias

- **Conciliação por DSP:** a fração de cada DSP só é publicada se o geo dela
  bater com a entrega (unified) dentro de 0,5% nas chaves dia × line ×
  criativo. Se não bater, aquela DSP fica com o último ajuste que bateu, ou
  sem ajuste, e as outras seguem. Com uma DSP aplicada e outra não, o status
  é **parcial** e o drawer diz qual ficou de fora e a diferença de cada uma.
- **Enquanto a base unificada não existe** (deploy do hyprster pendente), a
  cópia compacta sai do Region cru e o ajuste segue só DV360, como antes.
  Quando ela aparece, o próximo warmup refaz a cópia pela unificada (a cópia
  montada dela tem a coluna `from_unified_geo`) e recalcula tudo.
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
| `dv360_region_country_compact` | cópia do geo por dia × DSP × line × criativo × país, particionada por data. Sai da `unified_daily_geo_performance_metrics` (DV360 + Yahoo) quando ela existe, senão do Region cru (que não é particionado; cada leitura varria ~19 GB). Refeita no warmup quando a fonte muda; é o que deixa o toggle rápido. O nome ficou por compatibilidade |

## Desligar tudo em emergência

Desligue o toggle das campanhas (ou `delete_geo_exclusion`). Sem nenhuma
config, a tabela de frações é esvaziada no recálculo e o report volta a ler as
tabelas cruas, sem JOIN.
