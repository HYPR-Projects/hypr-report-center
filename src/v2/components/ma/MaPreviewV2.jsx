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
import { MaThumbV2 } from "./MaThumbV2";
import { MaActionButton, MaCard } from "./maUi";

const MAX_H = 620;

function nativeSize(piece) {
  if (piece?.width && piece?.height) return { w: piece.width, h: piece.height };
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(String(piece?.size || ""));
  if (m) return { w: Number(m[1]), h: Number(m[2]) };
  return null; // fluida
}

// `hero`: a miniatura do card clicado na grade vira este preview numa View
// Transition (MaxAttentionV2.openPiece). O nome só existe durante a troca.
export function MaPreviewV2({ piece, color, campaignStart = null, isDemo = false, hero = false, collapsible = false }) {
  const boxRef = useRef(null);
  const [boxW, setBoxW] = useState(0);
  const [nonce, setNonce] = useState(0);
  // Celular: a peça começa recolhida numa linha, para os números virem
  // primeiro. Abre sob demanda.
  const [expanded, setExpanded] = useState(false);
  const collapsed = collapsible && !expanded;
  // Qual iframe (src + recarga) já terminou de carregar. Comparar com a
  // chave atual reseta sozinho ao trocar de peça ou recarregar, sem efeito.
  const [loadedKey, setLoadedKey] = useState(null);
  const frameKey = `${piece?.preview_url || ""}#${nonce}`;
  const frameLoaded = loadedKey === frameKey;
  const size = nativeSize(piece);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setBoxW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed]);

  const w = size?.w || 360;
  const h = size?.h || 360;
  const scale = boxW > 0 ? Math.min(1, (boxW - 24) / w, MAX_H / h) : 1;
  const archived = piece?.status === "archived";
  const editedMidFlight =
    piece?.updated_at && campaignStart && String(piece.updated_at).slice(0, 10) > campaignStart;

  if (collapsed) {
    return (
      <MaCard>
        <div className="flex items-center gap-3">
          <MaThumbV2 format={piece?.format} color={color} className="h-14 w-10 shrink-0 [&_svg]:size-4" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold text-fg">Preview da peça</div>
            <div className="text-xs text-fg-subtle">{piece?.size ? `${piece.size} · ` : ""}{piece?.preview_url ? "interativo" : "quadro do formato"}</div>
          </div>
          <MaActionButton onClick={() => setExpanded(true)}>Ver peça</MaActionButton>
        </div>
      </MaCard>
    );
  }

  const iconBtn = "inline-grid size-7 place-items-center rounded-md border border-border text-fg-muted hover:text-fg hover:border-border-strong cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature";

  return (
    <MaCard
      title="Preview"
      subtitle={[piece?.size, piece?.preview_url ? "Interativo · versão atual" : null].filter(Boolean).join(" · ") || null}
      actions={
        <>
          {piece?.preview_url && (
            <>
              <button type="button" onClick={() => setNonce((n) => n + 1)} className={iconBtn} aria-label="Recarregar a peça" title="Recarregar">
                <ReloadIcon />
              </button>
              <a href={piece.preview_url} target="_blank" rel="noopener noreferrer" className={iconBtn} aria-label="Abrir a peça em nova aba" title="Abrir em nova aba">
                <ExternalIcon />
              </a>
            </>
          )}
          {collapsible && <MaActionButton onClick={() => setExpanded(false)}>Recolher</MaActionButton>}
        </>
      }
      footer={
        <span>
          {piece?.preview_url
            ? "Interagir aqui não conta impressão nem clique."
            : archived
              ? "Peça arquivada na Platform: sem preview. As métricas do período continuam valendo."
              : isDemo
                ? "No demo, o quadro representa o formato. Nas campanhas reais, a peça abre aqui e responde a toques."
                : "Esta peça não tem link público de preview."}
          {piece?.preview_url && editedMidFlight
            ? ` A peça foi editada em ${fmtDateBR(String(piece.updated_at).slice(0, 10))}, depois do início da campanha.`
            : ""}
        </span>
      }
    >
      <div
        ref={boxRef}
        className="grid place-items-center rounded-lg bg-canvas-deeper p-3 overflow-hidden"
        style={{ minHeight: Math.min(MAX_H, h * scale) + 24 }}
      >
        {piece?.preview_url ? (
          <div
            style={{ width: w * scale, height: h * scale, viewTransitionName: hero ? "ma-hero" : undefined }}
            className="relative"
          >
            {/* Quadro do formato com shimmer até a peça pintar; o iframe entra
                em fade por cima (sem o flash do fundo branco no tema escuro).
                É o mesmo quadro da miniatura do card, então a transição da
                grade pra cá não troca de visual no meio. */}
            {!frameLoaded && (
              <MaThumbV2
                format={piece?.format}
                size={piece?.size}
                color={color}
                large
                className="absolute inset-0 rounded-md skeleton-shimmer"
              />
            )}
            <iframe
              key={nonce}
              onLoad={() => setLoadedKey(frameKey)}
              data-loaded={frameLoaded ? "true" : "false"}
              title={`Preview da peça ${piece.name}`}
              src={piece.preview_url}
              width={w}
              height={h}
              loading="lazy"
              sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              className="ma-preview-frame absolute left-0 top-0 border-0 bg-white rounded-md shadow-lg origin-top-left"
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
            style={{ width: Math.max(120, w * scale), height: Math.max(80, h * scale), viewTransitionName: hero ? "ma-hero" : undefined }}
            label={`Quadro do formato ${piece?.name || ""}`}
          />
        )}
      </div>
    </MaCard>
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
