# HYPR Report Center

Dashboard de reports de campanhas em produção em **report.hypr.mobi**, atendendo todos os clientes da HYPR (DV360, Xandr Curate, StackAdapt).

## Stack

- **Frontend:** React 19 + Vite 7 + Tailwind 4 (primitives Radix em `src/ui/`)
- **Charts:** recharts
- **Datas:** date-fns + react-day-picker
- **Backend:** Flask via functions-framework, Cloud Function gen2 `report_data` (serviço Cloud Run `report-data`, `southamerica-east1`), dados no BigQuery
- **Auth:** JWT (admin) + senha por cliente
- **Deploy:** Vercel (frontend, automático) + Cloud Function (backend, manual)

## Desenvolvimento local

```bash
npm install
npm run dev      # http://localhost:5173
npm run lint
npm test         # node --test src/**/*.test.js
npm run build

cd backend && python -m pytest tests/ -q   # deps em backend/requirements-dev.txt
```

## Estrutura do projeto

```
src/
├── App.jsx                 Roteamento (sem React Router) + code-splitting por rota
├── pages/                  LoginScreen, ClientPasswordScreen
├── components/             Componentes compartilhados (ErrorBoundary, Toast, TabChat…)
│   └── modals/             Modais admin (Survey, Merge, Logo, Loom, Owner, uploads)
├── dashboards/             Abas de fonte específica (RMND, PDOOH, Survey, Upload)
├── lib/                    Cliente HTTP (api.js), cache persistido, prefetch
├── shared/                 Utilitários (auth, aggregations, format, dateFilter…)
├── ui/                     Primitives de UI (Tabs, Tooltip, Drawer, Skeleton…)
└── v2/
    ├── dashboards/         Report do cliente (ClientDashboardV2 + abas)
    ├── admin/              Menu admin, drilldown de cliente, PMP
    ├── portal/             Portal do Cliente (/c/:shareId)
    └── components/, hooks/, lib/
backend/                    Cloud Function (main.py) + módulos, testes em backend/tests
docs/                       EMERGENCY.md, ADRs e auditorias de incidentes
```

## Arquitetura

O Legacy foi removido: a interface é toda a V2 (`src/v2/`), sem toggle de versão. O histórico da coexistência está em [`docs/adr/001-coexistencia-legacy-v2.md`](docs/adr/001-coexistencia-legacy-v2.md).

Pontos que valem saber antes de mexer em performance:

- **Code-splitting por rota** (`App.jsx`, `React.lazy`) e por família de vendor (`vite.config.js`). Modais pesados são carregados sob demanda com preload em idle (`src/shared/lazyWithPreload.js`).
- **Deploy novo com aba aberta:** se um chunk lazy não carregar (hash antigo), o ErrorBoundary recarrega a página uma vez em vez de mostrar erro (`src/shared/chunkReload.js`). Modal lazy tem boundary próprio (`LazyModalBoundary`): se falhar, fecha sem derrubar a página.
- **Timeouts:** as leituras que seguram tela em `src/lib/api.js` têm deadline (30s/60s/120s conforme o peso, via `src/shared/timeout.js`); escritas não têm, de propósito — abortar um save que o backend ainda vai concluir mostraria erro de algo que deu certo.
- **Cache:** stale-while-revalidate em localStorage (`src/lib/persistedCache.js`), invalidado a cada deploy pelo BUILD_ID.

## Deploy

- **Frontend:** push para `main` dispara deploy automático no Vercel
- **Backend:** manual — `cd backend && bash deploy.sh` (exige permissão GCP) ou o workflow **Deploy backend (Cloud Function)** no GitHub Actions

## Em caso de incidente

Consulte [`docs/EMERGENCY.md`](docs/EMERGENCY.md). TL;DR: frontend → **Promote to Production** de um deploy anterior no Vercel; backend → rotear o tráfego de `report-data` pra revisão anterior; depois `git revert` do commit culpado.
