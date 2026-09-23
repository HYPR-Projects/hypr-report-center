// src/v2/components/ErrorBoundary.jsx
//
// ErrorBoundary do dashboard.
//
// Captura erros de runtime em qualquer descendente do <ClientDashboard>,
// registra o ocorrido (console + Google Analytics existente), e mostra
// uma UI de fallback com botão "Tentar de novo" que recarrega a página.
//
// ──────────────────────────────────────────────────────────────────────
// HISTÓRICO
// ──────────────────────────────────────────────────────────────────────
// Antes da remoção do Legacy, este boundary forçava
// `localStorage.hypr_report_version = 'legacy'` e recarregava — caía
// pra interface antiga em ~500ms sem ação do cliente. Com Legacy
// removido, não há fallback automático possível: ou o cliente clica
// em "Tentar de novo", ou contata a equipe.
//
// ──────────────────────────────────────────────────────────────────────
// COMO É RECONHECIDO COMO ERRO NO GA
// ──────────────────────────────────────────────────────────────────────
// O evento disparado tem nome 'v2_crash' (mantido pelo histórico,
// pra não perder continuidade nas dashboards do GA já criados) e
// parâmetros que permitem agrupar crashes recorrentes (mensagem do
// erro + stack do componente). No GA: Reports → Engagement → Events
// → v2_crash.
//
// ──────────────────────────────────────────────────────────────────────
// LIMITAÇÕES CONHECIDAS DE ERRORBOUNDARY (React)
// ──────────────────────────────────────────────────────────────────────
// ErrorBoundary NÃO captura:
//   - Erros em event handlers (try/catch local resolve)
//   - Erros assíncronos (try/catch ou .catch resolve)
//   - Erros em SSR (não usamos SSR)
//   - Erros no próprio ErrorBoundary
//
// O suficiente para o caso de uso: erros de render do dashboard,
// que são a classe mais grave — viram tela branca sem boundary.

import React from "react";
import { gaEvent } from "../../shared/analytics";
import { isChunkLoadError, canReloadForChunkError, reloadForChunkError } from "../../shared/chunkReload";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: "", reloading: false };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: error?.message || "Erro desconhecido",
      // Chunk que não baixou (deploy novo com a aba aberta): em vez da tela
      // de erro, recarrega uma vez — ver src/shared/chunkReload.js.
      reloading: isChunkLoadError(error) && canReloadForChunkError(),
    };
  }

  componentDidCatch(error, errorInfo) {
    if (this.state.reloading) {
      if (reloadForChunkError()) return;
      this.setState({ reloading: false });
    }
    // 1. Console — para devs com DevTools aberto verem stack completo
    //    sem precisar abrir GA.
    console.error("[ErrorBoundary] Crash capturado:", error, errorInfo);

    // 2. Google Analytics — telemetria leve para detectar volume e
    //    padrões. Mantemos o nome 'v2_crash' por continuidade do
    //    histórico no GA.
    try {
      gaEvent("v2_crash", {
        error_message: String(error?.message || error || "unknown").slice(0, 100),
        error_stack: String(errorInfo?.componentStack || "").slice(0, 200),
      });
    } catch {
      /* gaEvent pode falhar se gtag não carregou — não é fatal */
    }
  }

  handleRetry = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.state.reloading) return null;

    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "#0d1117",
          color: "#fff",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 420,
            width: "100%",
            textAlign: "center",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 12,
            padding: "32px 28px",
          }}
        >
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
            Algo deu errado ao carregar o report
          </h1>
          <p style={{ fontSize: 14, opacity: 0.7, marginBottom: 24, lineHeight: 1.6 }}>
            Já registramos o erro automaticamente. Tenta recarregar — se
            persistir, contata a equipe HYPR.
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            style={{
              background: "#3397b9",
              color: "#fff",
              border: "none",
              padding: "12px 24px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Tentar de novo
          </button>
        </div>
      </div>
    );
  }
}
