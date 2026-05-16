// src/components/Toast.jsx
//
// <ToastContainer /> — UI do sistema de toast. Subscreve no singleton de
// lib/toast.js e renderiza os items ativos via portal no canto inferior
// direito. Veja lib/toast.js pra a API (toast.success/error/info).

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { subscribe, dismiss } from "../lib/toast";

export function ToastContainer() {
  const [items, setItems] = useState([]);

  useEffect(() => subscribe((next) => setItems([...next])), []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 10000,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
        maxWidth: "calc(100vw - 32px)",
      }}
    >
      {items.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>,
    document.body,
  );
}

function ToastItem({ toast: t, onDismiss }) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);

  // Entrada — uma frame depois do mount pra forçar transition de 0 → 1
  useEffect(() => {
    const r = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(r);
  }, []);

  // Auto-dismiss — moved do singleton (lib/toast.js) pra cá pra que o
  // timer dispare o estado "exiting" (animação de saída), depois o
  // onDismiss real (que remove do singleton) só roda no onTransitionEnd.
  useEffect(() => {
    if (!t.duration || t.duration <= 0) return;
    const timer = setTimeout(() => setExiting(true), t.duration);
    return () => clearTimeout(timer);
  }, [t.duration]);

  const triggerExit = () => setExiting(true);

  // Quando exiting=true, opacity vai pra 0 com transição. Ao terminar a
  // transição de opacity, dispara o onDismiss real (remove do singleton).
  // Filtra propertyName pra não disparar em outras transições do elemento.
  const handleTransitionEnd = (e) => {
    if (exiting && e.propertyName === "opacity") onDismiss();
  };

  const palette = {
    success: { bg: "#1A2C24", border: "#2ECC7140", icon: "#2ECC71", iconChar: "✓" },
    error:   { bg: "#2C1A1F", border: "#E74C3C40", icon: "#E74C3C", iconChar: "⚠" },
    info:    { bg: "#1A2535", border: "#3397B940", icon: "#3397B9", iconChar: "ℹ" },
  }[t.kind] || { bg: "#1A2535", border: "#3397B940", icon: "#3397B9", iconChar: "•" };

  const isShown = visible && !exiting;

  return (
    <div
      role={t.kind === "error" ? "alert" : "status"}
      aria-live={t.kind === "error" ? "assertive" : "polite"}
      onTransitionEnd={handleTransitionEnd}
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        minWidth: 240,
        maxWidth: 380,
        padding: "10px 12px",
        background: "var(--color-canvas-elevated, " + palette.bg + ")",
        color: "var(--color-fg, #F5F7FA)",
        border: "1px solid var(--color-border, " + palette.border + ")",
        borderLeft: `3px solid ${palette.icon}`,
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
        fontSize: 13,
        lineHeight: 1.4,
        // Entrada: 8px → 0px com fade. Saída: 0px → 8px com fade.
        // 200ms expo-out — mesmo easing do design system pra coerência.
        opacity: isShown ? 1 : 0,
        transform: isShown ? "translateX(0)" : "translateX(8px)",
        transition: "opacity 200ms cubic-bezier(0.16, 1, 0.3, 1), transform 200ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      <span
        aria-hidden
        style={{
          color: palette.icon,
          fontWeight: 700,
          fontSize: 14,
          lineHeight: 1.2,
          marginTop: 1,
          flexShrink: 0,
        }}
      >
        {palette.iconChar}
      </span>
      <span style={{ flex: 1, wordBreak: "break-word" }}>{t.message}</span>
      <button
        type="button"
        onClick={triggerExit}
        aria-label="Fechar notificação"
        style={{
          background: "none",
          border: "none",
          color: "var(--color-fg-muted, rgba(245,247,250,0.6))",
          cursor: "pointer",
          fontSize: 16,
          lineHeight: 1,
          padding: 0,
          marginLeft: 4,
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}

export default ToastContainer;
