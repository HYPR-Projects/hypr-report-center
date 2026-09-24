// src/v2/components/ma/maFormat.js
//
// Formatação e exportação usadas pelos componentes da aba Max Attention
// (fora dos .jsx para o Fast Refresh continuar funcionando).

import { fmt } from "../../../shared/format";
import { downloadCsvText } from "../../../shared/download";
import { formatLabel } from "../../../shared/maMetrics";

export const pct = (v, d = 2) => (v == null ? "—" : `${fmt(v, d)}%`);

/** Valor da métrica-chave do formato, já formatado. */
export function keyMetricText(km) {
  if (!km) return "—";
  if (km.kind === "count") return fmt(km.value);
  return pct(km.value, km.value != null && km.value < 10 ? 2 : 1);
}

/** Baixa um CSV (UTF-8 com BOM, para o Excel abrir acentos certo). */
export function downloadCsv(filename, headers, rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  downloadCsvText(csv, String(filename || "max attention").replace(/\.csv$/i, ""));
}

/** "3,8 s" a partir de milissegundos; null → "—". */
export function secondsText(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return "—";
  const s = Number(ms) / 1000;
  return s < 60 ? `${fmt(s, 1)} s` : `${fmt(s / 60, 1)} min`;
}

/**
 * Cor literal para o SVG do recharts a partir de var(--color-chart-sN) /
 * var(--color-fg-subtle), usando as cores do tema atual (useThemeColors).
 */
export function resolveChartVar(c, hypr) {
  const m = /--color-chart-s(\d)/.exec(c || "");
  if (m) return hypr?.[`chartS${m[1]}`] || undefined;
  if (/--color-fg-subtle/.test(c || "")) return hypr?.fgSubtle || undefined;
  return c;
}

/** Nome de trafficking ("HYPR_NIELY_COR&TON_TAP-TO-MAP_AGO26"): sem espaço, com "_". */
export function looksTechnical(name) {
  const s = String(name || "");
  return s.includes("_") && !/\s/.test(s);
}

/**
 * Como a peça aparece no detalhe. Nome de trafficking não vira título: o
 * título passa a ser "Formato · Campanha" e o nome técnico fica na linha de
 * metadados (com copiar). Nome legível ("Lojas Verão") segue como título.
 */
export function pieceDisplay(piece, campaignTitle = null) {
  const format = formatLabel(piece?.format);
  const size = piece?.size ? ` · ${piece.size}` : "";
  if (looksTechnical(piece?.name)) {
    return {
      title: campaignTitle ? `${format} · ${campaignTitle}` : format,
      crumb: `${campaignTitle || "Peça"}${size}`,
      technical: piece.name,
      formatInTitle: true,
    };
  }
  const name = piece?.name || "Peça sem nome";
  return { title: name, crumb: `${name}${size}`, technical: null, formatInTitle: false };
}
