// src/v2/components/MediaSummaryV2.jsx
//
// Card de resumo por mídia (Display ou Video) — versão compacta inline.
//
// LAYOUT (PR-16 audit visual):
//   ┌─────────────────────────────────────────────┐
//   │ DISPLAY · CPM EFETIVO   R$ 10,05  ↓ 30,2%   │
//   │ ─────────────────────────────────────────── │
//   │ IMP.VISÍVEIS  CLICKS    CTR     CPC         │
//   │ 25.073.420   135.704    0,5%    R$ 1,86     │
//   └─────────────────────────────────────────────┘
//
// Mudanças vs versão anterior (PR-13/PR-14):
//   - Header e hero fundidos numa única linha (label tipo+métrica à esq,
//     valor+pill à dir) — economiza ~3 linhas verticais.
//   - Lado "Negociado" removido (já redundante: aparece no header da
//     campanha e no ComparisonCardV2 das tabs Display/Video).
//   - ComparisonRow saiu da OverviewV2 → este card é a única referência
//     da Visão Geral pra performance por mídia, mas continua secundário
//     ao Hero KPI lá em cima — daí o aperto visual é proposital.
//
// Por que recebe array `rows` (e não `row` único)
//   Uma mesma mídia pode ter múltiplas tactics (Display O2O + Display OOH).
//   Recebemos o array filtrado por media_type, somamos delivery (vi, clks,
//   v100, cost) e usamos cpm/cpcv negociado da primeira tactic (mesmo valor
//   contratual aplicado a todas). Para CPM/CPCV efetivo agregado, somamos
//   custo total e dividimos pelo delivery total — fórmula dimensional
//   idêntica à do backend.
//
// Quando consumir
//   - Display: <MediaSummaryV2 type="DISPLAY" rows={display} />
//   - Video:   <MediaSummaryV2 type="VIDEO"   rows={video} />
//   - rows pode estar vazio — componente renderiza null silenciosamente.

import { fmt, fmtP, fmtR } from "../../shared/format";
import { cn } from "../../ui/cn";
import { Card, CardBody } from "../../ui/Card";

// Renderiza um KPI compacto (label uppercase, valor tabular)
function MiniKpi({ label, value, accent = false }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
        {label}
      </div>
      <div
        className={cn(
          "text-base font-bold tabular-nums leading-tight mt-1 truncate",
          accent ? "text-signature" : "text-fg",
        )}
      >
        {value}
      </div>
    </div>
  );
}

// Estilo da pill de rentabilidade. Convenção:
//   - rentab >  0 → success (efetivo abaixo do negociado, lucro)
//   - rentab <  0 → danger  (efetivo acima do negociado, prejuízo)
//   - rentab == 0 ou null → neutral
function getPillStyle(rentab) {
  if (rentab == null) {
    return { bg: "bg-surface-strong", color: "text-fg-muted", text: "—" };
  }
  if (rentab > 0) {
    return {
      bg: "bg-success-soft",
      color: "text-success",
      text: `↓ ${fmtP(Math.abs(rentab))}`,
    };
  }
  if (rentab < 0) {
    return {
      bg: "bg-danger-soft",
      color: "text-danger",
      text: `↑ ${fmtP(Math.abs(rentab))}`,
    };
  }
  return { bg: "bg-surface-strong", color: "text-fg-muted", text: fmtP(0) };
}

export function MediaSummaryV2({ type, rows }) {
  if (!rows || rows.length === 0) return null;

  const isDisplay = type === "DISPLAY";

  // Soma delivery e custo de TODAS as tactics da mesma mídia.
  // (Display O2O + Display OOH compõem a visão "Display", e os números
  // contratuais como deal_cpm são iguais entre tactics — mesmo deal.)
  const totals = rows.reduce(
    (acc, r) => ({
      vi:   acc.vi   + (r.viewable_impressions || 0),
      clks: acc.clks + (r.clicks || 0),
      v100: acc.v100 + (r.completions || 0),
      cost: acc.cost + (r.effective_total_cost || 0),
    }),
    { vi: 0, clks: 0, v100: 0, cost: 0 },
  );

  // CPM/CPCV negociado: vem do contrato, igual em todas as tactics
  const dealCpm  = rows[0].deal_cpm_amount  || 0;
  const dealCpcv = rows[0].deal_cpcv_amount || 0;

  // CPM/CPCV efetivo agregado: recalcula a partir das somas — fórmula
  // dimensional idêntica ao backend. Não dá pra "somar" CPMs.
  const effCpm  = totals.vi   > 0 ? (totals.cost / totals.vi)   * 1000 : 0;
  const effCpcv = totals.v100 > 0 ?  totals.cost / totals.v100         : 0;

  // Rentabilidade agregada: re-calcula com base nos efetivos somados.
  // Se rentab estiver presente em row[0] e só houver uma tactic, é
  // equivalente ao valor já computado em computeAggregates.
  let rentab = null;
  if (isDisplay && dealCpm > 0) {
    rentab = ((dealCpm - effCpm) / dealCpm) * 100;
  } else if (!isDisplay && dealCpcv > 0) {
    rentab = ((dealCpcv - effCpcv) / dealCpcv) * 100;
  }

  const ctr = totals.vi > 0 ? (totals.clks / totals.vi) * 100 : null;
  const vtr = totals.vi > 0 ? (totals.v100 / totals.vi) * 100 : null;
  const cpc = totals.clks > 0 && effCpm > 0
    ? (effCpm / 1000) * (totals.vi / totals.clks)
    : null;

  const effLabel = isDisplay ? "CPM Efetivo" : "CPCV Efetivo";
  const effValue = isDisplay ? effCpm : effCpcv;
  const pill = getPillStyle(rentab);

  return (
    <Card>
      <CardBody className="p-4 space-y-3">
        {/* Linha hero compacta: tipo · label  ────────  valor + pill */}
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[11px] font-bold uppercase tracking-widest text-signature">
              {type}
            </span>
            <span className="text-fg-subtle">·</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
              {effLabel}
            </span>
          </div>
          <div className="flex items-baseline gap-2 shrink-0">
            <span className="text-2xl font-bold text-signature tabular-nums leading-tight">
              {fmtR(effValue)}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums",
                pill.bg,
                pill.color,
              )}
              title="Rentabilidade — diferença % entre o CPM/CPCV negociado e o efetivo entregue"
            >
              {pill.text}
            </span>
          </div>
        </div>

        {/* KPIs secundários */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-border">
          <MiniKpi label="Imp. Visíveis" value={fmt(totals.vi)} />
          {isDisplay ? (
            <>
              <MiniKpi label="Clicks" value={fmt(totals.clks)} />
              <MiniKpi label="CTR" value={ctr == null ? "—" : fmtP(ctr)} accent />
              <MiniKpi label="CPC" value={cpc == null ? "—" : fmtR(cpc)} />
            </>
          ) : (
            <>
              <MiniKpi label="Views 100%" value={fmt(totals.v100)} />
              <MiniKpi label="VTR" value={vtr == null ? "—" : fmtP(vtr)} accent />
              <MiniKpi label="Custo Efetivo" value={fmtR(totals.cost)} />
            </>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
