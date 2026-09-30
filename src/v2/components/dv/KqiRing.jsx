// src/v2/components/dv/KqiRing.jsx
//
// Anel de um KQI do DoubleVerify (taxa contra 100%). Usado na seção
// DoubleVerify do admin e na aba Quality do report do cliente, pra que os
// dois leiam igual. Um matiz só (signature): os anéis medem a mesma grandeza,
// cor por KQI inventaria identidade.
//
// Precisa de <TooltipProvider> num ancestral.

import { Tooltip, TooltipTrigger, TooltipContent } from "../../../ui/Tooltip";
import { formatRate } from "../../admin/lib/dvQuality.js";

const nf = new Intl.NumberFormat("pt-BR");

export function KqiRing({ label, rate, num, den, denLabel, badge, footnote }) {
  const R = 34;
  const C = 2 * Math.PI * R;
  const pct = rate == null ? 0 : Math.max(0, Math.min(1, rate));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          className="flex flex-col items-center text-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-signature"
          aria-label={`${label}: ${formatRate(rate)}`}
        >
          <div className="relative size-[92px]">
            <svg viewBox="0 0 80 80" className="size-full -rotate-90" aria-hidden="true">
              <circle cx="40" cy="40" r={R} fill="none" strokeWidth="6" className="stroke-surface-strong" />
              {rate != null && (
                <circle
                  cx="40" cy="40" r={R} fill="none" strokeWidth="6" strokeLinecap="round"
                  className="stroke-signature transition-[stroke-dashoffset] duration-500"
                  strokeDasharray={C}
                  strokeDashoffset={C * (1 - pct)}
                />
              )}
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-lg font-extrabold tabular-nums text-fg leading-none">{formatRate(rate)}</span>
              {rate != null && badge && <span className="mt-1">{badge}</span>}
            </div>
          </div>
          <div className="mt-2 text-xs font-semibold text-fg leading-tight">{label}</div>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-xs tabular-nums">
          <div className="font-semibold mb-0.5">{label}</div>
          {den ? (
            <div>{nf.format(num)} de {nf.format(den)} {denLabel}</div>
          ) : (
            <div>Sem {denLabel.toLowerCase()} no recorte</div>
          )}
          {footnote && <div className="text-fg-subtle mt-0.5">{footnote}</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
