// src/ui/Card.jsx
//
// Card composable. Imports separados (estilo shadcn) para casar com
// o jeito que Tabs/Dialog/Tooltip vão ser importados do Radix.
//
// API:
//   <Card variant="highlighted">
//     <CardHeader title="CPM Negociado" subtitle="Últimos 7 dias" />
//     <CardBody>...</CardBody>
//     <CardFooter>...</CardFooter>
//   </Card>

import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./cn";

const cardStyles = cva(
  [
    "rounded-xl border bg-surface",
    "transition-colors duration-150",
  ],
  {
    variants: {
      variant: {
        // padrão: surface sutil sobre canvas
        default: "border-border",
        // destaque: borda signature + leve glow pra puxar atenção
        highlighted: "border-signature/40 bg-signature-soft",
      },
      padding: {
        // controla padding interno do Card. 'none' deixa para o
        // CardHeader/Body/Footer cuidarem (uso mais comum). 'md'
        // serve pra cards simples sem subdivisão.
        none: "",
        sm: "p-3",
        md: "p-5",
        lg: "p-6",
      },
    },
    defaultVariants: {
      variant: "default",
      padding: "none",
    },
  }
);

export const Card = forwardRef(function Card(
  { variant, padding, className, children, ...rest },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn(cardStyles({ variant, padding }), className)}
      {...rest}
    >
      {children}
    </div>
  );
});
Card.displayName = "Card";

// ─── Header ───────────────────────────────────────────────────────────
// Aceita `title`/`subtitle` props pro caso simples, ou children livre
// pra layout custom (com action, ícone, etc).
export const CardHeader = forwardRef(function CardHeader(
  { title, subtitle, action, className, children, ...rest },
  ref
) {
  // Se houver children, ignora title/subtitle/action e renderiza livre.
  if (children) {
    return (
      <div
        ref={ref}
        className={cn(
          "px-5 pt-5 pb-3 border-b border-border",
          className
        )}
        {...rest}
      >
        {children}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-border",
        className
      )}
      {...rest}
    >
      <div className="min-w-0">
        {title && (
          <h3 className="text-sm font-semibold text-fg leading-tight">
            {title}
          </h3>
        )}
        {subtitle && (
          <p className="text-xs text-fg-muted mt-1 leading-snug">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
});
CardHeader.displayName = "CardHeader";

// ─── Body ─────────────────────────────────────────────────────────────
export const CardBody = forwardRef(function CardBody(
  { className, children, ...rest },
  ref
) {
  return (
    <div ref={ref} className={cn("p-5", className)} {...rest}>
      {children}
    </div>
  );
});
CardBody.displayName = "CardBody";

// ─── Footer ───────────────────────────────────────────────────────────
export const CardFooter = forwardRef(function CardFooter(
  { className, children, ...rest },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn(
        "px-5 py-3 border-t border-border flex items-center justify-end gap-2",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
});
CardFooter.displayName = "CardFooter";
