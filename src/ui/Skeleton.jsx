// src/ui/Skeleton.jsx
//
// Skeleton loader com shimmer. O keyframe mora em v2.css
// (`.skeleton-shimmer`), que respeita prefers-reduced-motion.
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
    // Faixa de luz atravessando o bloco (`.skeleton-shimmer` em v2.css).
    // Só transform no ::after, então não repinta o layout.
    "skeleton-shimmer",
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
