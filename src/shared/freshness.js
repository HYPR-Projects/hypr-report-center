// src/shared/freshness.js
//
// Selo de frescor do report ("Dados até 22/09 · atualizado às 06:12").
//
// O selo antigo dizia "Atualizado agora" em qualquer situação, mas o dado de
// mídia chega D-1 pela carga diária das DSPs. Quando o cliente comparava com
// a DSP e via diferença, o selo trabalhava contra a confiança no report.
//
// Duas fontes, cada uma com o que sabe:
//   • dataUntil  → a maior data com entrega no payload (daily/detail). É o
//                  que o cliente precisa saber: "até quando isso vai".
//   • updatedAt  → last_modified da base consolidada (campaign_results),
//                  anexado pelo backend na camada de serving. Opcional: sem
//                  ele o selo mostra só a data do dado.
//
// Horários sempre em Brasília — a carga, o contrato e o cliente estão aqui.

const TZ = "America/Sao_Paulo";

/** Maior data (YYYY-MM-DD) com entrega no payload do report, ou null. */
export function computeDataUntil(data) {
  let max = null;
  const scan = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      const d = typeof r?.date === "string" ? r.date.slice(0, 10) : null;
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && (max === null || d > max)) max = d;
    }
  };
  scan(data?.daily);
  if (max === null) scan(data?.detail);
  return max;
}

function ymdToDdMm(ymd) {
  const [, m, d] = ymd.split("-");
  return `${d}/${m}`;
}

// Partes de data/hora de um instante no fuso de Brasília.
function partsInTz(date) {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  // Alguns runtimes devolvem "24" pra meia-noite com hour12:false.
  if (out.hour === "24") out.hour = "00";
  return {
    ymd: `${out.year}-${out.month}-${out.day}`,
    ddmm: `${out.day}/${out.month}`,
    hhmm: `${out.hour}:${out.minute}`,
  };
}

function toDate(v) {
  if (v == null || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Monta o selo.
 * @param {object} p
 * @param {string|null} p.dataUntil   YYYY-MM-DD da última entrega
 * @param {number|string|null} p.updatedAt  instante da última carga (ms ou ISO)
 * @param {string|null} p.campaignEnd YYYY-MM-DD do fim efetivo da campanha
 * @param {Date} [p.now]
 * @returns {{label: string, shortLabel: string, title: string}}
 */
export function formatFreshness({ dataUntil, updatedAt = null, campaignEnd = null, now = new Date() }) {
  if (!dataUntil) {
    return {
      label: "Aguardando a primeira entrega",
      shortLabel: "Sem entrega",
      title: "A campanha ainda não tem entrega registrada. A carga das DSPs roda uma vez por dia.",
    };
  }
  const until = ymdToDdMm(dataUntil);
  const today = partsInTz(now);
  const ended = !!campaignEnd && campaignEnd < today.ymd && dataUntil >= campaignEnd;

  const upd = toDate(updatedAt);
  let updText = "";
  let updTitle = "";
  if (upd && !ended) {
    const u = partsInTz(upd);
    updText = u.ymd === today.ymd ? ` · atualizado às ${u.hhmm}` : ` · atualizado em ${u.ddmm} às ${u.hhmm}`;
    updTitle = ` Última carga: ${u.ddmm} às ${u.hhmm} (horário de Brasília).`;
  }

  if (ended) {
    return {
      label: `Campanha encerrada · dados até ${until}`,
      shortLabel: `até ${until}`,
      title: `Números finais da campanha, com entrega até ${until}.`,
    };
  }
  return {
    label: `Dados até ${until}${updText}`,
    shortLabel: `até ${until}`,
    title: `A mídia chega com um dia de defasagem pela carga diária das DSPs.${updTitle}`,
  };
}
