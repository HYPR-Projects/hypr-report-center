/**
 * Date range filter helpers.
 *
 * Centraliza a lógica de:
 *  - Definir presets ("Ontem", "Últimos 7 dias", etc.) com base numa data
 *    de referência (hoje, ou end_date da campanha — o que for menor);
 *  - Serializar / parsear range na URL (?from=YYYY-MM-DD&to=YYYY-MM-DD);
 *  - Filtrar arrays por campo de data, lidando com formatos zoados:
 *      * Excel serial (número), DD/MM/YYYY, YYYY-MM-DD;
 *      * Vários nomes de coluna ("date", "Date", "DATE").
 *  - Re-agregar `daily` em `totals` quando o filtro está ativo.
 */

import {
  format,
  subDays,
  startOfMonth,
  endOfMonth,
  subMonths,
  isAfter,
  isBefore,
  isEqual,
  differenceInCalendarDays,
} from "date-fns";

// ─── Date parsing & formatting ───────────────────────────────────────────────
export const ymd = (d) => (d instanceof Date ? format(d, "yyyy-MM-dd") : d);

/** Parse YYYY-MM-DD em Date local sem tropeçar no timezone. */
export function parseYmd(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  // parseISO trata como UTC se vier só "YYYY-MM-DD". Forçamos local.
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** Normaliza várias representações de data pra YYYY-MM-DD. */
export function normalizeRowDate(v) {
  if (v == null || v === "") return null;
  // Excel serial (número de dias desde 1899-12-30)
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    if (n > 25569 && n < 60000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return dt.toISOString().slice(0, 10);
    }
  }
  const s = String(v).trim();
  // DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
    const [dd, mm, yyyy] = s.slice(0, 10).split("/");
    return `${yyyy}-${mm}-${dd}`;
  }
  // YYYY-MM-DD ou ISO completo
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/**
 * Lê do row a primeira coluna não-vazia de uma lista de chaves
 * possíveis, normalizando pra YYYY-MM-DD.
 */
export function getRowDate(row, keys = ["Date", "DATE", "date"]) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== "") {
      const norm = normalizeRowDate(row[k]);
      if (norm) return norm;
    }
  }
  return null;
}

// ─── URL sync ────────────────────────────────────────────────────────────────
/**
 * Lê range da URL. `prefix` permite ranges independentes por aba:
 *   readRangeFromUrl()        → ?from=&to=         (Visão Geral/Display/Video)
 *   readRangeFromUrl("rmnd")  → ?rmnd_from=&rmnd_to=
 *   readRangeFromUrl("pdooh") → ?pdooh_from=&pdooh_to=
 */
export function readRangeFromUrl(prefix = "") {
  try {
    const fromKey = prefix ? `${prefix}_from` : "from";
    const toKey = prefix ? `${prefix}_to` : "to";
    const p = new URLSearchParams(window.location.search);
    const from = p.get(fromKey);
    const to = p.get(toKey);
    if (!from || !to) return null;
    const f = parseYmd(from);
    const t = parseYmd(to);
    if (!f || !t) return null;
    return { from: f, to: t };
  } catch {
    return null;
  }
}

export function writeRangeToUrl(range, prefix = "") {
  try {
    const fromKey = prefix ? `${prefix}_from` : "from";
    const toKey = prefix ? `${prefix}_to` : "to";
    const url = new URL(window.location.href);
    if (range?.from && range?.to) {
      url.searchParams.set(fromKey, ymd(range.from));
      url.searchParams.set(toKey, ymd(range.to));
    } else {
      url.searchParams.delete(fromKey);
      url.searchParams.delete(toKey);
    }
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* ignore */
  }
}

// ─── Presets ─────────────────────────────────────────────────────────────────
/**
 * Gera presets baseados num "hoje" lógico — geralmente o min(today, campaign.end_date)
 * pra evitar presets futuros em campanhas já encerradas.
 */
export function buildPresets(refToday, campaignStart, campaignEnd) {
  const today = refToday || new Date();
  const start = campaignStart ? parseYmd(campaignStart) : null;
  const end = campaignEnd ? parseYmd(campaignEnd) : null;

  // Clampa um range pra dentro dos limites da campanha
  const clamp = (from, to) => {
    let f = from;
    let t = to;
    if (start && isBefore(f, start)) f = start;
    if (end && isAfter(t, end)) t = end;
    if (isAfter(f, t)) return null;
    return { from: f, to: t };
  };

  const yest = subDays(today, 1);
  return [
    { id: "all", label: "Todo o período", range: null },
    { id: "yesterday", label: "Ontem", range: clamp(yest, yest) },
    { id: "last7", label: "Últimos 7 dias", range: clamp(subDays(today, 6), today) },
    { id: "last15", label: "Últimos 15 dias", range: clamp(subDays(today, 14), today) },
    { id: "last30", label: "Últimos 30 dias", range: clamp(subDays(today, 29), today) },
    { id: "thisMonth", label: "Este mês", range: clamp(startOfMonth(today), today) },
    {
      id: "lastMonth",
      label: "Mês passado",
      range: clamp(startOfMonth(subMonths(today, 1)), endOfMonth(subMonths(today, 1))),
    },
  ];
}

/** True se o range bate com o preset (compara apenas yyyy-MM-dd). */
export function matchesPreset(range, preset) {
  if (!preset.range) return !range;
  if (!range) return false;
  return ymd(range.from) === ymd(preset.range.from) && ymd(range.to) === ymd(preset.range.to);
}

// ─── Range matching ──────────────────────────────────────────────────────────
/** Inclui inicio e fim. Aceita string YYYY-MM-DD ou Date. */
export function inRange(dateLike, range) {
  if (!range) return true;
  const d = typeof dateLike === "string" ? parseYmd(dateLike) : dateLike;
  if (!d) return false;
  const f = range.from, t = range.to;
  return (
    (isEqual(d, f) || isAfter(d, f)) &&
    (isEqual(d, t) || isBefore(d, t))
  );
}

/** Formata range para exibição compacta tipo "01/04 - 15/04". */
export function formatRangeShort(range) {
  if (!range) return "";
  const fmt = (d) => format(d, "dd/MM");
  if (ymd(range.from) === ymd(range.to)) return fmt(range.from);
  return `${fmt(range.from)} – ${fmt(range.to)}`;
}

/** Quantidade de dias inclusivos no range. */
export function daysInRange(range) {
  if (!range) return 0;
  return differenceInCalendarDays(range.to, range.from) + 1;
}

/** Quantidade de dias inclusivos entre duas datas (campaign duration). */
export function daysBetween(startStr, endStr) {
  const s = parseYmd(startStr);
  const e = parseYmd(endStr);
  if (!s || !e) return 0;
  return differenceInCalendarDays(e, s) + 1;
}
