// src/v2/admin/components/MonthFilterPills.jsx
//
// Pills horizontais: [Todos · 211] [Abril · 58] [Março · 60] ...
// Click em uma pill aplica filtro de mês; click novamente em pill ativa
// limpa.
//
// Espelha a "Acesso Rápido por Mês" do legacy mas com visual atualizado:
// pills mais compactas, contagem em badge interna, e cor signature pra
// estado ativo (em vez de azul saturado preenchido).

import { useMemo } from "react";
import { cn } from "../../../ui/cn";
import { formatMonthLabel } from "../lib/format";

export function MonthFilterPills({ campaigns, activeMonth, onChange, className }) {
  // Lista de meses únicos com contagem, ordenados decrescente (mais recente
  // primeiro). useMemo pra não recomputar a cada render do parent.
  const months = useMemo(() => {
    const counter = new Map();
    for (const c of campaigns || []) {
      const m = c.start_date?.slice(0, 7);
      if (!m) continue;
      counter.set(m, (counter.get(m) || 0) + 1);
    }
    return [...counter.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([month, count]) => ({ month, count }));
  }, [campaigns]);

  if (months.length === 0) return null;

  const totalCount = campaigns?.length || 0;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <PillButton
        active={activeMonth === null}
        label="Todos"
        count={totalCount}
        onClick={() => onChange(null)}
      />
      {months.map(({ month, count }) => (
        <PillButton
          key={month}
          active={activeMonth === month}
          label={formatMonthLabel(month, "short")}
          count={count}
          onClick={() => onChange(activeMonth === month ? null : month)}
        />
      ))}
    </div>
  );
}

function PillButton({ active, label, count, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 h-8 px-3.5 rounded-full",
        "text-xs font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
        active
          ? "bg-signature-soft text-fg border border-signature/40"
          : "bg-surface text-fg-muted border border-border hover:bg-surface-strong hover:text-fg"
      )}
    >
      {label}
      <span
        className={cn(
          "inline-flex items-center justify-center min-w-[22px] h-4 px-1.5 rounded-full text-[10px] font-bold tabular-nums",
          active
            ? "bg-signature/25 text-fg"
            : "bg-surface-strong text-fg-muted"
        )}
      >
        {count}
      </span>
    </button>
  );
}
