// src/v2/components/MediaSummaryV2.jsx
//
// Card de resumo por mídia (Display ou Video) — Stat Strip layout.
//
// LAYOUT (referência: Stripe Payments / Vercel Analytics / Linear)
//   Strip horizontal com 5 colunas iguais distribuindo todo o espaço
//   disponível, separadas por dividers sutis. A primeira célula é o
//   hero (CPM/CPCV efetivo) com o delta de rentabilidade inline; as
//   outras 4 são os KPIs secundários.
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ Display                                                          │
//   ├──────────┬──────────┬──────────┬──────────┬──────────────────────┤
//   │ R$ 14,40 │ 6.263.110│  38.444  │  0,6%    │ R$ 2,35              │
//   │ ↓ 0,0%   │          │          │          │                      │
//   │ CPM ef.  │ Imp.vis. │ Clicks   │ CTR      │ CPC                  │
//   └──────────┴──────────┴──────────┴──────────┴──────────────────────┘
//
// DECISÕES DE DESIGN
//   - Tipografia uniforme (todos os valores em 22px) para evitar drama
//     visual. Hierarquia é feita por COR: hero e métrica de qualidade
//     (CTR/VTR) ganham `text-signature`; demais ficam neutras. Padrão
//     adotado por dashboards operacionais top-tier.
//   - Dividers `border-border/40` ancoram visualmente sem fazer barulho.
//     Density adequada — não vira "card vazio com números soltos".
//   - 5 colunas iguais (`grid-cols-5`) com `divide-x` distribuem o
//     espaço uniformemente em qualquer largura — resolve tanto card
//     metade (~620px) quanto card full-width (~1300px) sem reorganizar.
//   - Em mobile, vira coluna única com `divide-y` (acessível, sem grid
//     apertado).
//
// Quando consumir
//   - Display: <MediaSummaryV2 type="DISPLAY" rows={display} />
//   - Video:   <MediaSummaryV2 type="VIDEO"   rows={video} />
//   - rows pode estar vazio — componente renderiza null silenciosamente.

import { fmt, fmtP, fmtR } from "../../shared/format";
import { cn } from "../../ui/cn";
import { Card, CardBody } from "../../ui/Card";

// Célula do strip. Valor (com delta opcional inline) em cima, label embaixo.
function StatCell({ label, value, accent = false, delta = null }) {
  return (
    <div className="px-5 py-4 min-w-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span
          className={cn(
            "text-[22px] font-semibold tabular-nums leading-tight truncate",
            accent ? "text-signature" : "text-fg",
          )}
        >
          {value}
        </span>
        {delta !== null && delta !== undefined && <Delta rentab={delta} />}
      </div>
      <div className="text-[11px] text-fg-muted mt-1.5 truncate">{label}</div>
    </div>
  );
}

// Delta inline minimalista — ícone + %, sem fundo de pill.
// Convenção: rentab > 0 = efetivo abaixo do negociado (lucro, verde, ↓).
function Delta({ rentab }) {
  if (rentab == null) {
    return <span className="text-[11px] tabular-nums text-fg-muted">—</span>;
  }
  if (rentab === 0) {
    return (
      <span className="text-[11px] font-medium tabular-nums text-fg-muted">
        {fmtP(0)}
      </span>
    );
  }
  const isGood = rentab > 0;
  return (
    <span
      className={cn(
        "text-[11px] font-medium tabular-nums whitespace-nowrap",
        isGood ? "text-success" : "text-danger",
      )}
      title="Rentabilidade — diferença % entre o CPM/CPCV negociado e o efetivo entregue"
    >
      {isGood ? "↓" : "↑"} {fmtP(Math.abs(rentab))}
    </span>
  );
}

export function MediaSummaryV2({ type, rows }) {
  if (!rows || rows.length === 0) return null;

  const isDisplay = type === "DISPLAY";

  // Soma delivery e custo de TODAS as tactics da mesma mídia
  // (Display O2O + Display OOH compõem a visão "Display").
  const totals = rows.reduce(
    (acc, r) => ({
      vi:   acc.vi   + (r.viewable_impressions || 0),
      clks: acc.clks + (r.clicks || 0),
      v100: acc.v100 + (r.completions || 0),
      cost: acc.cost + (r.effective_total_cost || 0),
    }),
    { vi: 0, clks: 0, v100: 0, cost: 0 },
  );

  // CPM/CPCV negociado: vem do contrato, igual em todas as tactics.
  const dealCpm  = rows[0].deal_cpm_amount  || 0;
  const dealCpcv = rows[0].deal_cpcv_amount || 0;

  // Efetivo agregado: recalcula a partir das somas (não dá pra "somar" CPMs).
  const effCpm  = totals.vi   > 0 ? (totals.cost / totals.vi)   * 1000 : 0;
  const effCpcv = totals.v100 > 0 ?  totals.cost / totals.v100         : 0;

  // Rentabilidade agregada.
  let rentab = null;
  if (isDisplay && dealCpm > 0) {
    rentab = ((dealCpm - effCpm) / dealCpm) * 100;
  } else if (!isDisplay && dealCpcv > 0) {
    rentab = ((dealCpcv - effCpcv) / dealCpcv) * 100;
  }

  const ctr = totals.vi   > 0 ? (totals.clks / totals.vi) * 100 : null;
  const vtr = totals.vi   > 0 ? (totals.v100 / totals.vi) * 100 : null;
  const cpc = totals.clks > 0 && effCpm > 0
    ? (effCpm / 1000) * (totals.vi / totals.clks)
    : null;

  // Cells do strip — hero é a primeira (com delta), as 4 seguintes são
  // os KPIs secundários. CTR/VTR ficam em accent (métrica de qualidade).
  const cells = isDisplay
    ? [
        { label: "CPM efetivo",  value: fmtR(effCpm),         accent: true,  delta: rentab },
        { label: "Imp. visíveis", value: fmt(totals.vi) },
        { label: "Clicks",        value: fmt(totals.clks) },
        { label: "CTR",           value: ctr == null ? "—" : fmtP(ctr), accent: true },
        { label: "CPC",           value: cpc == null ? "—" : fmtR(cpc) },
      ]
    : [
        { label: "CPCV efetivo",  value: fmtR(effCpcv),        accent: true,  delta: rentab },
        { label: "Imp. visíveis", value: fmt(totals.vi) },
        { label: "Views 100%",    value: fmt(totals.v100) },
        { label: "VTR",           value: vtr == null ? "—" : fmtP(vtr),  accent: true },
      ];

  return (
    <Card>
      <CardBody className="p-0">
        {/* Header com border-bottom ancorando o card */}
        <div className="px-5 py-3 border-b border-border">
          <div className="text-[12px] font-medium text-fg-muted">
            {isDisplay ? "Display" : "Video"}
          </div>
        </div>

        {/* Strip: N colunas iguais com dividers verticais em desktop;
            coluna única com dividers horizontais em mobile.
            Display tem 5 cells (CPM + 4 KPIs), Video tem 4 (CPCV + 3 KPIs). */}
        <div
          className={cn(
            "grid grid-cols-1 divide-y md:divide-y-0 md:divide-x divide-border/40",
            cells.length === 5 ? "md:grid-cols-5" : "md:grid-cols-4",
          )}
        >
          {cells.map((c) => (
            <StatCell
              key={c.label}
              label={c.label}
              value={c.value}
              accent={c.accent}
              delta={c.delta}
            />
          ))}
        </div>
      </CardBody>
    </Card>
  );
}
