// src/ui/useSlidingThumb.js
//
// Hook compartilhado pelos toggles (SegmentedControl, LayoutToggle, Tabs pill
// e underline) pra animar um "thumb" deslizante por trás da opção ativa.
//
// Por que assim
// ─────────────
// Larguras variáveis ("Por mês" vs "Top Performers") inviabilizam um thumb
// puramente CSS — precisa medir o DOM. Mas a animação em si é 100% CSS:
// o React só atualiza `transform` e `width`, e o browser interpola entre
// frames usando `transition: transform, width`. Zero `requestAnimationFrame`,
// zero JS no caminho da animação, GPU-composited.
//
// `useLayoutEffect` garante que a medição roda antes do paint — sem flash
// de "thumb fora de lugar". `ResizeObserver` cobre rotação de tela, troca
// de fonte, mudança de zoom, e re-layout do container pai.
//
// Primeira medição vem com `enableTransition=false` pra que o thumb apareça
// já posicionado, sem deslizar do canto. Depois liga, e a partir daí toda
// troca de seleção desliza.
//
// API
// ───
//   const { containerRef, setItemRef, thumbStyle } = useSlidingThumb(activeIndex, count);
//   <div ref={containerRef} className="relative">
//     <span className="absolute ..." style={thumbStyle} />
//     {options.map((o, i) =>
//       <button ref={setItemRef(i)} className="relative z-10">{o.label}</button>
//     )}
//   </div>
//
// `count` precisa estar nas deps pra re-medir quando o conjunto de opções muda
// (hoje só os toggles fixos, mas deixa pronto pra filtros dinâmicos).

import { useLayoutEffect, useRef, useState } from "react";

export function useSlidingThumb(activeIndex, count) {
  const containerRef = useRef(null);
  const itemsRef = useRef([]);
  const [thumbStyle, setThumbStyle] = useState({
    transform: "translate3d(0,0,0)",
    width: 0,
    opacity: 0,
    transition: "none",
  });
  // Primeira medição não anima (evita o slide-in do canto). Depois libera.
  const measuredOnceRef = useRef(false);

  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      const item = itemsRef.current[activeIndex];
      if (!container || !item) return;
      const cRect = container.getBoundingClientRect();
      const iRect = item.getBoundingClientRect();
      // Subpixel é bom — evita jitter em zoom 90%/110%.
      const x = iRect.left - cRect.left;
      const w = iRect.width;
      setThumbStyle({
        transform: `translate3d(${x}px, 0, 0)`,
        width: w,
        opacity: 1,
        // Após a primeira medição, todas as transições subsequentes deslizam.
        transition: measuredOnceRef.current
          ? "transform 280ms var(--ease-standard), width 280ms var(--ease-standard)"
          : "none",
      });
      measuredOnceRef.current = true;
    };

    measure();

    const container = containerRef.current;
    if (!container) return;
    // ResizeObserver no container cobre: rotação, zoom, font-load, mudança
    // de viewport. Re-medir aqui mantém o thumb alinhado mesmo se o ativo
    // não mudou.
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    // Observa também os items — largura do botão pode mudar (badge entrando,
    // texto trocando) sem o container mudar de tamanho.
    itemsRef.current.forEach((el) => el && ro.observe(el));
    return () => ro.disconnect();
  }, [activeIndex, count]);

  const setItemRef = (idx) => (el) => {
    itemsRef.current[idx] = el;
  };

  return { containerRef, setItemRef, thumbStyle };
}

// Variante pra Radix Tabs: o componente externo (Radix) é dono do estado
// ativo via atributo `data-state="active"`, então não temos `activeIndex`.
// Em vez disso, observamos mutações de `data-state` no container e medimos
// o elemento que estiver ativo a cada troca.
//
// Reuso o mesmo padrão do useSlidingThumb mas trocando "índice ativo" por
// "consulta no DOM". Mesmo timing, mesma transição.
export function useSlidingThumbForActive(activeSelector = '[data-state="active"]') {
  const containerRef = useRef(null);
  const [thumbStyle, setThumbStyle] = useState({
    transform: "translate3d(0,0,0)",
    width: 0,
    opacity: 0,
    transition: "none",
  });
  const measuredOnceRef = useRef(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const active = container.querySelector(activeSelector);
      if (!active) return;
      const cRect = container.getBoundingClientRect();
      const aRect = active.getBoundingClientRect();
      const x = aRect.left - cRect.left;
      const w = aRect.width;
      setThumbStyle({
        transform: `translate3d(${x}px, 0, 0)`,
        width: w,
        opacity: 1,
        transition: measuredOnceRef.current
          ? "transform 280ms var(--ease-standard), width 280ms var(--ease-standard)"
          : "none",
      });
      measuredOnceRef.current = true;
    };

    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(container);
    Array.from(container.children).forEach((el) => ro.observe(el));

    // Radix muda `data-state` quando outro tab é selecionado — mutação
    // no atributo dispara o re-measure sem precisar acoplar ao value do Root.
    const mo = new MutationObserver(measure);
    mo.observe(container, {
      attributes: true,
      attributeFilter: ["data-state"],
      subtree: true,
    });

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [activeSelector]);

  return { containerRef, thumbStyle };
}
