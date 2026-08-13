// src/v2/components/SessionExpiredModalV2.jsx
//
// Modal global "sessão expirou". Ouvinte do evento emitido por
// sessionEvents.js — disparado quando uma call admin falha 401 mesmo
// depois do auto-retry com JWT renovado (= sessão genuinamente expirou).
//
// UX: bloqueia interação até o user clicar "Recarregar" (reload preserva
// a URL atual e recarrega o estado, refazendo login se necessário). Não
// tem botão de "fechar" porque continuar usando sem recarregar levaria
// a mais 401s silenciosos — exatamente o problema que esse modal
// resolve.

import { useEffect, useState } from "react";
import { onSessionExpired } from "../../lib/sessionEvents";

export function SessionExpiredModalV2() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    return onSessionExpired(() => setOpen(true));
  }, []);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
    >
      <div className="w-[min(420px,calc(100vw-32px))] rounded-2xl border border-border bg-canvas-elevated shadow-xl p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-warning-soft shrink-0">
            <ClockIcon className="size-5 text-warning" />
          </div>
          <div className="flex-1 min-w-0">
            <h2
              id="session-expired-title"
              className="text-base font-bold text-fg mb-1"
            >
              Sua sessão expirou
            </h2>
            <p className="text-sm text-fg-muted leading-relaxed">
              Por segurança, sua sessão admin terminou. Recarregue a página
              para entrar de novo e continuar de onde parou.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => window.location.reload()}
          autoFocus
          className="w-full inline-flex items-center justify-center gap-2 h-10 px-4 rounded-lg bg-signature-fill text-on-signature text-sm font-semibold hover:bg-signature-hover transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-elevated"
        >
          <RefreshIcon className="size-4" />
          Recarregar página
        </button>
      </div>
    </div>
  );
}

function ClockIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function RefreshIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  );
}
