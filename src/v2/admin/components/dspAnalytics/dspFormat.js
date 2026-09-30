// Formatação das métricas do Analytics › Saúde das DSPs. Um lugar só pra
// que KPI, card, tabela e tooltip do gráfico escrevam o mesmo número igual.

import { METRICS, ecpmKind, VIEWABILITY_RED, MEAS_RED } from "../../lib/dspAnalytics";
import { formatBRL, formatBrlShort, formatBrlCompact, ecpmToneClass, ctrColorClass, vtrColorClass } from "../../lib/format";

const nfCompact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
const nfInt = new Intl.NumberFormat("pt-BR");

export const fmtInt = (v) => (v == null ? "—" : nfInt.format(Math.round(v)));
export const fmtCompact = (v) => (v == null ? "—" : nfCompact.format(v));

export function fmtPct(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits).replace(".", ",")}%`;
}

export function fmtMoney(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (digits === 2) return formatBRL(v);
  return new Intl.NumberFormat("pt-BR", {
    style: "currency", currency: "BRL", minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(v);
}

/** Valor de uma métrica no formato dela. `compact` encurta volume e custo. */
export function fmtMetric(key, v, { compact = true } = {}) {
  const def = METRICS[key];
  if (!def) return String(v ?? "—");
  if (v == null) return "—";
  if (def.kind === "count") return compact ? fmtCompact(v) : fmtInt(v);
  if (def.kind === "money") {
    // Abaixo de R$ 10 mil o compacto ("R$ 764,7") lê pior que o inteiro.
    if (key === "cost") return compact ? (Math.abs(v) < 10_000 ? formatBrlCompact(v) : formatBrlShort(v)) : fmtMoney(v);
    return fmtMoney(v, def.digits ?? 2);
  }
  return fmtPct(v, def.digits ?? 1);
}

/** Valor por extenso pro title/tooltip. */
export const fmtMetricFull = (key, v) => fmtMetric(key, v, { compact: false });

/** Variação formatada: {text, dir} ou null. */
export function fmtDelta(d) {
  if (!d || !Number.isFinite(d.value)) return null;
  const flat = d.kind === "pp" ? Math.abs(d.value) < 0.05 : Math.abs(d.value) < 0.5;
  const dir = flat ? "flat" : d.value > 0 ? "up" : "down";
  const abs = Math.abs(d.value);
  const text = d.kind === "pp"
    ? `${abs.toFixed(abs < 1 ? 2 : 1).replace(".", ",")} p.p.`
    : `${abs >= 100 ? Math.round(abs) : abs.toFixed(1).replace(".", ",")}%`;
  return { dir, text };
}

// Cor da régua do admin por métrica (classes de texto). "" = sem régua.
export function toneFor(key, v, { media = "DISPLAY", abs = false } = {}) {
  if (v == null) return "";
  if (key === "ecpm") return ecpmToneClass(v, ecpmKind(media, abs));
  if (key === "ctr" && media === "DISPLAY") return ctrColorClass(v, abs);
  if (key === "vtr") return vtrColorClass(v);
  if (key === "viewability") return v < VIEWABILITY_RED ? "text-danger" : v < 70 ? "text-warning" : "text-success";
  if (key === "measRate") return v < MEAS_RED ? "text-danger" : v < 85 ? "text-warning" : "";
  return "";
}

export function fmtDay(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(-2)}`;
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** Rótulo do eixo por granularidade. */
export function bucketLabel(key, granularity) {
  if (granularity === "month") {
    const [y, m] = key.split("-");
    return `${MONTHS[Number(m) - 1]}/${y.slice(-2)}`;
  }
  const [, m, d] = key.split("-");
  return `${d}/${m}`;
}

export function bucketLabelLong(key, granularity) {
  if (granularity === "month") {
    const [y, m] = key.split("-");
    return `${MONTHS[Number(m) - 1]} ${y}`;
  }
  if (granularity === "week") return `Semana de ${fmtDay(key)}`;
  return fmtDay(key);
}

// Métricas selecionáveis no gráfico de evolução.
export const CHART_METRICS = ["imp", "view", "cost", "ecpm", "vcpm", "ctr", "vtr", "viewability", "measRate"];
