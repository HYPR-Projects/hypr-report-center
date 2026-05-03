// src/v2/components/SegmentedControlV2.jsx
//
// Pill switch entre 2-N opções mutuamente exclusivas. Usado no DisplayV2
// e VideoV2 para alternar entre tactics (O2O / OOH) sem o peso visual e
// semântico de um <Tabs> aninhado dentro do <Tabs> principal do
// ClientDashboardV2.
//
// Por que não Radix Tabs aninhadas
// ─────────────────────────────────
// Tabs dentro de Tabs gera estrutura ARIA confusa (dois `role="tablist"`
// hierárquicos no mesmo painel) e duplica o keyboard navigation
// (←/→ ambíguos: trocam tab externa ou interna?). RadioGroup é a
// semântica correta para "escolha 1 entre N opções pertencentes a um
// grupo único" — que é exatamente o caso O2O vs OOH.
//
// A11y
// ────
// - Container: <div role="radiogroup" aria-label={label}>
// - Cada opção: <button role="radio" aria-checked>
// - Setas ←/→ trocam seleção (handler de keydown)
// - Tab navega o grupo todo, não cada opção (focus management
//   delegado ao botão ativo via tabIndex)
//
// API:
//   <SegmentedControlV2
//     label="Tática"
//     options={[{ value: "O2O", label: "O2O" }, { value: "OOH", label: "OOH" }]}
//     value={tactic}
//     onChange={setTactic}
//   />

import { useRef } from "react";
import { cn } from "../../ui/cn";
import { useSlidingThumb } from "../../ui/useSlidingThumb";

export function SegmentedControlV2({
  label,
  options,
  value,
  onChange,
  className,
}) {
  const activeIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const { containerRef, setItemRef, thumbStyle } = useSlidingThumb(
    activeIndex,
    options.length,
  );
  // Refs locais pra mover foco em ←/→ — o setItemRef do hook só guarda
  // pra medir, não dá acesso ao DOM aqui.
  const focusRefs = useRef([]);
  const setRef = (idx) => (el) => {
    focusRefs.current[idx] = el;
    setItemRef(idx)(el);
  };

  const onKeyDown = (e, idx) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = e.key === "ArrowLeft" ? -1 : 1;
    const next = (idx + dir + options.length) % options.length;
    onChange(options[next].value);
    // Move o foco pro próximo radio (consistente com pattern WAI-ARIA)
    focusRefs.current[next]?.focus();
  };

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label={label}
      className={cn(
        "relative inline-flex items-center gap-1 p-1",
        "rounded-lg bg-canvas-deeper border border-border",
        // Quando o usuário pediu reduced-motion, o thumb não desliza.
        // (a transition é forçada pra none direto no style abaixo.)
        "motion-reduce:[&_[data-thumb]]:!transition-none",
        className,
      )}
    >
      {/* Thumb deslizante: fica atrás dos botões, herda largura/posição
        * do botão ativo via useSlidingThumb. shadow-sm + bg matchando
        * o estado ativo do design original. */}
      <span
        data-thumb
        aria-hidden="true"
        className="absolute top-1 left-0 h-8 rounded-md bg-signature shadow-sm pointer-events-none"
        style={thumbStyle}
      />
      {options.map((opt, idx) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={setRef(idx)}
            type="button"
            role="radio"
            aria-checked={active}
            // Só o botão ativo é tabbable — pattern WAI-ARIA radio group.
            // Os demais entram no foco via setas dentro do grupo.
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            className={cn(
              "relative z-10 inline-flex items-center justify-center whitespace-nowrap",
              "px-4 h-8 rounded-md text-xs font-semibold",
              "transition-colors duration-150 cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
              active
                ? "text-on-signature"
                : "text-fg-muted hover:text-fg",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
