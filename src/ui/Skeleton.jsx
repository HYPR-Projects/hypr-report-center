// src/ui/Skeleton.jsx
//
// Skeleton loader com shimmer. Usa keyframe inline (Tailwind v4 não
// tem `animate-shimmer` default) via style + CSS custom no theme.
//
// API:
//   <Skeleton className="h-8 w-32" />
//   <Skeleton rounded="full" className="h-10 w-10" />

import { cva } from "class-variance-authority";
import { cn } from "./cn";

const skeletonStyles = cva(
  [
    "relative overflow-hidden",
    "bg-surface-strong",
    // shimmer via pseudo-elemento inline (animate-pulse simples evita
    // precisar registrar keyframe customizado — fica sutil e suficiente
    // pra indicar loading)
    "animate-pulse",
  ],
  {
    variants: {
      rounded: {
        sm: "rounded-md",
        md: "rounded-lg",
        lg: "rounded-xl",
        full: "rounded-full",
        none: "rounded-none",
      },
    },
    defaultVariants: {
      rounded: "md",
    },
  }
);

export function Skeleton({ rounded, className, ...rest }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn(skeletonStyles({ rounded }), className)}
      {...rest}
    />
  );
}
