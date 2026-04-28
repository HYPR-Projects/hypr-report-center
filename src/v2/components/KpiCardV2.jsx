// src/v2/components/KpiCardV2.jsx
//
// KPI card do V2. Mostra label + valor grande + hint opcional via tooltip.
//
// Diferenças vs Legacy KpiCard:
//   - Tipografia escalada (label menor, valor maior)
//   - Cor signature como acento opcional (prop `accent`)
//   - Tooltip do Radix integrado quando `hint` é passado
//   - Loading state via Skeleton (prop `loading`)

import { Card, CardBody } from "../../ui/Card";
import { Skeleton } from "../../ui/Skeleton";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "../../ui/Tooltip";
import { cn } from "../../ui/cn";

export function KpiCardV2({
  label,
  value,
  hint,
  accent = false,
  loading = false,
  className,
}) {
  const labelEl = (
    <span
      className={cn(
        "text-[11px] font-semibold uppercase tracking-wider leading-none",
        "text-fg-muted",
        // Quando tem hint, marca visualmente o label como "tooltipável"
        hint && "underline decoration-dotted decoration-fg-subtle underline-offset-4 cursor-help",
      )}
    >
      {label}
    </span>
  );

  return (
    <Card
      variant={accent ? "highlighted" : "default"}
      className={cn("min-w-0", className)}
    >
      <CardBody className="flex flex-col gap-2 p-4">
        {hint ? (
          <Tooltip>
            <TooltipTrigger asChild>{labelEl}</TooltipTrigger>
            <TooltipContent side="top">{hint}</TooltipContent>
          </Tooltip>
        ) : (
          labelEl
        )}

        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <span
            className={cn(
              "text-xl md:text-2xl font-bold leading-tight tabular-nums truncate",
              accent ? "text-signature" : "text-fg",
            )}
            title={typeof value === "string" ? value : undefined}
          >
            {value}
          </span>
        )}
      </CardBody>
    </Card>
  );
}
