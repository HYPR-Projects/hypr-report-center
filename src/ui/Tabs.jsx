// src/ui/Tabs.jsx
//
// Tabs sobre Radix UI. Acessibilidade (ARIA), keyboard nav (←→, Home,
// End) e focus management vêm de graça do Radix. Estilo via classes
// HYPR.
//
// API (igual Radix, só com estilo aplicado):
//   <Tabs defaultValue="overview">
//     <TabsList>
//       <TabsTrigger value="overview">Visão Geral</TabsTrigger>
//       <TabsTrigger value="display">Display</TabsTrigger>
//     </TabsList>
//     <TabsContent value="overview">...</TabsContent>
//     <TabsContent value="display">...</TabsContent>
//   </Tabs>

import { forwardRef } from "react";
import * as RadixTabs from "@radix-ui/react-tabs";
import { cn } from "./cn";

export const Tabs = RadixTabs.Root;

export const TabsList = forwardRef(function TabsList(
  { className, ...rest },
  ref
) {
  return (
    <RadixTabs.List
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1 p-1 rounded-lg bg-surface-strong border border-border",
        className
      )}
      {...rest}
    />
  );
});
TabsList.displayName = "TabsList";

export const TabsTrigger = forwardRef(function TabsTrigger(
  { className, ...rest },
  ref
) {
  return (
    <RadixTabs.Trigger
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap",
        "px-4 h-9 rounded-md text-sm font-semibold",
        "text-fg-muted hover:text-fg",
        "transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        // estado ativo (data-state="active" do Radix)
        "data-[state=active]:bg-signature data-[state=active]:text-fg",
        "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
        className
      )}
      {...rest}
    />
  );
});
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = forwardRef(function TabsContent(
  { className, ...rest },
  ref
) {
  return (
    <RadixTabs.Content
      ref={ref}
      className={cn(
        "mt-4",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        className
      )}
      {...rest}
    />
  );
});
TabsContent.displayName = "TabsContent";
