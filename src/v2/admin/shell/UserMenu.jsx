// src/v2/admin/shell/UserMenu.jsx
//
// Bloco de usuário no pé do rail + menu de preferências.
//
// O que veio pra cá e por quê
// ────────────────────────────────────────────────────────────────────────
// Antes, o header direito misturava quatro naturezas de controle no mesmo
// botão-ícone de 36px: estado de sistema (bases, DSPs), fila de trabalho
// (alertas), preferência (tema) e identidade (avatar, nome, Sair). O "Sair"
// era o ÚNICO com borda e fundo no hover — ou seja, a ação menos usada e
// mais destrutiva da tela tinha mais peso visual que 14 alertas críticos.
//
// Aqui ficam só as duas últimas naturezas: identidade e preferência.
// Estado de sistema e fila de trabalho subiram pro grupo "Operação" do
// rail, onde têm rótulo escrito e dot de severidade.
//
// O menu abre pra CIMA porque o gatilho é a última coisa do rail. No rail
// colapsado ele solta pra direita com largura fixa — sem isso viraria um
// painel de 52px de largura.

import { useEffect, useRef, useState } from "react";
import { cn } from "../../../ui/cn";
import { useTheme } from "../../hooks/useTheme";
import { DENSITY_COZY, DENSITY_DENSE } from "./useShellState";
import { ChevronDownIcon, DensityIcon, ExternalIcon, LogoutIcon } from "./navIcons";

export function UserMenu({ user, onLogout, density, onDensityChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const [theme, toggleTheme] = useTheme();
  const isDark = theme === "dark";
  const isDense = density === DENSITY_DENSE;

  // Fecha em clique fora e em Esc. Não é um Dialog do Radix de propósito:
  // é um menu de preferências dentro do layout, não um overlay modal — não
  // deve travar o scroll nem prender o foco da página.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initials = getInitials(user?.name || user?.email);

  return (
    <div ref={wrapRef} className="relative">
      {open && (
        <div
          role="menu"
          aria-label="Preferências e conta"
          className={cn(
            "absolute bottom-[calc(100%+6px)] left-0 right-0 z-[80] p-1.5",
            "rounded-xl border border-border-strong bg-canvas-elevated shadow-lg",
            // Colapsado: solta pra direita com largura própria.
            "rail-collapsed:right-auto rail-collapsed:w-[220px]",
          )}
        >
          <MenuRow
            icon={isDark ? <SunGlyph /> : <MoonGlyph />}
            label="Tema"
            trail={isDark ? "Escuro" : "Claro"}
            onClick={toggleTheme}
          />
          <MenuRow
            icon={<DensityIcon dense={isDense} />}
            label="Densidade"
            trail={isDense ? "Compacta" : "Confortável"}
            onClick={() => onDensityChange(isDense ? DENSITY_COZY : DENSITY_DENSE)}
          />
          <MenuRow
            icon={<ExternalIcon />}
            label="Abrir demo"
            onClick={() => {
              window.open("/report/DEMO", "_blank", "noopener");
              setOpen(false);
            }}
          />
          <div className="h-px bg-border my-1.5 mx-1" />
          <MenuRow
            icon={<LogoutIcon />}
            label="Sair"
            tone="danger"
            onClick={() => { setOpen(false); onLogout?.(); }}
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user?.name || user?.email || "Conta"}
        className={cn(
          "w-full h-[42px] flex items-center gap-2.5 px-2 rounded-md cursor-pointer",
          "border-0 bg-transparent text-left transition-colors",
          "hover:bg-surface",
          open && "bg-surface",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
          "focus-visible:ring-offset-1 focus-visible:ring-offset-canvas-elevated",
          "rail-collapsed:justify-center rail-collapsed:px-0 rail-collapsed:gap-0",
        )}
      >
        {user?.picture ? (
          <img
            src={user.picture}
            alt=""
            referrerPolicy="no-referrer"
            className="shrink-0 size-7 rounded-full ring-2 ring-signature-soft object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "shrink-0 size-7 rounded-full grid place-items-center",
              "bg-signature-fill text-on-signature text-[10.5px] font-extrabold",
              "ring-2 ring-signature-soft",
            )}
          >
            {initials}
          </span>
        )}

        <span className="flex-1 min-w-0 rail-collapsed:hidden">
          <span className="block text-[12.5px] font-semibold text-fg truncate">
            {user?.name || "Conta"}
          </span>
          <span className="block text-[10px] text-fg-subtle truncate">
            {user?.email || "Admin · HYPR"}
          </span>
        </span>

        <ChevronDownIcon
          size={12}
          className={cn(
            "shrink-0 text-fg-subtle transition-transform duration-200 rail-collapsed:hidden",
            open ? "rotate-0" : "rotate-180",
          )}
        />
      </button>
    </div>
  );
}

function MenuRow({ icon, label, trail, tone, onClick }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "w-full h-8 flex items-center gap-2.5 px-2.5 rounded-md cursor-pointer",
        "border-0 bg-transparent text-left text-[12.5px] font-medium transition-colors",
        tone === "danger"
          ? "text-danger hover:bg-danger-soft"
          : "text-fg-muted hover:bg-surface hover:text-fg",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("shrink-0 grid place-items-center", tone === "danger" ? "text-danger" : "text-fg-subtle")}
      >
        {icon}
      </span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {trail && <span className="shrink-0 text-[10.5px] font-semibold text-fg-subtle">{trail}</span>}
    </button>
  );
}

/**
 * Iniciais para quando o Google não devolve `picture` (conta sem foto, ou
 * a imagem 403a por referrer policy). Duas letras no máximo.
 */
function getInitials(nameOrEmail) {
  if (!nameOrEmail) return "?";
  const clean = nameOrEmail.split("@")[0].replace(/[._-]+/g, " ").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function SunGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
