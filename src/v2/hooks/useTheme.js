// src/v2/hooks/useTheme.js
//
// Hook de gerenciamento do tema (dark/light) no V2.
//
// Single source of truth: o atributo `data-theme` no <html>.
// Esse atributo é setado em 3 momentos:
//   1. Script anti-FOUC inline no index.html (lê localStorage antes do
//      React montar pra evitar flash de tema errado)
//   2. Hook useTheme — sincroniza state global → DOM quando
//      o user clica no toggle
//   3. Listener prefers-color-scheme — atualiza se user mudar tema do
//      sistema operacional E não tiver preferência salva
//
// Ordem de prioridade na resolução inicial:
//   localStorage > prefers-color-scheme > 'dark' (default)
//
// IMPORTANTE: state global, não local
// ───────────────────────────────────
// O hook usa useSyncExternalStore (React 18+) com state module-level
// + pub/sub. Múltiplos componentes que chamam useTheme() compartilham
// O MESMO estado — quando um componente trigga setTheme/toggleTheme,
// TODOS os outros são notificados e re-renderizam automaticamente.
//
// Por que importa: o ThemeToggleV2 muda o tema, e isso precisa
// propagar pro CampaignHeaderV2 (que aplica filter na logo conforme
// o tema), pros gráficos (que mudam paleta) etc. Se cada hook tivesse
// seu próprio useState, só o componente do toggle re-renderizaria —
// o resto da árvore ficaria com o tema "antigo" até o próximo refresh.
// (Foi exatamente o bug do PR #58.)
//
// Exporta:
//   - useTheme()        → ['dark' | 'light', toggleFn, setThemeFn]
//   - getInitialTheme() → string (usado pelo script anti-FOUC; export
//                         pra reutilizar a mesma lógica em ambos os lugares)

import { useCallback, useEffect, useSyncExternalStore } from "react";

const STORAGE_KEY = "hypr_theme";
const VALID = ["dark", "light"];

export function getInitialTheme() {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (VALID.includes(stored)) return stored;
  } catch {
    /* localStorage indisponível (incognito + Safari, etc) — segue */
  }
  // HYPR é dark-first. Sem toggle explícito, sempre dark — não seguimos
  // prefers-color-scheme do OS porque vários componentes legacy ainda têm
  // estilos hardcoded em dark, e respeitar o OS quebrava a consistência
  // visual (drawer/modais pintavam light enquanto o resto seguia dark).
  return "dark";
}

function applyTheme(theme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

// ── Estado global module-level + pub/sub ─────────────────────────────────
// Todas as instâncias de useTheme leem deste store. setCurrentTheme notifica
// todos os subscribers, garantindo re-render sincronizado em toda a árvore.

let currentTheme = typeof window !== "undefined" ? getInitialTheme() : "dark";
const listeners = new Set();

function getSnapshot() {
  return currentTheme;
}

function getServerSnapshot() {
  // SSR: assume default. O script anti-FOUC corrige no client antes do
  // primeiro paint, então não dá flash visível.
  return "dark";
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setCurrentTheme(next) {
  if (!VALID.includes(next) || next === currentTheme) return;
  currentTheme = next;
  applyTheme(next);
  // Notifica todos os hooks ativos
  listeners.forEach((l) => l());
}

// Aplica imediatamente no carregamento do módulo (caso script anti-FOUC
// não tenha rodado, ex: dev sem index.html customizado).
if (typeof window !== "undefined") {
  applyTheme(currentTheme);
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setTheme = useCallback((next) => {
    if (!VALID.includes(next)) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* sem persistência, mas troca em sessão */
    }
    setCurrentTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(currentTheme === "dark" ? "light" : "dark");
  }, [setTheme]);

  // Listener prefers-color-scheme do OS removido junto com o fallback em
  // getInitialTheme — HYPR é dark-first, OS não interfere. User pode
  // toggleTheme() explicitamente pra light.

  return [theme, toggleTheme, setTheme];
}
