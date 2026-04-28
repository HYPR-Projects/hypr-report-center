// src/ui/Input.jsx
//
// Input de texto. Compatível com qualquer type nativo (text, password,
// email, number, search). Sem label embutido — uso esperado é compor
// com <label htmlFor>.
//
// API:
//   <Input
//     type="text"
//     placeholder="Buscar campanha"
//     invalid={!!error}
//     iconLeft={<SearchIcon/>}
//   />

import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./cn";

const inputStyles = cva(
  [
    "w-full bg-canvas-deeper border text-fg",
    "placeholder:text-fg-subtle",
    "transition-colors duration-150",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  ],
  {
    variants: {
      size: {
        sm: "h-8 px-3 text-xs rounded-md",
        md: "h-10 px-3.5 text-sm rounded-lg",
        lg: "h-12 px-4 text-base rounded-lg",
      },
      invalid: {
        true: "border-danger focus-visible:ring-danger",
        false: "border-border-strong focus:border-signature",
      },
    },
    defaultVariants: {
      size: "md",
      invalid: false,
    },
  }
);

export const Input = forwardRef(function Input(
  {
    size,
    invalid,
    iconLeft,
    iconRight,
    className,
    type = "text",
    ...rest
  },
  ref
) {
  // Sem ícones: render direto, sem wrapper.
  if (!iconLeft && !iconRight) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(inputStyles({ size, invalid }), className)}
        {...rest}
      />
    );
  }

  // Com ícones: wrapper relative + padding extra pra acomodar.
  return (
    <div className="relative w-full">
      {iconLeft && (
        <span
          className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none"
          aria-hidden="true"
        >
          {iconLeft}
        </span>
      )}
      <input
        ref={ref}
        type={type}
        className={cn(
          inputStyles({ size, invalid }),
          iconLeft && "pl-10",
          iconRight && "pr-10",
          className
        )}
        {...rest}
      />
      {iconRight && (
        <span
          className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none"
          aria-hidden="true"
        >
          {iconRight}
        </span>
      )}
    </div>
  );
});
Input.displayName = "Input";
