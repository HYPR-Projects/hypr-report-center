// src/v2/admin/lib/scoreSnapshots.js
//
// Snapshot diário client-side de scores do leaderboard de Top Performers.
// Permite mostrar variação semanal (delta vs 7d atrás) sem precisar de
// backend pra histórico.
//
// Storage: localStorage["hypr.top-performers-snapshots"]
// Schema: { "YYYY-MM-DD": { "cs": {email: score}, "cp": {email: score} } }
//
// Comportamento:
//   - Salva 1x por dia por role (CS/CP) na primeira chamada do dia.
//     Visitas subsequentes do mesmo dia não sobrescrevem — captura o
//     "score do começo do dia".
//   - Mantém últimos 30 dias, descarta o resto pra não inflar.
//   - Date string em LOCAL time (não UTC), pra dia bater com horário
//     do usuário (BR é UTC-3, UTC daria rollover às 21h local).
//
// Limitação assumida: só funciona pra usuários que abriram o app há
// pelo menos 7 dias. Sem snapshot, retorna null e a UI esconde o delta.
// Pra histórico autoritativo team-wide, futura migração pra backend.

const KEY = "hypr.top-performers-snapshots";
const MAX_DAYS = 30;

function localDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDateStr(d);
}

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeAll(snapshots) {
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshots));
  } catch {
    /* quota cheia ou storage desabilitado — silencioso, não crítico */
  }
}

/**
 * Salva snapshot de hoje pro role, se ainda não existe. Retorna o
 * objeto completo de snapshots (após save + prune).
 */
export function saveDailySnapshot(role, performers) {
  const today = localDateStr();
  const snapshots = readAll();

  // Evita sobrescrever se já tem snapshot do dia — preserva o "score
  // do começo do dia" entre múltiplas visitas.
  if (snapshots[today]?.[role]) return snapshots;

  if (!snapshots[today]) snapshots[today] = {};
  const map = {};
  for (const p of performers) {
    if (p.email && Number.isFinite(p.score)) {
      map[p.email] = p.score;
    }
  }
  snapshots[today][role] = map;

  // Prune entradas mais antigas que MAX_DAYS.
  const cutoff = daysAgoStr(MAX_DAYS);
  for (const date of Object.keys(snapshots)) {
    if (date < cutoff) delete snapshots[date];
  }

  writeAll(snapshots);
  return snapshots;
}

/**
 * Lê o score de N dias atrás pra um email/role. Retorna null se não
 * tem snapshot daquela data ou daquele owner.
 */
export function getScoreNDaysAgo(snapshots, role, email, n) {
  const date = daysAgoStr(n);
  const v = snapshots?.[date]?.[role]?.[email];
  return Number.isFinite(v) ? v : null;
}

/**
 * Lê todos os snapshots crus (pra debug/futuro gráfico).
 */
export function loadSnapshots() {
  return readAll();
}
