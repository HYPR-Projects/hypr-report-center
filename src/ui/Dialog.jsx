// src/ui/Dialog.jsx
//
// Dialog/Modal sobre Radix UI. Trap de foco, ESC pra fechar, click no
// overlay, scroll lock — tudo do Radix. Estilo HYPR aplicado.
//
// API:
//   <Dialog>
//     <DialogTrigger asChild><Button>Abrir</Button></DialogTrigger>
//     <DialogContent>
//       <DialogHeader>
//         <DialogTitle>Confirmação</DialogTitle>
//         <DialogDescription>...</DialogDescription>
//       </DialogHeader>
//       <DialogBody>...</DialogBody>
//       <DialogFooter>...</DialogFooter>
//     </DialogContent>
//   </Dialog>

import { forwardRef } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { cn } from "./cn";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;
export const DialogPortal = RadixDialog.Portal;

const DialogOverlay = forwardRef(function DialogOverlay(
  { className, ...rest },
  ref
) {
  return (
    <RadixDialog.Overlay
      ref={ref}
      className={cn(
        "fixed inset-0 z-50",
        "bg-black/60 backdrop-blur-sm",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=open]:fade-in data-[state=closed]:fade-out",
        className
      )}
      {...rest}
    />
  );
});
DialogOverlay.displayName = "DialogOverlay";

export const DialogContent = forwardRef(function DialogContent(
  { className, children, ...rest },
  ref
) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <RadixDialog.Content
        ref={ref}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
          "w-[92vw] max-w-lg",
          "rounded-xl border border-border bg-canvas-elevated shadow-xl",
          "focus-visible:outline-none",
          className
        )}
        {...rest}
      >
        {children}
      </RadixDialog.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...rest }) {
  return (
    <div
      className={cn(
        "px-6 pt-6 pb-3 border-b border-border",
        className
      )}
      {...rest}
    />
  );
}

export const DialogTitle = forwardRef(function DialogTitle(
  { className, ...rest },
  ref
) {
  return (
    <RadixDialog.Title
      ref={ref}
      className={cn("text-lg font-bold text-fg leading-tight", className)}
      {...rest}
    />
  );
});
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = forwardRef(function DialogDescription(
  { className, ...rest },
  ref
) {
  return (
    <RadixDialog.Description
      ref={ref}
      className={cn("text-sm text-fg-muted mt-1.5 leading-relaxed", className)}
      {...rest}
    />
  );
});
DialogDescription.displayName = "DialogDescription";

export function DialogBody({ className, ...rest }) {
  return <div className={cn("px-6 py-4", className)} {...rest} />;
}

export function DialogFooter({ className, ...rest }) {
  return (
    <div
      className={cn(
        "px-6 py-4 border-t border-border flex items-center justify-end gap-2",
        className
      )}
      {...rest}
    />
  );
}
