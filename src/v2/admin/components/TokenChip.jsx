// src/v2/admin/components/TokenChip.jsx
//
// Chip do short_token com click-to-copy.
//
// Comportamento
//   - Click: copia o token pro clipboard, troca o conteúdo pra "✓ COPIADO"
//     por 1.4s, volta ao normal.
//   - stopPropagation: o chip vive dentro de cards clicáveis (drawer,
//     report). Click no chip NÃO deve abrir o card.
//   - title attribute muda conforme o estado pra leitor de tela / hover.
//
// Visual
//   - Mesmas classes que existiam inline antes (`font-mono text-[10px]
//     text-fg-subtle ... bg-surface border border-border`) — variant
//     `card` reproduz o look do CampaignCardV2 e `compact` reproduz o
//     do CampaignListV2 (tracking e padding menores).
//   - Estado "copiado": bg vira success-soft, texto signature, com fade
//     suave via transition-colors.
//
// API
//   <TokenChip token="ABC123" variant="card" />
//   <TokenChip token="ABC123" variant="compact" />
//   <TokenChip token="ABC123" variant="report" icon={<CircleIcon className="size-3" />} />

import { useState, useRef, useEffect } from "react";
import { cn } from "../../../ui/cn";

const VARIANTS = {
  card:
    "text-[10px] tracking-wider px-1.5 py-0.5 rounded border",
  compact:
    "text-[9.5px] tracking-wider px-1 rounded",
  // report: usado no header do report público — visual signature soft com
  // ícone opcional à esquerda. Maior que o card pra equiparar com período
  // e duração na linha de meta.
  report:
    "text-[11px] tracking-wider px-2.5 py-1 rounded-md border",
};

export function TokenChip({ token, variant = "card", icon, className }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = (e) => {
    // Chip vive dentro de cards/headers clicáveis — não dispara o handler
    // do parent.
    e.stopPropagation();
    e.preventDefault();
    if (!token) return;
    try {
      navigator.clipboard?.writeText(token);
    } catch {
      // Clipboard pode falhar em contextos não-https/iframes — ignora
      // silenciosamente, feedback ainda mostra "copiado" pra dar pista
      // visual de que o click foi reconhecido.
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? "Copiado!" : `Clique para copiar: ${token}`}
      aria-label={copied ? "Token copiado" : `Copiar token ${token}`}
      className={cn(
        "font-mono uppercase cursor-pointer select-none",
        "transition-colors duration-150",
        // Estado idle x copiado.
        // Report variant idle usa signature soft (vive no header colorido);
        // os outros usam neutro (vivem dentro de cards do menu admin).
        copied
          ? "bg-success-soft text-success"
          : variant === "report"
            ? "bg-signature-soft text-signature font-bold hover:bg-signature/15"
            : "bg-surface text-fg-subtle hover:text-fg hover:bg-surface-strong",
        // Variantes (card e report têm border, compact não)
        VARIANTS[variant],
        // Border per variant: success quando copiado, neutro/signature quando idle
        variant === "card" && (copied ? "border-success/40" : "border-border"),
        variant === "report" && (copied ? "border-success/40" : "border-signature/40"),
        // Largura mínima evita "pulinho" quando o texto troca pra COPIADO.
        // Com leading icon, o gap interno aumenta — usa inline-flex gap-1.5.
        "inline-flex items-center justify-center gap-1.5 min-w-[5.5ch]",
        className,
      )}
    >
      {copied ? "✓ COPIADO" : (
        <>
          {icon}
          {token}
        </>
      )}
    </button>
  );
}
