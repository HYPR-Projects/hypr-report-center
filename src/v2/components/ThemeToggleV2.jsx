// src/v2/components/ThemeToggleV2.jsx
//
// Toggle de tema (dark ↔ light) — botão icon-only minimalista.
//
// Mostra o ícone do PRÓXIMO estado (sol quando atual é dark, lua quando
// atual é light) — convenção UX comum em produtos como Linear, Vercel
// dashboard, Tailwind docs. Comunica "clicar pra ir pra esse modo".
//
// Acessibilidade
//   aria-label dinâmico descreve a ação ("Mudar para tema claro/escuro").
//   role="switch" + aria-checked seria semanticamente mais correto, mas
//   button + aria-label é suficiente e mais previsível em screen readers
//   no contexto de toggle binário sem state group.

import { useTheme } from "../hooks/useTheme";
import { cn } from "../../ui/cn";

export function ThemeToggleV2({ className }) {
  const [theme, toggleTheme] = useTheme();
  const isDark = theme === "dark";
  const nextLabel = isDark ? "claro" : "escuro";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Mudar para tema ${nextLabel}`}
      title={`Mudar para tema ${nextLabel}`}
      className={cn(
        "inline-flex items-center justify-center size-9 rounded-full",
        "border border-border bg-surface text-fg-muted",
        "hover:border-border-strong hover:bg-surface-strong hover:text-fg",
        "transition-colors duration-150 cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        className,
      )}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
