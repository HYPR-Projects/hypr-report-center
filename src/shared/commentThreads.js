// src/shared/commentThreads.js
//
// Regras do painel de comentários do report (chat cliente ↔ HYPR).
// Cada mensagem traz a conversa em `metric_name`: GERAL (report como um
// todo) e as conversas que antes ficavam no rodapé das abas RMND, PDOOH e
// Brand Lift (SURVEY). Funções puras para poderem ser testadas sem React.

const BASE_THREADS = [
  { value: "GERAL", label: "Geral" },
  { value: "RMND", label: "RMND" },
  { value: "PDOOH", label: "PDOOH" },
  { value: "SURVEY", label: "Brand Lift" },
];

const TAB_THREAD = { rmnd: "RMND", pdooh: "PDOOH", survey: "SURVEY" };

/**
 * Conversas exibidas no painel. "Geral" sempre; a de cada aba complementar
 * quando a aba está visível ou já tem mensagem (uma conversa antiga nunca
 * some). Qualquer outro `metric_name` que exista no histórico também entra,
 * com o próprio nome.
 */
export function buildCommentThreads({ visible = {}, comments = [] } = {}) {
  const present = new Set(comments.map((c) => c?.metric_name).filter(Boolean));
  const threads = BASE_THREADS.filter(
    (t) => t.value === "GERAL" || visible[t.value] || present.has(t.value),
  );
  for (const name of present) {
    if (!BASE_THREADS.some((t) => t.value === name)) threads.push({ value: name, label: name });
  }
  return threads;
}

/** Conversa em que o painel abre, a partir da aba atual. */
export function threadForTab(tab) {
  return TAB_THREAD[tab] || "GERAL";
}

/**
 * Timestamp (ms) de `created_at`. O backend devolve TIMESTAMP do BigQuery
 * como "2026-09-22 14:03:11.123456+00:00"; as mensagens enviadas na sessão
 * vêm em ISO. Sem fuso explícito, é UTC (o backend grava utcnow). Fração
 * de segundo cortada em 3 dígitos porque nem todo navegador aceita 6.
 */
export function parseCommentTime(value) {
  if (!value) return null;
  let s = String(value).trim().replace(" ", "T");
  s = s.replace(/(\.\d{3})\d+/, "$1");
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += "Z";
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Mensagens da outra parte ainda não vistas neste navegador: para o cliente,
 * as da HYPR; para a HYPR, as do cliente. `seenAt` é o ms da última vez que
 * o painel foi aberto ou fechado (0 = nunca).
 */
export function countUnread(comments = [], { viewer, seenAt = 0 } = {}) {
  return comments.filter((c) => {
    if (!c) return false;
    const fromOther = viewer === "HYPR" ? c.author !== "HYPR" : c.author === "HYPR";
    if (!fromOther) return false;
    const t = parseCommentTime(c.created_at);
    return t == null ? seenAt === 0 : t > seenAt;
  }).length;
}

/**
 * Junta as mensagens do token do report com as de outros tokens (membros de
 * um report mesclado), só da conversa `onlyThread`, sem duplicar e em ordem
 * cronológica.
 */
export function mergeCommentSources(own = [], others = [], { onlyThread } = {}) {
  const out = [...(own || [])];
  const seen = new Set(out.map((c) => `${c.metric_name}|${c.author}|${c.comment}|${c.created_at}`));
  for (const list of others || []) {
    for (const c of list || []) {
      if (onlyThread && c?.metric_name !== onlyThread) continue;
      const k = `${c.metric_name}|${c.author}|${c.comment}|${c.created_at}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  if (!(others || []).some((l) => l?.length)) return out;
  return out
    .map((c, i) => ({ c, i, t: parseCommentTime(c.created_at) }))
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || a.i - b.i)
    .map((x) => x.c);
}
