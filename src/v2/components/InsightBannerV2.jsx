// src/v2/components/InsightBannerV2.jsx
//
// Banner de insight automaticamente gerado a partir dos números da
// campanha. Padrão visual do mockup: faixa colorida lateral + ícone
// + texto com strong + caption.
//
// Variantes:
//   - success (verde): pacing dentro do esperado, economia consistente
//   - warn (amarelo): over-delivery, atenção a alguma métrica
//   - danger (vermelho): pacing crítico, queda de performance
//   - info (azul): observações neutras
//
// API:
//   <InsightBannerV2 variant="success" title="Display dentro do esperado">
//     pacing 96.8% com economia de 24.7% no CPM efetivo vs negociado.
//   </InsightBannerV2>

import { cn } from "../../ui/cn";

const VARIANT_STYLES = {
  success: {
    border: "border-l-success",
    bg: "bg-success-soft",
    icon: "text-success",
    Icon: CheckCircleIcon,
  },
  warn: {
    border: "border-l-warning",
    bg: "bg-warning-soft",
    icon: "text-warning",
    Icon: AlertTriangleIcon,
  },
  danger: {
    border: "border-l-danger",
    bg: "bg-danger-soft",
    icon: "text-danger",
    Icon: AlertCircleIcon,
  },
  info: {
    border: "border-l-signature",
    bg: "bg-signature-soft",
    icon: "text-signature",
    Icon: InfoIcon,
  },
};

export function InsightBannerV2({ variant = "info", title, children, className }) {
  const styles = VARIANT_STYLES[variant] || VARIANT_STYLES.info;
  const Icon = styles.Icon;

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 px-4 py-3 rounded-lg border-l-4",
        "bg-surface border border-border",
        styles.border,
        className,
      )}
    >
      <div className={cn("shrink-0 mt-0.5", styles.icon)}>
        <Icon className="size-4" />
      </div>
      <div className="text-xs text-fg-muted leading-relaxed flex-1 min-w-0">
        {title && <strong className="text-fg font-semibold">{title}</strong>}
        {title && children && <span className="text-fg-subtle"> · </span>}
        {children}
      </div>
    </div>
  );
}

// ─── Ícones inline ────────────────────────────────────────────────────
function CheckCircleIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function AlertTriangleIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function AlertCircleIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function InfoIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

// ─── Helper: gera lista de insights a partir de aggregates ────────────
//
// Lógica de insights consistente com o mockup:
//   - Display: pacing 90-110% = success; <90% ou >110% = warn
//   - Video idem
//   - Economia CPM/CPCV >5% = success extra
//
// Retorna array de objetos { variant, title, body } pronto pra render.
//
// Quando rangeLabel é "Mês passado" ou similar (período fechado), texto
// usa pretérito; senão presente. Decisão pequena mas evita "campanha
// está entregando" pra um período já encerrado.

export function buildInsights({
  display,
  video,
  totals,
  isFiltered,
  isClosedPeriod = false,
}) {
  const insights = [];
  const verb = isClosedPeriod ? "entregou" : "entregando";
  const verbVideo = isClosedPeriod ? "ficou em" : "em";

  // Pacing display: somar pacing ponderado por budget contratado
  const hasDisplay = display && display.length > 0;
  const hasVideo = video && video.length > 0;

  if (hasDisplay) {
    const pacingDisplay = computeDisplayPacingHelper(display);
    const cpmNeg = display[0]?.deal_cpm_amount || 0;
    const cpmEf = display[0]?.effective_cpm_amount || 0;
    const economia = cpmNeg > 0 ? ((cpmNeg - cpmEf) / cpmNeg) * 100 : 0;

    if (pacingDisplay >= 90 && pacingDisplay <= 110) {
      insights.push({
        variant: "success",
        title: `Display ${verb} dentro do esperado`,
        body: `pacing ${pacingDisplay.toFixed(1)}%${
          economia > 5
            ? ` com economia de ${economia.toFixed(1)}% no CPM efetivo vs negociado.`
            : "."
        }`,
      });
    } else if (pacingDisplay > 110) {
      insights.push({
        variant: "warn",
        title: `Display em over delivery (+${(pacingDisplay - 100).toFixed(1)}%)`,
        body: `entrega acima do contratado dentro do mesmo budget.`,
      });
    } else if (pacingDisplay < 90) {
      insights.push({
        variant: "warn",
        title: `Display abaixo do pacing esperado (${pacingDisplay.toFixed(1)}%)`,
        body: `acompanhar entrega para manter dentro do contratado.`,
      });
    }
  }

  if (hasVideo) {
    const pacingVideo = video[0]?.pacing || 0;
    const cpcvNeg = video[0]?.deal_cpcv_amount || 0;
    const cpcvEf = video[0]?.effective_cpcv_amount || 0;

    if (pacingVideo > 105) {
      insights.push({
        variant: "warn",
        title: `Video em over delivery (+${(pacingVideo - 100).toFixed(1)}%)`,
        body:
          cpcvNeg && cpcvEf
            ? `CPCV efetivo R$ ${cpcvEf.toFixed(3).replace(".", ",")} vs negociado R$ ${cpcvNeg.toFixed(3).replace(".", ",")}. Cliente recebe entrega bonus dentro do mesmo budget.`
            : `entrega acima do contratado dentro do mesmo budget.`,
      });
    } else if (pacingVideo < 90) {
      insights.push({
        variant: "warn",
        title: `Video abaixo do pacing (${pacingVideo.toFixed(1)}%)`,
        body: `acompanhar entrega para manter dentro do contratado.`,
      });
    } else if (pacingVideo >= 90 && pacingVideo <= 105) {
      insights.push({
        variant: "success",
        title: `Video ${verbVideo} entrega esperada`,
        body: `pacing ${pacingVideo.toFixed(1)}%.`,
      });
    }
  }

  return insights;
}

// Helper interno — pacing display agregado.
// Replica lógica de computeDisplayPacing do OverviewV2 mas em forma
// simplificada para o uso aqui (sem dependência de camp.start/end).
// Quando rows[0]?.pacing existir, usa direto (já calculado pelo backend
// pra display em algumas campanhas).
function computeDisplayPacingHelper(displayRows) {
  if (!displayRows.length) return 0;

  // Se backend retorna pacing, usar
  if (displayRows[0]?.pacing) return displayRows[0].pacing;

  // Senão, derivar de delivered/contracted (já pro periodo total).
  const contracted = displayRows.reduce(
    (s, r) =>
      s +
      (r.contracted_o2o_display_impressions || 0) +
      (r.contracted_ooh_display_impressions || 0),
    0,
  );
  const bonus = displayRows.reduce(
    (s, r) =>
      s +
      (r.bonus_o2o_display_impressions || 0) +
      (r.bonus_ooh_display_impressions || 0),
    0,
  );
  const totalNeg = contracted + bonus;
  if (!totalNeg) return 0;

  const delivered = displayRows.reduce(
    (s, r) => s + (r.viewable_impressions || 0),
    0,
  );
  return (delivered / totalNeg) * 100;
}
