// src/v2/admin/components/filterChipStyle.js
//
// A geometria do chip de filtro, num módulo só de estilo.
//
// POR QUE EXISTE
// ────────────────────────────────────────────────────────────────────────
// Três filtros do PMP mantêm o próprio `Popover`: o calendário de período
// (DayPicker com presets e range), o grid de trimestres e o de meses. A
// lógica deles não cabe no contrato `panel(close)` do `FilterChip` sem
// reescrever a validação de datas — e reescrever validação de data pra
// ganhar consistência visual é a troca errada.
//
// Então eles renderizam o próprio botão e herdam a FORMA daqui. Sem uma
// fonte única, é assim que uma fileira acumula cinco geometrias pro mesmo
// tipo de decisão — foi o que aconteceu: `h-9 rounded-lg` num controle,
// `h-8 rounded-lg` no vizinho, `border-signature/50 bg-signature/10` num
// estado ativo, `bg-signature-soft border-signature` no outro.
//
// (Está em .js separado porque o ESLint exige que arquivos de componente
// exportem só componentes — `react-refresh/only-export-components`.)

import { cn } from "../../../ui/cn";

export function filterChipClass({ isSet = false, disabled = false } = {}) {
  return cn(
    "h-8 px-2.5 inline-flex items-center gap-1.5 rounded-md whitespace-nowrap cursor-pointer",
    "text-[12.5px] font-medium transition-colors border",
    isSet
      ? "bg-signature-soft border-signature text-fg"
      : "bg-surface border-border text-fg-muted hover:bg-surface-strong hover:text-fg hover:border-border-strong",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
    "focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
    disabled && "opacity-50 pointer-events-none",
  );
}
