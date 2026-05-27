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
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../ui/Tooltip";
import { localPartFromEmail, ecpmToneClass, formatDateRange, ctrColorClass } from "../lib/format";
import {
  STATUS_META,
  formatPctRow,
  formatIntRow,
  formatBrlRow,
  techCostToneClass,
  mediaDiariaToneClass,
  viewabilityToneClass,
  d1VsFaltaInfo,
  buildVerdict,
  compareNullableNumbers,
} from "../lib/diagnostico";

// ────────────────────────────────────────────────────────────────────────
// Veredito da campanha — dot + label curto + modifier de tendência
// ────────────────────────────────────────────────────────────────────────
//
// Substituiu o StatusDot dot-only. Agora a coluna Status comunica direto:
// "Under ↗ recuperando", "OK", "Over ↘ desacelerando" — em vez de obrigar
// o CS a olhar Projetada + Falta/Dia + Ontem pra entender se a campanha
// tá indo bem.
//
// Visual: dot pequeno colorido + texto curto. Modifier de tendência fica
// abaixo do label principal em fonte menor, sem inflar a altura da row.
// Tooltip mantém o detalhe operacional.
function StatusVerdict({ row }) {
  const meta = STATUS_META[row.status];
  if (!meta) return <span className="text-fg-subtle">—</span>;
  const verdict = buildVerdict({
    status: row.status,
    deliveredD1: row.deliveredD1,
    minDiariaContratada: row.minDiariaContratada,
    mediaDiariaAtual: row.mediaDiariaAtual,
  });
  const imbalancePromoted = row.front_imbalance && row.front_imbalance.status === row.status;
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1.5 cursor-help align-middle"
          aria-label={meta.label}
          onClick={(e) => e.stopPropagation()}
        >
          <span
            className={cn(
              "inline-block size-2 rounded-full shrink-0",
              meta.dotClass,
              meta.textClass,
              "shadow-[0_0_4px_currentColor]"
            )}
          />
          <span className="inline-flex flex-col items-start leading-tight">
            <span className={cn("text-xs font-semibold whitespace-nowrap", meta.textClass)}>
              {verdict.label}
            </span>
            {verdict.trendLabel && (
              <span className={cn("text-[10px] font-medium whitespace-nowrap", verdict.trendTone)}>
                {verdict.trendLabel}
              </span>
            )}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">
        <div className="flex flex-col gap-0.5">
          <span className={cn("font-semibold", meta.textClass)}>{meta.label}</span>
          <span className="text-fg-muted">{meta.description}</span>
          {verdict.trendLabel && (
            <span className="text-fg-muted">
              {verdict.trendLabel === "↗ recuperando"
                ? "Ontem (D-1) entregou acima do necessário pra fechar — pode virar."
                : "Ontem (D-1) entregou abaixo da média recente — perdendo ritmo."}
            </span>
          )}
          {imbalancePromoted && (
            <span className="text-fg-muted">
              Frente {row.front_imbalance.worstLabel} em {row.front_imbalance.worstPacing.toFixed(1)}% — combinado esconde o risco
            </span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
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
        "px-2 py-2.5",
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
        "px-2 py-2.5",
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
    // Resolve o nome do CS do row do mesmo jeito que o render faz: row só
    // carrega `cs_email`, e o display passa por teamMap (nome bonito) com
    // fallback pro local-part do email. Sem isso, sortar por "cs_name"
    // virava no-op porque o campo não existe no row → tudo "" → toggles
    // de asc/desc não reordenavam nada (esse era o bug reportado).
    const resolveCsName = (r) => {
      if (!r.cs_email) return "";
      return (teamMap[r.cs_email] || localPartFromEmail(r.cs_email) || "").toLowerCase();
    };
    arr.sort((a, b) => {
      // CS: nome derivado de cs_email via teamMap. Rows sem CS ("Sem CS")
      // vão sempre pro fim, independente da direção — não faz sentido
      // misturar com nomes ordenados.
      if (sortKey === "cs_name") {
        const av = resolveCsName(a);
        const bv = resolveCsName(b);
        if (!av && bv) return 1;
        if (av && !bv) return -1;
        if (!av && !bv) return 0;
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      // Strings (client_name, campaign_name, start_date ISO) ordenam
      // alfabeticamente. start_date como "YYYY-MM-DD" já bate com ordem
      // cronológica via localeCompare.
      if (sortKey === "client_name" || sortKey === "campaign_name" || sortKey === "start_date") {
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
  }, [filteredRows, sortKey, sortDir, teamMap]);

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
          {/* table-fixed + larguras explícitas por coluna pra ritmo visual
              consistente — sem table-fixed o browser distribui excesso de
              forma desigual e a grade fica visualmente "respirando" demais
              entre as colunas numéricas. */}
          <table className="w-full text-left table-fixed">
            <thead>
              <tr>
                {/* Larguras balanceadas: colunas com texto (Cliente, Campanha)
                    ganham espaço; colunas com % curto (Entregue, View, CTR,
                    Tech) encolhem. Ontem (D-1) encolheu porque virou só
                    "número + ✓/✗" depois da remoção do delta vs média.
                    Soma = 100%. */}
                <Th align="left"  {...headerProps("status")}            className="w-[7%] px-2">Status</Th>
                <Th align="left"  {...headerProps("client_name")}       className="w-[10%]">Cliente</Th>
                <Th align="left"  {...headerProps("campaign_name")}     className="w-[14%]">Campanha</Th>
                <Th align="left"  {...headerProps("cs_name")}           className="w-[5%]">CS</Th>
                <Th align="left"  {...headerProps("start_date")}        className="w-[7%]">Período</Th>
                <Th align="right" {...headerProps("totalEntreguePct")}  className="w-[5%]">Entregue</Th>
                <Th align="right" {...headerProps("projetadaPct")}      className="w-[6%]">Projetada</Th>
                <Th align="right" {...headerProps("minDiariaContratada")} className="w-[6%]">Falta/Dia</Th>
                <Th align="right" {...headerProps("mediaDiariaAtual")}  className="w-[6%]">Média/Dia</Th>
                <Th align="right" {...headerProps("deliveredD1")}       className="w-[7%]">Ontem (D-1)</Th>
                <Th align="right" {...headerProps("realEcpm")}          className="w-[5%]">CPM</Th>
                <Th align="right" {...headerProps("realTotalCost")}     className="w-[8%]">Custo</Th>
                <Th align="right" {...headerProps("techCostPct")}       className="w-[4%]">Tech</Th>
                <Th align="right" {...headerProps("viewability")}       className="w-[5%]">View.</Th>
                <Th align="right" {...headerProps("ctr")}               className="w-[5%]">CTR</Th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => {
                const csFullName = r.cs_email
                  ? (teamMap[r.cs_email] || localPartFromEmail(r.cs_email))
                  : null;
                // Compacta "Thiago Nascimento" → "Thiago N." pra reduzir
                // a largura da coluna. Split por espaço OU ponto cobre
                // tanto teamMap ("Thiago Nascimento") quanto fallback de
                // email ("thiago.nascimento"). Capitalize CSS já normaliza
                // o resultado pro caso do fallback.
                const csName = csFullName
                  ? (() => {
                      const parts = csFullName.trim().split(/[\s.]+/).filter(Boolean);
                      if (parts.length < 2) return parts[0] || csFullName;
                      return `${parts[0]} ${parts[1][0].toUpperCase()}.`;
                    })()
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
                    <Td align="left" className="w-[7%] px-2">
                      <StatusVerdict row={r} />
                    </Td>
                    <Td align="left" title={r.client_name || undefined}>
                      <span className="font-medium text-fg">
                        {(() => {
                          const name = r.client_name || "—";
                          // Coluna ganhou ~10% de largura na redistribuição —
                          // sobe limite de 12 → 15 chars pra "GeneralMotors"
                          // (13) e "MERCEDES-BENZ" (13) caberem sem truncar.
                          // Nome completo continua no tooltip do <td>.
                          return name.length > 15 ? name.slice(0, 14) + "…" : name;
                        })()}
                      </span>
                    </Td>
                    <Td align="left" className="max-w-[260px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate" title={r.campaign_name}>
                          {(() => {
                            const name = r.campaign_name || "—";
                            // Limite sobe 20 → 24 chars junto com a coluna
                            // (13% → 14% de largura) — cobre nomes operacionais
                            // mais longos tipo "SPRINTER AUTOMÁTICA Q2".
                            return name.length > 24 ? name.slice(0, 23) + "…" : name;
                          })()}
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
                    <Td align="left" title={csFullName || undefined}>
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
                      title="% que vai bater no final mantendo o ritmo médio da última semana (7 dias). Fallback pra D-1 ou pacing histórico quando não tem dado recente."
                    >
                      {formatPctRow(r.projetadaPct, 1)}
                    </Td>
                    <Td
                      align="right"
                      tabular
                      className="text-fg-muted"
                      title="Ritmo diário NECESSÁRIO daqui pra frente pra fechar 100% do contrato — recalculado todo dia: (contrato − entregue) ÷ dias restantes. Se a campanha tá under, esse número sobe; se tá over, vira '—' (não precisa de mínima)."
                    >
                      {formatIntRow(r.minDiariaContratada)}
                    </Td>
                    <Td
                      align="right"
                      tabular
                      className={cn("font-semibold", mediaDiariaToneClass(r.mediaDiariaAtual, r.minDiariaContratada))}
                      title="Média real de entrega por dia (entregue até hoje ÷ dias decorridos). Régua de proximidade à Falta/Dia: |delta| ≤ 15% verde · ≤ 30% amarelo · > 30% vermelho. Verde = no ritmo de catch-up; vermelho = falta entregar mais (under) ou tá entregando demais (over)."
                    >
                      {formatIntRow(r.mediaDiariaAtual)}
                    </Td>
                    {(() => {
                      // Indicador principal: D-1 deu conta do necessário (Falta/Dia)?
                      // Mais útil que comparar com a média histórica — responde
                      // direto a pergunta "ontem foi suficiente pra fechar?".
                      const d1Verdict = d1VsFaltaInfo(r.deliveredD1, r.minDiariaContratada);
                      return (
                        <Td
                          align="right"
                          tabular
                          title={
                            r.deliveredD1 == null || r.deliveredD1 <= 0
                              ? "Sem entrega registrada ontem (D-1)"
                              : d1Verdict
                                ? `Ontem entregou ${formatIntRow(r.deliveredD1)} vs ${formatIntRow(r.minDiariaContratada)} necessário/dia. ` +
                                  (d1Verdict.ok
                                    ? `${formatIntRow(Math.abs(d1Verdict.gap))} acima do necessário — se mantiver, vai fechar 100%.`
                                    : `Faltaram ${formatIntRow(Math.abs(d1Verdict.gap))}/dia — abaixo do ritmo de catch-up.`)
                                : `Ontem entregou ${formatIntRow(r.deliveredD1)}. Sem Falta/Dia pra comparar (campanha já bateu 100%).`
                          }
                        >
                          {r.deliveredD1 != null && r.deliveredD1 > 0 ? (
                            <span className="inline-flex items-baseline gap-1.5">
                              <span>{formatIntRow(r.deliveredD1)}</span>
                              {d1Verdict && (
                                <span className={cn("text-[11px] font-bold", d1Verdict.tone)}>
                                  {d1Verdict.icon}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-fg-subtle">—</span>
                          )}
                        </Td>
                      );
                    })()}
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
                    <Td
                      align="right"
                      tabular
                      className={cn("font-semibold", ctrColorClass(r.ctr))}
                      title="CTR (clicks / impressões totais): <0,50% vermelho · 0,50–0,65% amarelo · ≥0,65% verde"
                    >
                      {formatPctRow(r.ctr, 2)}
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
