// src/v2/hooks/useTheme.js
//
// Hook de gerenciamento do tema (dark/light) no V2.
//
// Single source of truth: o atributo `data-theme` no <html>.
// Esse atributo é setado em 3 momentos:
//   1. Script anti-FOUC inline no index.html (lê localStorage antes do
//      React montar pra evitar flash de tema errado)
//   2. Hook useTheme.useEffect — sincroniza state React → DOM quando
//      o user clica no toggle
//   3. Listener prefers-color-scheme — atualiza se user mudar tema do
//      sistema operacional E não tiver preferência salva
//
// Ordem de prioridade na resolução inicial:
//   localStorage > prefers-color-scheme > 'dark' (default)
//
// Exporta:
//   - useTheme()       → ['dark' | 'light', toggleFn, setThemeFn]
//   - getInitialTheme() → string (usado pelo script anti-FOUC; export
//     pra reutilizar a mesma lógica em ambos os lugares)

import { useCallback, useEffect, useState } from "react";

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
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

function applyTheme(theme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setThemeState] = useState(() => getInitialTheme());

  // Sincroniza state React → DOM. Idempotente: se script anti-FOUC já
  // setou data-theme, esta linha apenas confirma.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Persiste E atualiza estado local. Toggle escreve em localStorage,
  // o que sinaliza preferência explícita do usuário (sobrescreve OS).
  const setTheme = useCallback((next) => {
    if (!VALID.includes(next)) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* sem persistência, mas troca em sessão */
    }
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  // Listener pra mudança de prefers-color-scheme do OS — só atualiza se
  // user NÃO tem preferência salva (toggle explícito sobrescreve OS).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (e) => {
      try {
        if (window.localStorage.getItem(STORAGE_KEY)) return;
      } catch {
        /* sem localStorage — segue OS */
      }
      setThemeState(e.matches ? "light" : "dark");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return [theme, toggleTheme, setTheme];
}
