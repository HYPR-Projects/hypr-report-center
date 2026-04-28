# HYPR Report Hub

Dashboard de reports de campanhas em produção em **report.hypr.mobi**, atendendo todos os clientes da HYPR (DV360, Xandr Curate, StackAdapt).

## Stack

- **Frontend:** React 19 + Vite 7
- **Charts:** recharts
- **Datas:** date-fns + react-day-picker
- **Backend:** FastAPI (Python) em Cloud Run
- **Auth:** JWT (admin) + senha por cliente
- **Deploy:** Vercel (frontend) + Cloud Run (backend)

## Desenvolvimento local

```bash
npm install
npm run dev      # http://localhost:5173
npm run lint
npm run build
```

## Estrutura do projeto

```
src/
├── pages/                  Páginas Legacy (LoginScreen, ClientPasswordScreen, CampaignMenu, ClientDashboard)
├── components/             Componentes Legacy (cards, tabelas, charts, modais, abas)
│   ├── dashboard-tabs/     Abas do ClientDashboard (Overview, Display, Video, Loom)
│   └── modals/             Modais admin (NewCampaign, Logo, Loom, Owner, Survey)
├── dashboards/             Dashboards específicos (RMND, PDOOH, Survey, Upload)
├── lib/                    Cliente HTTP (api.js)
├── shared/                 Utilitários compartilhados (auth, theme, dateFilter, aggregations…)
├── ui/                     UI primitives compartilhados Legacy ↔ V2 (a partir da Fase 1)
└── v2/                     Refatoração visual V2 (a partir da Fase 1)
    ├── components/
    └── dashboards/
backend/                    API FastAPI (auth, owners, deploy)
docs/
├── EMERGENCY.md            Procedimento de rollback de emergência
└── adr/                    Architecture Decision Records
```

## Arquitetura: coexistência Legacy + V2

O HYPR Report Hub está em meio a uma refatoração visual profunda (Fases 0–7, ~6 semanas). Para que isso aconteça **sem big-bang rewrite e sem risco de tela branca em produção**, adotamos coexistência:

- A interface atual ("Legacy") permanece intacta em `src/pages/`, `src/components/` e `src/dashboards/`
- A nova interface ("V2") cresce em paralelo em `src/v2/`, com primitives compartilhados em `src/ui/`
- Um toggle (`src/shared/version.js`) controla qual versão cada cliente vê
- Um `ErrorBoundary` global captura crashes do V2 e cai automaticamente no Legacy
- Tag `v1.0-legacy-baseline` marca o ponto de rollback de emergência

**Default permanece Legacy** durante toda a refatoração. A virada para V2 default acontece apenas na Fase 7, simultânea para todos os clientes.

### Toggle de versão

Quando ativo (a partir da Fase 0, PR-03), o toggle resolve a versão na seguinte ordem:

1. Query param `?v=v2` ou `?v=legacy` (também persiste em localStorage)
2. localStorage `hypr_report_version`
3. Fallback hardcoded — `legacy` até a Fase 7, `v2` depois

> Em desenvolvimento e em previews do Vercel, basta acessar `/report/<token>?v=v2` para ver a nova interface. A escolha persiste entre recarregamentos.

### Documentos de referência

- [`docs/EMERGENCY.md`](docs/EMERGENCY.md) — procedimento completo de rollback de emergência
- [`docs/adr/001-coexistencia-legacy-v2.md`](docs/adr/001-coexistencia-legacy-v2.md) — racional arquitetural completo (alternativas consideradas, consequências, plano de remoção do Legacy)
- [Release `v1.0-legacy-baseline`](https://github.com/HYPR-Projects/hypr-report-hub/releases/tag/v1.0-legacy-baseline) — snapshot do estado de produção pré-V2

## Deploy

- **Frontend:** push para `main` dispara deploy automático no Vercel
- **Backend:** `cd backend && bash deploy.sh` (Cloud Run, exige permissão GCP)

## Em caso de incidente

Consulte [`docs/EMERGENCY.md`](docs/EMERGENCY.md). TL;DR: o ponto de restauração é a tag `v1.0-legacy-baseline`. Para problemas pontuais com o V2, prefira o toggle (`?v=legacy`) antes de reverter o repo.
