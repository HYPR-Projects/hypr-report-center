// src/v2/dashboards/OverviewV2.jsx
//
// Visão Geral V2 — primeira fatia (PR-06).
//
// O QUE TEM
//   - CampaignHeaderV2 (nome, cliente, período, status badge, ações)
//   - DateRangeFilterV2 (chips de presets)
//   - Grid de KpiCardV2 (Budget, CPM Neg, CPCV Neg, Imp. Visíveis, Views 100%,
//     Custo Efetivo, Custo Efetivo + Over)
//
// O QUE NÃO TEM AINDA (próximas PRs da Fase 2)
//   - PacingBar Display/Video (PR-07)
//   - MediaSummary com CPM/CPCV negociado vs efetivo (PR-07)
//   - Charts diários Imp. Visíveis × CTR e Views 100% × VTR (PR-08)
//   - Tabela detalhada (PR-08)
//   - Bloco A&F admin (PR-08)
//   - Custom range arbitrário (calendário) — só presets nessa fatia
//
// CONTRATO COM ClientDashboardV2
//   Recebe `data` (output de getCampaign) já carregado e os handlers
//   de range. Não faz fetch — fetch fica no ClientDashboardV2 pra
//   orquestrar loading state + ErrorBoundary.

import { useMemo, useState } from "react";
import { computeAggregates } from "../../shared/aggregations";
import { fmt, fmtR } from "../../shared/format";

import { Button } from "../../ui/Button";
import { TooltipProvider } from "../../ui/Tooltip";

import { CampaignHeaderV2 } from "../components/CampaignHeaderV2";
import { DateRangeFilterV2 } from "../components/DateRangeFilterV2";
import { KpiCardV2 } from "../components/KpiCardV2";

export default function OverviewV2({ data, onBackToLegacy }) {
  // mainRange local — quando o filtro de período evoluir pra ?from=&to=
  // na URL, troca pra readRangeFromUrl/writeRangeToUrl (já existe em
  // shared/dateFilter). Pra primeira fatia, state local basta.
  const [mainRange, setMainRange] = useState(null);

  const aggregates = useMemo(
    () => computeAggregates(data, mainRange),
    [data, mainRange],
  );

  if (!aggregates) {
    return (
      <div className="text-fg-muted text-sm p-6">
        Não foi possível processar os dados desta campanha.
      </div>
    );
  }

  const camp = data.campaign;
  const {
    totalImpressions, totalCusto, totalCustoOver,
    display, video, totals,
    isFiltered, rangeLabel, budgetProRata, budgetTotal,
  } = aggregates;

  const hasDisplay = display.length > 0;
  const hasVideo = video.length > 0;
  const totalViews100 = totals.reduce((s, t) => s + (t.completions || 0), 0);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-canvas text-fg font-sans">
        <div className="mx-auto max-w-7xl px-4 md:px-6 lg:px-8 py-6 md:py-10">

          <CampaignHeaderV2
            campaignName={camp.campaign_name}
            clientName={camp.client_name}
            startDate={camp.start_date}
            endDate={camp.end_date}
            rangeLabel={rangeLabel}
            actions={
              <Button variant="ghost" size="sm" onClick={onBackToLegacy}>
                Voltar à versão atual
              </Button>
            }
          />

          {/* Filtro de período */}
          <section className="mt-6">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
              Período
            </h2>
            <DateRangeFilterV2
              value={mainRange}
              campaignStart={camp.start_date}
              campaignEnd={camp.end_date}
              onChange={setMainRange}
            />
          </section>

          {/* KPI grid */}
          <section className="mt-8">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
              Indicadores
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              <KpiCardV2
                label={isFiltered ? "Budget (período)" : "Budget Total"}
                value={fmtR(isFiltered ? budgetProRata : budgetTotal)}
                hint={
                  isFiltered
                    ? "Budget contratado proporcionalizado pelo período do filtro (linear, dias/dias-totais)."
                    : "Budget contratado total da campanha."
                }
              />

              {hasDisplay && (
                <KpiCardV2
                  label="CPM Negociado"
                  value={fmtR(camp.cpm_negociado)}
                  hint="CPM acordado em contrato — aplicado às mídias Display."
                />
              )}

              {hasVideo && (
                <KpiCardV2
                  label="CPCV Negociado"
                  value={fmtR(camp.cpcv_negociado)}
                  hint="Custo por completion negociado — aplicado às mídias Video."
                />
              )}

              <KpiCardV2
                label="Imp. Visíveis"
                value={fmt(totalImpressions)}
                hint="Soma de viewable impressions no período selecionado."
              />

              {hasVideo && (
                <KpiCardV2
                  label="Views 100%"
                  value={fmt(totalViews100)}
                  hint="Completions de vídeo (visualizações até 100%)."
                />
              )}

              <KpiCardV2
                label="Custo Efetivo"
                value={fmtR(totalCusto)}
                accent
                hint="Custo real entregue no período — derivado do delivery × CPM/CPCV efetivo."
              />

              <KpiCardV2
                label="Custo Efetivo + Over"
                value={fmtR(totalCustoOver)}
                accent
                hint="Inclui valor da over-delivery (entrega acima do contratado)."
              />
            </div>
          </section>

          {/* Placeholder das próximas fatias */}
          <section className="mt-10 rounded-xl border border-border bg-surface px-5 py-6 text-center">
            <p className="text-sm text-fg-muted">
              <span className="font-semibold text-fg">Em breve:</span>{" "}
              Pacing, comparação CPM/CPCV negociado vs efetivo, gráficos diários
              e tabela detalhada chegam nas próximas atualizações.
            </p>
          </section>

        </div>
      </div>
    </TooltipProvider>
  );
}
