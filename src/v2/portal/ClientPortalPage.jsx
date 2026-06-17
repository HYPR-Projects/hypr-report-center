// src/v2/portal/ClientPortalPage.jsx
//
// Portal do Cliente — dashboard central client-facing por cliente.
//
// Um link compartilhado (/c/<share_id>) onde o cliente (PicPay, Kenvue, etc.)
// vê TODAS as campanhas que rodou com a HYPR, com big numbers agregados,
// quebra por mês ou por campanha, e acesso direto aos reports.
//
// REGRA DE OURO: zero dado interno HYPR. Nada de custo real, margem, tech cost,
// rentabilidade ou ECPM admin. Só investimento (PI contratado), impressões,
// cliques, CTR, VTR, views 100% e datas — os mesmos campos client-safe que o
// report individual já expõe com isAdmin=false.
//
// Co-branded: a `accent_color` do cliente re-tematiza os acentos da página
// inteira (sobrescreve --color-signature no escopo do root), e o logo do
// cliente aparece em destaque ao lado da marca HYPR.
//
// Esta versão consome PORTAL_MOCK; a fiação com o backend
// (?action=client_portal_data) troca só a fonte de `data`.

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import "../v2.css";
import "../../ui/typography";

import { TooltipProvider } from "../../ui/Tooltip";
import { SegmentedControlV2 } from "../components/SegmentedControlV2";
import { DateRangeFilterV2 } from "../components/DateRangeFilterV2";
import { ThemeToggleV2 } from "../components/ThemeToggleV2";
import { ymd } from "../../shared/dateFilter";
import { MultiSelectDropdown } from "./PortalFilters";
import PortalAnalytics from "./PortalAnalytics";
import HyprReportCenterLogo from "../../components/HyprReportCenterLogo";
import { cn } from "../../ui/cn";
import { getClientPortalData, resolveClientShare } from "../../lib/api";
import { markClientUnlocked } from "../../shared/auth";
import { useTheme } from "../hooks/useTheme";
import { useLogoAnalysis } from "../hooks/useLogoAnalysis";

import {
  formatBrlCompact,
  formatBrlShort,
  formatBRL,
  formatPct,
  formatMonthLabel,
  getDateRangeParts,
  getCampaignStatus,
  slugToDisplay,
} from "../admin/lib/format";
import { formatInt, formatIntCompact } from "../admin/lib/pmpFormat";

import { PORTAL_MOCK, MOCK_SHARE_ID } from "./portalMock";

// ── Unlock persistente (localStorage) ────────────────────────────────────────
// Mesmo princípio do unlock de report: depois que o cliente acerta a senha,
// guarda por 8h pra não pedir de novo a cada refresh. Keyed por share_id.
const UNLOCK_PREFIX = "hypr.portalUnlock.";
const UNLOCK_TTL_MS = 8 * 60 * 60 * 1000;

function isPortalUnlocked(shareId) {
  try {
    const raw = localStorage.getItem(UNLOCK_PREFIX + shareId);
    if (!raw) return false;
    const { expiresAt } = JSON.parse(raw);
    return typeof expiresAt === "number" && Date.now() < expiresAt;
  } catch {
    return false;
  }
}

function markPortalUnlocked(shareId) {
  try {
    localStorage.setItem(
      UNLOCK_PREFIX + shareId,
      JSON.stringify({ expiresAt: Date.now() + UNLOCK_TTL_MS }),
    );
  } catch {
    /* ignore */
  }
}

// ── Container: gate de senha + fetch (ou mock no protótipo) ───────────────────
export default function ClientPortalPage({ shareId }) {
  // Protótipo: share_id reservado curto-circuita pro mock (sem backend/senha).
  const isMock = !shareId || shareId === MOCK_SHARE_ID;

  const [unlocked, setUnlocked] = useState(() => isMock || isPortalUnlocked(shareId));
  const [data, setData] = useState(isMock ? PORTAL_MOCK : null);
  const [status, setStatus] = useState(isMock ? "ready" : "idle"); // idle|loading|ready|error|notfound

  const loadData = useCallback(async () => {
    setStatus("loading");
    try {
      const payload = await getClientPortalData(shareId);
      setData(payload);
      setStatus("ready");
    } catch (e) {
      setStatus(e?.message === "portal_not_found" ? "notfound" : "error");
    }
  }, [shareId]);

  // Já desbloqueado (cache) → busca direto.
  useEffect(() => {
    if (isMock) return;
    if (unlocked && status === "idle") loadData();
  }, [isMock, unlocked, status, loadData]);

  if (isMock) return <PortalView data={PORTAL_MOCK} />;

  if (status === "notfound") {
    return <PortalMessage title="Portal não encontrado" body="Este link não está ativo ou não existe. Confira com seu contato na HYPR." />;
  }

  if (!unlocked) {
    return (
      <PortalPasswordScreen
        shareId={shareId}
        onUnlock={() => {
          markPortalUnlocked(shareId);
          setUnlocked(true);
          setStatus("idle"); // dispara o fetch no próximo effect
        }}
      />
    );
  }

  if (status === "loading" || status === "idle") {
    return <PortalMessage title="Carregando…" body="Buscando seus relatórios." spinner />;
  }

  if (status === "error" || !data) {
    return (
      <PortalMessage
        title="Não consegui carregar"
        body="Tente recarregar a página em instantes."
        action={<button onClick={loadData} className="mt-4 px-4 h-9 rounded-lg bg-signature text-on-signature text-[13px] font-semibold">Tentar de novo</button>}
      />
    );
  }

  return <PortalView data={data} />;
}

// ── Helpers client-safe ─────────────────────────────────────────────────────

// Investido = PI cliente contratado (display + vídeo). Campo seguro: é o que o
// cliente comprou, não o custo real da HYPR.
function investedOf(c) {
  return (Number(c.d_client_budget) || 0) + (Number(c.v_client_budget) || 0);
}

const MONOGRAM_MAX = 2;
function monogram(name) {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, MONOGRAM_MAX).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ── Página ───────────────────────────────────────────────────────────────────

function PortalView({ data }) {
  const { client, campaigns } = data;
  const accent = client.accent_color || "#3397B9";

  const [view, setView] = useState("campaigns"); // "campaigns" | "analytics"
  const [groupBy, setGroupBy] = useState("month"); // "month" | "campaign"
  const [search, setSearch] = useState("");
  // Filtros (Bloco B) — todos multi-seleção (arrays vazios = "todos").
  const [fmts, setFmts] = useState([]); // subset de DISPLAY/VIDEO
  const [feats, setFeats] = useState([]); // subset de survey/rmnd/pdooh
  // Período: range {from,to}|null (null = todo o período) + id do preset que
  // o originou (desempate visual no DateRangeFilterV2). Substitui o antigo
  // multi-select de meses pelo mesmo filtro range do report (presets +
  // calendário). Filtra campanhas por SOBREPOSIÇÃO do voo com o range.
  const [period, setPeriod] = useState(null);
  const [periodPresetId, setPeriodPresetId] = useState("all");
  const [collapsed, setCollapsed] = useState(() => new Set()); // meses recolhidos

  const toggleMonth = (key) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const filtersActive = fmts.length > 0 || feats.length > 0 || !!period;
  const clearFilters = () => { setFmts([]); setFeats([]); setPeriod(null); setPeriodPresetId("all"); };

  // Big numbers agregados — só métricas seguras.
  const summary = useMemo(() => {
    let invested = 0;
    let impressions = 0;
    let clicks = 0;
    let completions = 0;
    const ctrs = [];
    const vtrs = [];
    let active = 0;
    let firstStart = null;
    let lastEnd = null;
    for (const c of campaigns) {
      invested += investedOf(c);
      impressions += Number(c.viewable_impressions) || 0;
      clicks += Number(c.clicks) || 0;
      completions += Number(c.completions) || 0;
      if (c.ctr != null) ctrs.push(Number(c.ctr));
      if (c.vtr != null) vtrs.push(Number(c.vtr));
      const status = getCampaignStatus(c.end_date, c.closed_at, c.paused_at, c.early_end_date);
      if (status === "in_flight" || status === "paused") active += 1;
      if (c.start_date && (!firstStart || c.start_date < firstStart)) firstStart = c.start_date;
      if (c.end_date && (!lastEnd || c.end_date > lastEnd)) lastEnd = c.end_date;
    }
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return {
      invested,
      impressions,
      clicks,
      completions,
      // CTR agregado correto = Σcliques / Σimpressões (não média de razões).
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      vtr: mean(vtrs), // VTR médio das campanhas com vídeo
      count: campaigns.length,
      active,
      firstStart,
      lastEnd,
    };
  }, [campaigns]);

  // Filtro: busca + formato + features + meses (multi-seleção, OR dentro de
  // cada dimensão; AND entre dimensões).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return campaigns.filter((c) => {
      if (q && !c.campaign_name?.toLowerCase().includes(q)) return false;
      if (fmts.length > 0 && !fmts.some((f) => (c.media || []).includes(f))) return false;
      if (feats.length > 0 && !feats.some((f) => (c.features || []).includes(f))) return false;
      if (period?.from && period?.to) {
        // Sobreposição: a campanha entra se o voo dela (início→fim) cruza o
        // range escolhido. Comparação lexical de "YYYY-MM-DD" (datas ISO).
        const from = ymd(period.from);
        const to   = ymd(period.to);
        const cs = c.start_date || "";
        const ce = c.end_date || cs;
        if (!cs || cs > to || ce < from) return false;
      }
      return true;
    });
  }, [campaigns, search, fmts, feats, period]);

  // Agrupa campanhas merged num único item "group" (1 link, métricas somadas);
  // as demais viram "single". Reports agregados deixam de aparecer soltos.
  const items = useMemo(() => {
    const out = [];
    const idx = new Map();
    const seen = new Set(); // dedup: mesmo short_token pode vir 2x (rename de line)
    for (const c of filtered) {
      const tok = (c.short_token || "").toUpperCase();
      if (tok && seen.has(tok)) continue;
      if (tok) seen.add(tok);
      if (!c.merge_id) {
        out.push({ kind: "single", campaign: c, key: `s-${tok || out.length}` });
        continue;
      }
      const at = idx.get(c.merge_id);
      if (at == null) {
        idx.set(c.merge_id, out.length);
        out.push({ kind: "group", merge_id: c.merge_id, members: [c], key: `g-${c.merge_id}` });
      } else {
        out[at].members.push(c);
      }
    }
    for (const it of out) {
      if (it.kind === "group") {
        it.members.sort((a, b) => (b.start_date || "").localeCompare(a.start_date || ""));
      }
    }
    return out;
  }, [filtered]);

  const repDate = (it) => (it.kind === "single" ? it.campaign.start_date : it.members[0]?.start_date) || "";
  const repName = (it) => (it.kind === "single" ? it.campaign.campaign_name : it.members[0]?.campaign_name) || "";

  // Por mês (de início, desc) ou flat por nome (alpha).
  const sections = useMemo(() => {
    if (groupBy === "campaign") {
      const sorted = [...items].sort((a, b) => repName(a).localeCompare(repName(b), "pt-BR"));
      return [{ key: "all", label: null, items: sorted }];
    }
    const acc = new Map();
    for (const it of items) {
      const m = repDate(it).slice(0, 7) || "no-date";
      if (!acc.has(m)) acc.set(m, []);
      acc.get(m).push(it);
    }
    const keys = [...acc.keys()].sort((a, b) => (a === "no-date" ? 1 : b === "no-date" ? -1 : b.localeCompare(a)));
    return keys.map((m) => ({
      key: m,
      label: m === "no-date" ? "Sem data" : formatMonthLabel(m),
      items: acc.get(m).sort((a, b) => repDate(b).localeCompare(repDate(a))),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, groupBy]);

  const periodLabel = useMemo(() => {
    if (!summary.firstStart || !summary.lastEnd) return null;
    const s = formatMonthLabel(summary.firstStart.slice(0, 7), "short");
    const e = formatMonthLabel(summary.lastEnd.slice(0, 7), "short");
    return s === e ? s : `${s} – ${e}`;
  }, [summary]);

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="relative min-h-screen w-full bg-canvas text-fg transition-colors"
        // Co-branding: re-tematiza os acentos da página com a cor do cliente.
        // Todas as utilitárias text-signature/bg-signature/etc passam a usar a
        // cor da marca sem precisar tocar em componente nenhum.
        style={{
          "--color-signature": accent,
          "--color-signature-hover": accent,
        }}
      >
        {/* Glow ambiente — discreto, na cor da marca */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[420px] opacity-50"
          style={{ background: `radial-gradient(1000px 420px at 80% -200px, ${accent}1f, transparent 70%)` }}
        />

        {/* ── Topbar: marca HYPR (produto) ─────────────────────────────────── */}
        <header className="relative z-30 sticky top-0 backdrop-blur-md bg-canvas/70 border-b border-border">
          <div className="max-w-[1400px] mx-auto px-5 sm:px-8 h-[68px] flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <HyprReportCenterLogo height={26} />
              {/* Divisor + label alinhados ao centro ÓPTICO dos glifos do logo,
                  não ao box do SVG. O viewBox do wordmark tem ~6px de folga no
                  topo (glifos encostados embaixo), então os glifos visíveis caem
                  ~3px abaixo do centro do box — daí o translate-y pra casar. */}
              <div className="hidden sm:flex items-center gap-3 translate-y-[3px]">
                <span className="h-4 w-px bg-border-strong" />
                <span className="text-[11px] uppercase tracking-[0.2em] font-semibold text-fg-subtle">
                  Portal do cliente
                </span>
              </div>
            </div>
            <ThemeToggleV2 />
          </div>
        </header>

        <main className="relative max-w-[1400px] mx-auto px-5 sm:px-8 pt-10 sm:pt-14 pb-24">
          {/* ── Hero do cliente — eyebrow + nome grande à esquerda, logo da
              marca flutuando à direita. Espelha o ritmo do header do report
              (CampaignHeaderV2: barra+eyebrow → título → meta), sem card pra
              não competir com o glow ambiente da página e preservar o
              minimalismo do portal. ──────────────────────────────────────── */}
          <header className="mb-14 sm:mb-16 flex items-center justify-between gap-6 sm:gap-10">
            <div className="min-w-0 flex-1">
              {/* Eyebrow: barra na cor da marca + rótulo + status de ativas */}
              <div className="flex items-center gap-2.5 mb-3 flex-wrap">
                <span className="inline-block h-[3px] w-7 rounded-full" style={{ background: accent }} aria-hidden />
                <span className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: accent }}>
                  Visão geral
                </span>
                {summary.active > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-fg-muted">
                    <span className="size-1.5 rounded-full" style={{ background: accent }} aria-hidden />
                    {summary.active} {summary.active === 1 ? "ativa" : "ativas"}
                  </span>
                )}
              </div>

              {/* Título — nome do cliente em destaque */}
              <h1 className="text-[26px] sm:text-[33px] lg:text-[38px] font-extrabold leading-[1.06] tracking-[-0.8px] text-fg break-words">
                {client.display_name || slugToDisplay(client.slug)}
              </h1>

              {/* Meta: total de campanhas + período do conjunto */}
              <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] sm:text-[15px] text-fg-muted">
                <span className="tabular-nums">
                  {summary.count} {summary.count === 1 ? "campanha" : "campanhas"}
                </span>
                {periodLabel && (
                  <>
                    <span className="text-fg-subtle/50" aria-hidden>·</span>
                    <span className="tabular-nums">{periodLabel}</span>
                  </>
                )}
              </div>
            </div>

            {/* Logo da marca — flutua sem caixa, maior, alinhada à direita
                e centrada verticalmente com o bloco de texto. */}
            <PortalHeroLogo logo={client.logo_base64} name={client.display_name || slugToDisplay(client.slug)} />
          </header>

          {/* ── Navegação: Campanhas × Analytics ─────────────────────────────── */}
          <div className="mb-8 flex items-center gap-1 border-b border-border">
            <PortalTab active={view === "campaigns"} onClick={() => setView("campaigns")} accent={accent}>Campanhas</PortalTab>
            <PortalTab active={view === "analytics"} onClick={() => setView("analytics")} accent={accent}>Analytics</PortalTab>
          </div>

          {view === "analytics" && (
            <PortalAnalytics
              campaigns={campaigns}
              accent={accent}
              shareId={client.share_id}
              brandLiftMock={data.brandLift}
            />
          )}

          {view === "campaigns" && (
          <>
          {/* ── Big numbers — snapshot da conta. Só na aba Campanhas; em
              Analytics o strip de KPIs reativo aos filtros cumpre esse papel
              (evita duplicar dois strips quase idênticos). ──────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5 sm:gap-4 mb-12">
            <BigNumber label="Investimento" value={formatBrlShort(summary.invested)} fullValue={formatBRL(summary.invested)} accent />
            <BigNumber label="Impressões" value={formatIntCompact(summary.impressions)} fullValue={`${formatInt(summary.impressions)} impressões visíveis`} sub="visíveis" />
            <BigNumber label="Cliques" value={formatIntCompact(summary.clicks)} fullValue={formatInt(summary.clicks)} />
            <BigNumber label="CTR" value={formatPct(summary.ctr, 2)} sub="médio" />
            <BigNumber label="VTR" value={formatPct(summary.vtr, 1)} sub="vídeo" />
            <BigNumber label="Views 100%" value={formatIntCompact(summary.completions)} fullValue={`${formatInt(summary.completions)} vídeos completos`} sub="vídeo completo" />
          </div>

          {/* ── Campanhas — agrupamento + toolbar ────────────────────────────── */}
          <div className="flex items-center justify-end gap-4 mb-5">
            <SegmentedControlV2
              label="Agrupar por"
              options={[{ value: "month", label: "Por mês" }, { value: "campaign", label: "Por campanha" }]}
              value={groupBy}
              onChange={setGroupBy}
            />
          </div>

          {/* Toolbar: filtros à esquerda, busca à direita */}
          <div className="mb-8 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <DateRangeFilterV2
                value={period}
                presetId={periodPresetId}
                campaignStart={summary.firstStart}
                campaignEnd={summary.lastEnd}
                onChange={(r, pid) => { setPeriod(r); setPeriodPresetId(pid); }}
                triggerClassName="h-9 px-3 rounded-lg bg-canvas-deeper font-medium"
              />
              <MultiSelectDropdown
                label="Formato" allLabel="Todos os formatos"
                options={[{ value: "DISPLAY", label: "Display" }, { value: "VIDEO", label: "Vídeo" }]}
                selected={fmts} onChange={setFmts} accent={accent}
              />
            <MultiSelectDropdown
              label="Features" allLabel="Todas as features"
              options={[{ value: "survey", label: "Survey" }, { value: "rmnd", label: "RMND" }, { value: "pdooh", label: "PDOOH" }]}
              selected={feats} onChange={setFeats} accent={accent}
            />
              {filtersActive && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-0.5 text-[12px] text-fg-muted hover:text-fg underline-offset-2 hover:underline transition-colors"
                >
                  Limpar
                </button>
              )}
            </div>
            <SearchInput value={search} onChange={setSearch} />
          </div>

          {filtered.length === 0 ? (
            <EmptyState query={search} filtered={filtersActive} />
          ) : (
            <div className="space-y-9">
              {sections.map((sec) => {
                const collapsible = groupBy === "month" && !!sec.label;
                const isCollapsed = collapsible && collapsed.has(sec.key);
                return (
                  <section key={sec.key}>
                    {sec.label && (
                      collapsible ? (
                        <button
                          type="button"
                          onClick={() => toggleMonth(sec.key)}
                          className="w-full flex items-center gap-2 mb-3 px-0.5 group/m focus-visible:outline-none"
                        >
                          <svg
                            width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                            className={cn("text-fg-subtle transition-transform", !isCollapsed && "rotate-90")}
                          >
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                          <h3 className="text-[11px] uppercase tracking-widest font-semibold text-fg-subtle group-hover/m:text-fg-muted whitespace-nowrap transition-colors">
                            {sec.label}
                          </h3>
                          <span className="text-[11px] text-fg-subtle/60 tabular-nums">{sec.items.length}</span>
                        </button>
                      ) : (
                        <div className="flex items-baseline gap-2 mb-3 px-0.5">
                          <h3 className="text-[11px] uppercase tracking-widest font-semibold text-fg-subtle whitespace-nowrap">{sec.label}</h3>
                          <span className="text-[11px] text-fg-subtle/60 tabular-nums">{sec.items.length}</span>
                        </div>
                      )
                    )}
                    {!isCollapsed && (
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5 sm:gap-3">
                        {sec.items.map((it) =>
                          it.kind === "group" ? (
                            <MergeGroupCard key={it.key} members={it.members} accent={accent} client={client} />
                          ) : (
                            <PortalCampaignCard key={it.key} campaign={it.campaign} accent={accent} client={client} />
                          ),
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
          </>
          )}

          {/* ── Footer ─────────────────────────────────────────────────────── */}
          <footer className="mt-16 pt-6 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-2 text-center sm:text-left">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-fg-subtle">
              Relatório gerado por
              <HyprReportCenterLogo height={13} />
            </span>
            <span className="text-[11px] text-fg-subtle">
              Dados confidenciais · uso exclusivo {client.display_name || slugToDisplay(client.slug)}
            </span>
          </footer>
        </main>
      </div>
    </TooltipProvider>
  );
}

// ── Subcomponentes ────────────────────────────────────────────────────────────

// Chip de logo PADRONIZADO: toda logo é renderizada MONOCROMÁTICA e theme-aware
// (branca no dark, escura no light), via filtro CSS — mesma lógica do report
// original que adapta a logo ao tema. Resultado: cor 100% uniforme entre marcas,
// sempre visível, zero "circo". Sem logo → monograma neutro no mesmo chip.
function LogoChip({ logo, accent, name, size = 44, radius = 12 }) {
  const [theme] = useTheme();
  const boxStyle = { height: size, width: size, borderRadius: radius };
  // brightness(0) = silhueta preta (light); +invert(1) = silhueta branca (dark).
  const monoFilter = theme === "light" ? "brightness(0)" : "brightness(0) invert(1)";
  if (logo) {
    return (
      <div
        className="shrink-0 flex items-center justify-center overflow-hidden bg-canvas-deeper ring-1 ring-border"
        style={boxStyle}
      >
        <img
          src={logo}
          alt={name || ""}
          className="object-contain"
          style={{ maxHeight: "52%", maxWidth: "62%", filter: monoFilter, opacity: 0.92 }}
        />
      </div>
    );
  }
  return (
    <div
      className="shrink-0 flex items-center justify-center overflow-hidden bg-canvas-deeper ring-1 ring-border font-bold text-fg-muted"
      style={{ ...boxStyle, fontSize: size * 0.34 }}
      aria-hidden
    >
      {monogram(name)}
    </div>
  );
}

// Logo "hero" do topo do portal — diferente do LogoChip dos cards: aqui a
// marca aparece GRANDE, sem caixa nem ring, flutuando direto sobre o canvas
// (espelha o header do report). Mantém a COR ORIGINAL da marca; só aplica
// filtro de contraste quando a logo conflita com o tema (monochrome no tema
// oposto, ou colored-dark em dark) — mesma régua do CampaignHeaderV2. A altura
// escala 48→64→72px e o max-width evita que logos largas (ex: lockups
// horizontais) invadam o título; object-right ancora no canto.
function PortalHeroLogo({ logo, name }) {
  const logoKind = useLogoAnalysis(logo);
  const [theme] = useTheme();
  const shouldInvert =
    (logoKind === "monochrome-light" && theme === "light") ||
    (logoKind === "monochrome-dark" && theme === "dark");
  const shouldBoost = logoKind === "colored-dark" && theme === "dark";
  const filter = shouldInvert
    ? "invert(1)"
    : shouldBoost
      ? "brightness(1.7) contrast(1.1)"
      : undefined;

  if (logo) {
    return (
      <img
        src={logo}
        alt={name ? `Logo ${name}` : "Logo do cliente"}
        className="shrink-0 h-10 sm:h-12 lg:h-[56px] w-auto max-w-[110px] sm:max-w-[168px] lg:max-w-[200px] object-contain object-right transition-[filter] duration-200"
        style={filter ? { filter } : undefined}
        loading="eager"
      />
    );
  }
  // Sem logo: monograma num chip discreto pra ancorar o canto direito sem
  // peso visual (mantém a simetria do hero mesmo sem asset da marca).
  return (
    <div
      className="shrink-0 flex items-center justify-center size-11 sm:size-12 lg:size-[56px] rounded-2xl border border-border bg-canvas-elevated font-bold text-fg-muted text-lg sm:text-xl"
      aria-hidden
    >
      {monogram(name)}
    </div>
  );
}

// Big number: card elevado com borda + sombra (contraste claro nos dois temas).
// Investimento ganha tom + borda da marca pra ser a âncora.
function BigNumber({ label, value, fullValue, sub, accent = false }) {
  return (
    <div
      className={cn(
        "rounded-2xl p-5 min-w-0 border",
        !accent && "bg-canvas-elevated border-border",
      )}
      style={accent ? {
        background: "color-mix(in srgb, var(--color-signature) 12%, var(--color-canvas-elevated))",
        borderColor: "color-mix(in srgb, var(--color-signature) 38%, transparent)",
      } : undefined}
    >
      <div className="text-[10.5px] sm:text-[11px] font-semibold uppercase tracking-wider text-fg-muted leading-none">
        {label}
      </div>
      <div
        className={cn("mt-3 text-[24px] sm:text-[28px] font-bold leading-none tabular-nums truncate", accent ? "text-signature" : "text-fg")}
        title={fullValue}
      >
        {value}
      </div>
      {sub && <div className="mt-2 text-[11px] text-fg-subtle leading-none">{sub}</div>}
    </div>
  );
}

function PortalCampaignCard({ campaign: c, accent, client }) {
  const invested = investedOf(c);
  const status = getCampaignStatus(c.end_date, c.closed_at, c.paused_at, c.early_end_date);
  const range = getDateRangeParts(c.start_date, c.end_date);
  const hasVideo = Array.isArray(c.media) && c.media.includes("VIDEO");
  const reportToken = c.share_id || c.short_token;
  const reportHref = `/report/${reportToken}`;

  // Pré-libera o report: o cliente já se autenticou no portal, então não faz
  // sentido pedir a senha de novo. Como a senha do report É o short_token (e o
  // portal já o conhece), gravamos o unlock antes de abrir a aba.
  const preUnlock = () => {
    try { markClientUnlocked(reportToken, c.short_token); } catch { /* ignore */ }
  };

  const logo = c.logo_base64 || client.logo_base64; // logo própria → co-brand → monograma

  return (
    <a
      href={reportHref}
      target="_blank"
      rel="noopener noreferrer"
      onClick={preUnlock}
      onAuxClick={preUnlock}
      className={cn(
        "group rounded-2xl bg-canvas-elevated border border-border p-5 flex flex-col min-h-[300px]",
        "transition-colors duration-150 hover:border-border-strong",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
      )}
    >
      {/* Header: logo + nome/datas + status */}
      <div className="flex items-start gap-3 min-h-[60px]">
        <LogoChip logo={logo} accent={accent} name={c.campaign_name} size={48} radius={13} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-[14px] sm:text-[15px] font-semibold text-fg leading-snug line-clamp-2">
              {c.campaign_name}
            </h3>
            <StatusPill status={status} accent={accent} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {range && (
              <span className="text-[12px] text-fg-subtle tabular-nums">
                {range.startStr} <span className="opacity-60">→</span> {range.endStr}
              </span>
            )}
            {c.aggregated && <AggregatedBadge />}
          </div>
        </div>
      </div>

      {/* divisória sutil identidade → métricas (margens generosas) */}
      <div className="my-5 h-px bg-border" />

      {/* Métricas client-safe (sem cor condicional) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-3.5">
        <Metric label="Investimento" value={formatBrlCompact(invested)} title={formatBRL(invested)} />
        <Metric label="Impressões" value={formatIntCompact(c.viewable_impressions)} title={formatInt(c.viewable_impressions)} />
        <Metric label="CTR" value={formatPct(c.ctr, 2)} />
        <Metric
          label={hasVideo ? "VTR" : "Cliques"}
          value={hasVideo ? formatPct(c.vtr, 1) : formatIntCompact(c.clicks)}
          title={hasVideo ? undefined : formatInt(c.clicks)}
        />
      </div>

      {/* Sinais: pacing + core products + features */}
      {(c.pacing != null || (c.tactics || []).length > 0 || (c.features || []).length > 0) && (
        <div className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          {c.pacing != null && (
            <span className="inline-flex items-baseline gap-1 text-[11px]">
              <span className="text-fg-subtle uppercase tracking-wider font-semibold">Pacing</span>
              <span className="tabular-nums font-semibold text-fg">{c.pacing}%</span>
            </span>
          )}
          {(c.tactics || []).map((t) => <ProductChip key={t} t={t} />)}
          {(c.features || []).map((f) => <FeatureChip key={f} f={f} accent={accent} />)}
        </div>
      )}

      {/* Spacer com altura mínima — garante respiro antes do rodapé (nunca cola) */}
      <div className="flex-1 min-h-5" aria-hidden />

      {/* Footer: formato + CTA */}
      <div className="pt-4 border-t border-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {(c.media || []).map((m) => (
            <span key={m} className="text-[10px] uppercase tracking-wider font-semibold text-fg-subtle">
              {m === "DISPLAY" ? "Display" : m === "VIDEO" ? "Vídeo" : m}
            </span>
          ))}
        </div>
        <span className="inline-flex items-center gap-1 text-[12px] font-semibold group-hover:gap-1.5 transition-all" style={{ color: accent }}>
          Ver relatório
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </span>
      </div>
    </a>
  );
}

// Card de grupo AGREGADO — vários reports merged numa única visão (1 link).
// Métricas somadas, pacing/tactics/features unidos, membros listados.
function MergeGroupCard({ members, accent, client }) {
  const agg = useMemo(() => {
    let invested = 0, impressions = 0, clicks = 0, completions = 0;
    const pacings = [], vtrs = [];
    const tactics = new Set(), features = new Set();
    let start = null, end = null, anyActive = false, hasVideo = false;
    for (const m of members) {
      invested += investedOf(m);
      impressions += Number(m.viewable_impressions) || 0;
      clicks += Number(m.clicks) || 0;
      completions += Number(m.completions) || 0;
      if (m.pacing != null) pacings.push(Number(m.pacing));
      if (m.vtr != null) vtrs.push(Number(m.vtr));
      (m.tactics || []).forEach((t) => tactics.add(t));
      (m.features || []).forEach((f) => features.add(f));
      if ((m.media || []).includes("VIDEO")) hasVideo = true;
      if (m.start_date && (!start || m.start_date < start)) start = m.start_date;
      if (m.end_date && (!end || m.end_date > end)) end = m.end_date;
      const st = getCampaignStatus(m.end_date, m.closed_at, m.paused_at, m.early_end_date);
      if (st === "in_flight" || st === "paused") anyActive = true;
    }
    const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
    const meanF = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return {
      invested, impressions, clicks, completions,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
      vtr: meanF(vtrs), pacing: mean(pacings),
      tactics: [...tactics], features: [...features], hasVideo, start, end, anyActive,
    };
  }, [members]);

  const lead = members[0]; // membro mais recente (lista ordenada desc)
  const title = lead.campaign_name;
  const logo = lead.logo_base64 || client.logo_base64;
  const range = getDateRangeParts(agg.start, agg.end);
  const status = agg.anyActive ? "in_flight" : "ended";
  const reportToken = lead.share_id || lead.short_token;
  const preUnlock = () =>
    members.forEach((m) => { try { markClientUnlocked(m.share_id || m.short_token, m.short_token); } catch { /* ignore */ } });

  return (
    <a
      href={`/report/${reportToken}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={preUnlock}
      onAuxClick={preUnlock}
      className={cn(
        "group rounded-2xl bg-canvas-elevated border p-5 flex flex-col min-h-[300px]",
        "transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
      )}
      style={{ borderColor: `color-mix(in srgb, ${accent} 28%, var(--color-border))` }}
    >
      <div className="flex items-start gap-3 min-h-[60px]">
        <LogoChip logo={logo} accent={accent} name={title} size={48} radius={13} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-[14px] sm:text-[15px] font-semibold text-fg leading-snug line-clamp-2">{title}</h3>
            <StatusPill status={status} accent={accent} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <AggregatedBadge />
            <span className="text-[12px] text-fg-subtle tabular-nums">{members.length} relatórios</span>
            {range && (
              <>
                <span className="text-fg-subtle/60">·</span>
                <span className="text-[12px] text-fg-subtle tabular-nums">{range.startStr} → {range.endStr}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* divisória sutil identidade → métricas (margens generosas) */}
      <div className="my-5 h-px bg-border" />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-3.5">
        <Metric label="Investimento" value={formatBrlCompact(agg.invested)} title={formatBRL(agg.invested)} />
        <Metric label="Impressões" value={formatIntCompact(agg.impressions)} title={formatInt(agg.impressions)} />
        <Metric label="CTR" value={formatPct(agg.ctr, 2)} />
        <Metric
          label={agg.hasVideo ? "VTR" : "Cliques"}
          value={agg.hasVideo ? formatPct(agg.vtr, 1) : formatIntCompact(agg.clicks)}
          title={agg.hasVideo ? undefined : formatInt(agg.clicks)}
        />
      </div>

      {(agg.pacing != null || agg.tactics.length > 0 || agg.features.length > 0) && (
        <div className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          {agg.pacing != null && (
            <span className="inline-flex items-baseline gap-1 text-[11px]">
              <span className="text-fg-subtle uppercase tracking-wider font-semibold">Pacing</span>
              <span className="tabular-nums font-semibold text-fg">{agg.pacing}%</span>
            </span>
          )}
          {agg.tactics.map((t) => <ProductChip key={t} t={t} />)}
          {agg.features.map((f) => <FeatureChip key={f} f={f} accent={accent} />)}
        </div>
      )}

      {/* Membros do agregado — cada um com seu mês de referência */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {members.map((m) => (
          <span key={m.short_token} className="inline-flex items-center gap-1.5 text-[10.5px] px-2 py-1 rounded-md bg-surface">
            <span className="truncate max-w-[150px] text-fg-muted">{m.campaign_name}</span>
            {m.start_date && (
              <span className="shrink-0 tabular-nums uppercase tracking-wide font-semibold" style={{ color: accent }}>
                {formatMonthLabel(m.start_date.slice(0, 7), "short")}
              </span>
            )}
          </span>
        ))}
      </div>

      {/* Spacer com altura mínima — respiro garantido antes do rodapé */}
      <div className="flex-1 min-h-5" aria-hidden />

      <div className="pt-4 border-t border-border flex items-center justify-between gap-3">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-fg-subtle">Visão agregada · 1 link</span>
        <span className="inline-flex items-center gap-1 text-[12px] font-semibold group-hover:gap-1.5 transition-all" style={{ color: accent }}>
          Ver relatório
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </span>
      </div>
    </a>
  );
}

const TACTIC_LABEL = { O2O: "O2O", OOH: "OOH", GROUNDFLOW: "Groundflow" };
function ProductChip({ t }) {
  return (
    <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded-md bg-surface-strong text-fg-muted">
      {TACTIC_LABEL[t] || t}
    </span>
  );
}

const FEATURE_LABEL = { survey: "Survey", rmnd: "RMND", pdooh: "PDOOH" };
function FeatureChip({ f, accent }) {
  return (
    <span
      className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded-md"
      style={{ background: `color-mix(in srgb, ${accent} 16%, transparent)`, color: accent }}
    >
      {FEATURE_LABEL[f] || f}
    </span>
  );
}

function AggregatedBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded-md bg-surface-strong text-fg-muted">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
      Agregado
    </span>
  );
}

function Metric({ label, value, valueClass = "text-fg", title }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle leading-none">{label}</div>
      <div className={cn("mt-1.5 text-[15px] font-semibold tabular-nums leading-none truncate", valueClass)} title={title}>
        {value}
      </div>
    </div>
  );
}

const STATUS_META = {
  in_flight: { label: "Ativa", accent: true },
  paused: { label: "Pausada", tone: "text-warning", dot: "var(--color-warning)" },
  awaiting_closure: { label: "Encerrando", tone: "text-fg-muted", dot: "var(--color-fg-subtle)" },
  ended: { label: "Encerrada", tone: "text-fg-subtle", dot: "var(--color-fg-subtle)" },
};

function StatusPill({ status, accent }) {
  const meta = STATUS_META[status] || STATUS_META.ended;
  const useAccent = meta.accent;
  return (
    <span
      className={cn("shrink-0 inline-flex items-center gap-1.5 text-[11px] font-medium whitespace-nowrap", !useAccent && meta.tone)}
      style={useAccent ? { color: accent } : undefined}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: useAccent ? accent : meta.dot }} />
      {meta.label}
    </span>
  );
}

function SearchInput({ value, onChange }) {
  // Mesma linguagem visual do SegmentedControlV2: h-10, rounded-lg,
  // bg-canvas-deeper + border-border (controles cohesos lado a lado).
  return (
    <div className="relative w-full sm:w-64">
      <svg
        className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none"
        width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Buscar campanha…"
        className="w-full h-10 pl-9 pr-3 rounded-lg bg-canvas-deeper border border-border text-[13px] text-fg placeholder:text-fg-subtle focus:outline-none focus:border-signature focus:ring-2 focus:ring-signature/20 transition-colors"
      />
    </div>
  );
}

function EmptyState({ query, filtered }) {
  return (
    <div className="rounded-2xl bg-surface py-16 px-6 text-center">
      <p className="text-sm text-fg-muted">
        {query ? (
          <>Nenhuma campanha encontrada para “<span className="text-fg font-medium">{query}</span>”.</>
        ) : filtered ? (
          "Nenhuma campanha com os filtros atuais."
        ) : (
          "Nenhuma campanha disponível ainda."
        )}
      </p>
    </div>
  );
}

// Tab primária do portal (Campanhas × Analytics). Underline na cor da marca
// quando ativa — mesmo idioma das tabs do report, mantendo o minimalismo.
function PortalTab({ active, onClick, accent, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative px-1 pb-2.5 pt-1 text-[14px] font-semibold transition-colors",
        active ? "text-fg" : "text-fg-subtle hover:text-fg-muted",
      )}
    >
      {children}
      {active && (
        <span
          className="absolute left-0 right-0 -bottom-px h-[2px] rounded-full"
          style={{ background: accent || "var(--color-signature)" }}
          aria-hidden
        />
      )}
    </button>
  );
}

// ── Gate de senha (público) ───────────────────────────────────────────────────
// Mesmo "fundo bonito" da tela de senha dos reports (dot-grid + vinheta + glow
// + card glassmorphism). Sempre dark pra um look premium client-facing.
const PW_DARK = "#1C262F";
const PW_BLUE = "#3397B9";
const PW_BLUE_DARK = "#246C84";
const PW_WHITE = "#F5F7FA";

function PortalPasswordScreen({ shareId, onUnlock }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [errorMsg, setErrorMsg] = useState("Senha inválida. Tente novamente.");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    if (e) e.preventDefault();
    if (!password.trim() || submitting) return;
    setSubmitting(true);
    setError(false);
    const res = await resolveClientShare({ share_id: shareId, password: password.trim() });
    if (res.ok) {
      onUnlock();
    } else {
      setErrorMsg(
        res.inactive
          ? "Este portal está desativado. Fale com seu contato na HYPR."
          : "Senha inválida. Tente novamente.",
      );
      setError(true);
      setSubmitting(false);
      setTimeout(() => setError(false), 3500);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh", width: "100%", display: "flex", alignItems: "center",
        justifyContent: "center", padding: 24, position: "relative", overflow: "hidden",
        background: PW_DARK,
      }}
    >
      {/* Dot grid sutil em azul brand */}
      <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(rgba(51,151,185,0.32) 1.2px, transparent 1.2px)", backgroundSize: "22px 22px", pointerEvents: "none" }} />
      {/* Vinheta — foco no card */}
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 70% 60% at center, transparent 0%, ${PW_DARK}d9 80%)`, pointerEvents: "none" }} />
      {/* Glow atrás do card */}
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 40% 35% at center, ${PW_BLUE}1f 0%, transparent 60%)`, pointerEvents: "none" }} />

      <form
        onSubmit={submit}
        className="animate-fade-in"
        style={{
          position: "relative", zIndex: 10, background: "rgba(28,38,47,0.45)",
          backdropFilter: "blur(32px) saturate(1.2)", WebkitBackdropFilter: "blur(32px) saturate(1.2)",
          border: `1px solid ${error ? "rgba(231,76,60,0.4)" : "rgba(255,255,255,0.08)"}`,
          borderRadius: 20, padding: "52px 44px", maxWidth: 400, width: "100%", textAlign: "center",
          boxShadow: "0 24px 80px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
          transition: "border-color 0.3s",
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 36, color: PW_WHITE }}>
          <HyprReportCenterLogo height={32} />
        </div>
        <p style={{ color: "rgba(229,235,242,0.7)", fontSize: 13, marginBottom: 32, lineHeight: 1.7 }}>
          Insira a senha de acesso fornecida<br />pela equipe HYPR para ver seus relatórios.
        </p>
        <input
          aria-label="Senha de acesso"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(false); }}
          placeholder="Senha de acesso"
          disabled={submitting}
          style={{
            width: "100%", background: "rgba(255,255,255,0.04)",
            border: `1px solid ${error ? "rgba(231,76,60,0.5)" : "rgba(255,255,255,0.10)"}`,
            borderRadius: 12, padding: "15px 16px", color: PW_WHITE, fontSize: 15, fontWeight: 600,
            letterSpacing: 2, textAlign: "center", outline: "none", marginBottom: 14,
            transition: "border-color 0.2s, background 0.2s", opacity: submitting ? 0.6 : 1,
          }}
          onFocus={(e) => { if (!error) e.currentTarget.style.borderColor = "rgba(255,255,255,0.20)"; e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
          onBlur={(e) => { if (!error) e.currentTarget.style.borderColor = "rgba(255,255,255,0.10)"; e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
        />
        {error && <p style={{ color: "rgba(231,76,60,0.85)", fontSize: 12, marginBottom: 14, fontWeight: 500 }}>{errorMsg}</p>}
        <button
          type="submit"
          disabled={submitting || !password.trim()}
          style={{
            width: "100%", background: PW_BLUE, color: PW_WHITE, border: "none", padding: "15px",
            borderRadius: 12, cursor: submitting ? "wait" : "pointer", fontSize: 14, fontWeight: 600,
            letterSpacing: 0.3, opacity: submitting || !password.trim() ? 0.7 : 1,
            transition: "background 0.2s, transform 0.1s",
          }}
          onMouseEnter={(e) => { if (!submitting) e.currentTarget.style.background = PW_BLUE_DARK; }}
          onMouseLeave={(e) => { if (!submitting) e.currentTarget.style.background = PW_BLUE; }}
        >
          {submitting ? "Validando…" : "Acessar relatórios"}
        </button>
      </form>
    </div>
  );
}

// ── Tela de mensagem (loading / erro / not found) ─────────────────────────────
function PortalMessage({ title, body, spinner = false, action = null }) {
  return (
    <div className="min-h-screen w-full bg-canvas text-fg flex items-center justify-center px-4">
      <div className="text-center max-w-sm">
        <div className="flex justify-center mb-5">
          <HyprReportCenterLogo height={22} />
        </div>
        {spinner && (
          <div
            className="mx-auto mb-4 w-6 h-6 rounded-full border-2 border-border border-t-signature animate-spin"
            aria-hidden
          />
        )}
        <h1 className="text-lg font-bold leading-tight">{title}</h1>
        <p className="text-[13px] text-fg-muted mt-1.5">{body}</p>
        {action}
      </div>
    </div>
  );
}
