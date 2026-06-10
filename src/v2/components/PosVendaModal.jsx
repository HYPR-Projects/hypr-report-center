// src/v2/components/PosVendaModal.jsx
//
// Modal do pós-venda no report do cliente — abre pelo chip "Pós-venda" do
// CampaignHeaderV2. Renderiza o deck do Google Slides EMBUTIDO (iframe
// /embed, com navegação de slides e fullscreen) sem o cliente precisar
// abrir nova aba; o link externo fica como ação secundária.
//
// Quando há material adicional (qualquer URL), aparece como card de link
// abaixo do deck. Se o link de pós-venda não for parseável como Slides
// (caso raro — admin colou outra coisa), degrada pro mesmo card de link.

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../../ui/cn";
import { slidesEmbedUrl } from "../../lib/slides";

const MODE_LABEL = {
  apresentado: "Apresentado ao cliente",
  enviado: "Enviado ao cliente",
};

export function PosVendaModal({ open, onOpenChange, posVenda, clientName }) {
  if (!posVenda) return null;
  const embedUrl = slidesEmbedUrl(posVenda.url);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-40 bg-black/60 backdrop-blur-[3px]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "duration-200",
          )}
        />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50",
            "-translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-32px)] max-w-[960px]",
            "max-h-[calc(100vh-48px)] overflow-hidden",
            "rounded-2xl border border-border-strong bg-canvas-elevated shadow-2xl",
            "flex flex-col outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            "duration-200",
          )}
        >
          {/* ── Header ──────────────────────────────────────────────── */}
          <div className="px-6 md:px-8 pt-6 pb-5 border-b border-border bg-surface-2/60 relative shrink-0">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(ellipse at top right, var(--color-signature-glow) 0%, transparent 70%)",
              }}
            />
            <div className="relative flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="inline-block w-6 h-0.5 rounded-full bg-signature" aria-hidden />
                  <Dialog.Title asChild>
                    <span className="text-[10.5px] font-bold uppercase tracking-[1.5px] text-signature">
                      Pós-venda
                    </span>
                  </Dialog.Title>
                </div>
                <Dialog.Description asChild>
                  <h2 className="text-lg md:text-xl font-bold text-fg leading-tight tracking-[-0.3px] line-clamp-1">
                    {clientName ? `Resultados — ${clientName}` : "Resultados da campanha"}
                  </h2>
                </Dialog.Description>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {posVenda.mode && <ModeBadge mode={posVenda.mode} />}
                <Dialog.Close
                  aria-label="Fechar"
                  className={cn(
                    "inline-flex items-center justify-center w-8 h-8 rounded-md",
                    "text-fg-muted hover:text-fg hover:bg-surface transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                  )}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </Dialog.Close>
              </div>
            </div>
          </div>

          {/* ── Body ────────────────────────────────────────────────── */}
          <div className="flex-1 overflow-y-auto px-6 md:px-8 py-6 space-y-5">
            {posVenda.url && embedUrl && <SlidesFrame embedUrl={embedUrl} />}

            {/* Fallback: link de pós-venda não-parseável como Slides */}
            {posVenda.url && !embedUrl && (
              <LinkCard
                url={posVenda.url}
                title="Apresentação de pós-venda"
                mode={posVenda.mode}
                icon={<SlidesIcon className="size-4" />}
              />
            )}

            {posVenda.extra_url && (
              <LinkCard
                url={posVenda.extra_url}
                title="Material adicional"
                mode={posVenda.extra_mode}
                icon={<PaperclipIcon className="size-4" />}
              />
            )}
          </div>

          {/* ── Footer — link externo como ação secundária ──────────── */}
          {posVenda.url && embedUrl && (
            <div className="flex items-center justify-end px-6 md:px-8 py-3.5 border-t border-border bg-surface shrink-0">
              <a
                href={posVenda.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "inline-flex items-center gap-1.5 text-xs font-semibold",
                  "text-fg-muted hover:text-signature transition-colors",
                )}
              >
                Abrir no Google Slides
                <ExternalIcon className="size-3" />
              </a>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Building blocks ─────────────────────────────────────────────────────

/**
 * Deck do Slides embedado com skeleton de loading. Componente próprio de
 * propósito: o Radix desmonta o conteúdo do Dialog ao fechar, então o
 * `frameLoaded` reseta por desmontagem natural na próxima abertura — sem
 * precisar de setState em effect.
 */
function SlidesFrame({ embedUrl }) {
  const [frameLoaded, setFrameLoaded] = useState(false);
  return (
    <div className="rounded-xl border border-border overflow-hidden bg-canvas-deeper">
      {/* 16:9 — mesma técnica do LoomV2 (padding-top trick) */}
      <div className="relative w-full" style={{ paddingTop: "59%" }}>
        {!frameLoaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-fg-subtle">
            <FrameSpinner />
            <span className="text-xs font-medium">Carregando apresentação…</span>
          </div>
        )}
        <iframe
          src={embedUrl}
          title="Apresentação de pós-venda"
          allowFullScreen
          onLoad={() => setFrameLoaded(true)}
          className={cn(
            "absolute inset-0 w-full h-full border-0 transition-opacity duration-300",
            frameLoaded ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
    </div>
  );
}

function ModeBadge({ mode }) {
  const label = MODE_LABEL[mode];
  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-signature-soft border border-signature/40 text-signature text-[10px] font-bold uppercase tracking-wider whitespace-nowrap">
      {mode === "apresentado" ? <PresentIcon className="size-3" /> : <SendIcon className="size-3" />}
      {label}
    </span>
  );
}

/**
 * Card de link externo — usado pro material adicional e como fallback
 * quando o link de pós-venda não é um Slides embedável.
 */
function LinkCard({ url, title, mode, icon }) {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    host = url;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group flex items-center gap-3.5 px-4 py-3.5 rounded-xl",
        "border border-border bg-surface hover:border-signature/40 hover:bg-signature/5",
        "transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
      )}
    >
      <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-signature-soft text-signature shrink-0">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-fg group-hover:text-signature transition-colors">
          {title}
        </span>
        <span className="block text-[11px] text-fg-subtle truncate">{host}</span>
      </span>
      {MODE_LABEL[mode] && (
        <span className="hidden sm:inline text-[10px] font-bold uppercase tracking-wider text-fg-subtle shrink-0">
          {MODE_LABEL[mode]}
        </span>
      )}
      <ExternalIcon className="size-3.5 text-fg-subtle group-hover:text-signature transition-colors shrink-0" />
    </a>
  );
}

function FrameSpinner() {
  return (
    <svg className="animate-spin" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────

function SlidesIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function PaperclipIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function PresentIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
    </svg>
  );
}

function SendIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

function ExternalIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14 21 3" />
    </svg>
  );
}
