// src/v2/dashboards/ClientDashboardV2.jsx
//
// STUB do ClientDashboardV2 — versão Tailwind.
//
// Esta é a primeira página V2 efetivamente importada e renderizada,
// agora usando Tailwind v4 + tokens HYPR (src/ui/theme.css) em vez
// de estilos inline.
//
// ──────────────────────────────────────────────────────────────────────
// O QUE ESTE STUB VALIDA
// ──────────────────────────────────────────────────────────────────────
// 1. Tailwind v4 está processando classes corretamente
// 2. Tokens HYPR (bg-canvas, text-signature, etc) gerados via @theme
//    estão funcionando como utilitárias
// 3. Urbanist (typography.js) é carregada como fonte default
// 4. global-reset.css aplica opiniões extras (focus-visible, etc)
// 5. Botão "Voltar à versão atual" persiste 'legacy' no localStorage
//    e recarrega
//
// ──────────────────────────────────────────────────────────────────────
// SUBSTITUIÇÃO NA FASE 2
// ──────────────────────────────────────────────────────────────────────
// Na Fase 2, este arquivo passa a renderizar o ClientDashboardV2 real
// (com tabs, dados, filtros). O stub é descartado. O contrato com
// App.jsx (props: token, isAdmin, adminJwt) permanece o mesmo.

import "../v2.css";          // entry CSS (Tailwind + theme + reset)
import "../../ui/typography"; // carrega Urbanist (efeito colateral)
import { setReportVersion } from "../../shared/version";

export default function ClientDashboardV2({ token, isAdmin /*, adminJwt */ }) {
  const goLegacy = () => {
    setReportVersion("legacy");
    // Remove ?v= da URL para que o reload não force V2 de novo via
    // prioridade do query param.
    const url = new URL(window.location.href);
    url.searchParams.delete("v");
    window.location.replace(url.toString());
  };

  return (
    <div className="font-sans min-h-screen bg-canvas text-fg flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface shadow-md px-8 py-10 text-center">
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-signature-soft text-signature text-xs font-semibold uppercase tracking-wider mb-6">
          Preview · V2
        </span>

        <h1 className="text-3xl font-bold leading-tight mb-3">
          Em construção
        </h1>

        <p className="text-base leading-relaxed text-fg-muted mb-8">
          Esta é a próxima versão do dashboard de reports da HYPR. O
          conteúdo será construído nas próximas semanas. Por enquanto,
          a versão estável continua disponível.
        </p>

        <button
          type="button"
          onClick={goLegacy}
          className="inline-flex items-center justify-center px-6 py-3 rounded-lg bg-signature hover:bg-signature-hover text-fg text-sm font-semibold transition-colors duration-150 cursor-pointer"
        >
          Voltar à versão atual
        </button>

        <div className="mt-8 pt-5 border-t border-border font-mono text-xs text-fg-subtle break-all text-left">
          <div>token: {token || "—"}</div>
          <div>modo: {isAdmin ? "admin" : "cliente"}</div>
        </div>
      </div>
    </div>
  );
}
