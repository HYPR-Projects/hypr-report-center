// Dataset determinístico pro E2E do PMP Deals.
// Lifetime das lines = soma exata da própria série diária, pra que qualquer
// divergência na tela seja bug de código e não do fixture.

// A série vai de D-30 até D-1 (30 dias, terminando ontem). Datas RELATIVAS de
// propósito: o Analytics abre em "últimos 30 dias" (D-29..hoje), então a
// janela default cobre 29 dos 30 dias — é essa diferença que separa "o filtro
// de período funciona" de "está somando o lifetime".
const DAYS = 30;
export const TODAY = ymd(new Date());
export function ymd(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
export function daysAgo(n) {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return ymd(d);
}
const day = (i) => daysAgo(DAYS - i);      // i=0 → D-30 … i=29 → D-1

// [line_id, source, customer, campaign, bid, status, pi, ecpm-ish, imps/dia]
const SPEC = [
  [101, "xandr",    "Ambev", "Brahma Verao",  "flex",  "Andamento",  300000, 20, 40000],
  [102, "xandr",    "Vivo",  "Fibra Casa",    "fixed", "Andamento",  150000, 15, 20000],
  [103, "xandr",    "Itau",  "Cartoes Q3",    "flex",  "Finalizado", 100000, 10, 10000],
  [201, "pubmatic", "Ambev", "Brahma Verao",  "flex",  "Andamento",  200000, 25, 30000],
  [202, "pubmatic", "Itau",  "Cartoes Q3",    "fixed", "Andamento",   80000, 12,  8000],
  [203, "pubmatic", "Magalu", "Black Friday", "flex",  "Finalizado",  60000,  8,  5000],
];

export function buildFixture() {
  const lines = [];
  const rows = [];
  for (const [line_id, source, customer, campaign, bid, status, pi, ecpm, impsDay] of SPEC) {
    let imps = 0, revenue = 0, margin = 0, cost = 0;
    let rev7 = 0, mgn7 = 0;
    for (let i = 0; i < DAYS; i++) {
      // Volume varia por dia (mas sem aleatoriedade) pra o gráfico ter forma.
      const dayImps = Math.round(impsDay * (0.6 + ((i * 7) % 10) / 10));
      const dayRev = (dayImps / 1000) * ecpm;
      const dayMgn = dayRev * 0.8;
      rows.push({
        source, line_id, day: day(i),
        imps: dayImps, viewable_imps: Math.round(dayImps * 0.7),
        clicks: Math.round(dayImps / 5000),
        curator_total_cost: round2(dayRev - dayMgn),
        curator_revenue: round2(dayRev),
        curator_margin: round2(dayMgn),
      });
      imps += dayImps; revenue += dayRev; margin += dayMgn; cost += dayRev - dayMgn;
      if (i >= DAYS - 7) { rev7 += dayRev; mgn7 += dayMgn; }
    }
    lines.push({
      line_id, source,
      line_name: `${campaign} — ${source} ${line_id}`,
      customer, campaign_name: campaign,
      agency: customer === "Ambev" ? "MediaCom" : null,
      short_token: `TK${line_id}`,
      bid_type: bid, status,
      delivery_status: status === "Finalizado" ? "ended" : "live",
      state: "active", is_archived: false,
      start_date: day(0), end_date: daysAgo(-30),
      first_delivery_day: day(0), last_delivery_day: day(DAYS - 1),
      last_synced_at: `${TODAY}T04:00:00Z`,
      pi_brl: pi, curator_margin_pct: 80,
      curator_revenue: round2(revenue), curator_margin: round2(margin),
      curator_total_cost: round2(cost), imps,
      revenue_last_7d: round2(rev7), margin_last_7d: round2(mgn7),
      effective_margin_pct: margin / revenue,
      pct_a_receber: margin / pi, pct_a_receber_rev: revenue / pi,
      ecpm: (revenue * 1000) / imps,
      group_id: null,
    });
  }
  return { lines, rows };
}

const round2 = (v) => Math.round(v * 100) / 100;

/** Somas esperadas por fonte, na janela [from, to] (inclusive). */
export function expected(rows, { source = null, from = null, to = null, pick = null } = {}) {
  let revenue = 0, margin = 0, imps = 0;
  const deals = new Set();
  for (const r of rows) {
    if (source && r.source !== source) continue;
    if (from && r.day < from) continue;
    if (to && r.day > to) continue;
    if (pick && !pick(r)) continue;
    revenue += r.curator_revenue; margin += r.curator_margin; imps += r.imps;
    deals.add(`${r.source}:${r.line_id}`);
  }
  return { revenue: round2(revenue), margin: round2(margin), imps, deals: deals.size };
}
