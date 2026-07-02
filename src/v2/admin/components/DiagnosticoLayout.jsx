// src/v2/admin/components/DiagnosticoLayout.jsx
//
// Layout da aba "Diagnóstico" do CampaignMenuV2 — renderiza filtros pill
// pré-setados (Super Over / Over / Verificar Under / Ok) + duas tabelas
// (Display, depois Video) com as campanhas classificadas.
//
// Filtros são MULTI-SELECT (clica em vários, mostra a união). Se nenhum
// estiver selecionado = mostra tudo. Hit em cima do filtro ativo deseleciona.
//
// Período: preset "Agora" (default) mantém o comportamento original —
// apenas campanhas in_flight, projeção 7d, D-1, Falta/Dia. Qualquer outro
// preset entra em modo HISTÓRICO: busca o payload janelado do backend
// (action=performers, mesmo endpoint do Top Performers) e re-deriva as
// linhas com cálculos ajustados à janela — entregue ÷ contratado pro-rata,
// custo janelado, tech cost sobre budget pro-rata. Ver
// buildDiagnosticoRowsForPeriod em lib/diagnostico.js.

import { useState, useMemo, useEffect, useRef } from "react";
import { cn } from "../../../ui/cn";
import { getCampaignStatus } from "../lib/format";
import {
  STATUS,
  STATUS_ORDER,
  STATUS_META,
  buildDiagnosticoRows,
  buildDiagnosticoRowsForPeriod,
  countByStatus,
} from "../lib/diagnostico";
import { resolvePeriod, formatPeriodLabel } from "../lib/period";
import { PeriodPicker } from "./PeriodPicker";
import { listPerformersForPeriod } from "../../../lib/api";
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
// Empty state global
// ────────────────────────────────────────────────────────────────────────
function EmptyStateGlobal({ historical, periodLabel }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-12 text-center">
      <p className="text-sm text-fg-muted">
        {historical
          ? `Nenhuma campanha com entrega e contrato no período (${periodLabel}).`
          : "Nenhuma campanha ativa no momento — no modo \"Agora\" o diagnóstico só considera campanhas em vôo (in_flight). Use o filtro de período pra ver meses passados."}
      </p>
    </div>
  );
}

// Skeleton simples enquanto o fetch da janela roda — mesmo padrão de card
// das tabelas pra não dar layout shift.
function TableSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-3.5 border-t border-border/40 first:border-t-0 animate-pulse"
        >
          <div className="w-16 h-3 bg-surface-strong rounded shrink-0" />
          <div className="w-28 h-3 bg-surface-strong rounded shrink-0" />
          <div className="flex-1 h-3 bg-surface-strong rounded" />
          {[...Array(5)].map((__, j) => (
            <div key={j} className="w-12 h-3 bg-surface-strong rounded shrink-0 hidden lg:block" />
          ))}
        </div>
      ))}
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

  // Filtro de período — mesma máquina de estados do Top Performers.
  // preset="now" (default) usa props.campaigns sem fetch; qualquer outro
  // preset dispara fetch janelado ao backend.
  const [preset, setPreset] = useState("now");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [periodCampaigns, setPeriodCampaigns] = useState(null); // null = não fetcheado
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [refetchKey, setRefetchKey] = useState(0);
  // SeqRef contra race: fetch lento de um preset anterior não pode
  // sobrescrever a resposta do preset atual.
  const fetchSeqRef = useRef(0);

  const isHistorical = preset !== "now";
  const { from, to } = useMemo(() => resolvePeriod(preset, custom), [preset, custom]);

  useEffect(() => {
    if (!isHistorical) {
      setPeriodCampaigns(null);
      setLoading(false);
      setFetchError(null);
      return;
    }
    if (!from || !to) return; // custom ainda incompleto
    const seq = ++fetchSeqRef.current;
    setPeriodCampaigns(null);
    setLoading(true);
    setFetchError(null);
    listPerformersForPeriod({ from, to })
      .then((data) => {
        if (seq !== fetchSeqRef.current) return; // resposta obsoleta
        setPeriodCampaigns(data);
        setLoading(false);
      })
      .catch((err) => {
        if (seq !== fetchSeqRef.current) return;
        setFetchError(err.message || "Erro ao carregar período");
        setLoading(false);
      });
  }, [isHistorical, from, to, refetchKey]);

  // Linhas Display + Video. Modo Agora: payload da lista, só in_flight,
  // projeção 7d. Modo histórico: payload janelado do backend, cálculos
  // ajustados à janela.
  const { displayRows: allDisplayRows, videoRows: allVideoRows } = useMemo(() => {
    if (isHistorical) {
      if (!periodCampaigns) return { displayRows: [], videoRows: [] };
      return buildDiagnosticoRowsForPeriod(periodCampaigns, { from, to });
    }
    return buildDiagnosticoRows(campaigns, getCampaignStatus);
  }, [isHistorical, periodCampaigns, from, to, campaigns]);

  // Aplica search + owner ANTES de contar pills e renderizar tabelas, pra que
  // os números nos pills reflitam o escopo já filtrado.
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
  // de linhas naquele status entre as duas tabelas.
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

  const totalRows = displayRows.length + videoRows.length;
  const periodLabel = isHistorical ? formatPeriodLabel(preset, from, to) : null;

  const handleDownloadXlsx = () => {
    // Download exporta o que está visível APÓS search/owner mas ANTES dos
    // filtros pill — pra que o arquivo seja o "diagnóstico do escopo" e
    // não sofra com cliques exploratórios nos pills.
    downloadDiagnosticoXlsx({
      displayRows,
      videoRows,
      teamMap,
      period: isHistorical ? { from, to } : null,
    });
  };

  return (
    <div className="space-y-6">
      {/* Filtro de período + aviso de modo histórico ─────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <PeriodPicker
          preset={preset}
          onPresetChange={setPreset}
          custom={custom}
          onCustomChange={setCustom}
          ariaLabel="Período do diagnóstico"
        />
        {isHistorical && (
          <span className="text-[11px] text-fg-subtle leading-snug max-w-[560px]">
            Diagnóstico <span className="text-fg-muted font-medium">retrospectivo</span> de{" "}
            <span className="text-fg-muted font-medium">{periodLabel}</span> — inclui campanhas
            encerradas. Entregue % = entregue na janela ÷ contrato pro-rata; custo e tech cost
            também são da janela.
          </span>
        )}
      </div>

      {fetchError ? (
        <div className="rounded-xl border border-border bg-surface p-8 text-center">
          <p className="text-sm text-danger">Erro ao carregar período: {fetchError}</p>
          <button
            type="button"
            onClick={() => setRefetchKey((k) => k + 1)}
            className="mt-2 text-xs text-signature hover:underline"
          >
            Tentar de novo
          </button>
        </div>
      ) : loading ? (
        <TableSkeleton />
      ) : totalRows === 0 ? (
        <EmptyStateGlobal historical={isHistorical} periodLabel={periodLabel} />
      ) : (
        <>
          {/* Filtros pill + download ──────────────────────────────────── */}
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
              title="Baixar diagnóstico em Excel (Display e Video na mesma aba)"
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

          {/* Tabelas: Display em cima, Video embaixo. `key` força remount ao
              alternar Agora ↔ histórico — reseta o sort local pro default
              certo de cada modo (projetadaPct não existe no histórico). */}
          <DiagnosticoTable
            key={isHistorical ? "display-hist" : "display-now"}
            title="Display"
            rows={displayRows}
            teamMap={teamMap}
            onOpenReport={onOpenReport}
            onOpenCampaign={onOpenCampaign}
            activeStatuses={activeStatuses}
            historical={isHistorical}
          />

          <DiagnosticoTable
            key={isHistorical ? "video-hist" : "video-now"}
            title="Video"
            rows={videoRows}
            teamMap={teamMap}
            onOpenReport={onOpenReport}
            onOpenCampaign={onOpenCampaign}
            activeStatuses={activeStatuses}
            historical={isHistorical}
          />
        </>
      )}
    </div>
  );
}
