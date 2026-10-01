// src/ui/useEdgeFade.js
//
// Affordance de "tem mais pro lado" em faixas que rolam na horizontal (barra
// de abas, linha de chips de filtro). No celular essas faixas usam
// `scrollbar-hidden`: sem barra, a última aba aparecia cortada na borda sem
// nenhuma pista de que dava pra arrastar.
//
// Por que máscara e não o `scroll-fade-x` (sombra por background)
// ───────────────────────────────────────────────────────────────
// O `scroll-fade-x` pinta um fundo opaco — serve pra tabela dentro de card,
// mas a barra de abas é translúcida (bg-canvas/85 + blur) e o conteúdo da
// página passa por trás. Aqui o próprio conteúdo esmaece nas bordas via
// `mask-image` (CSS em global-reset.css, utility `edge-fade-x`), funciona em
// qualquer fundo e qualquer tema.
//
// O hook só liga/desliga cada borda: `data-fade-start` quando dá pra rolar
// pra trás, `data-fade-end` quando ainda tem conteúdo à frente. Sem overflow,
// nenhuma borda esmaece (desktop fica idêntico).
//
// `opts.centerActive`: seletor do item ativo (ex: '[data-state="active"]').
// Quando o item ativo muda e está fora da área visível, a faixa rola pra
// mostrá-lo — sem isso, trocar de aba pelo link "Ver Vídeo →" deixava a aba
// ativa escondida fora da tela.

import { useCallback } from "react";

// Devolve um callback ref (com cleanup, React 19): funciona também quando o
// elemento só monta depois do primeiro render (report saindo do skeleton).
export function useEdgeFade(opts = {}) {
  const { centerActive } = opts;

  return useCallback((el) => {
    if (!el) return undefined;

    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      const start = max > 1 && el.scrollLeft > 1;
      const end = max > 1 && el.scrollLeft < max - 1;
      el.toggleAttribute("data-fade-start", start);
      el.toggleAttribute("data-fade-end", end);
    };

    const revealActive = (smooth) => {
      if (!centerActive) return;
      const item = el.querySelector(centerActive);
      if (!item || el.scrollWidth <= el.clientWidth) return;
      const left = item.offsetLeft;
      const right = left + item.offsetWidth;
      const pad = 32;
      if (left >= el.scrollLeft + pad && right <= el.scrollLeft + el.clientWidth - pad) return;
      el.scrollTo({
        left: Math.max(0, left - (el.clientWidth - item.offsetWidth) / 2),
        behavior: smooth ? "smooth" : "auto",
      });
    };

    update();
    revealActive(false);
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Filhos entrando/saindo (aba condicional, chip de filtro novo) mudam o
    // scrollWidth sem redimensionar o container; troca de aba muda o
    // data-state do trigger.
    const mo = new MutationObserver(() => {
      update();
      revealActive(true);
    });
    mo.observe(el, {
      childList: true,
      subtree: true,
      ...(centerActive ? { attributes: true, attributeFilter: ["data-state"] } : {}),
    });
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      mo.disconnect();
    };
  }, [centerActive]);
}
