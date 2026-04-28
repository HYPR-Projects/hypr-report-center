// src/v2/dashboards/ClientDashboardV2.jsx
//
// Root do dashboard V2.
//
// Responsabilidades
//   - Buscar dados da campanha via getCampaign(token)
//   - Renderizar loading state (Skeleton de KPIs enquanto fetch responde)
//   - Renderizar erro (mensagem amigável; ErrorBoundary global cobre crash)
//   - Delegar pro OverviewV2 quando dados estão prontos
//   - Botão "Voltar à versão atual" — persiste 'legacy' no localStorage
//
// Por que separar root × OverviewV2
//   ClientDashboardV2 é o "shell" — fetch, loading, error.
//   OverviewV2 é o conteúdo da Visão Geral — recebe data já carregado.
//   Quando outras tabs (Display/Video/RMND/etc) entrarem no V2, elas
//   serão filhas do ClientDashboardV2 também — fetch único compartilhado
//   por todas as tabs, exatamente como faz o Legacy.

import { useEffect, useState } from "react";

import "../v2.css";              // entry CSS do V2
import "../../ui/typography";    // carrega Urbanist (efeito colateral)

import { getCampaign } from "../../lib/api";
import { setReportVersion } from "../../shared/version";
import { gaPageView } from "../../shared/analytics";

import { Skeleton } from "../../ui/Skeleton";

import OverviewV2 from "./OverviewV2";

export default function ClientDashboardV2({ token /*, isAdmin, adminJwt */ }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

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

  if (!data) {
    return <DashboardSkeleton onBackToLegacy={goLegacy} />;
  }

  return <OverviewV2 data={data} onBackToLegacy={goLegacy} />;
}

// ─── Loading state ────────────────────────────────────────────────────
// Skeleton que imita o shape do OverviewV2 — header + chips + grid de
// KPIs. Reduz layout shift quando dados chegam.
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
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-full" />
          ))}
        </div>

        <div className="mt-8 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
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
