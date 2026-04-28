// src/ui/Tooltip.jsx
//
// Tooltip sobre Radix UI. Atrasos, posicionamento, collision detection,
// teclado (focus mostra, blur esconde) — tudo do Radix.
//
// IMPORTANTE: precisa de <TooltipProvider> em algum ancestral comum
// (idealmente envolvendo a árvore inteira do V2). Aplicar no
// ClientDashboardV2.jsx quando tiver tooltips de fato em uso.
//
// API:
//   <Tooltip>
//     <TooltipTrigger asChild><Button>?</Button></TooltipTrigger>
//     <TooltipContent>Explicação curta</TooltipContent>
//   </Tooltip>

import { forwardRef } from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { cn } from "./cn";

export const TooltipProvider = RadixTooltip.Provider;
export const Tooltip = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;

export const TooltipContent = forwardRef(function TooltipContent(
  { className, sideOffset = 6, ...rest },
  ref
) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-xs",
          "rounded-md border border-border bg-canvas-elevated",
          "px-3 py-2 text-xs text-fg shadow-md",
          "data-[state=delayed-open]:animate-in data-[state=closed]:animate-out",
          className
        )}
        {...rest}
      />
    </RadixTooltip.Portal>
  );
});
TooltipContent.displayName = "TooltipContent";
