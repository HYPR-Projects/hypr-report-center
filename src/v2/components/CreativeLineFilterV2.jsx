// src/v2/components/CreativeLineFilterV2.jsx
//
// Filtro multiselect de linhas criativas. Espelha o padrão do
// AudienceFilterV2 (mesma combo Popover + checkboxes + counter + Limpar)
// — só muda o ícone, copy e o encurtamento do label, já que as chaves de
// linha criativa podem ser strings bem longas (ver getCreativeLineKey
// em shared/aggregations.js).
//
// Convenções herdadas do AudienceFilterV2:
//   - selected vazio = "todas as linhas" (filtro inativo)
//   - Itens do dropdown truncam pra últimos 3 tokens (separadores -_|),
//     com title= mostrando a chave completa
//   - Trigger label compacto: 1 ativo → últimos 2 tokens; N ativos →
//     "N linhas criativas"

import { useId } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../ui/cn";

const SEP_RE = /[-_| ]+/;

const tokenize = (key) => key.split(SEP_RE).filter(Boolean);

const shortLabel = (key, n = 3) => {
  const parts = tokenize(key);
  if (parts.length <= n) return key;
  return "…_" + parts.slice(-n).join("_");
};

const triggerShortLabel = (key) => {
  const parts = tokenize(key);
  return parts.slice(-2).join("_") || key;
};

export function CreativeLineFilterV2({ lines, selected, onChange }) {
  const headerId = useId();

  const isActive = selected.length > 0;
  const trigger = !isActive
    ? "Linha Criativa"
    : selected.length === 1
      ? triggerShortLabel(selected[0])
      : `${selected.length} linhas criativas`;

  const toggle = (line) => {
    if (selected.includes(line)) onChange(selected.filter((l) => l !== line));
    else onChange([...selected, line]);
  };

  const clear = () => onChange([]);

  return (
    <div className="inline-flex items-center gap-1.5">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Filtrar por linha criativa"
            className={cn(
              "inline-flex items-center gap-2 whitespace-nowrap",
              "h-9 px-4 rounded-full text-xs font-semibold",
              "border transition-colors duration-150 cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
              "max-w-[280px]",
              isActive
                ? "bg-signature-soft border-signature/40 text-signature hover:border-signature/70"
                : "bg-surface border-border text-fg hover:border-border-strong",
            )}
          >
            {/* Ícone "layers" — sugere variantes/linhas de criativo */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="shrink-0"
            >
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            <span className="truncate">{trigger}</span>
            {isActive && (
              <span className="shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-signature text-on-signature text-[10px] font-bold tabular-nums">
                {selected.length}
              </span>
            )}
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="currentColor"
              aria-hidden="true"
              className="opacity-60 shrink-0"
            >
              <path d="M0 2.5L5 7.5L10 2.5z" />
            </svg>
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            sideOffset={6}
            collisionPadding={16}
            align="end"
            className={cn(
              "z-50 w-[420px] max-w-[calc(100vw-32px)]",
              "max-h-[min(440px,calc(100vh-32px))]",
              "rounded-xl border border-border bg-canvas-elevated shadow-lg",
              "overflow-hidden flex flex-col",
              "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
              "focus-visible:outline-none",
            )}
            aria-labelledby={headerId}
          >
            <div className="flex items-center justify-between gap-2 px-4 py-3 bg-surface-strong border-b border-border">
              <span
                id={headerId}
                className="text-[11px] font-bold uppercase tracking-wider text-fg-muted"
              >
                {selected.length === 0
                  ? "Todas as linhas"
                  : `${selected.length} de ${lines.length}`}
              </span>
              {selected.length > 0 && (
                <button
                  type="button"
                  onClick={clear}
                  className="text-[11px] font-semibold text-signature hover:text-signature-hover px-2 py-0.5 rounded-md hover:bg-signature-soft transition-colors cursor-pointer"
                >
                  Limpar
                </button>
              )}
            </div>

            <div className="overflow-y-auto flex-1">
              {lines.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-fg-subtle">
                  Nenhuma linha criativa disponível.
                </div>
              ) : (
                lines.map((line) => {
                  const checked = selected.includes(line);
                  return (
                    <label
                      key={line}
                      title={line}
                      className={cn(
                        "flex items-center gap-2.5 px-4 py-2.5 cursor-pointer",
                        "border-b border-border/40 last:border-b-0",
                        "transition-colors",
                        checked
                          ? "bg-signature-soft hover:bg-signature/20"
                          : "hover:bg-surface",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(line)}
                        className="sr-only peer"
                      />
                      <span
                        aria-hidden="true"
                        className={cn(
                          "shrink-0 w-4 h-4 rounded-[4px] border-2 inline-flex items-center justify-center",
                          "transition-colors",
                          checked
                            ? "bg-signature border-signature"
                            : "border-fg-subtle",
                          "peer-focus-visible:ring-2 peer-focus-visible:ring-signature peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-canvas-elevated",
                        )}
                      >
                        {checked && (
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            fill="none"
                            stroke="white"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M1.5 5.5L4 8L8.5 2" />
                          </svg>
                        )}
                      </span>
                      <span
                        className={cn(
                          "text-xs flex-1 min-w-0 truncate",
                          checked
                            ? "text-fg font-semibold"
                            : "text-fg-muted font-normal",
                        )}
                      >
                        {shortLabel(line)}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {isActive && (
        <button
          type="button"
          onClick={clear}
          aria-label="Limpar filtro de linha criativa"
          title="Limpar filtro"
          className={cn(
            "inline-flex items-center justify-center w-7 h-7 rounded-full",
            "border border-border text-fg-subtle",
            "hover:border-danger hover:text-danger",
            "transition-colors cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
          )}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M2 2L10 10M10 2L2 10" />
          </svg>
        </button>
      )}
    </div>
  );
}
