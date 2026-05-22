// src/v2/admin/components/DiagnosticoTable.jsx
//
// Tabela densa pra aba "Diagnóstico" — uma instância pra Display, outra
// pra Video. Recebe linhas já calculadas (de buildDiagnosticoRows) e a
// configuração das colunas. Ordenação client-side por header click.
//
// Visual: header sticky dentro do container, hover por row, dot colorido
// na coluna de status. Linhas clicáveis abrem o report da campanha em
// nova aba (mesmo handler `onOpenReport` usado nos cards).

import { useState, useMemo } from "react";
import { cn } from "../../../ui/cn";
import { localPartFromEmail, ecpmToneClass, formatDateRange } from "../lib/format";
import {
  STATUS_META,
  formatPctRow,
  formatIntRow,
  formatBrlRow,
  techCostToneClass,
  mediaDiariaToneClass,
  viewabilityToneClass,
  compareNullableNumbers,
} from "../lib/diagnostico";

// ────────────────────────────────────────────────────────────────────────
// Pílula de status — dot + label
// ────────────────────────────────────────────────────────────────────────
function StatusPill({ status }) {
  const meta = STATUS_META[status];
  if (!meta) return <span className="text-fg-subtle">—</span>;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full",
        "text-[11px] font-semibold whitespace-nowrap",
        "border",
        meta.bgClass,
        meta.borderClass,
        meta.textClass
      )}
      title={meta.description}
    >
      <span className={cn("size-1.5 rounded-full", meta.dotClass)} />
      {meta.shortLabel}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Header com sort indicator
// ────────────────────────────────────────────────────────────────────────
function Th({ children, align = "left", sortable = false, active = false, dir, onClick, className }) {
  return (
    <th
      scope="col"
      className={cn(
        "sticky top-0 z-10 bg-canvas-deeper",
        "px-3 py-2.5",
        "text-[10px] font-bold uppercase tracking-wider text-fg-subtle",
        "border-b border-border",
        "whitespace-nowrap",
        sortable && "cursor-pointer select-none hover:text-fg",
        align === "right"  && "text-right",
        align === "center" && "text-center",
        align === "left"   && "text-left",
        className
      )}
      onClick={sortable ? onClick : undefined}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortable && active && (
          <span className="text-fg" aria-hidden="true">
            {dir === "asc" ? "▲" : "▼"}
          </span>
        )}
      </span>
    </th>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Cell helpers
// ────────────────────────────────────────────────────────────────────────
function Td({ children, align = "left", className, tabular = false, title }) {
  return (
    <td
      className={cn(
        "px-3 py-2.5",
        "text-xs text-fg",
        "border-b border-border/40",
        "whitespace-nowrap",
        tabular && "tabular-nums",
        align === "right"  && "text-right",
        align === "center" && "text-center",
        align === "left"   && "text-left",
        className
      )}
      title={title}
    >
      {children}
    </td>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Empty state
// ────────────────────────────────────────────────────────────────────────
function EmptyState({ message }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-8 text-center">
      <p className="text-sm text-fg-muted">{message}</p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Componente principal
// ────────────────────────────────────────────────────────────────────────
/**
 * Props:
 *   title          — "Display" | "Video"
 *   rows           — array vindo de buildDiagnosticoRows
 *   teamMap        — { email → nome de exibição }
 *   onOpenReport   — (short_token) => void  (fallback se onOpenCampaign ausente)
 *   onOpenCampaign — (short_token) => void  (clicar row abre sheet de análise)
 *   activeStatuses — Set<status> de filtros ativos (vindo do parent)
 */
export function DiagnosticoTable({
  title,
  rows,
  teamMap = {},
  onOpenReport,
  onOpenCampaign,
  activeStatuses,
}) {
  // Sort state local (cada tabela tem o seu).
  // Default: por projetada desc (problema mais visível primeiro).
  const [sortKey, setSortKey] = useState("projetadaPct");
  const [sortDir, setSortDir] = useState("desc");

  const filteredRows = useMemo(() => {
    if (!activeStatuses || activeStatuses.size === 0) return rows;
    // Row passa se o pacing status OU o tech_status casa com algum filtro
    // ativo. Filtros pacing e tech cost são ortogonais — usar OR aqui faz
    // o multi-select agir como "mostre rows que tenham qualquer um desses
    // problemas".
    return rows.filter(
      (r) => activeStatuses.has(r.status) || (r.tech_status && activeStatuses.has(r.tech_status))
    );
  }, [rows, activeStatuses]);

  const sortedRows = useMemo(() => {
    const arr = [...filteredRows];
    arr.sort((a, b) => {
      // Strings (client_name, campaign_name, cs_name, start_date ISO)
      // ordenam alfabeticamente. start_date como "YYYY-MM-DD" já bate com
      // ordem cronológica via localeCompare.
      if (sortKey === "client_name" || sortKey === "campaign_name" || sortKey === "cs_name" || sortKey === "start_date") {
        const av = String(a[sortKey] || "").toLowerCase();
        const bv = String(b[sortKey] || "").toLowerCase();
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      // Status: ordena pelo rank dele (super_over no topo quando desc).
      if (sortKey === "status") {
        const RANK = { super_over: 3, over: 2, under: 1, ok: 0 };
        const av = RANK[a.status] ?? -1;
        const bv = RANK[b.status] ?? -1;
        return sortDir === "asc" ? av - bv : bv - av;
      }
      // Default: número.
      return compareNullableNumbers(a[sortKey], b[sortKey], sortDir);
    });
    return arr;
  }, [filteredRows, sortKey, sortDir]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Default direction: desc pra números (pior em cima), asc pra texto/data.
      setSortDir(
        key === "client_name" || key === "campaign_name" || key === "cs_name" || key === "start_date"
          ? "asc"
          : "desc"
      );
    }
  };

  if (rows.length === 0) {
    return (
      <section className="space-y-3">
        <header className="flex items-baseline justify-between gap-3">
          <h3 className="text-base font-bold text-fg">{title}</h3>
          <span className="text-xs text-fg-muted">0 campanhas</span>
        </header>
        <EmptyState message={`Nenhuma campanha ativa de ${title.toLowerCase()} no momento.`} />
      </section>
    );
  }

  if (filteredRows.length === 0) {
    return (
      <section className="space-y-3">
        <header className="flex items-baseline justify-between gap-3">
          <h3 className="text-base font-bold text-fg">{title}</h3>
          <span className="text-xs text-fg-muted">
            {rows.length} {rows.length === 1 ? "campanha" : "campanhas"} · 0 no filtro
          </span>
        </header>
        <EmptyState message="Nenhuma campanha bate com os filtros selecionados." />
      </section>
    );
  }

  // Coluna helper: gera props do header pra sort
  const headerProps = (key) => ({
    sortable: true,
    active:   sortKey === key,
    dir:      sortDir,
    onClick:  () => handleSort(key),
  });

  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-bold text-fg">{title}</h3>
        <span className="text-xs text-fg-muted">
          {filteredRows.length} de {rows.length} {rows.length === 1 ? "campanha" : "campanhas"}
        </span>
      </header>

      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr>
                <Th align="left"  {...headerProps("client_name")}>Cliente</Th>
                <Th align="left"  {...headerProps("campaign_name")}>Campanha</Th>
                <Th align="left"  {...headerProps("cs_name")}>CS Responsável</Th>
                <Th align="left"  {...headerProps("start_date")}>Período</Th>
                <Th align="right" {...headerProps("totalEntreguePct")}>Entregue</Th>
                <Th align="right" {...headerProps("projetadaPct")}>Projetada</Th>
                <Th align="right" {...headerProps("idealDiaria")}>Ideal/Dia</Th>
                <Th align="right" {...headerProps("mediaDiariaAtual")}>Média/Dia</Th>
                <Th align="center" {...headerProps("status")}>Status Pacing</Th>
                <Th align="right" {...headerProps("realEcpm")}>CPM Real</Th>
                <Th align="right" {...headerProps("realTotalCost")}>Custo Real</Th>
                <Th align="right" {...headerProps("techCostPct")}>Tech Cost</Th>
                <Th align="right" {...headerProps("viewability")}>Viewability</Th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => {
                const csName = r.cs_email
                  ? (teamMap[r.cs_email] || localPartFromEmail(r.cs_email))
                  : null;
                const projTone = STATUS_META[r.status]?.textClass || "";
                // Régua de CPM segue exatamente os mesmos tiers do card "Por mês"
                // (ecpmBgClass/ecpmToneClass em format.js). Video não tem
                // displayAbs próprio — ABS só muda a régua de Display.
                const ecpmKind = r.media === "video"
                  ? "video"
                  : (r.has_abs ? "displayAbs" : "display");
                const cpmTone     = ecpmToneClass(r.realEcpm, ecpmKind);
                const techCostTone = techCostToneClass(r.techCostPct, r.has_abs);
                return (
                  <tr
                    key={`${r.short_token}-${r.media}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => (onOpenCampaign || onOpenReport)?.(r.short_token)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        (onOpenCampaign || onOpenReport)?.(r.short_token);
                      }
                    }}
                    className={cn(
                      "cursor-pointer transition-colors",
                      "hover:bg-canvas-deeper",
                      "focus-visible:outline-none focus-visible:bg-canvas-deeper",
                      "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-signature"
                    )}
                  >
                    <Td align="left">
                      <span className="font-medium text-fg">{r.client_name || "—"}</span>
                    </Td>
                    <Td align="left" className="max-w-[280px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate" title={r.campaign_name}>
                          {r.campaign_name || "—"}
                        </span>
                        {r.has_abs && (
                          <span
                            className={cn(
                              "shrink-0 inline-flex items-center px-1.5 py-0.5 rounded",
                              "text-[9px] font-bold uppercase tracking-wide",
                              "border border-signature/40 bg-signature-soft text-signature"
                            )}
                            title={
                              r.media === "video"
                                ? "Campanha com ABS (pre-bid)"
                                : "Campanha com ABS (pre-bid) — tier de Tech Cost mais permissivo (≤10% saudável / >12% alto)"
                            }
                          >
                            ABS
                          </span>
                        )}
                      </div>
                    </Td>
                    <Td align="left">
                      {csName ? (
                        <span className="capitalize">{csName}</span>
                      ) : (
                        <span className="text-fg-subtle italic">Sem CS</span>
                      )}
                    </Td>
                    <Td
                      align="left"
                      tabular
                      className="text-fg-muted"
                      title={`Início: ${r.start_date || "—"} · Fim: ${r.end_date || "—"}`}
                    >
                      {formatDateRange(r.start_date, r.end_date) || "—"}
                    </Td>
                    <Td align="right" tabular>
                      {formatPctRow(r.totalEntreguePct, 1)}
                    </Td>
                    <Td
                      align="right"
                      tabular
                      className={cn("font-semibold", projTone)}
                      title="% que vai bater no final mantendo o ritmo atual"
                    >
                      {formatPctRow(r.projetadaPct, 1)}
                    </Td>
                    <Td
                      align="right"
                      tabular
                      className="text-fg-muted"
                      title="Ritmo ideal por dia pra bater 100% (contrato total ÷ dias totais da campanha) — baseline linear do plano"
                    >
                      {formatIntRow(r.idealDiaria)}
                    </Td>
                    <Td
                      align="right"
                      tabular
                      className={cn("font-semibold", mediaDiariaToneClass(r.mediaDiariaAtual, r.idealDiaria))}
                      title="Média real de entrega por dia (entregue até hoje ÷ dias decorridos). Régua de proximidade ao Ideal/Dia: |delta| ≤ 15% verde · ≤ 30% amarelo · > 30% vermelho. Acima OU abaixo do ideal são problema."
                    >
                      {formatIntRow(r.mediaDiariaAtual)}
                    </Td>
                    <Td align="center">
                      <StatusPill status={r.status} />
                    </Td>
                    <Td
                      align="right"
                      tabular
                      className={cn("font-semibold", cpmTone)}
                      title={
                        r.media === "video"
                          ? "eCPM real HYPR (custo cru DSP / 1k imps). Régua: <R$3 verde · <R$3,50 amarelo · ≥R$3,50 vermelho"
                          : r.has_abs
                            ? "eCPM real HYPR com ABS (pre-bid). Régua: <R$1,50 verde · <R$1,80 amarelo · ≥R$1,80 vermelho"
                            : "eCPM real HYPR (custo cru DSP / 1k imps). Régua: <R$0,70 verde · <R$0,80 amarelo · ≥R$0,80 vermelho"
                      }
                    >
                      {formatBrlRow(r.realEcpm, 2)}
                    </Td>
                    <Td
                      align="right"
                      tabular
                      title="Custo real total HYPR (DSP spend, sem margem cliente)"
                    >
                      {formatBrlRow(r.realTotalCost, 2)}
                    </Td>
                    <Td
                      align="right"
                      tabular
                      className={cn("font-semibold", techCostTone)}
                      title={
                        r.has_abs
                          ? "Custo real HYPR ÷ PI cliente (sem bônus). Com ABS — Régua: ≤10% verde · 10–12% amarelo · >12% vermelho"
                          : "Custo real HYPR ÷ PI cliente (sem bônus). Sem ABS — Régua: ≤8% verde · 8–10% amarelo · >10% vermelho"
                      }
                    >
                      {formatPctRow(r.techCostPct, 1)}
                    </Td>
                    <Td
                      align="right"
                      tabular
                      className={cn("font-semibold", viewabilityToneClass(r.viewability))}
                      title="Viewability: <60% vermelho · 60–70% amarelo · >70% verde"
                    >
                      {formatPctRow(r.viewability, 1)}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
