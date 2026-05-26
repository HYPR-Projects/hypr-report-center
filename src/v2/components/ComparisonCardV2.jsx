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
//     negociadoComBonus={20.00}  // opcional — só quando campanha tem bonus
//     formatValue={(v) => fmtR(v)}
//     decimalsForDelta={1}
//   />
//
// negociadoComBonus
//   CPM contratual recalculado contra (contracted + bonus). Quando
//   presente E diferente do negociado, a card RESTRUTURA o layout em
//   3 cells com semântica diferente, exibindo a trajetória real do
//   deal (bonus é considerado parte do contrato):
//
//     ┌───────────────────┬────────────────────┬────────────┐
//     │ CPM Tabela HYPR   │ Negociado Ajustado │ Efetivo    │
//     │ (rate contrato    │ (rate considerando │ (entrega   │
//     │  pré-bonus)       │  bonus)            │  real)     │
//     └───────────────────┴────────────────────┴────────────┘
//
//   Drop da cell "Economia" nesse caso é proposital: comparar
//   Efetivo contra Tabela mostra "Sem variação" enquanto bonus não
//   roda (uninformativo); comparar contra Ajustado mostra "↑ 44%
//   Variação" durante todo o período contratado (alarmista falso).
//   A trajetória Tabela → Ajustado → Efetivo já comunica visualmente
//   onde o cliente está vs onde o deal vai chegar.
//
//   Pra campanhas SEM bonus, mantém o layout 3-cells clássico
//   (Negociado | Efetivo | Economia) — Economia é informativa quando
//   não há bonus distorcendo o cálculo.

import { Card } from "../../ui/Card";
import { cn } from "../../ui/cn";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../ui/Tooltip";

export function ComparisonCardV2({
  title,
  negociado,
  efetivo,
  negociadoComBonus,
  // Quando true, o cell "Efetivo" ganha sublinhado pontilhado + asterisco
  // e tooltip explicando que é projeção (não factual atual). Usado em
  // campanhas com bonus negociado — ver DisplayV2/VideoV2.
  efetivoIsProjection = false,
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

  // Switch de layout: campanhas COM bonus mostram a trajetória
  // Tabela → Ajustado → Efetivo (sem Economia — ver doc no topo).
  // Campanhas SEM bonus mantêm Negociado | Efetivo | Economia. Threshold
  // de 1 centavo evita falso-positivo por arredondamento.
  const hasBonus =
    typeof negociadoComBonus === "number" &&
    negociadoComBonus > 0 &&
    typeof negociado === "number" &&
    negociado > 0 &&
    Math.abs(negociadoComBonus - negociado) >= 0.01;

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
        {hasBonus ? (
          <>
            {/* Trajetória pra campanhas com bonus negociado. Tabela
                HYPR = CPM contratual cru; Ajustado = mesmo budget
                contra (contracted + bonus); Efetivo = entrega real. */}
            <ComparisonCell
              label="CPM Tabela HYPR"
              value={formatValue(negociado)}
              tone="muted"
            />
            <ComparisonCell
              label="Negociado Ajustado"
              value={formatValue(negociadoComBonus)}
              tone="muted"
            />
            <ComparisonCell
              label="Efetivo"
              value={hasValues ? formatValue(efetivo) : "—"}
              tone="accent"
              indicator={efetivoIsProjection ? "*" : null}
              tooltip={efetivoIsProjection
                ? "Projeção mantendo o ritmo atual de entrega até o fim da campanha. Conforme o pacing oscila, o valor se ajusta. Se o pacing chegar a 100%, este número converge para o Negociado Ajustado."
                : null}
            />
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </Card>
  );
}

function ComparisonCell({ label, value, tone = "default", indicator = null, tooltip = null }) {
  // Quando há tooltip, o label vira "trigger" com sublinhado pontilhado
  // (mesmo padrão do KpiCardV2.hint pra consistência visual).
  const labelEl = (
    <span
      className={cn(
        "inline-block text-[11px] text-fg-muted truncate",
        tooltip &&
          "underline decoration-dotted decoration-fg-subtle underline-offset-4 cursor-help",
      )}
    >
      {label}
    </span>
  );
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
        {indicator && (
          <sup className="ml-0.5 text-[14px] font-medium text-fg-subtle">
            {indicator}
          </sup>
        )}
      </div>
      <div className="mt-1.5">
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger asChild>{labelEl}</TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[280px]">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        ) : (
          labelEl
        )}
      </div>
    </div>
  );
}
