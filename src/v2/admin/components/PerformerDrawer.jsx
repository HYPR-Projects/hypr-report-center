// src/v2/admin/components/PerformerDrawer.jsx
//
// Drawer "Onde estou ganhando/perdendo" — abre ao clicar numa row do
// Top Performers. Foco em ação: top campanhas com maior potencial de
// ganho aparecem primeiro, com link direto pra abrir o report.
//
// Estrutura do drawer:
//   ┌─────────────────────────────────────────────┐
//   │ Nome                          [score / 100] │
//   │ N campanhas ativas · email                  │
//   ├─────────────────────────────────────────────┤
//   │ 🎯 ONDE VOCÊ TEM MAIS A GANHAR             │
//   │   Lista de campanhas ordenadas por          │
//   │   potential (gap × share de impressões),    │
//   │   com top diagnóstico e botão "Abrir report"│
//   ├─────────────────────────────────────────────┤
//   │ BREAKDOWN DE PONTOS                         │
//   │   4 barras: Pacing / eCPM / CTR / VTR       │
//   │   X / max  com cor por % preenchido         │
//   ├─────────────────────────────────────────────┤
//   │ vs TIME                                     │
//   │   Delta de pts em cada categoria            │
//   └─────────────────────────────────────────────┘
//
// Recebe `performer` direto do output de computeTopPerformers — já vem
// com .breakdown, .campaigns (ordenado por potential desc) e .team_avg.

import { Drawer, DrawerContent, DrawerHeader, DrawerBody } from "../../../ui/Drawer";
import { cn } from "../../../ui/cn";

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

const BAR_BG = {
  success:   "bg-success",
  signature: "bg-signature",
  warning:   "bg-warning",
  danger:    "bg-danger",
};

const TEXT_TONE = {
  success:   "text-success",
  signature: "text-signature",
  warning:   "text-warning",
  danger:    "text-danger",
  fg:        "text-fg",
  muted:     "text-fg-subtle",
};

// Tone pra barra de breakdown — % de pontos atingidos sobre o max realista.
function fillTone(pts, max) {
  if (!max || max < 0.01) return "muted";
  const pct = pts / max;
  if (pct >= 0.85) return "success";
  if (pct >= 0.6)  return "signature";
  if (pct >= 0.3)  return "warning";
  return "danger";
}

function CategoryBar({ label, pts, max }) {
  const tone = fillTone(pts, max);
  const pct = max > 0.01 ? Math.min(100, (pts / max) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wider font-bold text-fg-subtle">
          {label}
        </span>
        <span className={cn("text-xs font-semibold tabular-nums", TEXT_TONE[tone])}>
          {pts.toFixed(1)} <span className="text-fg-subtle font-normal">/ {max.toFixed(0)}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-strong overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-300", BAR_BG[tone] || "bg-surface")}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
    </div>
  );
}

function CampaignCard({ item, onOpenReport }) {
  const { campaign, breakdown, potential } = item;
  const top = breakdown.diagnostics[0]; // razão de maior perda
  const handleOpen = () => onOpenReport?.(campaign.short_token);

  return (
    <div className="rounded-lg border border-border bg-surface p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg truncate">
            {campaign.campaign_name || campaign.client_name || campaign.short_token}
          </div>
          {campaign.client_name && campaign.campaign_name !== campaign.client_name && (
            <div className="text-[11px] text-fg-subtle truncate">{campaign.client_name}</div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-xs font-semibold text-fg-muted tabular-nums">
            {breakdown.total.toFixed(0)}/{breakdown.max_total.toFixed(0)}
          </div>
          {potential > 0.5 && (
            <div className="text-[10px] font-bold text-signature tabular-nums">
              +{potential.toFixed(1)} pts
            </div>
          )}
        </div>
      </div>
      {top && (
        <div className="text-[11px] text-fg-muted leading-snug">
          <span className="font-semibold uppercase tracking-wider text-fg-subtle text-[10px] mr-1">
            {top.category}:
          </span>
          {top.reason}
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

function TeamDelta({ label, you, team }) {
  if (you == null || team == null) {
    return (
      <div className="flex items-center justify-between gap-2 py-1">
        <span className="text-xs text-fg-muted">{label}</span>
        <span className="text-xs text-fg-subtle">—</span>
      </div>
    );
  }
  const delta = you - team;
  const rounded = Math.round(delta * 10) / 10;
  let tone = "muted";
  let arrow = "▬";
  if (rounded > 0.1)  { tone = "success"; arrow = "▲"; }
  else if (rounded < -0.1) { tone = "danger"; arrow = "▼"; }
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-xs text-fg-muted">{label}</span>
      <span className={cn("text-xs font-semibold tabular-nums", TEXT_TONE[tone])}>
        {arrow} {Math.abs(rounded).toFixed(1)} pts
        <span className="text-fg-subtle font-normal ml-1">
          ({you.toFixed(1)} vs {team.toFixed(1)} média)
        </span>
      </span>
    </div>
  );
}

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
            onClose={onClose}
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

  // Top 5 campanhas com maior potencial de ganho. Filtra fora as com
  // potential ~0 (já no teto).
  const topGain = campaigns.filter((cd) => cd.potential > 0.5).slice(0, 5);
  // Pontos totais que ele está deixando na mesa (somando todas).
  const totalLost = bd
    ? Math.max(0, (bd.max_pacing + bd.max_ecpm + bd.max_ctr + bd.max_vtr) - performer.score)
    : 0;

  return (
    <>
      <DrawerHeader
        title={name}
        subtitle={`${performer.campaign_count} campanha${performer.campaign_count === 1 ? "" : "s"} ativa${performer.campaign_count === 1 ? "" : "s"} · ${performer.email}`}
      />
      <DrawerBody className="space-y-6">
        {/* Score destaque */}
        <div className="flex items-baseline justify-between gap-2 -mt-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">
              Score atual
            </div>
            <div className={cn("text-3xl font-bold tabular-nums leading-tight", TEXT_TONE[tone])}>
              {Math.round(performer.score)}
              <span className="text-fg-subtle text-base font-normal"> / 100</span>
            </div>
          </div>
          {totalLost > 0.5 && (
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">
                Perdendo
              </div>
              <div className="text-lg font-bold text-danger tabular-nums">
                {totalLost.toFixed(1)} pts
              </div>
            </div>
          )}
        </div>

        {/* SEÇÃO 1: Onde tem mais a ganhar */}
        {topGain.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="text-[11px] uppercase tracking-widest font-bold text-fg">
                Onde você tem mais a ganhar
              </h3>
            </div>
            <p className="text-[11px] text-fg-subtle leading-snug">
              Campanhas ordenadas por <strong>potencial de ganho</strong> (gap × share
              de impressões). Mexer aqui rende mais que mexer numa campanha menor.
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
              Breakdown de pontos
            </h3>
            <div className="space-y-3">
              <CategoryBar label="Pacing"   pts={bd.pacing_pts} max={bd.max_pacing} />
              <CategoryBar label="eCPM"     pts={bd.ecpm_pts}   max={bd.max_ecpm} />
              <CategoryBar label="CTR"      pts={bd.ctr_pts}    max={bd.max_ctr} />
              <CategoryBar label="VTR"      pts={bd.vtr_pts}    max={bd.max_vtr} />
            </div>
            <p className="text-[10px] text-fg-subtle leading-snug">
              Pontos médios ponderados por impressões. O máximo varia conforme o mix
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
            <div className="rounded-lg border border-border bg-surface p-3 divide-y divide-border/40">
              <TeamDelta label="Pacing" you={bd.pacing_pts} team={teamAvg.pacing_pts} />
              <TeamDelta label="eCPM"   you={bd.ecpm_pts}   team={teamAvg.ecpm_pts} />
              <TeamDelta label="CTR"    you={bd.ctr_pts}    team={teamAvg.ctr_pts} />
              <TeamDelta label="VTR"    you={bd.vtr_pts}    team={teamAvg.vtr_pts} />
            </div>
          </section>
        )}
      </DrawerBody>
    </>
  );
}
