// src/v2/admin/components/PerformerDrawer.jsx
//
// Drawer "Onde estou ganhando/perdendo" — abre ao clicar numa row do
// Top Performers. Foco em ação visual: o user deve enxergar de relance
// onde mexer, sem precisar ler texto corrido.
//
// Estrutura:
//   ┌─────────────────────────────────────────────┐
//   │ Nome                                        │
//   │ N campanhas · email                         │
//   ├─────────────────────────────────────────────┤
//   │ SCORE — barra grande + delta vs time        │
//   ├─────────────────────────────────────────────┤
//   │ 🎯 ONDE TEM MAIS A GANHAR                   │
//   │   Cards de campanha com:                    │
//   │   • borda esquerda colorida por severidade  │
//   │   • 4 mini-pills (P/e/C/V) com cor por sts  │
//   │   • diagnóstico curto e CTA                 │
//   ├─────────────────────────────────────────────┤
//   │ BREAKDOWN — 4 barras com ícones             │
//   ├─────────────────────────────────────────────┤
//   │ vs TIME — 4 deltas alinhados                │
//   └─────────────────────────────────────────────┘

import { Drawer, DrawerContent, DrawerHeader, DrawerBody } from "../../../ui/Drawer";
import { cn } from "../../../ui/cn";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function localPartFromEmail(email) {
  if (!email) return "";
  return email.split("@")[0].replace(/[._-]+/g, " ").trim();
}

function scoreTone(score) {
  if (score >= 80) return "success";
  if (score >= 60) return "signature";
  if (score >= 40) return "warning";
  return "danger";
}

// Severidade do "potencial perdido" — quanto mais pts deixados na mesa,
// mais o card chama atenção. Usado pra cor da borda lateral.
function severityTone(potential) {
  if (potential >= 10) return "danger";
  if (potential >= 5)  return "warning";
  return "signature";
}

// Tone de pill por % do max atingido. Categoria com max=0 (não aplicável,
// ex: VTR em campanha só-Display) fica neutra.
function pillTone(pts, max) {
  if (!max || max < 0.01) return "muted";
  const pct = pts / max;
  if (pct >= 0.85) return "success";
  if (pct >= 0.5)  return "warning";
  return "danger";
}

const BAR_BG = {
  success:   "bg-success",
  signature: "bg-signature",
  warning:   "bg-warning",
  danger:    "bg-danger",
  muted:     "bg-fg-subtle/30",
};

const BORDER_LEFT = {
  success:   "border-l-success",
  signature: "border-l-signature",
  warning:   "border-l-warning",
  danger:    "border-l-danger",
  muted:     "border-l-border",
};

const PILL_BG = {
  success: "bg-success-soft text-success border-success/30",
  warning: "bg-warning-soft text-warning border-warning/30",
  danger:  "bg-danger-soft text-danger border-danger/30",
  muted:   "bg-surface text-fg-subtle border-border",
};

const TEXT_TONE = {
  success:   "text-success",
  signature: "text-signature",
  warning:   "text-warning",
  danger:    "text-danger",
  fg:        "text-fg",
  muted:     "text-fg-subtle",
};

// ─── Ícones SVG inline por categoria ─────────────────────────────────────────
// Pacing: linha tipo "trend"; eCPM: cifrão; CTR: cursor/click; VTR: play.
// Mantidos pequenos (12-14px) pra encaixar dentro de pills e barras.
function PacingIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="2 11 6 7 9 10 14 4" />
      <polyline points="11 4 14 4 14 7" />
    </svg>
  );
}
function EcpmIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="8" y1="2" x2="8" y2="14" />
      <path d="M11 4.5H6.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H5" />
    </svg>
  );
}
function CtrIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3l3 8 1.5-3.5L11 6 3 3z" />
      <line x1="8" y1="8" x2="13" y2="13" />
    </svg>
  );
}
function VtrIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <polygon points="4 3 13 8 4 13" fill="currentColor" />
    </svg>
  );
}

const CATEGORY_META = {
  pacing: { label: "Pacing", short: "P", Icon: PacingIcon },
  ecpm:   { label: "eCPM",   short: "$", Icon: EcpmIcon },
  ctr:    { label: "CTR",    short: "C", Icon: CtrIcon },
  vtr:    { label: "VTR",    short: "V", Icon: VtrIcon },
};

// ─── Componentes internos ────────────────────────────────────────────────────

// Pill compacto por categoria — usa em cada card de campanha. Mostra
// pts/max e um ícone de status (✓ se cheio, ✗ se zero, ◐ se parcial).
function CategoryPill({ category, pts, max }) {
  const meta = CATEGORY_META[category];
  if (!meta) return null;
  const tone = pillTone(pts, max);
  const naCategory = !max || max < 0.01;
  const fullyAchieved = !naCategory && pts >= max - 0.5;
  const zeroAchieved = !naCategory && pts < 0.5;
  const Icon = meta.Icon;

  return (
    <div
      className={cn(
        "flex items-center gap-1 px-1.5 py-1 rounded-md border text-[10px] font-semibold tabular-nums",
        PILL_BG[tone]
      )}
      title={`${meta.label}: ${pts.toFixed(1)} de ${max.toFixed(0)} pts`}
    >
      <Icon className="size-3 shrink-0" />
      <span>
        {naCategory
          ? "—"
          : fullyAchieved
            ? `${max.toFixed(0)}/${max.toFixed(0)}`
            : zeroAchieved
              ? `0/${max.toFixed(0)}`
              : `${pts.toFixed(0)}/${max.toFixed(0)}`}
      </span>
    </div>
  );
}

// Card de campanha — destaque visual da severidade via borda lateral.
function CampaignCard({ item, onOpenReport }) {
  const { campaign, breakdown, potential } = item;
  const severityT = severityTone(potential);
  const handleOpen = () => onOpenReport?.(campaign.short_token);

  // Diagnóstico: top 2 categorias com perda. Cada uma vira uma "frase"
  // estruturada com ícone — em vez de string solta concatenada por "·".
  const topProblems = breakdown.diagnostics.slice(0, 2);

  return (
    <div
      className={cn(
        "rounded-lg border border-border border-l-4 bg-surface p-3 space-y-2.5",
        BORDER_LEFT[severityT]
      )}
    >
      {/* Header: nome + score numérico + potencial */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg truncate leading-tight">
            {campaign.campaign_name || campaign.client_name || campaign.short_token}
          </div>
          {campaign.client_name && campaign.campaign_name !== campaign.client_name && (
            <div className="text-[10px] text-fg-subtle uppercase tracking-wider mt-0.5">
              {campaign.client_name}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[11px] font-semibold text-fg-muted tabular-nums">
            {breakdown.total.toFixed(0)}
            <span className="text-fg-subtle font-normal">/{breakdown.max_total.toFixed(0)}</span>
          </div>
          {potential > 0.5 && (
            <div className={cn("text-xs font-bold tabular-nums leading-tight", TEXT_TONE[severityT])}>
              +{potential.toFixed(1)} pts
            </div>
          )}
        </div>
      </div>

      {/* 4 micro-pills de categoria */}
      <div className="grid grid-cols-4 gap-1">
        <CategoryPill category="pacing" pts={breakdown.pacing} max={breakdown.max_pacing} />
        <CategoryPill category="ecpm"   pts={breakdown.ecpm}   max={breakdown.max_ecpm} />
        <CategoryPill category="ctr"    pts={breakdown.ctr}    max={breakdown.max_ctr} />
        <CategoryPill category="vtr"    pts={breakdown.vtr}    max={breakdown.max_vtr} />
      </div>

      {/* Diagnóstico: top problemas com ícone */}
      {topProblems.length > 0 && (
        <div className="space-y-1">
          {topProblems.map((p) => {
            const meta = CATEGORY_META[p.category];
            const Icon = meta?.Icon;
            return (
              <div key={p.category} className="flex items-start gap-1.5 text-[11px] leading-snug">
                {Icon && <Icon className="size-3 shrink-0 text-fg-subtle mt-[1px]" />}
                <span className="text-fg-muted">{p.reason}</span>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={handleOpen}
        className="w-full text-[11px] font-semibold text-signature hover:underline text-left cursor-pointer"
      >
        Abrir report →
      </button>
    </div>
  );
}

// Barra de breakdown agregada do CS — uma linha por categoria, com
// ícone, label, valor e barra colorida.
function CategoryBar({ category, pts, max }) {
  const meta = CATEGORY_META[category];
  if (!meta) return null;
  const tone = pillTone(pts, max);
  const Icon = meta.Icon;
  const pct = max > 0.01 ? Math.min(100, (pts / max) * 100) : 0;
  const naCategory = !max || max < 0.01;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Icon className={cn("size-3.5", TEXT_TONE[tone] || "text-fg-subtle")} />
          <span className="text-[11px] uppercase tracking-wider font-bold text-fg">
            {meta.label}
          </span>
        </div>
        <span className={cn("text-xs font-semibold tabular-nums", TEXT_TONE[tone])}>
          {naCategory ? "—" : (
            <>
              {pts.toFixed(1)} <span className="text-fg-subtle font-normal">/ {max.toFixed(0)}</span>
            </>
          )}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-strong overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-300", BAR_BG[tone])}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
    </div>
  );
}

// Linha "vs Time" — você (esquerda) vs média do time (direita), com seta.
function TeamDelta({ category, you, team }) {
  const meta = CATEGORY_META[category];
  if (!meta || you == null || team == null) {
    return (
      <div className="flex items-center justify-between gap-2 py-1.5">
        <div className="flex items-center gap-1.5">
          {meta?.Icon && <meta.Icon className="size-3 text-fg-subtle" />}
          <span className="text-xs text-fg-muted">{meta?.label || category}</span>
        </div>
        <span className="text-xs text-fg-subtle">—</span>
      </div>
    );
  }
  const delta = you - team;
  const rounded = Math.round(delta * 10) / 10;
  let tone = "muted";
  let arrow = "▬";
  if (rounded > 0.3)  { tone = "success"; arrow = "▲"; }
  else if (rounded < -0.3) { tone = "danger"; arrow = "▼"; }
  const Icon = meta.Icon;

  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3 text-fg-subtle" />
        <span className="text-xs text-fg-muted">{meta.label}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-fg-subtle tabular-nums">
          {you.toFixed(1)} <span className="opacity-60">vs {team.toFixed(1)}</span>
        </span>
        <span className={cn("text-xs font-semibold tabular-nums w-14 text-right", TEXT_TONE[tone])}>
          {arrow} {rounded > 0 ? "+" : ""}{rounded.toFixed(1)}
        </span>
      </div>
    </div>
  );
}

// ─── Componente principal ────────────────────────────────────────────────────

export function PerformerDrawer({ performer, displayName, onOpenReport, onClose }) {
  const open = !!performer;
  return (
    <Drawer open={open} onOpenChange={(v) => { if (!v) onClose?.(); }}>
      {open && (
        <DrawerContent className="sm:w-[480px]">
          <PerformerDrawerInner
            performer={performer}
            displayName={displayName}
            onOpenReport={onOpenReport}
          />
        </DrawerContent>
      )}
    </Drawer>
  );
}

function PerformerDrawerInner({ performer, displayName, onOpenReport }) {
  const name = displayName || localPartFromEmail(performer.email);
  const tone = scoreTone(performer.score);
  const bd = performer.breakdown;
  const teamAvg = performer.team_avg;
  const campaigns = performer.campaigns || [];

  // Top 5 campanhas por potencial (já vem ordenado de aggregation.js).
  const topGain = campaigns.filter((cd) => cd.potential > 0.5).slice(0, 5);

  // "Perdendo X pts" = soma do max de cada categoria menos o score atual.
  // Reflete quanto está deixando de ganhar no total.
  const totalLost = bd
    ? Math.max(0, (bd.max_pacing + bd.max_ecpm + bd.max_ctr + bd.max_vtr) - performer.score)
    : 0;

  return (
    <>
      <DrawerHeader
        title={name}
        subtitle={`${performer.campaign_count} campanha${performer.campaign_count === 1 ? "" : "s"} ativa${performer.campaign_count === 1 ? "" : "s"} · ${performer.email}`}
      />
      <DrawerBody className="space-y-5">
        {/* Score destaque com barra grande */}
        <section className="space-y-2 -mt-2">
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">
                Score atual
              </div>
              <div className={cn("text-4xl font-bold tabular-nums leading-none mt-1", TEXT_TONE[tone])}>
                {Math.round(performer.score)}
                <span className="text-fg-subtle text-lg font-normal"> / 100</span>
              </div>
            </div>
            {totalLost > 0.5 && (
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">
                  Perdendo
                </div>
                <div className="text-xl font-bold text-danger tabular-nums leading-none mt-1">
                  {totalLost.toFixed(1)} <span className="text-sm font-normal">pts</span>
                </div>
              </div>
            )}
          </div>
          <div className="h-2 rounded-full bg-surface-strong overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all duration-500", BAR_BG[tone])}
              style={{ width: `${Math.max(2, performer.score)}%` }}
            />
          </div>
        </section>

        {/* SEÇÃO 1: Onde tem mais a ganhar */}
        {topGain.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-[11px] uppercase tracking-widest font-bold text-fg flex items-center gap-1.5">
              <TargetIcon className="size-3.5 text-signature" />
              Onde tem mais a ganhar
            </h3>
            <p className="text-[11px] text-fg-subtle leading-snug">
              Campanhas ordenadas por <strong>potencial de ganho</strong> (gap × share
              de impressões). Borda vermelha = mais alavancagem.
            </p>
            <div className="space-y-2">
              {topGain.map((item) => (
                <CampaignCard
                  key={item.campaign.short_token}
                  item={item}
                  onOpenReport={onOpenReport}
                />
              ))}
            </div>
          </section>
        )}

        {/* SEÇÃO 2: Breakdown geral */}
        {bd && (
          <section className="space-y-3">
            <h3 className="text-[11px] uppercase tracking-widest font-bold text-fg">
              Breakdown geral
            </h3>
            <div className="space-y-3">
              <CategoryBar category="pacing" pts={bd.pacing_pts} max={bd.max_pacing} />
              <CategoryBar category="ecpm"   pts={bd.ecpm_pts}   max={bd.max_ecpm} />
              <CategoryBar category="ctr"    pts={bd.ctr_pts}    max={bd.max_ctr} />
              <CategoryBar category="vtr"    pts={bd.vtr_pts}    max={bd.max_vtr} />
            </div>
            <p className="text-[10px] text-fg-subtle leading-snug">
              Pts médios ponderados por impressões. O máximo varia conforme o mix
              das suas campanhas — VTR só se aplica a Video.
            </p>
          </section>
        )}

        {/* SEÇÃO 3: vs Time */}
        {bd && teamAvg && (
          <section className="space-y-2">
            <h3 className="text-[11px] uppercase tracking-widest font-bold text-fg">
              vs Time
            </h3>
            <div className="rounded-lg border border-border bg-surface px-3 divide-y divide-border/40">
              <TeamDelta category="pacing" you={bd.pacing_pts} team={teamAvg.pacing_pts} />
              <TeamDelta category="ecpm"   you={bd.ecpm_pts}   team={teamAvg.ecpm_pts} />
              <TeamDelta category="ctr"    you={bd.ctr_pts}    team={teamAvg.ctr_pts} />
              <TeamDelta category="vtr"    you={bd.vtr_pts}    team={teamAvg.vtr_pts} />
            </div>
          </section>
        )}
      </DrawerBody>
    </>
  );
}

// Ícone do "alvo" (target) usado como decoração da seção 1.
function TargetIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="3" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}
