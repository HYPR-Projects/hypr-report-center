// src/v2/admin/lib/format.js
//
// Formatadores compartilhados pelo admin V2. Todos os helpers aqui são
// puros (input → output, sem side effects), pra serem testáveis e
// reusáveis em qualquer componente.

/**
 * Tempo relativo curto em PT-BR.
 * "há 2h" / "há 5d" / "há 1mês" / "agora"
 *
 * Usa Intl.RelativeTimeFormat quando disponível pra granularidade
 * automática. Fallback para parse manual em browsers antigos.
 */
const RTF = typeof Intl !== "undefined" && Intl.RelativeTimeFormat
  ? new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto", style: "narrow" })
  : null;

export function formatTimeAgo(timestamp) {
  if (!timestamp) return "";
  const then = new Date(timestamp);
  if (isNaN(then.getTime())) return "";
  const now = new Date();
  const diffSec = Math.round((then.getTime() - now.getTime()) / 1000);

  const absSec = Math.abs(diffSec);
  if (absSec < 60) return "agora";

  if (RTF) {
    if (absSec < 3600)     return RTF.format(Math.round(diffSec / 60),    "minute");
    if (absSec < 86400)    return RTF.format(Math.round(diffSec / 3600),  "hour");
    if (absSec < 86400 * 30) return RTF.format(Math.round(diffSec / 86400), "day");
    if (absSec < 86400 * 365) return RTF.format(Math.round(diffSec / (86400 * 30)), "month");
    return RTF.format(Math.round(diffSec / (86400 * 365)), "year");
  }

  // Fallback simples
  if (absSec < 3600)     return `há ${Math.round(absSec / 60)}min`;
  if (absSec < 86400)    return `há ${Math.round(absSec / 3600)}h`;
  if (absSec < 86400 * 30) return `há ${Math.round(absSec / 86400)}d`;
  return `há ${Math.round(absSec / (86400 * 30))}mês`;
}

/**
 * "115%" / "—"  (preserva ausência sem confundir com zero).
 */
export function formatPct(value, decimals = 0) {
  if (value == null || isNaN(value)) return "—";
  return `${Number(value).toFixed(decimals)}%`;
}

/**
 * Cor do número de pacing (CSS variable). Mantém alinhado com a
 * classificação de health do backend.
 */
export function pacingColorClass(pacing) {
  if (pacing == null) return "text-fg-subtle";
  if (pacing > 140 || pacing < 75) return "text-danger";
  if (pacing > 115 || pacing < 85) return "text-warning";
  return "text-success";
}

/**
 * Display de pacing curto. Acima de 999% mostra "999%+" pra evitar
 * estouro de layout (caso raro mas existe — backfill de delivery).
 */
export function formatPacingValue(pacing) {
  if (pacing == null) return "—";
  if (pacing > 999) return "999%+";
  return `${Math.round(pacing)}%`;
}

/**
 * Mês/ano formatado a partir de YYYY-MM-DD. Usado pra labels de
 * agrupamento mensal e quick-filter pills.
 *
 * "2026-04-15" → "Abril de 2026" (long) ou "Abr 26" (short)
 */
const MONTH_LONG  = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const MONTH_SHORT = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

export function formatMonthLabel(yyyymm, variant = "long") {
  if (!yyyymm) return "";
  const [y, m] = String(yyyymm).split("-").map(Number);
  if (!y || !m) return "";
  if (variant === "short") return `${MONTH_SHORT[m - 1]} ${String(y).slice(-2)}`;
  return `${MONTH_LONG[m - 1]} de ${y}`;
}

/**
 * Date range curto: "01/04 → 30/04" (mesmo ano omite ano), "01/12/25 → 15/01/26"
 */
export function formatDateRange(startISO, endISO) {
  if (!startISO || !endISO) return "";
  const s = new Date(startISO);
  const e = new Date(endISO);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return "";
  const sameYear = s.getFullYear() === e.getFullYear();
  const sd = String(s.getDate()).padStart(2, "0");
  const sm = String(s.getMonth() + 1).padStart(2, "0");
  const ed = String(e.getDate()).padStart(2, "0");
  const em = String(e.getMonth() + 1).padStart(2, "0");
  if (sameYear) return `${sd}/${sm} → ${ed}/${em}`;
  const sy = String(s.getFullYear()).slice(-2);
  const ey = String(e.getFullYear()).slice(-2);
  return `${sd}/${sm}/${sy} → ${ed}/${em}/${ey}`;
}

/**
 * Email → display name curto. "joao.buzolin@hypr.mobi" → "joao.buzolin".
 * Usado quando não temos o nome cadastrado mas precisa exibir alguém.
 */
export function localPartFromEmail(email) {
  if (!email) return "";
  const idx = email.indexOf("@");
  return idx > 0 ? email.slice(0, idx) : email;
}

/**
 * "kenvue" → "Kenvue", "coca-cola-brasil" → "Coca Cola Brasil"
 * Usado em fallbacks quando display_name não veio do backend.
 */
export function slugToDisplay(slug) {
  if (!slug) return "";
  return slug
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
