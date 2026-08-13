// src/v2/admin/components/LayoutToggle.jsx
//
// Segmented control de 5 botões pra alternar entre layouts:
//   - month:        agrupado por mês (legacy refatorado)
//   - client:       agrupado por cliente (view nova)
//   - list:         lista densa estilo Linear
//   - performers:   leaderboard de CS/CP
//   - diagnostico:  diagnóstico de pacing (status Ok/Over/Super Over/Under)
//
// Adota o mesmo padrão visual do SegmentedControlV2 já em uso no
// dashboard cliente, mas com 5 opções e ícones inline.

import { cn } from "../../../ui/cn";
import { useSlidingThumb } from "../../../ui/useSlidingThumb";

const OPTIONS = [
  {
    value: "month",
    label: "Por mês",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </svg>
    ),
  },
  {
    value: "client",
    label: "Por cliente",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="7" r="3.5" />
        <path d="M3 21v-1a6 6 0 0 1 12 0v1" />
        <circle cx="17" cy="7" r="3" strokeOpacity="0.5" />
      </svg>
    ),
  },
  {
    value: "list",
    label: "Lista",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      </svg>
    ),
  },
  {
    value: "performers",
    label: "Top Performers",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 21h8M12 17v4M6 4h12v3a6 6 0 0 1-12 0V4z" />
        <path d="M6 6H4a2 2 0 0 0 0 4h2M18 6h2a2 2 0 0 1 0 4h-2" />
      </svg>
    ),
  },
  {
    value: "diagnostico",
    label: "Diagnóstico",
    // Ícone de pulse/heart-rate — comunica "monitoramento da saúde da campanha".
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12h4l2-6 4 12 2-6h6" />
      </svg>
    ),
  },
];

export function LayoutToggle({ value, onChange, className }) {
  const activeIndex = Math.max(0, OPTIONS.findIndex((o) => o.value === value));
  const { containerRef, setItemRef, thumbStyle } = useSlidingThumb(
    activeIndex,
    OPTIONS.length,
  );

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label="Layout"
      className={cn(
        // bg-canvas-deeper é o padrão de "track" do DS — mesma escolha
        // do SegmentedControlV2 já em uso no dashboard cliente. Em
        // light fica #F1F3F6 (perceptível contra a página #F8F9FA);
        // em dark fica #0F1419 (mais escuro que canvas, dá contraste).
        // h-9 explícito (36px) em vez de deixar a altura ser calculada:
        // p-1 + h-7 dava 36 de conteúdo, mas a borda somava 2px por cima e o
        // controle fechava em 38 — 2px fora da busca e do select da linha de
        // baixo. Com h-9 e box-sizing border-box, a borda entra na conta.
        "relative inline-flex items-center gap-0.5 h-9 px-1 rounded-lg bg-canvas-deeper border border-border",
        // Mobile: 5 botões com label estouram 375px. Sem scroll, o flex pai
        // espremia e quebrava os labels em 2 linhas ("Por\nmês"). max-w-full +
        // min-w-0 deixa o controle encolher até a largura real, overflow-x-auto
        // libera o swipe horizontal (igual ui/Tabs), e o thumb absolute segue
        // medindo o botão ativo via offsetLeft (correto mesmo com scroll).
        "max-w-full min-w-0 overflow-x-auto scrollbar-hidden",
        "motion-reduce:[&_[data-thumb]]:!transition-none",
        className
      )}
    >
      {/* Thumb deslizante por trás do botão ativo. Largura/posição
        * medidas via useSlidingThumb. */}
      <span
        data-thumb
        aria-hidden="true"
        // top-[3px] = (34 - 28) / 2. A conta é sobre o PADDING BOX (34px: os
        // 36 do h-9 menos as duas bordas de 1px), porque é a ele que `top` de
        // um absolute se refere — não sobre os 36 externos. Com top-1 (4px) o
        // thumb ficava 2px baixo: 5 de folga em cima, 3 embaixo.
        //
        // NÃO usar top-1/2 + -translate-y-1/2 aqui: o useSlidingThumb aplica
        // `transform: translate3d(x,0,0)` via style inline pra deslizar na
        // horizontal, e style vence classe — a compensação vertical do
        // Tailwind seria descartada e o thumb cairia 14px.
        className="absolute top-[3px] left-0 h-7 rounded-md bg-canvas-elevated shadow-sm pointer-events-none"
        style={thumbStyle}
      />
      {OPTIONS.map((opt, idx) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            ref={setItemRef(idx)}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "relative z-10 inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-3 h-7 rounded-md cursor-pointer",
              "text-xs font-medium",
              "transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
              active
                ? "text-fg"
                : "text-fg-muted hover:text-fg"
            )}
          >
            <span className="shrink-0">{opt.icon}</span>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
