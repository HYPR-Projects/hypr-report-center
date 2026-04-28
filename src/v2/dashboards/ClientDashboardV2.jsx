// src/v2/dashboards/ClientDashboardV2.jsx
//
// Shell do dashboard V2.
//
// RESPONSABILIDADES
//   - Buscar dados da campanha via getCampaign(token)
//   - Gerenciar state global do dashboard:
//       • mainRange (filtro de período)  → ?from=&to=
//       • tab ativa (overview | display) → ?tab=
//       • tactic do Display (O2O | OOH)  → ?tactic=
//   - Sincronizar com botão voltar/avançar do navegador (popstate)
//   - Renderizar loading state (Skeleton) e error state
//   - Renderizar layout master: CampaignHeader, filtro de período,
//     Tabs Radix com painéis Visão Geral e Display
//
// POR QUE STATE GLOBAL VIVE NO SHELL
//   Período é compartilhado entre Visão Geral e Display — trocar a
//   janela e mudar de tab tem que preservar o filtro. Tab/tactic
//   também ficam aqui pra que o popstate listener seja único e
//   reaja a TODAS as mudanças de URL ao mesmo tempo.
//
//   Quando VideoV2 entrar (PR-11), bastará adicionar um <TabsTrigger>
//   e <TabsContent>, sem mudar nada na arquitetura do shell.
//
// FILTRO DE AUDIÊNCIA (Display) é state local da tab
//   `lines` é efêmero, UX-only, e a string ficaria gigante na URL —
//   mantido como state interno do componente DisplayV2. Ver doc lá.
//
// PERSISTÊNCIA DE URL
//   Tudo via history.replaceState (não pushState) — não polui o
//   histórico do navegador. O usuário pode voltar/avançar entre
//   páginas/tokens sem ficar pulando entre estados intermediários
//   do mesmo dashboard. popstate só dispara quando alguém faz
//   navegação real (back/forward, click em link externo).

import { useEffect, useMemo, useState } from "react";

import "../v2.css";              // entry CSS do V2
import "../../ui/typography";    // carrega Urbanist (efeito colateral)

import { getCampaign } from "../../lib/api";
import { setReportVersion } from "../../shared/version";
import { gaPageView } from "../../shared/analytics";
import { computeAggregates } from "../../shared/aggregations";
import {
  readRangeFromUrl,
  writeRangeToUrl,
} from "../../shared/dateFilter";

import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/Skeleton";
import { TooltipProvider } from "../../ui/Tooltip";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../ui/Tabs";

import { CampaignHeaderV2 } from "../components/CampaignHeaderV2";
import { DateRangeFilterV2 } from "../components/DateRangeFilterV2";

import OverviewV2 from "./OverviewV2";
import DisplayV2 from "./DisplayV2";

// ─── Helpers de URL ────────────────────────────────────────────────────
//
// Inline porque são consumidos só aqui. Quando aparecer terceira tab
// ou outro state URL-persistido, vale extrair pra src/shared/urlState.js.

const VALID_TABS = ["overview", "display"];
const VALID_TACTICS = ["O2O", "OOH"];

function readTabFromUrl() {
  if (typeof window === "undefined") return "overview";
  try {
    const t = new URLSearchParams(window.location.search).get("tab");
    return VALID_TABS.includes(t) ? t : "overview";
  } catch {
    return "overview";
  }
}

function writeTabToUrl(tab) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (tab === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  } catch { /* noop */ }
}

function readTacticFromUrl() {
  if (typeof window === "undefined") return "O2O";
  try {
    const t = new URLSearchParams(window.location.search).get("tactic");
    return VALID_TACTICS.includes(t) ? t : "O2O";
  } catch {
    return "O2O";
  }
}

function writeTacticToUrl(tactic) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (tactic === "O2O") url.searchParams.delete("tactic");
    else url.searchParams.set("tactic", tactic);
    window.history.replaceState({}, "", url.toString());
  } catch { /* noop */ }
}

// ─── Componente principal ──────────────────────────────────────────────

export default function ClientDashboardV2({ token, isAdmin, adminJwt }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  // State global do dashboard
  const [mainRange, setMainRangeState] = useState(() => readRangeFromUrl());
  const [tab, setTabState] = useState(() => readTabFromUrl());
  const [tactic, setTacticState] = useState(() => readTacticFromUrl());

  // Filtro de audiência da tab Display — state local ao shell por
  // simetria, mas NÃO persiste em URL (UX efêmero). Resetado ao trocar
  // tactic dentro do DisplayV2 (que recebe setLines como prop).
  const [lines, setLines] = useState([]);

  // Setters que sincronizam com URL
  const setMainRange = (r) => {
    setMainRangeState(r);
    writeRangeToUrl(r);
  };
  const setTab = (t) => {
    setTabState(t);
    writeTabToUrl(t);
  };
  const setTactic = (t) => {
    setTacticState(t);
    writeTacticToUrl(t);
  };

  // Fetch da campanha
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    getCampaign(token)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        gaPageView(`/report/${token}`, token);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.message || "Erro ao carregar dados");
      });

    return () => { cancelled = true; };
  }, [token]);

  // popstate listener único — ressincroniza TUDO que vive na URL
  // quando o usuário usa botão voltar/avançar do navegador. replaceState
  // não dispara popstate, então isso aqui só reage a navegação real
  // (ex: usuário cola URL com ?tab=display em outra aba).
  useEffect(() => {
    const onPop = () => {
      setMainRangeState(readRangeFromUrl());
      setTabState(readTabFromUrl());
      setTacticState(readTacticFromUrl());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // aggregates é computado uma vez por (data, mainRange) e passado
  // pra Overview e Display — ambas as tabs leem do MESMO snapshot.
  const aggregates = useMemo(
    () => (data ? computeAggregates(data, mainRange) : null),
    [data, mainRange],
  );

  // Voltar pro Legacy
  const goLegacy = () => {
    setReportVersion("legacy");
    const url = new URL(window.location.href);
    url.searchParams.delete("v");
    window.location.replace(url.toString());
  };

  if (error) {
    return (
      <div className="min-h-screen bg-canvas text-fg font-sans flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center rounded-xl border border-border bg-surface p-8">
          <h1 className="text-xl font-bold text-fg mb-2">
            Não foi possível carregar a campanha
          </h1>
          <p className="text-sm text-fg-muted mb-6">{error}</p>
          <button
            type="button"
            onClick={goLegacy}
            className="text-sm font-semibold text-signature hover:text-signature-hover transition-colors cursor-pointer"
          >
            Voltar à versão atual →
          </button>
        </div>
      </div>
    );
  }

  if (!data || !aggregates) {
    return <DashboardSkeleton onBackToLegacy={goLegacy} />;
  }

  const camp = data.campaign;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-canvas text-fg font-sans">
        <div className="mx-auto max-w-7xl px-4 md:px-6 lg:px-8 py-6 md:py-10">

          <CampaignHeaderV2
            campaignName={camp.campaign_name}
            clientName={camp.client_name}
            startDate={camp.start_date}
            endDate={camp.end_date}
            rangeLabel={aggregates.rangeLabel}
            actions={
              <Button variant="ghost" size="sm" onClick={goLegacy}>
                Voltar à versão atual
              </Button>
            }
          />

          {/* Filtro global de período — afeta Overview e Display */}
          <section className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
              Período
            </h2>
            <DateRangeFilterV2
              value={mainRange}
              campaignStart={camp.start_date}
              campaignEnd={camp.end_date}
              availableDates={aggregates.availableDates}
              onChange={setMainRange}
            />
          </section>

          {/* Tabs Radix — navegação principal */}
          <Tabs value={tab} onValueChange={setTab} className="mt-8">
            {/* TabsList scrolla horizontal em mobile se overflow.
                Sem scrollbar visível (overflow-x-auto sem scroll-smooth).
                Não é sticky por decisão (ver plano da PR-10). */}
            <div className="overflow-x-auto -mx-4 md:mx-0 px-4 md:px-0 pb-1">
              <TabsList>
                <TabsTrigger value="overview">Visão Geral</TabsTrigger>
                <TabsTrigger value="display">Display</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="overview">
              <OverviewV2
                data={data}
                aggregates={aggregates}
                token={token}
                isAdmin={isAdmin}
                adminJwt={adminJwt}
              />
            </TabsContent>

            <TabsContent value="display">
              <DisplayV2
                data={data}
                aggregates={aggregates}
                tactic={tactic}
                setTactic={setTactic}
                lines={lines}
                setLines={setLines}
              />
            </TabsContent>
          </Tabs>

        </div>
      </div>
    </TooltipProvider>
  );
}

// ─── Loading state ────────────────────────────────────────────────────
// Skeleton que imita o shape do shell — header + filtro + tabs + grid
// de KPIs. Reduz layout shift quando dados chegam.
function DashboardSkeleton({ onBackToLegacy }) {
  return (
    <div className="min-h-screen bg-canvas text-fg font-sans">
      <div className="mx-auto max-w-7xl px-4 md:px-6 lg:px-8 py-6 md:py-10">
        <header className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 pb-6 border-b border-border">
          <div className="flex-1 space-y-3">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-4 w-56" />
          </div>
          <button
            type="button"
            onClick={onBackToLegacy}
            className="text-xs font-semibold text-fg-subtle hover:text-fg transition-colors cursor-pointer self-start"
          >
            Voltar à versão atual
          </button>
        </header>

        <div className="mt-6 flex gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-full" />
          ))}
        </div>

        <div className="mt-8 flex gap-1 p-1 rounded-lg bg-surface-strong border border-border w-fit">
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-24 rounded-md" />
        </div>

        <div className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border bg-surface p-4">
              <Skeleton className="h-3 w-20 mb-3" />
              <Skeleton className="h-7 w-28" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
