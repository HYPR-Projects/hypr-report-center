// src/ui/Drawer.jsx
//
// Drawer lateral (side panel) deslizando da direita. Construído sobre
// Radix Dialog primitives — ganha foco-trap, escape-to-close, scroll
// lock e roles ARIA corretos sem custo.
//
// API espelha shadcn/ui Sheet, mas exposta com o nome "Drawer" porque
// é o termo que o time usa internamente:
//
//   <Drawer open={open} onOpenChange={setOpen}>
//     <DrawerHeader title="Smiles — Magno" subtitle="0VGU6Q" />
//     <DrawerBody>
//       ...conteúdo...
//     </DrawerBody>
//     <DrawerFooter>
//       <Button>Salvar</Button>
//     </DrawerFooter>
//   </Drawer>
//
// Uso típico no admin V2: card de campanha clicado abre drawer com
// ações (Loom, Survey, Logo, Owner, Link Cliente, abrir Report).
//
// Largura fixa de 420px no desktop; full-width abaixo de 640px.

import * as Dialog from "@radix-ui/react-dialog";
import { forwardRef } from "react";
import { cn } from "./cn";

export function Drawer({ open, onOpenChange, children }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </Dialog.Root>
  );
}

export const DrawerTrigger = Dialog.Trigger;

export const DrawerContent = forwardRef(function DrawerContent(
  { className, children, ...rest },
  ref
) {
  return (
    <Dialog.Portal>
      {/* Backdrop sutil — admin V2 já usa cor escura, então 40% basta */}
      <Dialog.Overlay
        className={cn(
          "fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0"
        )}
      />
      <Dialog.Content
        ref={ref}
        className={cn(
          // Posicionamento fixo, slide da direita
          "fixed top-0 right-0 z-50 h-full w-full sm:w-[420px]",
          "bg-canvas-elevated border-l border-border shadow-2xl",
          "flex flex-col outline-none",
          // Animations via tailwindcss-animate (já registrado no theme.css)
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
          "duration-200 ease-out",
          className
        )}
        {...rest}
      >
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
});

/**
 * Header com título grande + subtítulo opcional + botão fechar (X).
 * O botão é Dialog.Close pra fechar via Radix sem precisar de prop.
 */
export function DrawerHeader({ title, subtitle, className }) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 px-6 pt-6 pb-4 border-b border-border",
        className
      )}
    >
      <div className="min-w-0 flex-1">
        <Dialog.Title className="text-lg font-bold tracking-tight text-fg leading-tight truncate">
          {title}
        </Dialog.Title>
        {subtitle && (
          <Dialog.Description className="mt-1 text-xs text-fg-muted font-mono tracking-wide">
            {subtitle}
          </Dialog.Description>
        )}
      </div>
      <Dialog.Close
        aria-label="Fechar"
        className={cn(
          "shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md",
          "text-fg-muted hover:text-fg hover:bg-surface",
          "transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature"
        )}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </Dialog.Close>
    </div>
  );
}

export function DrawerBody({ className, children }) {
  return (
    <div className={cn("flex-1 overflow-y-auto px-6 py-5", className)}>
      {children}
    </div>
  );
}

export function DrawerFooter({ className, children }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-6 py-4 border-t border-border bg-surface",
        className
      )}
    >
      {children}
    </div>
  );
}
