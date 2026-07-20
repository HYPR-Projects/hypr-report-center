// src/v2/admin/lib/pmpFormat.js
//
// Helpers de formatação, classificação e cores pra UI v3 do PMP Lines.
// Centraliza decisões visuais pra que componentes (LiveCard, ClientAccordion,
// ListRow, Worklist) compartilhem o mesmo vocabulário.

import { FEATURE_ADMINS } from "../../../shared/auth";

// ─── Permissões de edição ───────────────────────────────────────────────────
// Lista de operadores que podem MUTAR campos do PMP (status, PI, command,
// overrides, notas, agrupamento). Demais admins @hypr.mobi acessam a aba em
// modo somente-leitura. NÃO confundir com FEATURE_ADMINS (shared/auth), que
// gateia só os REBUILDS ("Reconstruir agora" do menu e "Sincronizar agora"
// do PMP) — a aba PMP em si é visível pra todos os admins.
//
// União da lista original de editores (inclui mateus.lambranho e o e-mail
// antigo gian.nardo) com FEATURE_ADMINS — ninguém que edita hoje perde
// acesso, e os editores originais voltam a ter o que tinham.
//
// Gate é puramente frontend — guard rail UX, não barreira de segurança. Pra
// reforço real precisaria validar o `updated_by` no backend (`pmp_save_*`).
export const PMP_EDITORS = new Set([
  ...FEATURE_ADMINS,
  "mateus.lambranho@hypr.mobi",
  "gian.nardo@hypr.mobi",
]);

export function isPmpEditor(user) {
  const email = user?.email;
  if (!email || typeof email !== "string") return false;
  return PMP_EDITORS.has(email.toLowerCase());
}

// ─── Status workflow ─────────────────────────────────────────────────────────
export const PMP_STATUSES = [
  "Pendente", "Andamento", "Revisão", "Finalizado", "Pausado", "Cancelado",
];

export function statusPillClass(status) {
  switch (status) {
    case "Finalizado": return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "Andamento":  return "bg-sky-500/15 text-sky-400 border-sky-500/30";
    case "Revisão":    return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "Pausado":    return "bg-violet-500/15 text-violet-400 border-violet-500/30";
    case "Cancelado":  return "bg-rose-500/15 text-rose-400 border-rose-500/30";
    case "Pendente":
    default:           return "bg-surface text-fg-muted border-border";
  }
}

// ─── Delivery status (estado real, baseado em last_delivery_day) ─────────────
// O backend calcula em pmp_lines_enriched. Aqui só mapeamos pra estilo + label.

export const DELIVERY_STATUS_ORDER = [
  "live", "running", "slowing", "stopped", "scheduled",
  "paused", "ended", "archived", "unknown",
];

export const DELIVERY_STATUS_META = {
  live:      { label: "No ar",          dot: "bg-emerald-400 shadow-[0_0_8px_rgb(52,211,153)]", border: "border-emerald-500/30", text: "text-emerald-400", bg: "bg-emerald-500/10" },
  running:   { label: "Rodando",        dot: "bg-emerald-400",       border: "border-emerald-500/20", text: "text-emerald-400", bg: "bg-emerald-500/10" },
  slowing:   { label: "Desacelerando",  dot: "bg-amber-400",         border: "border-amber-500/30",   text: "text-amber-400",   bg: "bg-amber-500/10" },
  stopped:   { label: "Parou",          dot: "bg-rose-400",          border: "border-rose-500/30",    text: "text-rose-400",    bg: "bg-rose-500/10" },
  scheduled: { label: "Agendada",       dot: "bg-sky-400",           border: "border-sky-500/30",     text: "text-sky-400",     bg: "bg-sky-500/10" },
  paused:    { label: "Pausada",        dot: "bg-violet-400",        border: "border-violet-500/30",  text: "text-violet-400",  bg: "bg-violet-500/10" },
  ended:     { label: "Encerrada",      dot: "bg-fg-subtle",         border: "border-border",         text: "text-fg-muted",    bg: "bg-surface" },
  archived:  { label: "Histórico",      dot: "bg-fg-subtle/40",      border: "border-border",         text: "text-fg-subtle",   bg: "bg-surface/50" },
  unknown:   { label: "Sem delivery",   dot: "bg-fg-subtle/60",      border: "border-border",         text: "text-fg-subtle",   bg: "bg-surface" },
};

export function deliveryStatusMeta(status) {
  return DELIVERY_STATUS_META[status] || DELIVERY_STATUS_META.unknown;
}

/** Status workflow que indicam que a line está fora de operação ativa.
 *  Quando setado, os indicadores visuais (dot, pill de delivery) ficam
 *  cinza — o "estado de entrega" perde relevância. */
export const INACTIVE_WORKFLOW_STATUSES = new Set(["Finalizado", "Cancelado", "Pausado"]);

/** Status workflow derivado automaticamente do `delivery_status`. Regra:
 *    ≤ 72h sem delivery (live/running)  → Andamento
 *    72h–7d sem delivery (slowing)      → Pausado
 *    > 7d sem delivery (stopped/ended)  → Finalizado
 *  Demais (scheduled / unknown) ficam Pendente. */
function autoStatusFromDelivery(line) {
  const ds = line && line.delivery_status;
  if (ds === "live" || ds === "running")          return "Andamento";
  if (ds === "slowing")                            return "Pausado";
  if (ds === "stopped" || ds === "ended" || ds === "archived") return "Finalizado";
  return "Pendente";
}

const MONTH_ABBR_PT = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

/** "Mai/26 · Q2" — formato compacto pra mostrar quando a line foi ativada
 *  (start_date). Retorna null se start_date ausente. Útil ao lado do Line ID
 *  pra dar contexto temporal sem ocupar espaço. */
export function formatLineStartPeriod(line) {
  const d = line && line.start_date;
  if (!d || typeof d !== "string" || d.length < 7) return null;
  const [y, m] = d.split("-");
  const month = MONTH_ABBR_PT[Number(m) - 1];
  if (!month) return null;
  const q = Math.ceil(Number(m) / 3);
  return `${month}/${y.slice(-2)} · Q${q}`;
}

/** Status efetivo da line. "Pendente" é tratado como "auto" — derivamos
 *  do delivery_status. Qualquer outro valor é override manual e respeitamos. */
export function effectiveStatus(line) {
  if (!line) return "Pendente";
  const s = line.status;
  if (s && s !== "Pendente") return s;
  return autoStatusFromDelivery(line);
}

/** Retorna o meta de delivery LEVANDO EM CONTA o status workflow efetivo.
 *  Se efetivo é Finalizado/Cancelado/Pausado, força o estilo "histórico"
 *  (cinza) com o label correspondente — o admin marcou como fora do ar
 *  (ou está fora há ≥72h), então mostrar amarelo/vermelho de
 *  "Desacelerando/Parou" só polui a tela. */
export function effectiveDeliveryMeta(line) {
  if (!line) return DELIVERY_STATUS_META.unknown;
  const eff = effectiveStatus(line);
  if (INACTIVE_WORKFLOW_STATUSES.has(eff)) {
    return { ...DELIVERY_STATUS_META.archived, label: eff };
  }
  return deliveryStatusMeta(line.delivery_status);
}

/** Estados considerados "no ar" (= mostram na view Ao Vivo).
 *  Regra: line entregou nos últimos 7 dias OU está agendada. Se passa de 1
 *  semana sem entrega, sai de Ao vivo e vai pra Histórico — mesmo que o
 *  Xandr ainda marque state=active (esse caso vira `stopped`, ainda surge
 *  como alerta na Worklist "Pararam de entregar"). */
export const LIVE_STATUSES = new Set(["live", "running", "slowing", "scheduled"]);
/** Estados que NÃO contam pra "no ar" — vão pra Histórico. `stopped` entra
 *  aqui porque, embora ainda esteja `state=active` no Xandr, na prática
 *  está parada há mais de 1 semana. */
export const HISTORY_STATUSES = new Set(["stopped", "ended", "archived"]);

// ─── Health pill (calculado no backend) ──────────────────────────────────────
export function healthPillClass(health) {
  switch (health) {
    case "green":   return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "amber":   return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "red":     return "bg-rose-500/15 text-rose-400 border-rose-500/30";
    case "neutral":
    default:        return "bg-surface text-fg-subtle border-border";
  }
}
export function healthLabel(h) {
  return h === "green" ? "OK" : h === "amber" ? "Atenção"
       : h === "red"   ? "Crítico" : "Sem PI";
}

// ─── % entrega — fonte de verdade no frontend ───────────────────────────────
// Régua de negócio: "% entrega" = margem HYPR (curator_margin) ÷ PI.
// É o que efetivamente entra no caixa da HYPR comparado ao valor contratado.
//
// A SQL do enriched (pmp_lines_enriched.sql) já calcula pct_a_receber como
// margem÷PI, mas mantemos estes helpers como fonte de verdade no front:
// cobrem o caminho janelado (Histórico com período) e garantem a mesma
// fórmula em qualquer overlay local.

/** PI compartilhado de um grupo: primeiro membro com pi_brl > 0 (nem todo
 *  membro tem PI setado — só os com Command vinculado — então NÃO dá pra
 *  ler cegamente members[0].pi_brl). */
export function resolveGroupPi(members) {
  for (const m of members || []) {
    if (m.pi_brl != null && m.pi_brl > 0) return m.pi_brl;
  }
  return null;
}
export function pctEntrega(line) {
  if (!line) return null;
  const pi = line.pi_brl;
  const margin = line.curator_margin;
  if (pi == null || pi <= 0 || margin == null) return null;
  return margin / pi;
}

/** Versão grupo: usa group_curator_margin contra o PI compartilhado passado. */
export function groupPctEntrega(line, groupPi) {
  if (!line || groupPi == null || groupPi <= 0) return null;
  const margin = line.group_curator_margin;
  if (margin == null) return null;
  return margin / groupPi;
}

// ─── % entrega (Revenue) — métrica extra ao lado da % entrega de margem ──────
// Mesma ideia da pctEntrega, mas no numerador usa o faturamento bruto
// (curator_revenue) em vez da margem HYPR. Mostra "quanto de receita bruta
// foi entregue contra o valor contratado (PI)". Coexiste com pctEntrega — não
// substitui: % Entr Mgm = margem÷PI, % Entr Rev = revenue÷PI.
export function pctEntregaRev(line) {
  if (!line) return null;
  const pi = line.pi_brl;
  const revenue = line.curator_revenue;
  if (pi == null || pi <= 0 || revenue == null) return null;
  return revenue / pi;
}

/** Versão grupo: usa group_curator_revenue contra o PI compartilhado passado. */
export function groupPctEntregaRev(line, groupPi) {
  if (!line || groupPi == null || groupPi <= 0) return null;
  const revenue = line.group_curator_revenue;
  if (revenue == null) return null;
  return revenue / groupPi;
}

// ─── Falta entregar (R$) — saldo de receita ainda a faturar contra o PI ──────
// Contraparte absoluta do % Entr Rev: quanto de faturamento bruto ainda falta
// pra fechar o valor contratado (PI). = PI − curator_revenue.
// Retorna null quando não há PI; pode retornar valor ≤ 0 quando a entrega já
// bateu/passou o PI (a UI decide esconder nesse caso).
export function faltaEntregarRev(line) {
  if (!line) return null;
  const pi = line.pi_brl;
  const revenue = line.curator_revenue;
  if (pi == null || pi <= 0 || revenue == null) return null;
  return pi - revenue;
}

/** Versão grupo: usa group_curator_revenue contra o PI compartilhado passado. */
export function groupFaltaEntregarRev(line, groupPi) {
  if (!line || groupPi == null || groupPi <= 0) return null;
  const revenue = line.group_curator_revenue;
  if (revenue == null) return null;
  return groupPi - revenue;
}

// ─── % de entrega — cor de célula (régua compartilhada com sheets) ───────────
// Régua definida pelo time (margem ÷ PI):
//   < 70%   → vermelho      (entrega bem abaixo do esperado)
//   70-84%  → amarelo        (perto da meta mas ainda não bateu)
//   85-99%  → verde          (entregou ou tá quase batendo)
//   ≥ 100%  → verde escuro   (over-delivery — bateu o PI integralmente)
// Over-delivery sinaliza alerta operacional (passou do PI) na Worklist;
// na barra/cell mostramos o "verde mais saturado" pra diferenciar do
// verde "quase lá".
export function pctDeliveryClass(ratio) {
  if (ratio == null || isNaN(ratio)) return "";
  if (ratio < 0.70) return "bg-rose-500/15 text-rose-400";
  if (ratio < 0.85) return "bg-amber-500/15 text-amber-400";
  if (ratio < 1.00) return "bg-emerald-500/15 text-emerald-400";
  return "bg-emerald-700/20 text-emerald-500";
}

export function pctBarColor(ratio) {
  if (ratio == null || isNaN(ratio)) return "bg-border";
  if (ratio < 0.70) return "bg-rose-400";
  if (ratio < 0.85) return "bg-amber-400";
  if (ratio < 1.00) return "bg-emerald-400";
  return "bg-emerald-600";
}

// ─── Bid type ────────────────────────────────────────────────────────────────
export function bidTypeLabel(bid) {
  if (bid === "flex")  return "Flex";
  if (bid === "fixed") return "Fixed";
  return null;
}
export function bidTypeBadgeClass(bid) {
  if (bid === "flex")  return "bg-blue-500/10 text-blue-400 border-blue-500/20";
  if (bid === "fixed") return "bg-purple-500/10 text-purple-400 border-purple-500/20";
  return "bg-surface text-fg-subtle border-border";
}

// ─── Formatadores ────────────────────────────────────────────────────────────
const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2,
});
export function formatBRL(v) {
  if (v == null || isNaN(v)) return "—";
  return BRL.format(Number(v));
}

const BRL_COMPACT = new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1,
});
export function formatBRLCompact(v) {
  if (v == null || isNaN(v)) return "—";
  return BRL_COMPACT.format(Number(v));
}

const INT_BR = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
export function formatInt(v) {
  if (v == null || isNaN(v)) return "—";
  return INT_BR.format(Number(v));
}

const INT_COMPACT = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
export function formatIntCompact(v) {
  if (v == null || isNaN(v)) return "—";
  return INT_COMPACT.format(Number(v));
}

export function formatRatioPct(r, decimals = 1) {
  if (r == null || isNaN(r)) return "—";
  return `${(Number(r) * 100).toLocaleString("pt-BR", {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  })}%`;
}

/** "há 3 min" / "há 2h" / "há 4d" / "hoje". Usa hours_since_last_delivery do backend. */
export function formatLastDelivery(hours) {
  if (hours == null || isNaN(hours)) return null;
  if (hours < 1)  return "agora";
  if (hours < 24) return `há ${Math.floor(hours)}h`;
  const d = Math.floor(hours / 24);
  if (d === 1)  return "ontem";
  if (d < 7)    return `há ${d}d`;
  if (d < 30)   return `há ${Math.floor(d / 7)}sem`;
  if (d < 365)  return `há ${Math.floor(d / 30)}mês`;
  return `há ${Math.floor(d / 365)}a`;
}

/** True se a line foi criada há menos de `windowHours` (default 72h).
 *  Usado pra renderizar o badge "NEW" — janela curta pra ser informação útil
 *  (line acabou de chegar no sync) sem virar permanente. */
export function isNewLine(line, windowHours = 72) {
  if (!line?.created_at) return false;
  const created = new Date(line.created_at).getTime();
  if (isNaN(created)) return false;
  return (Date.now() - created) < windowHours * 3600 * 1000;
}

// O backend serializa NUMERIC do BQ com json.dumps(default=str), então
// campos monetários chegam como string ("353107.24") e comparação direta
// vira lexicográfica ("800" > "353107"). Coage pra número quando a string
// inteira é numérica; datas ("2026-06-01") e nomes viram NaN e seguem no
// compare de string.
function toSortNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Compara dois valores de sort. Nulls/vazios sempre no fim, em qualquer dir. */
export function compareSortValues(va, vb, dir = "desc") {
  const aN = va == null || va === "", bN = vb == null || vb === "";
  if (aN && bN) return 0;
  if (aN) return 1;
  if (bN) return -1;
  const na = toSortNumber(va), nb = toSortNumber(vb);
  if (na != null && nb != null) {
    return dir === "asc" ? na - nb : nb - na;
  }
  const sa = String(va).toLowerCase(), sb = String(vb).toLowerCase();
  if (sa < sb) return dir === "asc" ? -1 : 1;
  if (sa > sb) return dir === "asc" ? 1 : -1;
  return 0;
}

/** Compara duas lines pelo campo escolhido. Nulls sempre no fim. */
export function comparePmpLines(a, b, field, dir = "desc") {
  return compareSortValues(a?.[field], b?.[field], dir);
}

/** Inicial do email pra avatar. */
export function emailInitial(email) {
  if (!email) return "?";
  const local = email.split("@")[0];
  const parts = local.split(/[.\-_]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}
