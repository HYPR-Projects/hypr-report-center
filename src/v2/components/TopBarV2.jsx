// src/v2/components/TopBarV2.jsx
//
// Top bar fina com branding "Report Center" + ações no canto direito:
//   - Pill "atualizado há X" (informação, não interativa)
//   - Botão "Falar com CS" (abre WhatsApp/Slack/email — TODO Fase 4)
//   - Comentários (abre o painel de conversa cliente ↔ HYPR, com contador
//     de mensagens não lidas da outra parte)
//   - Share (copiar link do report)
//   - Toggle dark/light (PR-18 — botão icon-only, sol quando dark, lua
//     quando light, persiste em localStorage)
//   - Visão HYPR × Cliente (só admin): alterna o report entre o que a HYPR
//     vê e exatamente o que o cliente vê (ClientDashboardV2 → adminUi)
//
// O Voltar à versão atual é movido aqui também — é uma ação global,
// não pertence ao header da campanha.
//
// Sticky glass: `sticky top-0` + fundo translúcido (bg-canvas/70) +
// backdrop-blur. Conteúdo da página desliza por trás com efeito fosco.
// Mesmo padrão do header do Portal do Cliente (ClientPortalPage).

import { cn } from "../../ui/cn";
import { useSlidingThumb } from "../../ui/useSlidingThumb";
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

function EyeIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ShieldIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

const VIEW_AS_OPTIONS = [
  { value: "hypr", label: "HYPR", Icon: ShieldIcon, title: "Visão HYPR: tudo, inclusive o que só a HYPR vê" },
  { value: "client", label: "Cliente", Icon: EyeIcon, title: "Visão do cliente: exatamente o que o cliente vê neste report" },
];

/* Seletor HYPR × Cliente. Thumb deslizante (mesmo hook dos outros toggles);
 * na visão do cliente o thumb fica na cor da marca, pra ninguém esquecer
 * em qual das duas está. No celular, só os ícones. */
function ViewAsToggle({ value, onChange }) {
  const active = Math.max(0, VIEW_AS_OPTIONS.findIndex((o) => o.value === value));
  const { containerRef, setItemRef, thumbStyle } = useSlidingThumb(active, VIEW_AS_OPTIONS.length);
  const client = value === "client";
  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label="Ver o report como"
      className="relative inline-flex items-center h-9 p-0.5 rounded-lg border border-border bg-surface"
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-0.5 bottom-0.5 left-0 rounded-md shadow-sm transition-colors duration-200",
          client ? "bg-signature" : "bg-canvas-elevated border border-border-strong",
        )}
        style={thumbStyle}
      />
      {VIEW_AS_OPTIONS.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={setItemRef(i)}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => !on && onChange(o.value)}
            className={cn(
              "relative z-10 inline-flex items-center gap-1.5 h-full px-2 sm:px-2.5 rounded-md",
              "text-[11px] font-bold tracking-wide cursor-pointer transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
              on ? (client ? "text-white" : "text-fg") : "text-fg-muted hover:text-fg",
            )}
          >
            <o.Icon className="size-3.5" />
            <span className="hidden sm:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TopBarV2({
  updatedAtLabel,
  // Versão curta do selo pra telas estreitas ("até 22/09") e tooltip com a
  // explicação da defasagem D-1. Ver src/shared/freshness.js.
  updatedAtShort,
  updatedAtTitle,
  onShare,
  shareState = "idle",
  onContactCS,
  onOpenComments,
  commentsUnread = 0,
  // Só admin: "hypr" | "client" e o setter. Sem eles o seletor não aparece.
  viewAs = null,
  onViewAsChange = null,
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
        "sticky top-0 z-30 [view-transition-name:report-topbar]",
        "h-16 px-4 md:px-6 lg:px-8 flex items-center justify-between gap-3",
        "bg-canvas/70 backdrop-blur-md border-b border-border",
        className,
      )}
    >
      {/* Branding: wordmark HYPR°REPORT CENTER tematizado */}
      {/* No celular o wordmark encolhe (proporção mantida pelo viewBox) pra
          caber ao lado do selo de frescor, do compartilhar e do tema. */}
      <div className="flex items-center text-fg min-w-0">
        <HyprReportCenterLogo height={32} className="max-w-[42vw] sm:max-w-none" />
      </div>

      {/* Ações */}
      <div className="flex items-center gap-2 shrink-0">
        {viewAs && onViewAsChange && <ViewAsToggle value={viewAs} onChange={onViewAsChange} />}

        {updatedAtLabel && (
          <span
            title={updatedAtTitle || undefined}
            className={cn(
              "inline-flex items-center gap-1.5",
              "px-3 py-1 rounded-full",
              "bg-surface border border-border",
              "text-[11px] font-medium text-fg-muted whitespace-nowrap",
            )}
          >
            <span className="size-1.5 rounded-full bg-success" aria-hidden />
            <span className="hidden sm:inline">{updatedAtLabel}</span>
            <span className="sm:hidden">{updatedAtShort || updatedAtLabel}</span>
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
              "hover:bg-signature-fill hover:text-fg transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
            )}
          >
            <ChatIcon className="size-3.5" />
            <span className="hidden md:inline">Falar com CS</span>
          </button>
        )}

        {onOpenComments && (
          <IconButton
            onClick={onOpenComments}
            title={
              commentsUnread > 0
                ? `Comentários · ${commentsUnread} ${commentsUnread === 1 ? "mensagem nova" : "mensagens novas"}`
                : "Comentários"
            }
            badge={commentsUnread > 0 ? (commentsUnread > 9 ? "9+" : String(commentsUnread)) : null}
          >
            <ChatIcon className="size-4" />
          </IconButton>
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

function IconButton({ children, onClick, title, tone = "default", badge = null }) {
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
        "relative inline-flex items-center justify-center size-9 rounded-lg",
        "bg-transparent border cursor-pointer",
        toneClass,
        "transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
      )}
    >
      {children}
      {badge && (
        <span
          aria-hidden="true"
          className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-signature-fill text-on-signature text-[10px] font-bold leading-[18px] text-center tabular-nums ring-2 ring-canvas"
        >
          {badge}
        </span>
      )}
    </button>
  );
}
