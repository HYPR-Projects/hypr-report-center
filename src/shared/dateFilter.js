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

/**
 * Lê o id do preset que originou o range atual (se houver). Permite
 * preservar a *intenção* do filtro ao trocar de view num report agrupado:
 * "Mês passado" deve continuar "Mês passado" mesmo quando o range
 * absoluto colapsaria com outro preset (ex: "Últimos 30 dias") nos
 * limites do novo membro.
 */
export function readPresetFromUrl(prefix = "") {
  try {
    const key = prefix ? `${prefix}_preset` : "preset";
    const p = new URLSearchParams(window.location.search);
    const v = p.get(key);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function writePresetToUrl(presetId, prefix = "") {
  try {
    const key = prefix ? `${prefix}_preset` : "preset";
    const url = new URL(window.location.href);
    if (presetId) url.searchParams.set(key, presetId);
    else          url.searchParams.delete(key);
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* ignore */
  }
}

// ─── Presets ─────────────────────────────────────────────────────────────────
/**
 * Gera presets baseados num "hoje" lógico — geralmente o min(today, campaign.end_date)
 * pra evitar presets futuros em campanhas já encerradas.
 *
 * Cada preset carrega um flag `wasClamped`: true quando os limites da
 * campanha encolheram a janela natural (ex: "Últimos 30 dias" num membro
 * que começou há 3 dias vira `{start_membro → hoje}`). Vários presets
 * podem colapsar no mesmo range nesse caso — o consumidor usa esse flag
 * pra preferir o preset "natural" (não clampado) na hora de exibir label
 * e marcar o ativo no popover.
 */
export function buildPresets(refToday, campaignStart, campaignEnd) {
  const today = refToday || new Date();
  const start = campaignStart ? parseYmd(campaignStart) : null;
  const end = campaignEnd ? parseYmd(campaignEnd) : null;

  // Clampa um range pra dentro dos limites da campanha
  const clamp = (from, to) => {
    let f = from;
    let t = to;
    let wasClamped = false;
    if (start && isBefore(f, start)) { f = start; wasClamped = true; }
    if (end && isAfter(t, end))      { t = end;   wasClamped = true; }
    if (isAfter(f, t)) return { range: null, wasClamped: false };
    return { range: { from: f, to: t }, wasClamped };
  };

  const make = (id, label, from, to) => {
    const c = clamp(from, to);
    return { id, label, range: c.range, wasClamped: c.wasClamped };
  };

  const yest = subDays(today, 1);
  return [
    { id: "all", label: "Todo o período", range: null, wasClamped: false },
    make("yesterday", "Ontem",            yest,                                            yest),
    make("last7",     "Últimos 7 dias",   subDays(today, 6),                               today),
    make("last15",    "Últimos 15 dias",  subDays(today, 14),                              today),
    make("last30",    "Últimos 30 dias",  subDays(today, 29),                              today),
    make("thisMonth", "Este mês",         startOfMonth(today),                             today),
    make("lastMonth", "Mês passado",      startOfMonth(subMonths(today, 1)),               endOfMonth(subMonths(today, 1))),
  ];
}

/**
 * Resolve o preset "preferido" entre os que casam com `value`. Quando
 * vários colapsam no mesmo range (ex: dentro de um membro recém-iniciado),
 * prefere o que NÃO foi clampado — a janela natural ("Este mês") é mais
 * informativa que uma artificialmente encolhida ("Últimos 30 dias" virou
 * 3 dias). Sem nenhum match real, retorna null.
 *
 * `hintId` opcional: id do preset que originou o range. Quando vários
 * presets casam o range, o hint vence sobre as outras heurísticas — assim
 * a *intenção* do user ("Mês passado" no agregado) é preservada ao trocar
 * de view, mesmo quando o range numérico colapsaria com outro preset
 * ("Últimos 30 dias" nos limites apertados do membro).
 */
export function pickActivePreset(range, presets, hintId = null) {
  if (!range) {
    return presets.find((p) => p.id === "all") || null;
  }
  const matches = presets.filter((p) => p.id !== "all" && matchesPreset(range, p));
  if (!matches.length) return null;
  if (hintId) {
    const hinted = matches.find((p) => p.id === hintId);
    if (hinted) return hinted;
  }
  return matches.find((p) => !p.wasClamped) || matches[0];
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

/**
 * Recorta um range aos limites da janela [start, end]. Devolve null quando
 * não há interseção nenhuma.
 *
 * Usado ao trocar de membro num report agrupado: um range escolhido num mês
 * não deve vazar pro mês destino. Sem interseção → o caller cai pra "Todo o
 * período" em vez de manter um filtro fora da janela (que zera o detail e
 * deixa os KPIs de entrega num fallback enganoso).
 */
export function clampRangeToWindow(range, startStr, endStr) {
  if (!range?.from || !range?.to) return null;
  const s = parseYmd(startStr);
  const e = parseYmd(endStr);
  if (!s || !e) return range;
  const from = isAfter(range.from, s) ? range.from : s;
  const to   = isBefore(range.to, e) ? range.to : e;
  if (isAfter(from, to)) return null;
  return { from, to };
}

/**
 * Dias inclusivos de INTERSEÇÃO entre um range e a janela [start, end].
 * Zero quando não há overlap.
 *
 * Diferente de `daysInRange` (tamanho bruto do range): usado no cálculo de
 * budget/pacing proporcional, onde só os dias do filtro que realmente caem
 * dentro da janela da campanha/membro contam. Sem esse clamp, um filtro fora
 * da janela produz proporção absurda (ex: 30 dias de filtro / 18 dias de
 * campanha = 166% → budget pro-rata maior que o contratado).
 */
export function rangeOverlapDays(range, startStr, endStr) {
  if (!range?.from || !range?.to) return 0;
  const s = parseYmd(startStr);
  const e = parseYmd(endStr);
  if (!s || !e) return daysInRange(range);
  const from = isAfter(range.from, s) ? range.from : s;
  const to   = isBefore(range.to, e) ? range.to : e;
  if (isAfter(from, to)) return 0;
  return differenceInCalendarDays(to, from) + 1;
}
