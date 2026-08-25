// src/v2/admin/shell/navConfig.js
//
// Fonte única da árvore de navegação do admin.
//
// Antes desta PR a navegação vivia em dois lugares que não se conheciam:
// o `LayoutToggle` (5 views de Reports) e o `PmpLayoutToggle` (5 views de
// PMP), cada um com sua própria lista de options e seus próprios ícones.
// A view escolhida ficava só em `localStorage` — a URL não sabia dela, o
// botão voltar não navegava, e não existia link compartilhável pra
// "Diagnóstico".
//
// Aqui a árvore inteira é declarada uma vez, com o slug de URL ao lado do
// `layout` interno que as páginas já usavam. Nada do vocabulário antigo
// mudou: `CampaignMenuV2` continua recebendo "month" | "client" | "list" |
// "performers" | "diagnostico", e `PmpDealsPage` continua recebendo
// "list" | "live" | "client" | "history" | "analytics". O slug é só a
// projeção pública desse valor.
//
// ── Contrato de rotas ────────────────────────────────────────────────────
//   /admin/reports/:slug   → CampaignMenuV2 na view correspondente
//   /admin/pmp/:slug       → PmpDealsPage na view correspondente
//   /admin/client/:slug    → ClientDetailPage (drilldown, sem view interna)
//
// Rotas legadas continuam válidas e são normalizadas por `parseAdminPath`:
//   /            → /admin/reports/<última view usada, ou "mes">
//   /admin/pmp   → /admin/pmp/<última view usada, ou "lista">

import {
  CalendarIcon, UsersIcon, ListIcon, TrophyIcon, PulseIcon,
  LiveDotIcon, ArchiveIcon, ChartIcon,
} from "./navIcons";

export const SECTION_REPORTS = "reports";
export const SECTION_PMP     = "pmp";
export const SECTION_CLIENT  = "client";

// ── Views de Reports ─────────────────────────────────────────────────────
// `layout` = o valor que o CampaignMenuV2 sempre usou internamente.
// `count`  = qual contagem o rail mostra à direita do rótulo (resolvida em
//            runtime pelo AdminShell; ver `buildNavCounts`).
export const REPORT_VIEWS = [
  { layout: "month",       slug: "mes",         label: "Por mês",        icon: CalendarIcon, count: "campaigns" },
  { layout: "client",      slug: "clientes",    label: "Por cliente",    icon: UsersIcon,    count: "clients"   },
  { layout: "list",        slug: "lista",       label: "Lista",          icon: ListIcon,     count: "campaigns", wide: true },
  { layout: "performers",  slug: "performers",  label: "Top Performers", icon: TrophyIcon },
  { layout: "diagnostico", slug: "diagnostico", label: "Diagnóstico",    icon: PulseIcon,    badge: "critical", wide: true },
];

// ── Views de PMP ─────────────────────────────────────────────────────────
// Ordem preservada do PmpLayoutToggle original (Lista primeiro — é a view
// default do PMP desde que a aba existe).
export const PMP_VIEWS = [
  { layout: "list",      slug: "lista",     label: "Lista",     icon: ListIcon,    count: "pmpList",      wide: true },
  { layout: "live",      slug: "no-ar",     label: "No ar",     icon: LiveDotIcon, count: "pmpLive"      },
  { layout: "client",    slug: "carteira",  label: "Carteira",  icon: UsersIcon,   count: "pmpClient"    },
  { layout: "history",   slug: "historico", label: "Histórico", icon: ArchiveIcon, count: "pmpHistory",   wide: true },
  { layout: "analytics", slug: "analytics", label: "Analytics", icon: ChartIcon,                          wide: true },
];

export const NAV_GROUPS = [
  { id: SECTION_REPORTS, label: "Reports",   base: "/admin/reports", views: REPORT_VIEWS },
  { id: SECTION_PMP,     label: "PMP Deals", base: "/admin/pmp",     views: PMP_VIEWS    },
];

// Defaults por seção — usados quando a URL não nomeia a view (ex: bookmark
// antigo em `/` ou `/admin/pmp`).
export const DEFAULT_VIEW = {
  [SECTION_REPORTS]: "month",
  [SECTION_PMP]:     "list",
};

// ── localStorage ─────────────────────────────────────────────────────────
// `hypr.admin.layout` é a MESMA key que o CampaignMenuV2 e o
// ClientDetailPage já usavam. Mantida de propósito: quem estava no
// "Diagnóstico" ontem volta lá hoje. O que muda é o papel — deixa de ser o
// mecanismo de navegação (a URL assumiu isso) e volta a ser só a
// preferência de entrada quando nenhuma view foi pedida.
const LS_REPORTS_VIEW = "hypr.admin.layout";
const LS_PMP_VIEW     = "hypr.admin.pmpLayout";

const LS_KEY_BY_SECTION = {
  [SECTION_REPORTS]: LS_REPORTS_VIEW,
  [SECTION_PMP]:     LS_PMP_VIEW,
};

function viewsOf(section) {
  return section === SECTION_PMP ? PMP_VIEWS : REPORT_VIEWS;
}

/** Um layout é válido para a seção? Protege contra valor stale no storage. */
export function isValidLayout(section, layout) {
  return viewsOf(section).some((v) => v.layout === layout);
}

export function readStoredView(section) {
  try {
    const v = localStorage.getItem(LS_KEY_BY_SECTION[section]);
    if (v && isValidLayout(section, v)) return v;
  } catch { /* storage bloqueado — cai no default */ }
  return DEFAULT_VIEW[section];
}

export function writeStoredView(section, layout) {
  if (!isValidLayout(section, layout)) return;
  try { localStorage.setItem(LS_KEY_BY_SECTION[section], layout); }
  catch { /* ignore */ }
}

// ── Conversões slug ↔ layout ─────────────────────────────────────────────
export function layoutFromSlug(section, slug) {
  const hit = viewsOf(section).find((v) => v.slug === slug);
  return hit ? hit.layout : null;
}

export function slugFromLayout(section, layout) {
  const hit = viewsOf(section).find((v) => v.layout === layout);
  return hit ? hit.slug : null;
}

export function viewMeta(section, layout) {
  return viewsOf(section).find((v) => v.layout === layout) || null;
}

/** Path canônico de uma view. */
export function pathFor(section, layout) {
  const slug = slugFromLayout(section, layout);
  if (!slug) return "/";
  const base = section === SECTION_PMP ? "/admin/pmp" : "/admin/reports";
  return `${base}/${slug}`;
}

// ── Parsing da URL ───────────────────────────────────────────────────────
/**
 * Interpreta um pathname admin.
 *
 * Retorna sempre um objeto com `section`, e — quando a rota tem view —
 * `layout`. `canonical` traz o path normalizado quando a URL veio numa
 * forma legada ou inválida (o chamador faz replaceState pra ele); é null
 * quando a URL já está canônica.
 *
 * `null` significa "não é uma rota admin conhecida" — o App.jsx segue com
 * o próprio tratamento (report do cliente, portal, login).
 */
export function parseAdminPath(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";

  // Raiz — bookmark histórico do menu.
  if (path === "/") {
    const layout = readStoredView(SECTION_REPORTS);
    return { section: SECTION_REPORTS, layout, canonical: pathFor(SECTION_REPORTS, layout) };
  }

  // Drilldown de cliente — não tem view interna.
  const clientMatch = path.match(/^\/admin\/client\/([a-z0-9-]+)$/i);
  if (clientMatch) {
    return { section: SECTION_CLIENT, slug: clientMatch[1].toLowerCase(), canonical: null };
  }

  const reportsMatch = path.match(/^\/admin\/reports(?:\/([a-z0-9-]+))?$/i);
  if (reportsMatch) return sectionResult(SECTION_REPORTS, reportsMatch[1]);

  const pmpMatch = path.match(/^\/admin\/pmp(?:\/([a-z0-9-]+))?$/i);
  if (pmpMatch) return sectionResult(SECTION_PMP, pmpMatch[1]);

  return null;
}

function sectionResult(section, rawSlug) {
  const slug = rawSlug ? rawSlug.toLowerCase() : null;
  const layout = slug ? layoutFromSlug(section, slug) : null;
  if (layout) {
    // Slug reconhecido: URL já canônica.
    return { section, layout, canonical: null };
  }
  // Sem slug (rota legada) ou slug desconhecido (link velho, typo):
  // resolve pela preferência e devolve o path canônico pra normalizar.
  const fallback = readStoredView(section);
  return { section, layout: fallback, canonical: pathFor(section, fallback) };
}

// ── Contagens do rail, persistidas ───────────────────────────────────────
// O rail lista DESTINOS. A contagem ao lado de "Por mês" descreve o destino,
// não a página em que você está — então ela não pode mudar (nem sumir)
// conforme a rota. Só que cada página conhece uma fatia dos números:
//
//   CampaignMenuV2  sabe campanhas, clientes e críticos (roda o motor de alertas)
//   PmpDealsPage    sabe as quatro contagens de line do PMP
//   ClientDetailPage sabe só o cliente dele
//
// Sem um lugar comum, o rail ficava assimétrico: os itens do PMP apareciam
// sem número enquanto você estava em Reports, e o selo de críticos sumia ao
// entrar no drilldown. Cada página escreve a fatia que apurou e lê a união.
//
// É cache de EXIBIÇÃO, não fonte de verdade: quando a página que dona do
// número monta, ela sobrescreve. O pior caso é o rail mostrar a contagem da
// última visita — que é exatamente o que ele mostrava um segundo antes de
// você navegar.
const LS_NAV_COUNTS = "hypr.admin.navCounts";

export function readNavCountsCache() {
  try {
    const raw = localStorage.getItem(LS_NAV_COUNTS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

/** Mescla uma fatia no cache. Chaves com valor nulo são ignoradas. */
export function writeNavCountsCache(slice) {
  if (!slice) return;
  try {
    const merged = { ...readNavCountsCache() };
    for (const [k, v] of Object.entries(slice)) {
      if (v != null) merged[k] = v;
    }
    localStorage.setItem(LS_NAV_COUNTS, JSON.stringify(merged));
  } catch { /* ignore */ }
}

/**
 * Contagens exibidas no rail. Recebe o que cada página já calcula e devolve
 * o mapa consumido por `count`/`badge` das views.
 *
 * Só chaves presentes aparecem — `undefined` esconde a contagem em vez de
 * pintar "0". Importa no primeiro paint: enquanto `listCampaigns` não
 * responde, o rail mostra o rótulo sem número em vez de um zero que mente.
 */
export function buildNavCounts({ campaigns, clients, critical, pmp } = {}) {
  // Base: o que outras páginas já apuraram. Por cima, o que ESTA página
  // sabe — quem tem o número fresco sempre vence o cache.
  const counts = { ...readNavCountsCache() };
  if (campaigns != null) { counts.campaigns = campaigns; }
  if (clients   != null) { counts.clients   = clients;   }
  if (critical)          { counts.critical  = critical;  }
  if (pmp) {
    if (pmp.list    != null) counts.pmpList    = pmp.list;
    if (pmp.live    != null) counts.pmpLive    = pmp.live;
    if (pmp.client  != null) counts.pmpClient  = pmp.client;
    if (pmp.history != null) counts.pmpHistory = pmp.history;
  }
  return counts;
}

/** Rótulo público de uma seção — usado pelo eyebrow do PageHeader. */
export function sectionLabelOf(section) {
  return NAV_GROUPS.find((g) => g.id === section)?.label || "Admin";
}
