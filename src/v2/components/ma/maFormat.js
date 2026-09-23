// src/v2/components/ma/maFormat.js
//
// Formatação e exportação usadas pelos componentes da aba Max Attention
// (fora dos .jsx para o Fast Refresh continuar funcionando).

import { fmt } from "../../../shared/format";

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
  const bom = String.fromCharCode(0xfeff);
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
