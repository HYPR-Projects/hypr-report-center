export const fmt  = (n,d=0) => n==null?"—":Number(n).toLocaleString("pt-BR",{minimumFractionDigits:d,maximumFractionDigits:d});
export const fmtR = (n)     => n==null?"—":`R$ ${fmt(n,2)}`;
export const fmtP = (n)     => n==null?"—":`${fmt(n,1)}%`;
export const fmtP2= (n)     => n==null?"—":`${fmt(n,2)}%`;

// ─── Datas/horas ─────────────────────────────────────────────────────────────
// Timestamps são armazenados em UTC no backend e serializados COM offset
// (ex: "2026-06-15T14:37:07+00:00"). A exibição é fixada em horário de
// Brasília (America/Sao_Paulo) — independente do fuso de quem abre o report,
// que pode ser um cliente fora do BR. Sem `timeZone`, o toLocale usa o fuso do
// navegador, divergindo entre viewers. Mesma convenção de DataFreshnessIndicator.
const TZ_BR = "America/Sao_Paulo";

// "15/06/2026 11:37" em BRT. null/vazio/inválido → null (caller esconde a linha).
// suffix=true acrescenta " (BRT)" — útil em telas client-facing pra deixar
// explícito que é horário de Brasília.
export const fmtDateTimeBR = (iso, { suffix = false } = {}) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const s = d.toLocaleString("pt-BR", {
    timeZone: TZ_BR, day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  return suffix ? `${s} (BRT)` : s;
};

// "15/06/2026". null/vazio/inválido → null.
// Date-only ("YYYY-MM-DD") é formatado LITERALMENTE, sem conversão de fuso:
// `new Date("2026-07-30")` é meia-noite UTC e, em BRT (−3h), viraria o dia
// anterior ("29/07"). Datas com hora (timestamp) usam timeZone BRT normal.
export const fmtDateBR = (iso) => {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("pt-BR", {
    timeZone: TZ_BR, day: "2-digit", month: "2-digit", year: "numeric",
  });
};

// Formato compacto pra números grandes — usado quando o espaço aperta
// (ex: cards de Display e Video lado a lado). Mantém 1 casa decimal pra
// preservar precisão sem ocupar largura. Padrão "k/M/B" universal.
//   1.234     → "1,2k"
//   25.470    → "25,5k"
//   1.234.567 → "1,2M"
export const fmtCompact = (n) => {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs < 1000)            return fmt(n);
  if (abs < 1_000_000)       return `${fmt(n / 1_000,         1)}k`;
  if (abs < 1_000_000_000)   return `${fmt(n / 1_000_000,     1)}M`;
  return                            `${fmt(n / 1_000_000_000, 1)}B`;
};
