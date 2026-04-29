// src/v2/components/MediaSummaryV2.jsx
//
// Card de resumo por mídia (Display ou Video).
//
// LAYOUT (revisão "Linear/Vercel/Resend 2025"):
//   - Tipo da mídia (Display/Video) sai do "DISPLAY · CPM EFETIVO" antigo.
//     Vira label discreto no topo do card, sem competir com a métrica hero.
//   - Hero metric (CPM/CPCV efetivo) ganha hierarquia tipográfica clara:
//     valor grande, delta inline minúsculo (ícone + %, sem pill colorida),
//     label da métrica em sub-info abaixo.
//   - KPIs secundários reorganizados como stats em "value-first" (valor
//     em cima, label embaixo) — mesma convenção dos hero KPIs do topo da
//     visão geral.
//
// CONTAINER QUERIES (Tailwind v4 built-in)
//   O grid pai (Pacing/Resumo) ora coloca este card em 50% (Display+Video),
//   ora em 100% (apenas uma mídia). Em vez de reagir ao viewport, o card
//   reage ao próprio tamanho via @container:
//     - narrow (< @2xl ≈ 672px): hero em cima, stats embaixo
//     - wide  (≥ @2xl): hero à esquerda, stats à direita na mesma linha
//   Resolve o "espalhamento" do grid 4-col esticado em full-width sem
//   recorrer a viewport breakpoints (que não sabem o tamanho do container).
//
// Quando consumir
//   - Display: <MediaSummaryV2 type="DISPLAY" rows={display} />
//   - Video:   <MediaSummaryV2 type="VIDEO"   rows={video} />
//   - rows pode estar vazio — componente renderiza null silenciosamente.

import { fmt, fmtP, fmtR } from "../../shared/format";
import { cn } from "../../ui/cn";
import { Card, CardBody } from "../../ui/Card";

// Stat secundário (value-first, label embaixo). Tabular-nums pra alinhar
// dígitos verticalmente quando aparece em coluna.
function Stat({ label, value, accent = false }) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "text-[15px] font-semibold tabular-nums leading-tight truncate",
          accent ? "text-signature" : "text-fg",
        )}
      >
        {value}
      </div>
      <div className="text-[10.5px] text-fg-muted mt-1 truncate">{label}</div>
    </div>
  );
}

// Delta inline minimalista — só ícone + %, sem fundo de pill.
// Convenção: rentab > 0 = efetivo abaixo do negociado (lucro, verde, ↓).
function Delta({ rentab }) {
  if (rentab == null) {
    return <span className="text-[12px] tabular-nums text-fg-muted">—</span>;
  }
  if (rentab === 0) {
    return (
      <span className="text-[12px] font-medium tabular-nums text-fg-muted">
        {fmtP(0)}
      </span>
    );
  }
  const isGood = rentab > 0;
  return (
    <span
      className={cn(
        "text-[12px] font-medium tabular-nums",
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

  const heroLabel = isDisplay ? "CPM efetivo" : "CPCV efetivo";
  const heroValue = isDisplay ? effCpm : effCpcv;

  const stats = isDisplay
    ? [
        { label: "Imp. visíveis", value: fmt(totals.vi) },
        { label: "Clicks",        value: fmt(totals.clks) },
        { label: "CTR",           value: ctr == null ? "—" : fmtP(ctr), accent: true },
        { label: "CPC",           value: cpc == null ? "—" : fmtR(cpc) },
      ]
    : [
        { label: "Imp. visíveis",  value: fmt(totals.vi) },
        { label: "Views 100%",     value: fmt(totals.v100) },
        { label: "VTR",            value: vtr == null ? "—" : fmtP(vtr), accent: true },
        { label: "Custo efetivo",  value: fmtR(totals.cost) },
      ];

  return (
    <Card>
      <CardBody className="@container p-5">
        {/* Tipo da mídia: label discreto, sem competir com hero */}
        <div className="text-[11px] font-medium text-fg-muted mb-4">
          {isDisplay ? "Display" : "Video"}
        </div>

        {/* Hero + stats: empilha em narrow, lado a lado em wide (>= ~672px) */}
        <div className="flex flex-col gap-5 @2xl:flex-row @2xl:items-end @2xl:justify-between @2xl:gap-10">
          {/* Hero metric */}
          <div className="shrink-0">
            <div className="flex items-baseline gap-2.5">
              <span className="text-[30px] font-bold text-signature tabular-nums leading-none">
                {fmtR(heroValue)}
              </span>
              <Delta rentab={rentab} />
            </div>
            <div className="text-[11px] text-fg-muted mt-2">{heroLabel}</div>
          </div>

          {/* Stats secundários: 4 colunas sempre (cabem confortavelmente
              acima de ~360px de container). Encostados à direita em wide
              pra não esticar. */}
          <div className="grid grid-cols-4 gap-x-6 gap-y-3 @2xl:flex-1 @2xl:max-w-[640px]">
            {stats.map((s) => (
              <Stat key={s.label} label={s.label} value={s.value} accent={s.accent} />
            ))}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
