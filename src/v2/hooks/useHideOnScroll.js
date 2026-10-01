// src/v2/hooks/useHideOnScroll.js
//
// "Some ao rolar pra baixo, volta ao rolar pra cima" — o padrão da barra de
// endereço dos navegadores mobile. No celular o report tem TopBar (64px) +
// abas + filtros fixos: ~165px, 20% de um iPhone e 25% de um SE. Rolando pra
// ler, o TopBar sai de cena; qualquer rolagem pra cima (ou chegar perto do
// topo) traz de volta.
//
// Só liga abaixo do md: no desktop a barra fixa não pesa e nada muda. Quem
// usa aplica o estado via `transform` (não altura), então o conteúdo não
// pula — a barra fixa só desliza por cima dele.

import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 767px)";
// Abaixo disso a barra sempre aparece (o cabeçalho da campanha ainda está
// na tela, não há o que ganhar escondendo).
const SHOW_NEAR_TOP_PX = 160;
// Movimento mínimo pra trocar de estado — ignora o tremor do dedo e o
// "bounce" do iOS no fim da página.
const DELTA_PX = 12;

export function useHideOnScroll() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia(MOBILE_QUERY);
    let lastY = window.scrollY;
    let ticking = false;

    const evaluate = () => {
      ticking = false;
      const y = window.scrollY;
      if (!mq.matches || y < SHOW_NEAR_TOP_PX) {
        setHidden(false);
        lastY = y;
        return;
      }
      const dy = y - lastY;
      if (Math.abs(dy) < DELTA_PX) return;
      setHidden(dy > 0);
      lastY = y;
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(evaluate);
    };
    const onMq = () => { if (!mq.matches) setHidden(false); };

    window.addEventListener("scroll", onScroll, { passive: true });
    mq.addEventListener?.("change", onMq);
    return () => {
      window.removeEventListener("scroll", onScroll);
      mq.removeEventListener?.("change", onMq);
    };
  }, []);

  return hidden;
}
