// src/v2/admin/components/CampaignCardV2.jsx
//
// Card de campanha do menu admin V2.
//
// Layout em colunas semânticas com larguras FIXAS — alinhamento
// vertical entre cards é prioridade (operação faz scan vertical na
// lista, valores precisam ficar na mesma posição X em todas as linhas).
//
//   [stripe 3px de saúde]
//   [marca + campanha + datas (flex)]
//   │
//   [PACING (DSP row + VID row)]   ← 2 linhas próprias, separadas
//   │
//   [RESULTADOS (CTR row + VTR row)]
//   │
//   [avatares (slot fixo) + CTA (min-width fixo)]
//
// Decisões de design:
//   • DSP e VID viram LINHAS próprias (label + valor + mini-bar) em vez
//     de um valor primário com VID inline. Operação leu visualmente como
//     "uma métrica" o que era duas — ruim pra atuação.
//   • Slot dos avatares tem largura fixa (justify-end) pra que o botão
//     "Ver Report" / "Histórico" não dance entre linhas com 0/1/2 owners.
//   • Botão tem min-width fixo pra Histórico (encerrada, mais curto)
//     não desalinhar com Ver Report.
//   • Mini-bar por linha (não uma só pra "primary") porque DSP e VID
//     têm pacings independentes e valem visualizações independentes.
//   • Cabeçalhos "PACING" / "RESULTADOS" foram removidos — DSP/VID/CTR/VTR
//     já são labels familiares, e o cabeçalho dobrava altura sem ganho.
//
// Click no card → drawer (`onOpen`). Click "Ver Report" → report
// (`onOpenReport`). Stop propagation no botão pra não abrir o drawer.

import { cn } from "../../../ui/cn";
import { Card } from "../../../ui/Card";
import { Avatar } from "../../../ui/Avatar";
import { TokenChip } from "./TokenChip";
import {
  formatDateRange,
  formatPacingValue,
  formatPct,
  formatBRL,
  pacingColorClass,
  ctrColorClass,
  vtrColorClass,
  ecpmBgClass,
  isCampaignEnded,
  localPartFromEmail,
} from "../lib/format";
import { schedulePrefetch, cancelPrefetch } from "../../../lib/prefetchReport";

// Mapas health → classe de cor. Mesma régua de format.js (pacing tiers),
// reaproveitada pra stripe lateral e fill da barra de pacing.
const HEALTH_BAR = {
  healthy:   "bg-success",
  over:      "bg-signature",
  attention: "bg-warning",
  critical:  "bg-danger",
  ended:     "bg-fg-subtle/30",
};

/** Tier de UMA pacing isolada (pra colorir a barra dela especificamente). */
function pacingTier(pacing) {
  if (pacing == null || isNaN(pacing)) return null;
  if (pacing < 90)  return "critical";
  if (pacing < 100) return "attention";
  if (pacing < 125) return "healthy";
  return "over";
}

/**
 * Health do card = pior pacing entre DSP e VID.
 *
 * Severidade descendente: critical > attention > healthy > over.
 * Se uma métrica está crítica e a outra over, mostra crítico (a pior
 * cor ganha). Quando há mistura entre healthy e over, prefere healthy
 * (leitura conservadora — azul é destaque, não default).
 */
function classifyHealth(displayPacing, videoPacing) {
  const cands = [];
  if (displayPacing != null) cands.push(Number(displayPacing));
  if (videoPacing   != null) cands.push(Number(videoPacing));
  if (!cands.length) return null;
  const tiers = cands.map(pacingTier);
  for (const t of ["critical", "attention", "healthy", "over"]) {
    if (tiers.includes(t)) return t;
  }
  return "healthy";
}

export function CampaignCardV2({
  campaign,
  onOpen,
  onOpenReport,
  teamMap = {},
}) {
  const {
    short_token,
    client_name,
    campaign_name,
    start_date,
    end_date,
    display_pacing,
    video_pacing,
    display_ctr,
    video_vtr,
    cp_email,
    cs_email,
    // ADMIN-ONLY — custo cru/impressions × 1000. Backend só envia este
    // campo em endpoints admin-gated; quando ausente (campanha sem dado
    // de custo no DSP), a coluna mostra "—" mantendo o alinhamento.
    admin_ecpm,
    // Merge Reports — quando presente, indica que o token pertence a um
    // grupo unificado. UI sinaliza com badge discreto no header do card.
    merge_id,
  } = campaign;

  const ended  = isCampaignEnded(end_date);
  const health = ended ? "ended" : classifyHealth(display_pacing, video_pacing);
  const cpName = cp_email ? (teamMap[cp_email] || localPartFromEmail(cp_email)) : null;
  const csName = cs_email ? (teamMap[cs_email] || localPartFromEmail(cs_email)) : null;

  return (
    <Card
      className={cn(
        "relative overflow-hidden cursor-pointer group",
        "transition-all duration-150",
        "hover:border-signature/40 hover:bg-surface hover:shadow-sm",
        ended && "opacity-65"
      )}
      onClick={() => onOpen?.(campaign)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(campaign);
        }
      }}
      // Prefetch do report quando o cursor entra no card. O gap natural
      // entre hover e click (~200-400ms) cobre o RTT do fetch e deixa
      // a abertura do report instantânea quando o user clica.
      onMouseEnter={() => schedulePrefetch(short_token)}
      onMouseLeave={() => cancelPrefetch(short_token)}
      onFocus={() => schedulePrefetch(short_token)}
    >
      {/* Stripe lateral de status — substitui o dot, escala em scan rápido */}
      {health && (
        <span
          aria-hidden
          className={cn(
            "absolute left-0 top-0 bottom-0 w-[3px]",
            HEALTH_BAR[health]
          )}
          title={`Status: ${health}`}
        />
      )}

      <div className="flex items-stretch gap-4 px-5 py-3.5">
        {/* ── Marca + campanha + datas ─────────────────────────────── */}
        <div className="min-w-0 flex-1 self-center">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-bold text-fg tracking-tight truncate leading-none">
              {client_name}
            </h3>
            <TokenChip token={short_token} variant="card" />
            {merge_id && <MergedBadge />}
            {ended && (
              <span className="text-[9px] uppercase tracking-widest font-bold text-fg-subtle">
                encerrada
              </span>
            )}
          </div>
          <p className="text-[12.5px] text-fg-muted mt-1 truncate leading-snug">
            {campaign_name}
          </p>
          <p className="text-[10.5px] text-fg-subtle mt-0.5 tabular-nums">
            {formatDateRange(start_date, end_date)}
          </p>
        </div>

        <Divider />

        {/* ── eCPM REAL (admin-only, destaque) ─────────────────────────
            Coluna com bg pastel sinalizando o tier (verde/amarelo/vermelho
            soft do design system, alpha 0.15 → naturalmente pastel).
            Texto fica neutro — a cor do box é que comunica saúde, deixa
            o número clean. Encerrada vira bg-surface neutro pra não
            alarmar campanha histórica. Quando admin_ecpm é null mostra
            "—" pra manter alinhamento entre linhas. */}
        <div
          className={cn(
            "hidden md:flex flex-col justify-center shrink-0 w-[96px]",
            "px-2.5 py-1.5 rounded-md transition-colors",
            ended ? "bg-surface" : ecpmBgClass(admin_ecpm)
          )}
        >
          <div className="flex items-baseline gap-1 leading-none">
            <span className="text-[9px] uppercase tracking-[0.14em] font-bold text-fg-muted">
              eCPM
            </span>
            <span
              className="text-[7.5px] uppercase tracking-widest font-semibold text-fg-subtle/70"
              title="Custo bruto do DSP / impressions × 1000 — não exibir para o cliente"
            >
              adm
            </span>
          </div>
          <span className={cn(
            "text-[14px] font-bold tabular-nums tracking-tight mt-1",
            ended ? "text-fg-subtle" : "text-fg"
          )}>
            {formatBRL(admin_ecpm)}
          </span>
        </div>

        <Divider />

        {/* ── PACING (DSP row + VID row, separados) ────────────────── */}
        <div className="hidden md:flex flex-col justify-center gap-2 shrink-0 w-[160px]">
          <PacingRow label="DSP" pacing={display_pacing} ended={ended} />
          <PacingRow label="VID" pacing={video_pacing}   ended={ended} />
        </div>

        <Divider />

        {/* ── RESULTADOS (CTR + VTR) ───────────────────────────────── */}
        <div className="hidden md:flex flex-col justify-center gap-2 shrink-0 w-[90px]">
          <ResultRow
            label="CTR"
            value={display_ctr != null ? formatPct(display_ctr, 2) : null}
            colorClass={ended ? "text-fg-subtle" : (display_ctr != null ? ctrColorClass(display_ctr) : "text-fg-subtle")}
          />
          <ResultRow
            label="VTR"
            value={video_vtr != null ? formatPct(video_vtr, 1) : null}
            colorClass={ended ? "text-fg-subtle" : (video_vtr != null ? vtrColorClass(video_vtr) : "text-fg-subtle")}
          />
        </div>

        <Divider />

        {/* ── Owners (slot fixo) + CTA (min-w fixo) ────────────────── */}
        <div className="flex items-center gap-3 shrink-0 self-center">
          {/* Slot fixo 44px com justify-end: vazio, 1 ou 2 avatares,
           *  o botão fica sempre no mesmo X. */}
          <div className="hidden sm:flex w-11 justify-end items-center">
            {cpName && <Avatar name={cpName} role="cp" size="sm" title={`CP: ${cpName}`} />}
            {csName && <Avatar name={csName} role="cs" size="sm" className={cpName ? "-ml-1.5" : ""} title={`CS: ${csName}`} />}
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenReport?.(short_token);
            }}
            className={cn(
              "inline-flex items-center justify-center gap-1 h-8 px-3 rounded-md text-xs font-semibold",
              "min-w-[108px] transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
              ended
                // Encerrada: botão neutro/soft (leitura histórica, não operação)
                ? "bg-surface text-fg-muted border border-border hover:bg-surface-strong hover:text-fg"
                // Em vôo: CTA primário signature
                : "bg-signature text-white hover:bg-signature-hover"
            )}
          >
            {ended ? "Histórico" : "Ver Report"}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>
      </div>
    </Card>
  );
}

/** Divisor vertical entre colunas. Some no mobile (md:block). */
function Divider() {
  return <div className="w-px bg-border self-stretch hidden md:block" />;
}

/**
 * Badge "AGRUPADO" — pinta no header do card pra deixar claro que esse
 * token faz parte de um grupo. Sutil (signature soft, não gritando)
 * porque a campanha continua existindo enquanto admin — só o report
 * público é que é unificado.
 */
function MergedBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold text-signature px-1.5 py-0.5 rounded bg-signature/8 border border-signature/30"
      title="Pertence a um grupo — o link do report unifica os tokens"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6"  cy="6"  r="2.5" />
        <circle cx="6"  cy="18" r="2.5" />
        <circle cx="18" cy="12" r="2.5" />
        <path d="M9 6c4 0 6 2 6 6M9 18c4 0 6-2 6-6" />
      </svg>
      agrupado
    </span>
  );
}

/** Linha de pacing: label fixo · valor fixo · mini-barra fluida.
 *
 *  Larguras de label e valor são fixas pra DSP e VID alinharem
 *  verticalmente. A barra ocupa o restante da coluna até o divisor.
 *  Quando não há valor: mostra "—" e oculta a barra (não há o que medir). */
function PacingRow({ label, pacing, ended }) {
  const has = pacing != null && !isNaN(pacing);
  const tier = ended ? "ended" : pacingTier(pacing);
  const colorClass = ended
    ? "text-fg-subtle"
    : (has ? pacingColorClass(pacing) : "text-fg-subtle");
  return (
    <div className="flex items-center gap-2 leading-none">
      <span className="text-[9px] uppercase tracking-[0.14em] font-semibold text-fg-subtle w-7 shrink-0">
        {label}
      </span>
      <span className={cn("text-[13px] font-bold tabular-nums w-12 shrink-0 text-right", colorClass)}>
        {has ? formatPacingValue(pacing) : "—"}
      </span>
      {has && <PacingBar pacing={pacing} tier={tier} />}
    </div>
  );
}

/** Linha CTR/VTR: label tiny + valor à direita. Largura controlada
 *  pelo container (~90px) — value sempre alinhado na borda direita. */
function ResultRow({ label, value, colorClass }) {
  return (
    <div className="flex items-baseline gap-2 leading-none">
      <span className="text-[9px] uppercase tracking-[0.14em] font-semibold text-fg-subtle w-7 shrink-0">
        {label}
      </span>
      <span className={cn("text-[13px] font-bold tabular-nums flex-1 text-right", colorClass)}>
        {value ?? "—"}
      </span>
    </div>
  );
}

/** Barra horizontal de pacing.
 *   - Track cinza sutil (bg-fg-subtle/15 — funciona em light e dark).
 *   - Fill colorido pelo tier do próprio valor.
 *   - Tick vertical em 100% (target) — sempre na ponta direita.
 *   - Pacing >100% → barra cheia (capada visualmente). A cor azul (over)
 *     já comunica que excedeu; o número exato fica no valor textual.
 *   - flex-1 pra ocupar o restante da coluna depois de label+value. */
function PacingBar({ pacing, tier }) {
  if (pacing == null || isNaN(pacing)) return null;
  const fillPct = Math.min(100, Math.max(0, Number(pacing)));
  return (
    <div
      className="relative h-[3px] flex-1 min-w-[40px] rounded-full bg-fg-subtle/15 overflow-visible"
      role="progressbar"
      aria-valuenow={Math.round(pacing)}
      aria-valuemin={0}
      aria-valuemax={125}
      aria-label="Pacing"
    >
      <span
        className={cn("absolute inset-y-0 left-0 rounded-full", HEALTH_BAR[tier])}
        style={{ width: `${fillPct}%` }}
      />
      <span
        aria-hidden
        className="absolute right-0 top-[-2px] bottom-[-2px] w-px bg-fg-subtle/45"
      />
    </div>
  );
}
