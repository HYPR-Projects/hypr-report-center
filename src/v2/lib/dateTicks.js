// src/v2/lib/dateTicks.js
//
// Ticks do eixo X das séries temporais (dia ou mês). O automático do
// Recharts (interval="preserveStartEnd" / "preserveEnd" + minTickGap) decide
// label a label se cabe: como "11/09" é mais estreito que "08/09" na
// Urbanist, ele mostra todo dia num trecho, pula dia em outro e ainda força o
// último ("22/09 · 24/09 · 27/09"). Aqui o passo é um só pro eixo inteiro,
// escolhido pela largura disponível, e ancorado no último ponto (o mais
// recente é o que mais se lê).

// Passos "redondos". Dia: 7 e 14 caem sempre no mesmo dia da semana.
export const DAY_STEPS = [1, 2, 3, 7, 14, 21, 28, 56];
// Mês: trimestre, semestre, ano.
export const MONTH_STEPS = [1, 2, 3, 6, 12, 24];

// Largura reservada por label "dd/mm" em 10px, já com respiro entre eles.
export const DATE_LABEL_SLOT_PX = 52;

export function pickStep(count, plotWidth, slotPx = DATE_LABEL_SLOT_PX, steps = DAY_STEPS) {
  if (!(count > 1)) return 1;
  // Sem largura medida ainda (primeiro render): assume um card de desktop.
  const width = plotWidth > 0 ? plotWidth : 720;
  const perPoint = width / count;
  return steps.find((s) => s * perPoint >= slotPx) ?? Math.ceil(slotPx / perPoint);
}

export function uniformTicks(values, plotWidth, { slotPx = DATE_LABEL_SLOT_PX, steps = DAY_STEPS } = {}) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const step = pickStep(values.length, plotWidth, slotPx, steps);
  const out = [];
  for (let i = values.length - 1; i >= 0; i -= step) out.push(values[i]);
  return out.reverse();
}

// Atalhos mantidos por legibilidade nos gráficos diários.
export const pickDateStep = (count, plotWidth, slotPx) => pickStep(count, plotWidth, slotPx, DAY_STEPS);
export const dailyTicks = (dates, plotWidth, slotPx) => uniformTicks(dates, plotWidth, { slotPx });

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_FILL_DAYS = 800;

// Série diária sem buraco no calendário: um dia sem entrega (campanha
// pausada, sem linha no banco) vira { date } sem métricas. Sem isso o eixo
// pula o dia calado, as barras ficam coladas e o passo uniforme dos labels
// mente sobre o intervalo. Barra ausente e linha interrompida são a leitura
// honesta de "sem dado". Datas fora do formato YYYY-MM-DD passam intactas.
export function fillDailyGaps(rows, key = "date") {
  if (!Array.isArray(rows) || rows.length < 2) return rows || [];
  const first = ISO_DAY.exec(String(rows[0]?.[key] ?? ""));
  const last = ISO_DAY.exec(String(rows[rows.length - 1]?.[key] ?? ""));
  if (!first || !last) return rows;
  const t0 = Date.UTC(+first[1], +first[2] - 1, +first[3]);
  const t1 = Date.UTC(+last[1], +last[2] - 1, +last[3]);
  const days = Math.round((t1 - t0) / 86_400_000) + 1;
  if (!(days > rows.length) || days > MAX_FILL_DAYS) return rows;
  const byDate = new Map(rows.map((r) => [r?.[key], r]));
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(t0 + i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDate.get(d) || { [key]: d });
  }
  return out;
}

const ISO_MONTH = /^(\d{4})-(\d{2})$/;
const MAX_FILL_MONTHS = 240;

// Mesmo princípio do fillDailyGaps pra série mensal ("YYYY-MM"): mês sem
// linha entra com `blank(month)` em vez de sumir do eixo.
export function fillMonthlyGaps(rows, key = "month", blank = (m) => ({ [key]: m })) {
  if (!Array.isArray(rows) || rows.length < 2) return rows || [];
  const first = ISO_MONTH.exec(String(rows[0]?.[key] ?? ""));
  const last = ISO_MONTH.exec(String(rows[rows.length - 1]?.[key] ?? ""));
  if (!first || !last) return rows;
  const i0 = +first[1] * 12 + (+first[2] - 1);
  const i1 = +last[1] * 12 + (+last[2] - 1);
  const months = i1 - i0 + 1;
  if (!(months > rows.length) || months > MAX_FILL_MONTHS) return rows;
  const byMonth = new Map(rows.map((r) => [r?.[key], r]));
  const out = [];
  for (let i = i0; i <= i1; i++) {
    const m = `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
    out.push(byMonth.get(m) || blank(m));
  }
  return out;
}
