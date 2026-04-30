// src/ui/Avatar.jsx
//
// Pip circular com iniciais. Usado pra owners (CP/CS) no menu admin
// e em qualquer outro lugar que precise representar uma pessoa em
// espaço pequeno.
//
// API:
//   <Avatar name="Beatriz Mendes" role="cs" size="sm" />
//   <Avatar name="João" color="signature" />
//   <AvatarStack>
//     <Avatar name="Karol" role="cp" />
//     <Avatar name="Mariana" role="cs" />
//   </AvatarStack>
//
// Cores por role:
//   cp → signature (azul HYPR) — comercial
//   cs → success   (verde)     — customer success
//   neutral → surface-strong (default sem role)
//
// Tamanhos seguem a escala do DS (4/8/12/16/24/32):
//   xs: 18px  sm: 22px  md: 28px  lg: 36px

import { cn } from "./cn";

const SIZE_PX = { xs: 18, sm: 22, md: 28, lg: 36 };
const SIZE_TXT = { xs: "text-[8px]", sm: "text-[9.5px]", md: "text-[11px]", lg: "text-xs" };

const ROLE_BG = {
  cp: "bg-signature",      // CP = signature blue
  cs: "bg-success",        // CS = success green
  neutral: "bg-surface-strong",
};

/**
 * Extrai até 2 iniciais maiúsculas a partir do nome.
 * "Beatriz Mendes" → "BM"
 * "João Paulo Buzolin" → "JB" (primeira + última)
 * "Madonna" → "MA" (primeiras 2 letras se for um único nome)
 */
function initialsFrom(name) {
  if (!name) return "?";
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({
  name,
  role = "neutral",
  size = "sm",
  className,
  title,
  ...rest
}) {
  const px = SIZE_PX[size] ?? SIZE_PX.sm;
  const txtCls = SIZE_TXT[size] ?? SIZE_TXT.sm;
  const bgCls = ROLE_BG[role] ?? ROLE_BG.neutral;

  return (
    <div
      className={cn(
        "inline-flex items-center justify-center rounded-full font-bold leading-none",
        "text-white tracking-tight",
        "ring-2 ring-canvas",   // anel da cor do canvas pra dar separação ao stack
        bgCls,
        txtCls,
        className
      )}
      style={{ width: px, height: px }}
      title={title || name}
      role={title || name ? "img" : undefined}
      aria-label={title || name}
      {...rest}
    >
      {initialsFrom(name)}
    </div>
  );
}

/**
 * Container que sobrepõe avatares horizontalmente (-margin negativa).
 * Usar com 2-4 Avatars; mais que isso vira ruído visual.
 */
export function AvatarStack({ className, children, ...rest }) {
  return (
    <div className={cn("inline-flex items-center", className)} {...rest}>
      {/* Cada Avatar interno empurra o seguinte com -ml. Aplicado via
          CSS combinator pra evitar prop drilling em casos onde o
          consumer adiciona spacing entre Avatars. */}
      <style>{`
        .avatar-stack > * + * { margin-left: -6px; }
      `}</style>
      <div className="avatar-stack inline-flex items-center">{children}</div>
    </div>
  );
}
