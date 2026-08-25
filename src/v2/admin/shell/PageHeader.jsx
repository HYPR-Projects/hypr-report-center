// src/v2/admin/shell/PageHeader.jsx
//
// O cabeçalho de conteúdo, um só para as três rotas admin.
//
// Antes, a hierarquia estava INVERTIDA: a rota raiz — a mais importante do
// produto — usava `text-2xl` no H1, enquanto PMP e drilldown de cliente
// usavam `text-3xl`. A linha de meta era `text-xs` na raiz e `text-sm` no
// PMP. O breadcrumb existia em duas das três rotas, e no PMP ele era falso:
// dizia "Admin / PMP LINES" enquanto o H1 dizia "Deals de Pagamento" e o
// botão que trazia você até ali dizia "PMP Deals" — três nomes pro mesmo
// lugar.
//
// A escala aqui é única e o eyebrow vem da navegação, não de texto solto,
// então nome de seção e nome de view não podem mais divergir do rail.
//
// O breadcrumb navegável subiu pra AdminContextBar (onde sobrevive ao
// scroll). O eyebrow daqui é só rótulo — repetir um segundo controle de
// navegação a 20px do primeiro seria ruído.

import { cn } from "../../../ui/cn";

export function PageHeader({
  eyebrow,
  title,
  meta,
  actions,
  className,
}) {
  return (
    <div className={cn("flex items-end justify-between gap-4 flex-wrap mb-5", className)}>
      <div className="min-w-0">
        {eyebrow && (
          <div className="lbl-section mb-1.5">
            {eyebrow}
          </div>
        )}
        <h1 className="text-xl md:text-2xl font-extrabold tracking-tight text-fg leading-[1.15] text-balance">
          {title}
        </h1>
        {meta && (
          <div className="text-xs text-fg-muted mt-1.5 flex items-center gap-2 flex-wrap">
            {meta}
          </div>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

/**
 * Separador da linha de meta. Era um `<span className="w-0.5 h-0.5 rounded-full
 * bg-fg-subtle" />` reescrito em cada página, com dois diâmetros diferentes
 * (0.5 e 1) conforme quem escreveu.
 */
export function MetaDot() {
  return <span aria-hidden="true" className="size-[3px] rounded-full bg-fg-subtle shrink-0" />;
}

/**
 * Número + rótulo da linha de meta: `<MetaStat value={490} label="campanhas" />`.
 * Mantém `tabular-nums` e o peso do número consistentes — antes cada página
 * escrevia o par à mão e o peso variava entre `font-semibold` e `font-bold`.
 */
export function MetaStat({ value, label, tone }) {
  return (
    <span>
      <span
        className={cn(
          "font-bold tabular-nums",
          tone === "success" ? "text-success" :
          tone === "warning" ? "text-warning" :
          tone === "danger"  ? "text-danger"  : "text-fg",
        )}
      >
        {value}
      </span>
      {label ? ` ${label}` : null}
    </span>
  );
}
