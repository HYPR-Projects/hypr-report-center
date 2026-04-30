// src/v2/admin/components/TrendPill.jsx
//
// Pill compacta indicando tendência: ↑ +12%, ↓ -3%, — 0%.
// Cores semânticas: up=success, down=danger, flat=neutro.
//
// Espelha exatamente o `compute_trend` do backend:
//   { pct: number, direction: "up" | "down" | "flat" }

import { cn } from "../../../ui/cn";

const STYLES = {
  up:   "bg-success-soft text-success",
  down: "bg-danger-soft  text-danger",
  flat: "bg-surface      text-fg-subtle",
};

const ARROW = {
  up:   "↑",
  down: "↓",
  flat: "—",
};

export function TrendPill({ trend, className }) {
  if (!trend || !trend.direction) return null;
  const styleCls = STYLES[trend.direction] || STYLES.flat;
  const arrow = ARROW[trend.direction] || ARROW.flat;
  const sign = trend.pct > 0 ? "+" : "";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full",
        "text-[11px] font-semibold tabular-nums",
        styleCls,
        className
      )}
      title={`Variação vs período anterior: ${sign}${trend.pct}%`}
    >
      <span aria-hidden="true">{arrow}</span>
      {sign}
      {Math.abs(trend.pct)}%
    </span>
  );
}
