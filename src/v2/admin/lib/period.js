// src/v2/admin/lib/period.js
//
// Helpers de janela temporal pro filtro de período do Top Performers.
//
// Convenção: datas em ISO "YYYY-MM-DD" usando horário local (não UTC). O
// backend espera o mesmo formato e BigQuery `BETWEEN` é inclusivo nos dois
// lados, então `from = today - (N-1)` dá uma janela de N dias.
//
// Os presets cobrem casos típicos de acompanhamento: semana corrente (7d),
// mês corrente (30d), trimestre (90d), e o mês fechado anterior (last_month).
// "Custom" permite range arbitrário (limitado a 365d no backend).

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toLocalISO(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export const PERIOD_PRESETS = [
  { id: "now",        label: "Agora",        shortLabel: "Agora"     },
  { id: "7d",         label: "Últimos 7 dias",  shortLabel: "7d"     },
  { id: "30d",        label: "Últimos 30 dias", shortLabel: "30d"    },
  { id: "90d",        label: "Últimos 90 dias", shortLabel: "90d"    },
  { id: "last_month", label: "Mês passado",  shortLabel: "Mês passado" },
  { id: "custom",     label: "Personalizado", shortLabel: "Custom"   },
];

/**
 * Resolve preset → { from, to } em ISO local. Retorna { from: null, to: null }
 * pro preset "now" (modo snapshot atual, sem fetch). Pra "custom", devolve
 * os valores recebidos (caller é dono dos inputs).
 */
export function resolvePeriod(preset, custom = {}) {
  if (preset === "now") return { from: null, to: null };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (preset === "7d")  return { from: toLocalISO(addDays(today, -6)),  to: toLocalISO(today) };
  if (preset === "30d") return { from: toLocalISO(addDays(today, -29)), to: toLocalISO(today) };
  if (preset === "90d") return { from: toLocalISO(addDays(today, -89)), to: toLocalISO(today) };
  if (preset === "last_month") {
    const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastOfPrev       = addDays(firstOfThisMonth, -1);
    const firstOfPrev      = new Date(lastOfPrev.getFullYear(), lastOfPrev.getMonth(), 1);
    return { from: toLocalISO(firstOfPrev), to: toLocalISO(lastOfPrev) };
  }
  if (preset === "custom") return { from: custom.from || null, to: custom.to || null };
  return { from: null, to: null };
}

/**
 * Label legível pro botão/header quando um período está selecionado. Pra
 * presets fixos usa o `label`; pra "custom" reflete o range escolhido.
 */
export function formatPeriodLabel(preset, from, to) {
  const p = PERIOD_PRESETS.find((x) => x.id === preset);
  if (!p) return "";
  if (preset !== "custom") return p.label;
  if (!from || !to) return "Personalizado";
  // Reusa formatDateRange (DD/MM → DD/MM) — mesma estética do resto da admin.
  const f = from.split("-");
  const t = to.split("-");
  if (f.length !== 3 || t.length !== 3) return "Personalizado";
  const sameYear = f[0] === t[0];
  return sameYear
    ? `${f[2]}/${f[1]} → ${t[2]}/${t[1]}`
    : `${f[2]}/${f[1]}/${f[0].slice(-2)} → ${t[2]}/${t[1]}/${t[0].slice(-2)}`;
}
