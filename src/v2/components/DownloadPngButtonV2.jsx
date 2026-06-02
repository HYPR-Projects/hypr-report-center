// src/v2/components/DownloadPngButtonV2.jsx
//
// Botão "PNG" (admin-only) que baixa o card de gráfico/tabela como imagem
// de alta resolução pra colar em apresentações. Abre um mini-menu com duas
// opções de fundo:
//   - Fundo do tema:  preenche com a cor de fundo do report (dark/light).
//   - Transparente:   PNG sem fundo, pra colar sobre qualquer base.
//
// Recebe `targetRef` apontando pro nó a capturar (o card inteiro). O próprio
// wrapper carrega `data-export-ignore`, então o botão e o menu nunca
// aparecem na imagem exportada (ver exportElementPng.js).
//
// Self-contained: popover simples com fechamento por clique-fora e Esc, sem
// depender de lib de menu (não há Radix/Popover no projeto ainda).

import { useEffect, useRef, useState } from "react";
import { cn } from "../../ui/cn";
import { exportElementToPng } from "../lib/exportElementPng";

export function DownloadPngButtonV2({ targetRef, filename, className, exportMaxWidth = null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef(null);

  // Fecha ao clicar fora ou apertar Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleExport = async (background) => {
    setOpen(false);
    const node = targetRef?.current;
    if (!node) return;
    setBusy(true);
    try {
      await exportElementToPng(node, { filename, background, maxWidth: exportMaxWidth });
    } catch (err) {
      // Não quebra a UI — só loga. Falha típica = fonte cross-origin sem CORS.
      console.error("[export-png] falha ao gerar imagem:", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={wrapRef}
      data-export-ignore
      className={cn("relative shrink-0", className)}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        title="Baixar como imagem (PNG)"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md",
          "text-[11px] font-semibold uppercase tracking-wider",
          "text-fg-muted hover:text-fg hover:bg-surface",
          "border border-border transition-colors cursor-pointer",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
        )}
      >
        {busy ? <Spinner /> : <DownloadIcon />}
        PNG
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute right-0 top-full mt-1.5 z-30 min-w-[190px]",
            "rounded-lg border border-border-strong bg-canvas-elevated",
            "shadow-lg py-1 overflow-hidden",
          )}
        >
          <MenuItem onClick={() => handleExport("theme")} icon={<ThemeBgIcon />}>
            Fundo do tema
          </MenuItem>
          <MenuItem
            onClick={() => handleExport("transparent")}
            icon={<TransparentIcon />}
          >
            Fundo transparente
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, icon, children }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2 text-left",
        "text-xs font-medium text-fg hover:bg-surface transition-colors cursor-pointer",
      )}
    >
      <span className="text-fg-muted shrink-0">{icon}</span>
      {children}
    </button>
  );
}

function DownloadIcon() {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      className="size-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Quadrado preenchido = fundo sólido do tema.
function ThemeBgIcon() {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="3" />
    </svg>
  );
}

// Quadrado tracejado = sem fundo (transparente).
function TransparentIcon() {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeDasharray="3 3"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="3" />
    </svg>
  );
}
