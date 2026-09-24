// src/v2/components/LoomModal.jsx
//
// Vídeo explicativo da campanha (Loom) aberto pelo botão "Assistir resumo"
// do CampaignHeaderV2.
//
// Antes o vídeo era uma aba ("Video Loom") no mesmo nível de Display e
// Vídeo. É conteúdo narrativo, não análise: como aba disputava espaço com
// os dados e passava despercebido. No header fica ao lado de Negociado e
// Pós-venda, que são da mesma família (material que a HYPR preparou).
//
// O corpo reaproveita o LoomV2 inteiro — validação do domínio (nunca embeda
// URL arbitrária), placeholders de "sem vídeo"/"link inválido" e o link
// externo com tracking continuam num lugar só.

import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../../ui/cn";
import LoomV2 from "../dashboards/LoomV2";

export function LoomModal({ open, onOpenChange, loomUrl, campaignName }) {
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
                      Resumo em vídeo
                    </span>
                  </Dialog.Title>
                </div>
                <Dialog.Description asChild>
                  <h2 className="text-lg md:text-xl font-bold text-fg leading-tight tracking-[-0.3px] line-clamp-1">
                    {campaignName || "Resumo da campanha"}
                  </h2>
                </Dialog.Description>
              </div>
              <Dialog.Close
                aria-label="Fechar"
                className={cn(
                  "inline-flex items-center justify-center w-8 h-8 rounded-md shrink-0",
                  "text-fg-muted hover:text-fg hover:bg-surface transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                )}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </Dialog.Close>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-6 md:px-8 py-6">
            {open && <LoomV2 loomUrl={loomUrl} />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
