// src/v2/components/ComparisonCardV2.jsx
//
// Card "Negociado vs Efetivo" — destaque do diferencial HYPR.
// Mostrado no header das abas Display e Video.
//
// LAYOUT (refatorado pra casar com o stat strip do MediaSummaryV2)
//   ┌──────────────────────────────────────────────────────────┐
//   │ CPM Display · O2O                                         │
//   ├──────────────┬───────────────┬───────────────────────────┤
//   │ R$ 14,40     │ R$ 8,96       │ ↓ 37,7%                   │
//   │ Negociado    │ Efetivo       │ Economia                  │
//   └──────────────┴───────────────┴───────────────────────────┘
//
// DECISÕES DE DESIGN
//   - 3 cells iguais (grid-cols-3) com dividers sutis — distribui
//     espaço uniformemente, sem dominante visual desproporcional.
//   - Hierarquia por COR, não por fundo:
//       Negociado: text-fg-muted (contexto, "antes")
//       Efetivo:   text-signature (resultado, "depois")
//       Economia:  text-success c/ seta ↓ (diferencial HYPR)
//     Sem bg-success-soft no card: a cor da fonte + seta + label
//     "Economia" carregam a mensagem sem ruído visual.
//   - Tipografia uniforme (22px valores, 11px labels) — mesma
//     linguagem do MediaSummaryV2 e dos hero KPIs.
//   - Header simplificado: "CPM Display · O2O" (sem "Negociado vs
//     Efetivo" redundante — labels embaixo já comunicam).
//
// API:
//   <ComparisonCardV2
//     title="CPM Display · O2O"
//     negociado={25.00}
//     efetivo={18.82}
//     formatValue={(v) => fmtR(v)}
//     decimalsForDelta={1}
//   />

import { Card } from "../../ui/Card";
import { cn } from "../../ui/cn";

export function ComparisonCardV2({
  title,
  negociado,
  efetivo,
  formatValue,
  decimalsForDelta = 1,
  className,
}) {
  const hasValues =
    typeof negociado === "number" &&
    typeof efetivo === "number" &&
    negociado > 0;

  // Economia = (negociado - efetivo) / negociado.
  // Positiva = HYPR entregou mais barato (efetivo < negociado, ↓).
  // Negativa = saiu mais caro (raro, sinaliza problema, ↑).
  // Threshold de 0.05% pra tratar oscilações ínfimas como neutras.
  const economyPct = hasValues
    ? ((negociado - efetivo) / negociado) * 100
    : null;
  const isSignificant = economyPct !== null && Math.abs(economyPct) >= 0.05;
  const isEconomy = isSignificant && economyPct > 0;
  const isLoss = isSignificant && economyPct < 0;

  const economyDisplay = !isSignificant
    ? "—"
    : `${isEconomy ? "↓" : "↑"} ${Math.abs(economyPct).toFixed(decimalsForDelta)}%`;

  const economyLabel = isEconomy
    ? "Economia"
    : isLoss
      ? "Variação"
      : "Sem variação";

  return (
    <Card
      className={cn(
        "border-border-strong overflow-hidden p-0",
        className,
      )}
    >
      {/* Header — title case, sem uppercase tracking gritante */}
      <div className="px-5 py-3 border-b border-border">
        <div className="text-[12px] font-medium text-fg-muted">{title}</div>
      </div>

      {/* Strip 3 cells iguais com dividers verticais em desktop;
          coluna única com dividers horizontais em mobile.
          items-stretch + h-full nas cells garantem altura consistente
          do border-l mesmo se conteúdo quebrar linha. */}
      <div className="grid grid-cols-1 md:grid-cols-3 items-stretch divide-y md:divide-y-0 md:divide-x divide-border/60">
        <ComparisonCell
          label="Negociado"
          value={hasValues ? formatValue(negociado) : "—"}
          tone="muted"
        />
        <ComparisonCell
          label="Efetivo"
          value={hasValues ? formatValue(efetivo) : "—"}
          tone="accent"
        />
        <ComparisonCell
          label={economyLabel}
          value={economyDisplay}
          tone={isEconomy ? "success" : isLoss ? "danger" : "muted"}
        />
      </div>
    </Card>
  );
}

function ComparisonCell({ label, value, tone = "default" }) {
  return (
    <div className="px-5 py-4 min-w-0 h-full flex flex-col">
      <div
        className={cn(
          "text-[22px] font-semibold tabular-nums leading-tight truncate",
          tone === "muted" && "text-fg-muted",
          tone === "accent" && "text-signature",
          tone === "success" && "text-success",
          tone === "danger" && "text-danger",
          tone === "default" && "text-fg",
        )}
      >
        {value}
      </div>
      <div className="text-[11px] text-fg-muted mt-1.5 truncate">{label}</div>
    </div>
  );
}
