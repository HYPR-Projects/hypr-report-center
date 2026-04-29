# Procedimento de Rollback de Emergência

Este documento descreve como reverter o **HYPR Report Center** ao estado de produção pré-V2 caso a refatoração visual (Fases 0–7) cause um incidente em `report.hypr.mobi`.

> **TL;DR:** o ponto de restauração é a tag `v1.0-legacy-baseline`. Todo o código do V2 vive em `src/v2/` e `src/ui/`, em paralelo ao Legacy, então um rollback é **sempre seguro** — nada do código original foi movido ou renomeado.

---

## Quando acionar este procedimento

Use este rollback se qualquer uma destas condições for verdadeira:

- Cliente final reporta tela branca, crash ou dados incorretos no dashboard
- Sentry dispara alerta com taxa de erro > 1% após deploy do V2
- Métricas de negócio (taxa de leitura de report, tempo médio na página) caem >20% após virada
- Time interno detecta regressão visual ou de comportamento que não pode esperar fix forward

Para incidentes menores (um cliente específico, uma aba específica), prefira o **Rollback Parcial via Toggle** (seção 3) antes de reverter o repo inteiro.

---

## 1. Rollback completo do código (último recurso)

Use quando o V2 já foi promovido a default (Fase 7) e o problema é generalizado.

### 1.1. Reverter a `main` para o baseline

```bash
git fetch --all --tags
git checkout main
git pull --ff-only

# Confirma que a tag aponta para o commit esperado
git rev-parse v1.0-legacy-baseline

# Hard reset da main para o baseline
git reset --hard v1.0-legacy-baseline

# Push forçado (use --force-with-lease para evitar sobrescrever pushes alheios)
git push --force-with-lease origin main
```

> ⚠️ **Antes do `git push --force-with-lease`:** avise no canal interno do time. Push forçado em `main` invalida branches abertas que partiram de commits posteriores ao baseline.

### 1.2. Disparar redeploy no Vercel

Após o push, o Vercel detecta o novo HEAD da `main` e redepoia automaticamente. O deploy do baseline costuma levar 1–2 minutos.

**Se o auto-deploy não disparar:**

1. Acesse `vercel.com/hypr/hypr-report-hub` (Dashboard do projeto)
2. Vá em **Deployments**
3. Localize o último deploy bem-sucedido com commit `93bccc4` (ou anterior à introdução do V2)
4. Clique nos `…` ao lado dele → **Promote to Production**

Isso restaura produção sem esperar build novo.

### 1.3. Validar produção

- Abrir `https://report.hypr.mobi/report/<token-de-teste>` em janela anônima
- Conferir login admin (`/`) com conta Google
- Conferir que as 7 abas do dashboard carregam (Visão Geral, Display, Video, RMND, PDOOH, Video Loom, Survey)
- Abrir DevTools → Console: nenhum erro vermelho
- Abrir Sentry: taxa de erro voltando ao baseline em até 5 min

---

## 2. Rollback de uma feature específica (recomendado)

Se o problema está numa feature específica do V2 (ex.: nova tabela de Entrega Agregada quebrou):

```bash
# Localiza o commit que introduziu a feature
git log --oneline --grep="<termo da feature>"

# Reverte apenas aquele commit (gera commit novo de revert)
git revert <hash-do-commit>
git push origin main
```

Vantagem: histórico preservado, diff auditável, não invalida outras branches.

---

## 3. Rollback parcial via toggle (sem deploy)

**Status:** ✅ Ativo desde a PR-03 da Fase 0.

O app respeita um toggle de versão. Se o V2 estiver causando problema mas o Legacy continuar saudável, o cliente pode forçar Legacy **sem precisar de redeploy**:

### 3.1. Para um cliente específico

Envie ao cliente o link com query param de fallback:

```
https://report.hypr.mobi/report/<token>?v=legacy
```

A escolha persiste em `localStorage` (chave `hypr_report_version`) e sobrevive a recarregamentos. Funciona mesmo enquanto o default global ainda for Legacy — neste caso, o param vira no-op (cliente já estava no Legacy).

### 3.2. Para todos os clientes (kill switch)

Quando o V2 já é default (pós-Fase 7) e queremos forçar Legacy globalmente sem reverter código:

1. Editar `src/shared/version.js`
2. Mudar a linha de fallback final do `resolveReportVersion()` de `"v2"` para `"legacy"`
3. Commit + push + redeploy

Tempo total: ~3 minutos. Não invalida tag `v1.0-legacy-baseline` nem requer revert histórico.

> Esta opção só existe enquanto o código Legacy ainda estiver no repo. Em algum momento pós-estabilização do V2, o Legacy será removido — neste momento, este kill switch deixa de funcionar e o procedimento da Seção 1 passa a ser o único recurso.

---

## 4. Rollback do backend (Cloud Run)

O backend (`backend/main.py`) tem ciclo de deploy independente do frontend. Se o incidente for backend:

```bash
# Lista revisões ativas
gcloud run revisions list --service hypr-report-backend --region us-central1

# Promove revisão anterior ao 100% do tráfego
gcloud run services update-traffic hypr-report-backend \
  --region us-central1 \
  --to-revisions <REVISION_ID>=100
```

`<REVISION_ID>` é o nome da revisão imediatamente anterior à problemática. Confirma roteamento via `gcloud run revisions describe`.

---

## 5. Pós-rollback: checklist obrigatório

Após qualquer rollback, executar **todos** os passos abaixo antes de fechar o incidente:

- [ ] Produção em `report.hypr.mobi` funcional (login admin + dashboard cliente)
- [ ] Sentry sem novos erros nos últimos 15 min
- [ ] Postar resumo no canal interno: o que quebrou, qual rollback foi usado, lições aprendidas
- [ ] Abrir issue no GitHub com label `incident` documentando o ocorrido
- [ ] Criar branch `hotfix/<descrição>` para corrigir o problema antes de tentar reintroduzir o V2
- [ ] **Não** retomar deploys do V2 até causa raiz identificada e fix validado

---

## 6. Contatos

| Quem | Quando |
|------|--------|
| Owner do produto | Sempre (notificação) |
| Time de eng | Se o rollback falhar ou o incidente persistir após rollback |
| Vercel support | Se o redeploy automático estiver travado |

---

**Última atualização:** PR-01 da Fase 0 (criação inicial do documento).
**Próxima revisão prevista:** após a Fase 7, quando o Legacy for removido.
