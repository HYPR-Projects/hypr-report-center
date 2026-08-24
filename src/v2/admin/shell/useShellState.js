// src/v2/admin/shell/useShellState.js
//
// Preferências de chrome do admin: rail colapsado, gaveta mobile aberta e
// densidade das linhas. São três coisas com ciclos de vida diferentes:
//
//   colapsado  → preferência durável (localStorage, cross-tab)
//   densidade  → preferência durável (localStorage, cross-tab)
//   gaveta     → efêmera; nasce fechada em todo mount, some ao navegar
//
// O rail e a densidade são lidos SINCRONAMENTE no primeiro render e
// aplicados como atributo no <html> por um script inline no index.html.
// Sem isso o layout salta: o rail pinta 248px, o React lê o storage e
// encolhe pra 68px no frame seguinte. Mesmo problema que o anti-FOUC do
// tema já resolvia — a solução aqui é a mesma.

import { useCallback, useEffect, useState } from "react";

const LS_RAIL    = "hypr.admin.railCollapsed";
const LS_DENSITY = "hypr.admin.density";

export const DENSITY_COZY  = "cozy";
export const DENSITY_DENSE = "dense";

// ── Leitura síncrona ─────────────────────────────────────────────────────
// Prioriza o atributo que o script do index.html já aplicou (é a verdade
// que está na tela) e só cai no storage se ele não estiver lá — cobre
// ambiente sem o script (teste unitário, storybook futuro).
function readCollapsed() {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-rail");
    if (attr === "collapsed") return true;
    if (attr === "expanded")  return false;
  }
  try { return localStorage.getItem(LS_RAIL) === "1"; }
  catch { return false; }
}

function readDensity() {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-density");
    if (attr === DENSITY_DENSE || attr === DENSITY_COZY) return attr;
  }
  try {
    const v = localStorage.getItem(LS_DENSITY);
    return v === DENSITY_DENSE ? DENSITY_DENSE : DENSITY_COZY;
  } catch { return DENSITY_COZY; }
}

export function useShellState() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [density, setDensity]     = useState(readDensity);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Espelha no <html> + storage. O atributo é o que o CSS lê (o rail e as
  // tabelas reagem a `[data-rail]` / `[data-density]`), então mantê-lo em
  // sync aqui é o que faz o toggle valer pra árvore inteira — inclusive
  // pros portais do Radix, que renderizam fora da árvore React.
  useEffect(() => {
    document.documentElement.setAttribute("data-rail", collapsed ? "collapsed" : "expanded");
    try { localStorage.setItem(LS_RAIL, collapsed ? "1" : "0"); }
    catch { /* ignore */ }
  }, [collapsed]);

  useEffect(() => {
    document.documentElement.setAttribute("data-density", density);
    try { localStorage.setItem(LS_DENSITY, density); }
    catch { /* ignore */ }
  }, [density]);

  // Trava o scroll do body enquanto a gaveta mobile está aberta — sem
  // isso o conteúdo atrás do overlay rola junto com o gesto.
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [drawerOpen]);

  // Esc fecha a gaveta. A gaveta não é um Dialog do Radix (ela é parte do
  // layout, não um overlay modal sobre conteúdo), então o foco-trap e o
  // escape-to-close vêm daqui.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e) => { if (e.key === "Escape") setDrawerOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const toggleCollapsed = useCallback(() => setCollapsed((v) => !v), []);
  const openDrawer      = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer     = useCallback(() => setDrawerOpen(false), []);
  const toggleDrawer    = useCallback(() => setDrawerOpen((v) => !v), []);

  return {
    collapsed, toggleCollapsed, setCollapsed,
    density, setDensity,
    isDense: density === DENSITY_DENSE,
    drawerOpen, openDrawer, closeDrawer, toggleDrawer,
  };
}
