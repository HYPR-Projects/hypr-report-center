// src/v2/admin/components/DiagnosticoLayout.jsx
//
// Layout da aba "Diagnóstico" do CampaignMenuV2 — renderiza filtros pill
// pré-setados (Super Over / Over / Verificar Under / Ok) + duas tabelas
// (Display, depois Video) com as campanhas ativas classificadas.
//
// Filtros são MULTI-SELECT (clica em vários, mostra a união). Se nenhum
// estiver selecionado = mostra tudo. Hit em cima do filtro ativo deseleciona.
//
// "Apenas ativas" não precisa de toggle — a aba JÁ filtra só in_flight
// (decisão semântica: diagnóstico é sobre operação corrente, não histórico).

import { useState, useMemo } from "react";
import { cn } from "../../../ui/cn";
import { getCampaignStatus } from "../lib/format";
import {
  STATUS,
  STATUS_ORDER,
  STATUS_META,
  buildDiagnosticoRows,
  countByStatus,
} from "../lib/diagnostico";
import { DiagnosticoTable } from "./DiagnosticoTable";
import { downloadDiagnosticoXlsx } from "../lib/diagnosticoExport";

// ────────────────────────────────────────────────────────────────────────
// Pill de filtro — visual alinhado com MonthFilterPills/ActiveFilterPill
// ────────────────────────────────────────────────────────────────────────
function StatusFilterPill({ status, count, active, onToggle }) {
  const meta = STATUS_META[status];
  if (!meta) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      title={meta.description}
      className={cn(
        "inline-flex items-center gap-2 h-8 px-3.5 rounded-full cursor-pointer",
        "text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
        active
          ? cn(meta.bgClass, meta.borderClass, meta.textClass, "border")
          : "bg-surface text-fg-muted border border-border hover:bg-surface-strong hover:text-fg"
      )}
    >
      <span className={cn("size-1.5 rounded-full shrink-0", meta.dotClass)} />
      {meta.label}
      <span
        className={cn(
          "inline-flex items-center justify-center min-w-[22px] h-4 px-1.5 rounded-full",
          "text-[10px] font-bold tabular-nums",
          active
            ? "bg-canvas-elevated/60 text-fg"
            : "bg-surface-strong text-fg-muted"
        )}
      >
        {count}
      </span>
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Empty state global (zero campanhas ativas no payload todo)
// ────────────────────────────────────────────────────────────────────────
function EmptyStateGlobal() {
  return (
    <div className="rounded-xl border border-border bg-surface p-12 text-center">
      <p className="text-sm text-fg-muted">
        Nenhuma campanha ativa no momento — o diagnóstico só considera
        campanhas em vôo (in_flight).
      </p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Layout principal
// ────────────────────────────────────────────────────────────────────────
/**
 * Props:
 *   campaigns      — array cru de listCampaigns
 *   teamMap        — { email → nome de exibição }
 *   onOpenReport   — (short_token) => void  (kept pra fallback / botões dedicados)
 *   onOpenCampaign — (short_token) => void  (clicar row abre o sheet de análise)
 *   search         — string de busca (cliente/campanha/token), vinda do ToolbarV2
 *   ownerMatcher   — fn(row) → boolean, criada via createOwnerMatcher no parent
 */
export function DiagnosticoLayout({
  campaigns,
  teamMap,
  onOpenReport,
  onOpenCampaign,
  search = "",
  ownerMatcher,
}) {
  // Filtros: Set de status ativos. Vazio = mostra tudo.
  const [activeStatuses, setActiveStatuses] = useState(() => new Set());

  // Calcula linhas Display + Video uma vez por mudança de payload.
  // getCampaignStatus passa as datas/flags pra decidir "in_flight".
  const { displayRows: allDisplayRows, videoRows: allVideoRows } = useMemo(
    () => buildDiagnosticoRows(campaigns, getCampaignStatus),
    [campaigns]
  );

  // Aplica search + owner ANTES de contar pills e renderizar tabelas, pra que
  // os números nos pills reflitam o escopo já filtrado. Rows do
  // buildDiagnosticoRows preservam client_name/campaign_name/short_token +
  // cp_email/cs_email, então o ownerMatcher funciona direto.
  const { displayRows, videoRows } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const isTokenQuery = /[-]/.test(search.trim()) || /^[A-Z0-9]{4,8}$/.test(search.trim());
    const matchSearchAndOwner = (r) => {
      const matchSearch = !q ||
        r.client_name?.toLowerCase().includes(q) ||
        r.campaign_name?.toLowerCase().includes(q) ||
        (isTokenQuery && r.short_token?.toLowerCase().includes(q));
      const matchOwner = !ownerMatcher || ownerMatcher(r);
      return matchSearch && matchOwner;
    };
    return {
      displayRows: allDisplayRows.filter(matchSearchAndOwner),
      videoRows:   allVideoRows.filter(matchSearchAndOwner),
    };
  }, [allDisplayRows, allVideoRows, search, ownerMatcher]);

  // Contagens GLOBAIS (Display + Video) — o número no pill reflete o total
  // de linhas naquele status entre as duas tabelas, pra dar uma visão única
  // do "tamanho do problema" sem ter que somar mentalmente.
  const counts = useMemo(() => {
    const d = countByStatus(displayRows);
    const v = countByStatus(videoRows);
    return {
      [STATUS.SUPER_OVER]:   d[STATUS.SUPER_OVER]   + v[STATUS.SUPER_OVER],
      [STATUS.OVER]:         d[STATUS.OVER]         + v[STATUS.OVER],
      [STATUS.UNDER]:        d[STATUS.UNDER]        + v[STATUS.UNDER],
      [STATUS.OK]:           d[STATUS.OK]           + v[STATUS.OK],
      [STATUS.TECH_HIGH]:    d[STATUS.TECH_HIGH]    + v[STATUS.TECH_HIGH],
      [STATUS.TECH_AT_RISK]: d[STATUS.TECH_AT_RISK] + v[STATUS.TECH_AT_RISK],
    };
  }, [displayRows, videoRows]);

  const toggleStatus = (status) => {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const clearFilters = () => setActiveStatuses(new Set());

  const totalActive = displayRows.length + videoRows.length;

  if (totalActive === 0) {
    return <EmptyStateGlobal />;
  }

  const handleDownloadXlsx = () => {
    // Download exporta o que está visível APÓS search/owner mas ANTES dos
    // filtros pill — pra que o arquivo seja o "diagnóstico do escopo" e
    // não sofra com cliques exploratórios nos pills.
    downloadDiagnosticoXlsx({ displayRows, videoRows, teamMap });
  };

  return (
    <div className="space-y-6">
      {/* Filtros pill + sumário + download ──────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_ORDER.map((status) => (
          <StatusFilterPill
            key={status}
            status={status}
            count={counts[status] || 0}
            active={activeStatuses.has(status)}
            onToggle={() => toggleStatus(status)}
          />
        ))}
        {activeStatuses.size > 0 && (
          <button
            type="button"
            onClick={clearFilters}
            className={cn(
              "ml-1 text-[11px] text-fg-muted hover:text-fg font-medium",
              "px-2 h-8 rounded-md hover:bg-surface-strong transition-colors cursor-pointer"
            )}
          >
            Limpar filtros
          </button>
        )}
        <button
          type="button"
          onClick={handleDownloadXlsx}
          disabled={displayRows.length === 0 && videoRows.length === 0}
          title="Baixar diagnóstico em Excel (abas separadas para Display e Video)"
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-full",
            "text-xs font-medium border transition-colors cursor-pointer",
            "bg-surface text-fg-muted border-border hover:bg-surface-strong hover:text-fg",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        >
          <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Baixar Excel
        </button>
      </div>

      {/* Tabelas: Display em cima, Video embaixo ────────────────────── */}
      <DiagnosticoTable
        title="Display"
        rows={displayRows}
        teamMap={teamMap}
        onOpenReport={onOpenReport}
        onOpenCampaign={onOpenCampaign}
        activeStatuses={activeStatuses}
      />

      <DiagnosticoTable
        title="Video"
        rows={videoRows}
        teamMap={teamMap}
        onOpenReport={onOpenReport}
        onOpenCampaign={onOpenCampaign}
        activeStatuses={activeStatuses}
      />
    </div>
  );
}
