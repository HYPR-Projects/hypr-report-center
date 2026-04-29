// src/ui/Tabs.jsx
//
// Tabs sobre Radix UI. Acessibilidade (ARIA), keyboard nav (←→, Home,
// End) e focus management vêm de graça do Radix.
//
// Redesenhado em PR-13 pra suportar:
//   - Ícone à esquerda do label (TabsTrigger.iconLeft prop ou via children)
//   - Badge (counter ou indicador) à direita do label
//   - Variante "underline" (default agora) — mais leve visualmente que pill,
//     batendo com o mockup. Variante "pill" mantida pra reuso futuro.
//
// API:
//   <Tabs defaultValue="overview">
//     <TabsList>
//       <TabsTrigger value="overview" iconLeft={<GridIcon />}>Visão Geral</TabsTrigger>
//       <TabsTrigger value="rmnd" iconLeft={<ZapIcon />} badge="3">RMND</TabsTrigger>
//     </TabsList>
//     <TabsContent value="overview">...</TabsContent>
//   </Tabs>

import { forwardRef } from "react";
import * as RadixTabs from "@radix-ui/react-tabs";
import { cn } from "./cn";

export const Tabs = RadixTabs.Root;

export const TabsList = forwardRef(function TabsList(
  { className, variant = "underline", ...rest },
  ref,
) {
  return (
    <RadixTabs.List
      ref={ref}
      className={cn(
        "inline-flex items-center",
        variant === "underline"
          ? "gap-1 border-b border-border w-full md:w-auto"
          : "gap-1 p-1 rounded-lg bg-canvas-deeper border border-border",
        className,
      )}
      {...rest}
    />
  );
});
TabsList.displayName = "TabsList";

export const TabsTrigger = forwardRef(function TabsTrigger(
  { className, iconLeft, badge, badgeVariant = "neutral", children, variant = "underline", ...rest },
  ref,
) {
  const baseClass =
    variant === "underline"
      ? cn(
          "relative inline-flex items-center justify-center gap-2 whitespace-nowrap",
          "px-4 h-11 text-sm font-semibold cursor-pointer",
          "text-fg-muted hover:text-fg",
          "transition-colors duration-150",
          // estado ativo: underline azul + texto fg
          "data-[state=active]:text-fg",
          "after:content-[''] after:absolute after:left-3 after:right-3 after:bottom-0",
          "after:h-0.5 after:rounded-t-full after:bg-transparent after:transition-colors",
          "data-[state=active]:after:bg-signature",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        )
      : cn(
          "inline-flex items-center justify-center gap-2 whitespace-nowrap",
          "px-4 h-9 rounded-md text-sm font-semibold cursor-pointer",
          "text-fg-muted hover:text-fg hover:bg-surface",
          "transition-colors duration-150",
          "data-[state=active]:bg-signature data-[state=active]:text-fg data-[state=active]:hover:bg-signature",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        );

  return (
    <RadixTabs.Trigger ref={ref} className={cn(baseClass, className)} {...rest}>
      {iconLeft && <span className="size-4 shrink-0">{iconLeft}</span>}
      {children}
      {badge !== undefined && badge !== null && (
        <span
          className={cn(
            "ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5",
            "rounded-full text-[10px] font-bold tabular-nums leading-none",
            badgeVariant === "signature" && "bg-signature text-fg",
            badgeVariant === "warning" && "bg-warning text-canvas",
            badgeVariant === "neutral" && "bg-surface-strong text-fg",
            badgeVariant === "dot" && "size-1.5 min-w-0 p-0 rounded-full bg-warning",
          )}
        >
          {badgeVariant !== "dot" && badge}
        </span>
      )}
    </RadixTabs.Trigger>
  );
});
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = forwardRef(function TabsContent(
  { className, ...rest },
  ref,
) {
  return (
    <RadixTabs.Content
      ref={ref}
      className={cn(
        "mt-6",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        className,
      )}
      {...rest}
    />
  );
});
TabsContent.displayName = "TabsContent";
