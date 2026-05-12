// src/v2/components/TopBarV2.jsx
//
// Top bar fina com branding "Report Center" + ações no canto direito:
//   - Pill "atualizado há X" (informação, não interativa)
//   - Botão "Falar com CS" (abre WhatsApp/Slack/email — TODO Fase 4)
//   - Share (copiar link do report)
//   - Toggle dark/light (PR-18 — botão icon-only, sol quando dark, lua
//     quando light, persiste em localStorage)
//
// O Voltar à versão atual é movido aqui também — é uma ação global,
// não pertence ao header da campanha.
//
// Não fixo (não sticky). Decisão: manter scroll comportamento padrão,
// poupa pixel real estate em mobile.

import { cn } from "../../ui/cn";
import { ThemeToggleV2 } from "./ThemeToggleV2";
import HyprReportCenterLogo from "../../components/HyprReportCenterLogo";

// Ícones declarados ANTES do TopBarV2 — react-refresh do Vite envolve cada
// function declaration num wrapper de HMR e isso quebra a hoisting que o JS
// faria naturalmente. Referenciar CheckIcon/ShareIcon dentro do mapa
// `shareConfig` exige que estejam disponíveis no escopo de módulo no momento
// em que TopBarV2 roda — então elas vêm primeiro.

function CheckIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
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

export function TopBarV2({
  updatedAtLabel,
  onShare,
  shareState = "idle",
  onContactCS,
  className,
}) {
  // Mapeia estado do share pro tooltip + ícone do botão. O ClientDashboard
  // empurra "copied"/"error" por 2s e volta pra "idle" — feedback de "deu
  // certo" sem virar permanente. "copying" cobre a janela do round-trip pro
  // getShareId quando o cache não tem.
  const shareConfig = {
    idle:    { title: "Copiar link do report",  Icon: ShareIcon, tone: "default" },
    copying: { title: "Copiando…",              Icon: ShareIcon, tone: "default" },
    copied:  { title: "Link copiado!",          Icon: CheckIcon, tone: "success" },
    error:   { title: "Erro ao copiar",         Icon: ShareIcon, tone: "danger" },
  }[shareState] || { title: "Copiar link do report", Icon: ShareIcon, tone: "default" };
  return (
    <header
      className={cn(
        "h-16 px-4 md:px-6 lg:px-8 flex items-center justify-between gap-3",
        "bg-canvas border-b border-border",
        className,
      )}
    >
      {/* Branding: wordmark HYPR°REPORT CENTER tematizado */}
      <div className="flex items-center text-fg">
        <HyprReportCenterLogo height={32} />
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
          <IconButton onClick={onShare} title={shareConfig.title} tone={shareConfig.tone}>
            <shareConfig.Icon className="size-4" />
          </IconButton>
        )}

        <ThemeToggleV2 />
      </div>
    </header>
  );
}

// ─── Subcomponentes ───────────────────────────────────────────────────

function IconButton({ children, onClick, title, tone = "default" }) {
  // tone visual: "default" (neutro), "success" (verde — copy ok),
  // "danger" (vermelho — falha). Transição 200ms cobre o flash do feedback.
  const toneClass = {
    default: "border-border text-fg-muted hover:bg-surface hover:text-fg hover:border-border-strong",
    success: "border-success/40 text-success bg-success-soft",
    danger:  "border-danger/40 text-danger bg-danger-soft",
  }[tone] || "";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex items-center justify-center size-9 rounded-lg",
        "bg-transparent border cursor-pointer",
        toneClass,
        "transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
      )}
    >
      {children}
    </button>
  );
}
