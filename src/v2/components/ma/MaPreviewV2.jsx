// src/v2/components/ma/MaPreviewV2.jsx
//
// Preview real da peça: link público da Platform (/share/creatives/<slug>
// ?preview=1) num iframe, em tamanho nativo e reduzido quando não cabe. O
// modo preview não registra impressão (sem parâmetros de entrega).
//
// Ressalvas ditas na tela:
//   • mostra a versão ATUAL da peça (se foi editada no meio da campanha, o
//     aviso aparece);
//   • peça arquivada não tem preview (backend não manda o link);
//   • sem link público (rascunho, DEMO), fica o quadro gerado do formato.

import { useEffect, useRef, useState } from "react";
import { fmtDateBR } from "../../../shared/format";
import { cn } from "../../../ui/cn";
import { MaThumbV2 } from "./MaThumbV2";

const MAX_H = 620;

function nativeSize(piece) {
  if (piece?.width && piece?.height) return { w: piece.width, h: piece.height };
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(String(piece?.size || ""));
  if (m) return { w: Number(m[1]), h: Number(m[2]) };
  return null; // fluida
}

export function MaPreviewV2({ piece, color, campaignStart = null, isDemo = false }) {
  const boxRef = useRef(null);
  const [boxW, setBoxW] = useState(0);
  const [nonce, setNonce] = useState(0);
  const size = nativeSize(piece);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setBoxW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const w = size?.w || 360;
  const h = size?.h || 360;
  const scale = boxW > 0 ? Math.min(1, (boxW - 24) / w, MAX_H / h) : 1;
  const archived = piece?.status === "archived";
  const editedMidFlight =
    piece?.updated_at && campaignStart && String(piece.updated_at).slice(0, 10) > campaignStart;

  return (
    <div className="rounded-xl border border-border bg-surface-2 p-4 min-w-0">
      <div className="flex items-center justify-between gap-2 mb-3">
        <span className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">
          Preview{piece?.size ? ` · ${piece.size}` : ""}
        </span>
        {piece?.preview_url && <span className="text-[11px] text-fg-subtle">interativo</span>}
      </div>

      <div
        ref={boxRef}
        className="grid place-items-center rounded-lg bg-canvas-deeper p-3 overflow-hidden"
        style={{ minHeight: Math.min(MAX_H, h * scale) + 24 }}
      >
        {piece?.preview_url ? (
          <div style={{ width: w * scale, height: h * scale }} className="relative">
            <iframe
              key={nonce}
              title={`Preview da peça ${piece.name}`}
              src={piece.preview_url}
              width={w}
              height={h}
              loading="lazy"
              sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              className="absolute left-0 top-0 border-0 bg-white rounded-md shadow-lg origin-top-left"
              style={{ transform: `scale(${scale})` }}
            />
          </div>
        ) : (
          <MaThumbV2
            format={piece?.format}
            size={piece?.size}
            color={color}
            large
            className="shadow-lg"
            style={{ width: Math.max(120, w * scale), height: Math.max(80, h * scale) }}
            label={`Quadro do formato ${piece?.name || ""}`}
          />
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {piece?.preview_url && (
          <>
            <button
              type="button"
              onClick={() => setNonce((n) => n + 1)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border text-xs font-semibold text-fg-muted hover:text-fg hover:border-border-strong cursor-pointer"
            >
              <ReloadIcon /> Recarregar
            </button>
            <a
              href={piece.preview_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border text-xs font-semibold text-fg-muted hover:text-fg hover:border-border-strong"
            >
              <ExternalIcon /> Abrir em nova aba
            </a>
          </>
        )}
      </div>

      <p className={cn("mt-2 text-[11px] leading-snug text-fg-subtle")}>
        {piece?.preview_url
          ? "Peça real, na versão atual. Interagir aqui não conta impressão nem clique."
          : archived
            ? "Peça arquivada na Platform: sem preview. As métricas do período continuam valendo."
            : isDemo
              ? "No demo, o quadro representa o formato. Nas campanhas reais, a peça abre aqui e responde a toques."
              : "Esta peça não tem link público de preview."}
        {piece?.preview_url && editedMidFlight
          ? ` A peça foi editada em ${fmtDateBR(String(piece.updated_at).slice(0, 10))}, depois do início da campanha.`
          : ""}
      </p>
    </div>
  );
}

function ReloadIcon() {
  return (
    <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
