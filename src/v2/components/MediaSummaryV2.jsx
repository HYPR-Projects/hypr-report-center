// src/v2/components/MediaSummaryV2.jsx
//
// Card de resumo por mídia (Display ou Video) com FOCO na comparação
// Negociado vs Efetivo — diferencial citado no ADR como prioritário.
//
// Diferenças vs Legacy MediaSummary:
//   - Layout hero: CPM Negociado e CPM Efetivo lado a lado, com delta %
//     destacado (verde se efetivo < negociado, vermelho se acima)
//   - KPIs secundários em grid abaixo (Imp.Visíveis, Clicks/Views100, CTR/VTR, CPC)
//   - Sem cálculo interno de CPM efetivo (usa o que já vem dos rows
//     calculado pela computeAggregates) — evita divergência sutil que
//     existia entre Legacy MediaSummary e o restante do dashboard
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

// Bloco hero: NEG. vs EFET. com delta. Cor do delta:
//   - rentab >  0 → success (efetivo abaixo do negociado, lucro)
//   - rentab <  0 → danger  (efetivo acima do negociado, prejuízo)
//   - rentab == 0 ou null → neutral (sem variação)
function NegVsEffective({ negLabel, negValue, effLabel, effValue, rentab }) {
  let pillColor = "text-fg-muted";
  let pillBg = "bg-surface-strong";
  let pillSign = "—";
  let pillText;

  if (rentab == null) {
    pillText = "—";
  } else if (rentab > 0) {
    pillColor = "text-success";
    pillBg = "bg-success-soft";
    pillSign = "↓";
    pillText = `${pillSign} ${fmtP(Math.abs(rentab))}`;
  } else if (rentab < 0) {
    pillColor = "text-danger";
    pillBg = "bg-danger-soft";
    pillSign = "↑";
    pillText = `${pillSign} ${fmtP(Math.abs(rentab))}`;
  } else {
    pillText = fmtP(0);
  }

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
      <div className="text-center">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          {negLabel}
        </div>
        <div className="text-2xl font-bold text-fg tabular-nums leading-tight mt-1">
          {fmtR(negValue)}
        </div>
      </div>

      <div
        className={cn(
          "rounded-full px-3 py-1 text-xs font-bold tabular-nums",
          pillBg,
          pillColor,
        )}
        title="Rentabilidade — diferença % entre o CPM/CPCV negociado e o efetivo entregue"
      >
        {pillText}
      </div>

      <div className="text-center">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          {effLabel}
        </div>
        <div className="text-2xl font-bold text-signature tabular-nums leading-tight mt-1">
          {fmtR(effValue)}
        </div>
      </div>
    </div>
  );
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

  return (
    <Card>
      <CardBody className="p-5 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-widest text-signature">
            {type}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>

        {/* Hero: Negociado vs Efetivo */}
        <NegVsEffective
          negLabel={isDisplay ? "CPM Negociado" : "CPCV Negociado"}
          negValue={isDisplay ? dealCpm : dealCpcv}
          effLabel={isDisplay ? "CPM Efetivo" : "CPCV Efetivo"}
          effValue={isDisplay ? effCpm : effCpcv}
          rentab={rentab}
        />

        {/* KPIs secundários */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-border">
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
