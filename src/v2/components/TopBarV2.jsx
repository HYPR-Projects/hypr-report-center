// src/v2/components/TopBarV2.jsx
//
// Top bar fina com branding "Report Hub" + ações no canto direito:
//   - Pill "atualizado há X" (informação, não interativa)
//   - Botão "Falar com CS" (abre WhatsApp/Slack/email — TODO Fase 4)
//   - Share (copiar link do report)
//   - Toggle dark/light (default dark; light vem em fase futura)
//
// O Voltar à versão atual é movido aqui também — é uma ação global,
// não pertence ao header da campanha.
//
// Não fixo (não sticky). Decisão: manter scroll comportamento padrão,
// poupa pixel real estate em mobile.

import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";

export function TopBarV2({
  updatedAtLabel,
  onShare,
  onBackToLegacy,
  onContactCS,
  className,
}) {
  return (
    <header
      className={cn(
        "h-16 px-4 md:px-6 lg:px-8 flex items-center justify-between gap-3",
        "bg-canvas border-b border-border",
        className,
      )}
    >
      {/* Branding */}
      <div className="flex items-center gap-2.5">
        <LogoMark />
        <span className="font-extrabold text-base text-fg tracking-tight">
          Report Hub
        </span>
      </div>

      {/* Ações */}
      <div className="flex items-center gap-2">
        {updatedAtLabel && (
          <span
            className={cn(
              "hidden sm:inline-flex items-center gap-1.5",
              "px-3 py-1 rounded-full",
              "bg-surface border border-border",
              "text-[11px] font-medium text-fg-muted",
            )}
          >
            <span className="size-1.5 rounded-full bg-signature" aria-hidden />
            {updatedAtLabel}
          </span>
        )}

        {onContactCS && (
          <button
            type="button"
            onClick={onContactCS}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md",
              "bg-signature-soft border border-signature/40 text-signature",
              "text-xs font-bold cursor-pointer",
              "hover:bg-signature hover:text-fg transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
            )}
          >
            <ChatIcon className="size-3.5" />
            <span className="hidden md:inline">Falar com CS</span>
          </button>
        )}

        {onShare && (
          <IconButton onClick={onShare} title="Copiar link do report">
            <ShareIcon className="size-4" />
          </IconButton>
        )}

        {onBackToLegacy && (
          <Button variant="ghost" size="sm" onClick={onBackToLegacy} className="hidden md:inline-flex">
            Voltar à versão atual
          </Button>
        )}
      </div>
    </header>
  );
}

// ─── Subcomponentes ───────────────────────────────────────────────────

function LogoMark() {
  // Quadrado azul com "H" branco e degree symbol amarelo (igual mockup)
  return (
    <div className="relative inline-flex items-center justify-center size-7 rounded-lg bg-signature text-fg font-black text-sm">
      H
      <span
        aria-hidden="true"
        className="absolute -right-0.5 -top-0.5 text-warning text-base font-black leading-none"
      >
        °
      </span>
    </div>
  );
}

function IconButton({ children, onClick, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex items-center justify-center size-9 rounded-lg",
        "bg-transparent border border-border text-fg-muted cursor-pointer",
        "hover:bg-surface hover:text-fg hover:border-border-strong",
        "transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
      )}
    >
      {children}
    </button>
  );
}

function ShareIcon({ className }) {
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
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

function ChatIcon({ className }) {
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
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
