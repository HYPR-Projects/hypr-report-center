// src/shared/dvQualityReport.js
//
// Resumo da aba Quality do report do cliente (DoubleVerify por campanha).
//
// O backend (`quality_report`) devolve contagens Campaign × Dia só das
// campanhas DV conectadas ao token, no período escolhido pelo admin. Mesma
// regra do admin (lib/dvQuality.js): taxa = soma(num) / soma(den), nunca
// média de taxas — as definições das taxas vêm de lá pra que admin e
// cliente leiam o mesmo número.
import { deriveRates } from "../v2/admin/lib/dvQuality.js";

export {
  KQI_DEFS, GLANCE_DEFS, formatRate, formatCompact,
} from "../v2/admin/lib/dvQuality.js";

// rows = [campaign_idx, "YYYY-MM-DD", ...contagens na ordem de `columns`]
const DIMS = 2;

function emptyTotals(columns) {
  const t = {};
  for (const c of columns) t[c] = 0;
  return t;
}

function addRow(totals, row, columns) {
  columns.forEach((c, i) => { totals[c] += Number(row[DIMS + i]) || 0; });
}

/** Totais, taxas e quebra por campanha DV do recorte conectado. */
export function summarizeQuality(payload) {
  const columns = payload?.columns || [];
  const rows = payload?.rows || [];
  const names = payload?.campaigns_found || [];
  const totals = emptyTotals(columns);
  const byCampaign = new Map();
  const days = new Set();
  for (const row of rows) {
    addRow(totals, row, columns);
    days.add(row[1]);
    let t = byCampaign.get(row[0]);
    if (!t) { t = emptyTotals(columns); byCampaign.set(row[0], t); }
    addRow(t, row, columns);
  }
  const campaigns = [...byCampaign.entries()]
    .map(([ci, t]) => ({ id: ci, name: names[ci] ?? "", totals: t, rates: deriveRates(t) }))
    .sort((a, b) => b.totals.monitored_ads - a.totals.monitored_ads);
  return { totals, rates: deriveRates(totals), campaigns, dayCount: days.size };
}

/**
 * Campanhas DV sugeridas pra uma campanha HYPR: as que dividem mais palavras
 * com o nome do cliente/campanha vêm primeiro (o nome da DV é livre, tipo
 * "Gatorade_F1_2026", então não há chave de junção — só um empurrão na busca).
 */
export function rankDvCampaigns(names, hint) {
  const words = new Set(
    String(hint || "")
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
  if (!words.size) return [...names];
  const score = (n) => {
    const parts = n.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/);
    return parts.reduce((s, p) => s + (p.length >= 3 && words.has(p) ? 1 : 0), 0);
  };
  return names
    .map((n, i) => ({ n, i, s: score(n) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.n);
}
