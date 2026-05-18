// src/v2/contexts/ReportTrackingContext.js
//
// Context que distribui a função `trackCta` pra qualquer componente
// descendente do ClientDashboardV2 — sem precisar fazer prop drilling.
//
// Quem provê: ClientDashboardV2, que chama useReportTracking e passa o
// `trackCta` retornado no value do provider.
//
// Quem consome: componentes com CTAs trackáveis (SheetsIntegrationCardV2,
// DataTableV2, futuros). Via `useReportTrackingContext().trackCta(ctaId)`.
//
// Default = noop. Componentes fora de um Provider (ex: testes,
// preview harness, demo) chamam trackCta() sem efeito e sem erro.

import { createContext, useContext } from "react";

const ReportTrackingContext = createContext({
  trackCta: () => {},
});

export const ReportTrackingProvider = ReportTrackingContext.Provider;

export function useReportTrackingContext() {
  return useContext(ReportTrackingContext);
}
