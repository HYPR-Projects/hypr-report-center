// src/ui/Badge.jsx
//
// Badge / pill semântica. 5 variants alinhadas com a paleta HYPR.
// Use pra status, tags, indicadores curtos.
//
// API:
//   <Badge variant="success">Dentro do alvo</Badge>
//   <Badge variant="warning" size="sm">Pacing 87%</Badge>

import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./cn";

const badgeStyles = cva(
  [
    "inline-flex items-center gap-1.5 font-semibold whitespace-nowrap",
    "uppercase tracking-wider",
    "rounded-full",
  ],
  {
    variants: {
      variant: {
        signature: "bg-signature-soft text-signature",
        warning: "bg-warning-soft text-warning",
        success: "bg-success-soft text-success",
        danger: "bg-danger-soft text-danger",
        neutral: "bg-surface-strong text-fg-muted",
      },
      size: {
        sm: "px-2 py-0.5 text-[10px]",
        md: "px-3 py-1 text-xs",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "md",
    },
  }
);

export const Badge = forwardRef(function Badge(
  { variant, size, className, children, ...rest },
  ref
) {
  return (
    <span
      ref={ref}
      className={cn(badgeStyles({ variant, size }), className)}
      {...rest}
    >
      {children}
    </span>
  );
});
Badge.displayName = "Badge";
