# Procedimento de Rollback de Emergência

Como reverter o **HYPR Report Center** (`report.hypr.mobi`) quando um deploy causa incidente.

> **TL;DR:** frontend → **Promote to Production** de um deploy anterior no Vercel (instantâneo, sem build). Backend → rotear o tráfego do serviço `report-data` pra revisão anterior. Depois, `git revert` do commit culpado.

> ⚠️ **O que mudou:** este documento nasceu na Fase 0 da refatoração V2, quando o Legacy ainda coexistia com o V2. O Legacy foi removido. Por isso:
> - o toggle `?v=legacy` / `hypr_report_version` **não existe mais** (não há `src/shared/version.js`);
> - **não** use `git reset --hard v1.0-legacy-baseline`: a tag é de antes do V2 e voltar pra ela apagaria meses de funcionalidades (PMP, Portal do Cliente, Survey, Merge Reports, etc.). Ela só serve como referência histórica.

---

## Quando acionar

- Cliente final reporta tela branca, crash ou dados incorretos no report
- Tela de erro ("Algo quebrou…") aparecendo de forma generalizada após um deploy — no GA, eventos `app_crash` / `v2_crash` subindo
- Time interno detecta regressão que não pode esperar fix forward

Para problema restrito a uma feature, prefira a **seção 2** (revert do commit).

---

## 1. Frontend: voltar pro deploy anterior (mais rápido)

O frontend publica sozinho a cada push na `main` (Vercel). Cada deploy anterior continua disponível pra ser promovido:

1. Vercel → projeto do Report Center → **Deployments**
2. Localize o último deploy de produção saudável (o anterior ao commit problemático)
3. `…` → **Promote to Production**

Não há build: a troca é imediata. Abas que estavam abertas com o deploy quebrado recarregam sozinhas ao tentar abrir uma tela nova (ver `src/shared/chunkReload.js`); quem estiver com a tela de erro na frente precisa clicar em "Recarregar".

### Validar

- Abrir `https://report.hypr.mobi/report/<token-de-teste>` em janela anônima
- Conferir login admin (`/`) com conta Google
- Conferir as abas do report que a campanha de teste tem (Visão Geral, Display, Video e as demais que aparecerem)
- DevTools → Console: nenhum erro vermelho

Depois de estabilizar, corrija o código (seção 2): o próximo push na `main` publica por cima do deploy promovido.

---

## 2. Revert do commit culpado (recomendado pra corrigir de vez)

```bash
# Localiza o commit que introduziu o problema
git log --oneline --grep="<termo da feature>"

# Reverte apenas aquele commit (gera commit novo de revert)
git revert <hash-do-commit>
git push origin main
```

Histórico preservado, diff auditável, não invalida outras branches. O push dispara o deploy do frontend; se o commit mexeu em `backend/`, o backend precisa de deploy também (seção 3).

---

## 3. Backend (Cloud Function gen2 `report_data`)

O backend (`backend/main.py`) tem deploy **manual** e independente do frontend: `cd backend && bash deploy.sh` ou o workflow **Deploy backend (Cloud Function)** no GitHub Actions (`workflow_dispatch`). Por baixo é o serviço Cloud Run `report-data`, região `southamerica-east1`, projeto `site-hypr`.

Rollback pra revisão anterior:

```bash
# Lista revisões
gcloud run revisions list --service report-data --region southamerica-east1 --project site-hypr

# Manda 100% do tráfego pra revisão anterior
gcloud run services update-traffic report-data \
  --region southamerica-east1 --project site-hypr \
  --to-revisions <REVISION_ID>=100
```

`<REVISION_ID>` é a revisão imediatamente anterior à problemática. Confirme com `gcloud run revisions describe`. Atenção: o próximo `deploy.sh` roteia 100% pra revisão nova (`--to-latest`), então corrija o código antes de redeployar.

---

## 4. Pós-rollback: checklist

- [ ] Produção em `report.hypr.mobi` funcional (login admin + report cliente)
- [ ] GA sem pico de `app_crash` / `v2_crash` nos últimos 15 min
- [ ] Resumo no canal interno: o que quebrou, qual rollback foi usado, lições aprendidas
- [ ] Issue no GitHub com label `incident`
- [ ] Fix numa branch própria antes de reintroduzir a mudança

---

## 5. Contatos

| Quem | Quando |
|------|--------|
| Owner do produto | Sempre (notificação) |
| Time de eng | Se o rollback falhar ou o incidente persistir após rollback |
| Vercel support | Se o Promote to Production estiver travado |

---

**Última atualização:** revisão pós-remoção do Legacy (toggle e reset pro baseline retirados; nomes do backend corrigidos pra `report-data` / `southamerica-east1`).
