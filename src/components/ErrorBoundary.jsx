import { Component } from "react";
import { C } from "../shared/theme";
import { gaEvent } from "../shared/analytics";
import { isChunkLoadError, canReloadForChunkError, reloadForChunkError } from "../shared/chunkReload";

/**
 * ErrorBoundary global. Captura erros de renderização em qualquer subárvore e
 * mostra um fallback simples em vez de tela branca. Sem ele, qualquer exceção
 * dentro de um componente derruba o app inteiro.
 *
 * React só permite ErrorBoundary como class component (hooks não cobrem este
 * caso de uso até hoje).
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, reloading: false };
  }

  static getDerivedStateFromError(error) {
    // Chunk que não baixou (deploy novo com a aba aberta): em vez da tela de
    // erro, recarrega uma vez — ver src/shared/chunkReload.js.
    return { hasError: true, error, reloading: isChunkLoadError(error) && canReloadForChunkError() };
  }

  componentDidCatch(error, info) {
    if (this.state.reloading) {
      if (reloadForChunkError()) return;
      this.setState({ reloading: false });
    }
    // Log estruturado pro console (sentry/logrocket entram aqui no futuro).
    console.error("[ErrorBoundary]", error, info?.componentStack);
    // Telemetria: registra evento no GA pra rastrear taxa de crashes.
    try {
      gaEvent("app_crash", {
        message: String(error?.message || error).slice(0, 200),
        component: (info?.componentStack || "").split("\n")[1]?.trim().slice(0, 100),
      });
    } catch {
      /* GA off ou bloqueado — ignora */
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.state.reloading) return null;

    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: C.dark,
          color: C.white,
          padding: 24,
          fontFamily: "'Urbanist', sans-serif",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
          Algo quebrou ao carregar este relatório
        </h1>
        <p style={{ color: C.muted, maxWidth: 480, lineHeight: 1.5, marginBottom: 24 }}>
          Já registramos o erro automaticamente. Tente recarregar a página. Se o
          problema persistir, contate o time HYPR.
        </p>
        <button
          onClick={this.handleReload}
          style={{
            background: C.blue,
            color: C.white,
            border: "none",
            padding: "10px 24px",
            borderRadius: 8,
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            fontFamily: "'Urbanist', sans-serif",
          }}
        >
          Recarregar
        </button>
        {import.meta.env.DEV && this.state.error && (
          <pre
            style={{
              marginTop: 32,
              padding: 16,
              background: C.dark2,
              border: `1px solid ${C.dark3}`,
              borderRadius: 8,
              color: C.red,
              fontSize: 12,
              maxWidth: 720,
              overflow: "auto",
              textAlign: "left",
              whiteSpace: "pre-wrap",
            }}
          >
            {String(this.state.error?.stack || this.state.error)}
          </pre>
        )}
      </div>
    );
  }
}

export default ErrorBoundary;
