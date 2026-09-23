// src/v2/components/ma/MaThumbV2.jsx
//
// Quadro gerado a partir do formato, no lugar de miniatura (a Platform ainda
// não gera poster estático da peça). Gradiente na cor do formato, ícone do
// formato e o tamanho da peça. Também serve de preview quando a peça não tem
// link público (arquivada, rascunho ou DEMO).

import { cn } from "../../../ui/cn";

const ICONS = {
  "tap-to-map": (
    <>
      <path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z" />
      <circle cx="12" cy="9" r="2.5" />
    </>
  ),
  carrossel: (
    <>
      <rect x="7" y="5" width="10" height="14" rx="2" />
      <path d="M3 8v8M21 8v8" />
    </>
  ),
  scratch: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    </>
  ),
  freeform: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M3 15l5-5 4 4 3-3 6 6" />
    </>
  ),
  survey: (
    <>
      <path d="M9 11l2 2 4-4" />
      <rect x="3" y="3" width="18" height="18" rx="3" />
    </>
  ),
  play: (
    <>
      <rect x="2" y="7" width="20" height="10" rx="4" />
      <path d="M7 12h3M8.5 10.5v3M15 11h.01M17 13h.01" />
    </>
  ),
  adserver: (
    <>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M8 21h8" />
    </>
  ),
};

export function MaThumbV2({ format, size, color = "var(--color-chart-s1)", className, style, large = false, label = null }) {
  const icon = ICONS[format] || ICONS.freeform;
  return (
    <div
      className={cn("relative grid place-items-center overflow-hidden rounded-lg text-white", className)}
      style={{
        background: `linear-gradient(145deg, color-mix(in srgb, ${color} 55%, #0b1116) 0%, ${color} 100%)`,
        ...style,
      }}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
    >
      <div className="grid place-items-center gap-1.5 text-center px-2">
        <svg
          className={large ? "size-10" : "size-6"}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {icon}
        </svg>
        {size && (
          <span className={cn("font-bold tracking-wider tabular-nums", large ? "text-xs" : "text-[9.5px]")}>
            {size}
          </span>
        )}
      </div>
    </div>
  );
}
