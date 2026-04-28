# ADR 001 — Coexistência Legacy + V2 do HYPR Report Hub

- **Status:** aceito
- **Data:** 2026-04-28
- **Decisores:** time HYPR (produto + eng)
- **Contexto:** PR-01 da Fase 0 da refatoração visual

## Contexto

O HYPR Report Hub está em produção em `report.hypr.mobi` há vários meses, atendendo todos os clientes da HYPR (DV360, Xandr Curate, StackAdapt). A interface atual ("Legacy") cumpre o papel funcional, mas:

- A identidade visual não reflete a marca HYPR atual (paleta, tipografia, hierarquia)
- Componentes-chave para o negócio não existem ou são pouco visíveis (ex.: comparação CPM Negociado vs Efetivo, CPCV Negociado vs Efetivo)
- Tabelas operacionais críticas estão ausentes (Entrega Agregada por Dia, por Formato de Criativo)
- Mobile não é primeira classe — o uso em celular é sofrível
- A hierarquia das 7 abas trata todas com peso visual igual, apesar de Visão Geral, Display e Video serem dramaticamente mais usadas que RMND, PDOOH, Loom e Survey

A refatoração precisa ser **profunda** (não maquiagem), o que cria o risco clássico de big-bang rewrite: regressão funcional, deploy travado, cliente reportando "ficou pior do que antes".

## Decisão

**Construir o V2 em paralelo ao Legacy, no mesmo repositório, sem mover ou renomear nada do código atual, com toggle controlando qual versão o cliente vê.**

### Estrutura física

```
src/
├── pages/                  ← Legacy (intacto)
├── components/             ← Legacy (intacto)
├── dashboards/             ← Legacy (intacto)
├── lib/                    ← compartilhado (api.js)
├── shared/                 ← compartilhado
│   ├── theme.js            ← Legacy (intacto)
│   ├── tokens.js           ← NOVO — design tokens do V2
│   ├── version.js          ← NOVO — toggle Legacy/V2
│   └── ...                 ← outros utilitários compartilhados
├── ui/                     ← NOVO — primitives compartilhados (botões, inputs, modais)
└── v2/                     ← NOVO — todo o V2 mora aqui
    ├── components/
    └── dashboards/
```

### Roteamento

`App.jsx` (a partir da PR-03 da Fase 0) chama `useReportVersion()` antes de instanciar o dashboard do cliente:

```jsx
const version = useReportVersion();
return version === "v2"
  ? <ClientDashboardV2 ... />
  : <ClientDashboard ... />;   // Legacy
```

Telas administrativas (`LoginScreen`, `ClientPasswordScreen`, `CampaignMenu`) **não** são refatoradas no V1 do V2 — o toggle só afeta o `ClientDashboard`.

### Toggle

`src/shared/version.js` resolve a versão na seguinte ordem:

1. Query param `?v=v2` ou `?v=legacy` (também persiste em localStorage)
2. localStorage `hypr_report_version`
3. Fallback hardcoded — `"legacy"` até a Fase 7, `"v2"` depois

### Defesa contra crashes do V2

`ErrorBoundary` global envolve `<ClientDashboardV2>`. Se um componente do V2 lançar exceção em runtime, o boundary captura, reporta no Sentry, e renderiza o `<ClientDashboard>` Legacy automaticamente. O cliente final vê uma versão funcional, não uma tela branca.

### Default Legacy até Fase 7

Durante toda a refatoração (Fases 1–6), o **default permanece Legacy**. V2 só é visto por quem entrar com `?v=v2` na URL ou pelo time interno em ambiente de preview.

A virada para V2 default acontece apenas na Fase 7, simultânea para todos os clientes (sem rollout gradual). O risco é controlado por:

- Toggle reverso (`?v=legacy`) ainda funciona após a virada — opt-out permanece
- Tag `v1.0-legacy-baseline` permite revert completo do repo a qualquer momento
- ErrorBoundary global garante que crash não vira tela branca

## Alternativas consideradas

### A. Big-bang rewrite no mesmo lugar

Refatorar `src/pages/ClientDashboard.jsx`, `src/components/dashboard-tabs/*`, etc. diretamente, num branch longo, e mergear quando estiver pronto.

**Rejeitada porque:** sem toggle, qualquer regressão pega 100% dos clientes na hora do merge. Branch longo acumula merge conflicts. Sem fallback automático em runtime — se algo crashar em produção, é tela branca até o revert manual.

### B. Repositório separado (`hypr-report-hub-v2`)

Subir um novo Vercel project, novo domínio interno, e migrar clientes via redirect.

**Rejeitada porque:** duplica complexidade de deploy (2 backends, 2 sets de env vars, 2 dashboards Vercel). Compartilhar `lib/api.js`, `shared/auth.js`, `shared/dateFilter.js` vira pesadelo (npm link? submódulo? copy-paste?). Custo operacional 3× maior pelo restante do projeto.

### C. Branch persistente longa (`feat/v2`) sem coexistência em produção

Manter V2 em branch única até estar pronto, depois mergear de uma vez.

**Rejeitada porque:** não permite testar V2 com dados reais de produção até o último momento. Branch fica meses divergindo da `main`, conflitos crescem exponencialmente. Time de produto não consegue pedir ajustes incrementais — só vê o resultado final.

### D. Feature flag binário no nível de componente

Usar flag por componente (`<DashboardCard v2 />`) e ir migrando peça por peça dentro de `ClientDashboard`.

**Rejeitada porque:** o problema não é só substituir componentes, é repensar layout, hierarquia, tabs, mobile. Migração componente-a-componente preserva a estrutura ruim que estamos tentando substituir.

## Consequências

### Positivas

- **Risco operacional baixo:** rollback é remover `src/v2/` e `src/ui/` ou reverter a tag — Legacy continua intacto e funcional
- **Iteração com produto:** time de produto pode acessar `?v=v2` em qualquer ambiente e dar feedback ao longo das 6 semanas, não só no fim
- **ErrorBoundary garante "fail-safe":** crash do V2 vira fallback Legacy, não tela branca
- **Compartilhamento natural:** `lib/api.js`, `shared/dateFilter.js`, `shared/aggregations.js` são consumidos pelos dois sem duplicação
- **Sem freeze do Legacy:** bug fixes urgentes em produção continuam possíveis durante toda a refatoração

### Negativas

- **Bundle final inicialmente maior:** durante Fase 7 e algumas semanas depois, o build inclui Legacy + V2. Mitigação: code-splitting via dynamic import do `ClientDashboardV2`, removendo Legacy assim que a virada estabilizar.
- **Disciplina necessária:** componentes antigos não podem ser editados "por baixo" para resolver problema do V2 — toda mudança em `src/components/` precisa preservar comportamento Legacy. Mitigação: code review explícito sobre isso e bateria de testes de regressão antes da Fase 7.
- **Dois sistemas de design simultâneos:** `shared/theme.js` (Legacy) e `shared/tokens.js` + `src/ui/` (V2) coexistem. Mitigação: assumido como temporário, com remoção do Legacy planejada para depois da estabilização da Fase 7.
- **Custo de remoção do Legacy:** uma fase futura (não inclusa no plano de 6 semanas) é necessária para limpar o repo após a estabilização do V2.

## Plano de remoção do Legacy (futuro, fora deste ADR)

Após ~4 semanas de V2 estável em produção, abrir uma fase de "Legacy removal":

1. Confirmar via Sentry e analytics que `?v=legacy` tem uso desprezível
2. Remover `src/pages/ClientDashboard.jsx` e dependências exclusivas
3. Mover `src/v2/dashboards/ClientDashboardV2.jsx` para `src/pages/ClientDashboard.jsx`
4. Apagar `src/v2/` e mesclar `src/ui/` em `src/components/`
5. Remover `src/shared/version.js` e usos
6. Tag `v2.0-legacy-removed` marcando o estado pós-limpeza

## Referências

- Tag baseline: [`v1.0-legacy-baseline`](https://github.com/HYPR-Projects/hypr-report-hub/releases/tag/v1.0-legacy-baseline)
- Procedimento de rollback: [`docs/EMERGENCY.md`](../EMERGENCY.md)
- PR de origem: PR-01 da Fase 0 (`chore/phase-0-pr-01-coexistence-infra`)
