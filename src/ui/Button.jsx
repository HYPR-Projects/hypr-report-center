// src/ui/Button.jsx
//
// Button primitive do V2. Variants × sizes via cva, classes resolvidas
// com cn() (twMerge). Acessível por default: focus-visible ring,
// disabled state, aria handling herdado do <button>.
//
// API:
//   <Button variant="primary" size="md" loading iconLeft={<Plus/>}>
//     Salvar
//   </Button>

import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./cn";

const buttonStyles = cva(
  // base — sempre aplicado
  [
    "inline-flex items-center justify-center gap-2",
    "font-semibold whitespace-nowrap select-none",
    "transition-colors duration-150",
    "disabled:opacity-50 disabled:cursor-not-allowed",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
    "cursor-pointer",
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-signature text-fg hover:bg-signature-hover active:bg-signature-hover",
        secondary:
          "bg-surface-strong text-fg hover:bg-surface border border-border-strong",
        ghost:
          "bg-transparent text-fg hover:bg-surface",
        danger:
          "bg-danger text-fg hover:opacity-90",
      },
      size: {
        sm: "h-8 px-3 text-xs rounded-md",
        md: "h-10 px-4 text-sm rounded-lg",
        lg: "h-12 px-6 text-base rounded-lg",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
      fullWidth: false,
    },
  }
);

// Spinner inline pra estado loading. SVG simples pra evitar dependência
// extra de ícones aqui — quando entrar lucide-react ou similar, troca.
function Spinner({ className }) {
  return (
    <svg
      className={cn("animate-spin", className)}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export const Button = forwardRef(function Button(
  {
    variant,
    size,
    fullWidth,
    loading = false,
    disabled = false,
    iconLeft,
    iconRight,
    className,
    children,
    type = "button",
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonStyles({ variant, size, fullWidth }), className)}
      {...rest}
    >
      {loading ? <Spinner /> : iconLeft}
      {children}
      {!loading && iconRight}
    </button>
  );
});

Button.displayName = "Button";
