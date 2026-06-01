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

import { useEffect, useRef } from "react";
import { cn } from "../../../ui/cn";
import { Card } from "../../../ui/Card";
import { Avatar } from "../../../ui/Avatar";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../ui/Tooltip";
import { TokenChip } from "./TokenChip";
import {
  formatPacingValue,
  formatPct,
  formatBRL,
  pacingColorClass,
  ctrColorClass,
  vtrColorClass,
  ecpmBgClass,
  techCostToneClass,
  getCampaignStatus,
  getDateRangeParts,
  endUrgencyClass,
  isEarlyEnded,
  isRecentlyStarted,
  localPartFromEmail,
} from "../lib/format";
import { schedulePrefetch, cancelPrefetch } from "../../../lib/prefetchReport";
import { useCachedAccessSummary } from "../lib/accessSummaryCache";
import { useFrenteBreakdown } from "../lib/useFrenteBreakdown";

// Mapas health → classe de cor. Mesma régua de format.js (pacing tiers),
// reaproveitada pra stripe lateral e fill da barra de pacing.
// `awaiting` = campanha terminou mas precisa de fechamento manual — stripe
// âmbar puxa atenção do admin sem alarmar como crítico.
// `paused` = pausa temporária — signature azul comunica "congelada,
// vai voltar" sem virar alarme.
const HEALTH_BAR = {
  healthy:   "bg-success",
  over:      "bg-signature",
  attention: "bg-warning",
  critical:  "bg-danger",
  awaiting:  "bg-warning",
  paused:    "bg-signature",
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
 * Health do card = pior pacing entre DSP, VID e suas sub-frentes (O2O/OOH).
 *
 * Severidade descendente: critical > attention > healthy > over.
 * Se uma métrica está crítica e a outra over, mostra crítico (a pior
 * cor ganha). Quando há mistura entre healthy e over, prefere healthy
 * (leitura conservadora — azul é destaque, não default).
 *
 * As sub-frentes (O2O/OOH por mídia) entram no mesmo pool — uma frente
 * under puxa o card pra amarelo mesmo se a média agregada está saudável.
 * Sem isso, O2O super-over esconde OOH parado e o CS perde o sinal visual.
 */
function classifyHealth(displayPacing, videoPacing, displaySubBars, videoSubBars) {
  const cands = [];
  if (displayPacing != null) cands.push(Number(displayPacing));
  if (videoPacing   != null) cands.push(Number(videoPacing));
  for (const s of displaySubBars || []) if (s.pacing != null) cands.push(Number(s.pacing));
  for (const s of videoSubBars   || []) if (s.pacing != null) cands.push(Number(s.pacing));
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
    // Split por mídia — backend recente. Quando presente, a célula eCPM
    // do card mostra DSP e VID empilhados com tier próprio (display vs
    // video tem ordem de grandeza diferente). admin_ecpm vira fallback.
    display_ecpm,
    video_ecpm,
    // Merge Reports — quando presente, indica que o token pertence a um
    // grupo unificado. UI sinaliza com badge discreto no header do card.
    merge_id,
    // Campanha 100% bonificada (todo volume é cortesia HYPR, sem custo
    // contratado). Backend emite a flag derivada de contracted_*=0 +
    // bonus_*>0. Espelha o tratamento do report público.
    is_bonus_only,
    // Brand Safety pre-bid (DV ABS / IAS) por mídia — emite só quando TRUE.
    // Card mostra um único selo "ABS" se qualquer das duas mídias tiver.
    display_has_abs,
    video_has_abs,
    // Fechamento manual (admin clicou em "Marcar como encerrada" no drawer).
    // Combinado com end_date define o estado visual do card via getCampaignStatus.
    closed_at,
    // Pausa temporária — admin clicou em "Pausar campanha" no drawer.
    // Só afeta o status enquanto end_date >= hoje. `paused_reason` é
    // admin-only e vira tooltip ao passar o mouse no badge "PAUSADA".
    paused_at,
    paused_reason,
    // Encerramento antecipado — quando setado, substitui end_date pra
    // status/display. Pacing continua usando end_date original (Opção B).
    // `early_end_reason` é admin-only e vira tooltip no badge "ANTES DO PREVISTO".
    early_end_date,
    early_end_reason,
    // Tech Cost (admin-only) — % do PI cliente consumido em custo real HYPR.
    //   numerador   = custo real DSP COM survey (admin_total_cost_full),
    //                 fallback pro sem-survey enquanto backend não tem `_full`.
    //   denominador = valor PI cliente (d_client_budget + v_client_budget),
    //                 server-side = contracted × CPM/CPCV, sem bônus.
    // Mesma conta do diagnóstico (computeFinancials) e do KPI strip, só que
    // lifetime por campanha. Campanhas 100% bonificadas / sem CPM-CPCV vêm
    // sem budget → tech cost null → célula "—".
    admin_total_cost_full,
    admin_total_cost,
    d_client_budget,
    v_client_budget,
  } = campaign;
  const has_abs = display_has_abs || video_has_abs;

  const techCostBudget = (Number(d_client_budget) || 0) + (Number(v_client_budget) || 0);
  const techCostCost   = Number(admin_total_cost_full ?? admin_total_cost);
  const techCostPct = techCostBudget > 0 && Number.isFinite(techCostCost)
    ? (techCostCost / techCostBudget) * 100
    : null;

  // Pacing por frente (O2O/OOH). Lê primeiro de `campaign.display_pacing_o2o/ooh`
  // (mandado direto pelo `?list=true`, sem flicker) e cai pro detail prefetched
  // como fallback pra deployments antigos do backend.
  const { displaySubBars, videoSubBars } = useFrenteBreakdown(short_token, campaign);

  // Dispara o prefetch assim que o card entra no viewport. Sem isso, a média
  // saudável esconde uma frente under até o user passar o mouse — a janela
  // visual deixa "tudo verde" mesmo numa campanha desbalanceada. Com IO, o
  // prefetch acontece antes de qualquer interação e o card já pinta amarelo
  // + ⚠️ no scroll. schedulePrefetch tem TTL de 50s e dedup por token, então
  // re-entradas no viewport não amplificam tráfego.
  const cardRef = useRef(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !short_token || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) schedulePrefetch(short_token);
      },
      { rootMargin: "100px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [short_token]);

  // Data efetiva pra display: early_end_date quando setada, senão end_date.
  // Pacing math (PacingRow) continua usando end_date implícito do payload.
  const effectiveEndDate = early_end_date || end_date;
  const earlyEnded = isEarlyEnded(early_end_date);

  const status  = getCampaignStatus(end_date, closed_at, paused_at, early_end_date);
  const ended   = status === "ended";
  const awaiting = status === "awaiting_closure";
  const paused  = status === "paused";
  // NEW badge: in-flight ou pausada (campanha viva) + start_date ≤ 2 dias atrás.
  // Não aparece em encerrada/awaiting — não faz sentido sinalizar "nova" em
  // campanha que já terminou.
  const isNew   = !ended && !awaiting && isRecentlyStarted(start_date);
  const health  = ended    ? "ended"
                : awaiting ? "awaiting"
                : paused   ? "paused"
                : classifyHealth(display_pacing, video_pacing, displaySubBars, videoSubBars);
  const cpName = cp_email ? (teamMap[cp_email] || localPartFromEmail(cp_email)) : null;
  const csName = cs_email ? (teamMap[cs_email] || localPartFromEmail(cs_email)) : null;

  // "Tem campanha desse formato?" — guia render condicional de DSP/VID/CTR/VTR.
  // Pacing OU métrica de resultado existindo já indica presença do formato
  // (campanha brand-new pode ter pacing sem CTR ainda, ou vice-versa em
  // edge cases). Linha some inteira quando o formato não existe, em vez
  // de mostrar "—", pra não poluir o scan com placeholders.
  const hasDisplay = display_pacing != null || display_ctr != null;
  const hasVideo   = video_pacing   != null || video_vtr   != null;

  // Linhas de eCPM a exibir na célula. Régua:
  //   • Mix (DSP + VID): mostra split (display_ecpm + video_ecpm) com tier
  //     próprio por mídia. Sem split disponível → fallback usando admin_ecpm
  //     no tier de display (rótulo neutro, sem DSP/VID).
  //   • Só display: 1 linha, sem rótulo, tier display (com ABS se aplicável).
  //   • Só vídeo: 1 linha, sem rótulo, tier video.
  // Quando label === null, a linha não mostra prefixo DSP/VID — usado pra
  // single-format ou fallback legado pra não poluir o card.
  const ecpmRows = (() => {
    if (hasDisplay && hasVideo) {
      const dVal = display_ecpm ?? null;
      const vVal = video_ecpm ?? null;
      // Se backend ainda não manda split nessa campanha, cai pra admin_ecpm
      // único (tier display — escolha conservadora) sem rótulo.
      if (dVal == null && vVal == null && admin_ecpm != null) {
        return [{ label: null, value: admin_ecpm, kind: display_has_abs ? "displayAbs" : "display" }];
      }
      return [
        { label: "DSP", value: dVal, kind: display_has_abs ? "displayAbs" : "display" },
        { label: "VID", value: vVal, kind: "video" },
      ];
    }
    if (hasDisplay) {
      return [{ label: null, value: display_ecpm ?? admin_ecpm, kind: display_has_abs ? "displayAbs" : "display" }];
    }
    if (hasVideo) {
      return [{ label: null, value: video_ecpm ?? admin_ecpm, kind: "video" }];
    }
    // Nenhum formato detectado (campanha brand-new sem dados): mostra a célula
    // vazia com "—" pra manter alinhamento entre linhas.
    return [{ label: null, value: null, kind: "display" }];
  })();
  const ecpmIsSplit = ecpmRows.length > 1;

  return (
    <Card
      ref={cardRef}
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

      {/* Layout responsivo:
          • Mobile (<md): coluna única — header (marca/campanha/datas) +
            mini-grid de KPIs em 2 cols (DSP/VID/CTR/VTR) + footer (avatares
            + CTA). Sem dividers verticais (eles seriam horizontais e
            poluiriam). Pacing/CTR/VTR ficam visíveis pro user identificar
            saúde da campanha sem precisar abrir drawer.
          • Desktop (md+): row horizontal com colunas dedicadas e dividers
            verticais (UX original — operação faz scan vertical). */}
      <div className="flex flex-col md:flex-row md:items-stretch gap-3 md:gap-4 px-4 md:px-5 py-3.5">
        {/* ── Marca + campanha + datas ───────────────────────────────
            self-center vale só pra desktop (flex-row, eixo cruzado é vertical).
            No mobile (flex-col), self-center colapsava a largura horizontal e
            jogava o texto pro centro do card — texto fica esquerda alinhado
            via stretch default. */}
        <div className="min-w-0 flex-1 md:self-center">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-bold text-fg tracking-tight truncate leading-none">
              {client_name}
            </h3>
            <TokenChip token={short_token} variant="card" />
            {isNew && <NewBadge />}
            {merge_id && <MergedBadge />}
            {is_bonus_only && <BonusBadge />}
            {has_abs && <AbsBadge />}
            {paused && <PausedBadge reason={paused_reason} />}
            {awaiting && <AwaitingClosureBadge />}
            {/* Badge "antes do previsto" só aparece quando a campanha já está
                de fato encerrada (status="ended"). Setar early_end_date no
                futuro ou em hoje (efetivo só amanhã) NÃO dispara o badge —
                ele entra em cena assim que a data passa. */}
            {ended && earlyEnded && <EarlyEndedBadge reason={early_end_reason} date={early_end_date} />}
            {ended && !earlyEnded && (
              <span className="text-[9px] uppercase tracking-widest font-bold text-fg-subtle">
                encerrada
              </span>
            )}
          </div>
          <p className="text-[12.5px] text-fg-muted mt-1 truncate leading-snug">
            {campaign_name}
          </p>
          <DateRangeLine startISO={start_date} endISO={effectiveEndDate} />
        </div>

        {/* ── KPIs mobile (visível só <md) ──────────────────────────────
            Mini-grid 2 cols com DSP/VID em coluna esquerda e CTR/VTR em
            coluna direita. Em campanha encerrada, mostra cinza pra não
            chamar atenção. Quando todos os pacings são null, esconde
            o bloco inteiro (campanha brand-new sem dados ainda). */}
        {!ended && (hasDisplay || hasVideo) && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 md:hidden border-t border-border/60 pt-3">
            {hasDisplay && (
              <>
                <PacingRow label="DSP" pacing={display_pacing} ended={ended} />
                <ResultRow
                  label="CTR"
                  value={display_ctr != null ? formatPct(display_ctr, 2) : null}
                  colorClass={display_ctr != null ? ctrColorClass(display_ctr, !!display_has_abs) : "text-fg-subtle"}
                />
              </>
            )}
            {hasVideo && (
              <>
                <PacingRow label="VID" pacing={video_pacing} ended={ended} />
                <ResultRow
                  label="VTR"
                  value={video_vtr != null ? formatPct(video_vtr, 1) : null}
                  colorClass={video_vtr != null ? vtrColorClass(video_vtr) : "text-fg-subtle"}
                />
              </>
            )}
            {/* Tech Cost (admin-only) ocupa a row inteira no fim do grid —
                só aparece quando há PI/budget pra calcular. */}
            {techCostPct != null && (
              <div className="col-span-2">
                <ResultRow
                  label="TECH"
                  value={`${techCostPct.toFixed(1)}%`}
                  colorClass={techCostToneClass(techCostPct)}
                />
              </div>
            )}
          </div>
        )}

        <Divider />

        {/* ── eCPM REAL (admin-only, destaque) ─────────────────────────
            Layout dual:
              • Single-format ou fallback legado: bloco grande tintado
                (recipe original) — uma linha visual.
              • Mix DSP+VID: header "eCPM ADM" + 2 mini-pills LADO A LADO,
                cada uma tintada com seu próprio tier (display vs video).
            Tier vem de `ecpmBgClass(value, kind)` — display/displayAbs/video
            tem réguas em ordem de grandeza diferente (R$ 0,80 é catastrófico
            em display, ótimo em vídeo). Encerrada vira bg-surface neutro.
            Split: cada mini-pill ≈72px (um pouco mais estreito que o single
            96px) lado a lado, total 148px. Mesmo recipe visual do single
            (label superior + valor centrado) — só com label do formato
            substituindo "ECPM ADM" em cada pill. */}
        <div className={cn(
          "hidden md:flex flex-col justify-center shrink-0",
          ecpmIsSplit ? "w-[148px]" : "w-[96px]"
        )}>
          {ecpmIsSplit ? (
            <div className="flex gap-1">
              {ecpmRows.map((row) => (
                <div
                  key={row.label}
                  className={cn(
                    "flex-1 min-w-0 px-2 py-1.5 rounded-md transition-colors",
                    ended ? "bg-surface" : ecpmBgClass(row.value, row.kind)
                  )}
                >
                  <div className="flex items-baseline gap-1 leading-none">
                    <span className="text-[9px] uppercase tracking-[0.14em] font-bold text-fg-muted">
                      {row.label}
                    </span>
                    <span
                      className="text-[7.5px] uppercase tracking-widest font-semibold text-fg-subtle/70"
                      title="Custo bruto do DSP / impressions × 1000 — não exibir para o cliente"
                    >
                      adm
                    </span>
                  </div>
                  <span className={cn(
                    "text-[12px] font-bold tabular-nums tracking-tight mt-1 block",
                    ended ? "text-fg-subtle" : "text-fg"
                  )}>
                    {formatBRL(row.value)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className={cn(
              "px-2.5 py-1.5 rounded-md transition-colors",
              ended ? "bg-surface" : ecpmBgClass(ecpmRows[0].value, ecpmRows[0].kind)
            )}>
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
                "text-[14px] font-bold tabular-nums tracking-tight mt-1 block",
                ended ? "text-fg-subtle" : "text-fg"
              )}>
                {formatBRL(ecpmRows[0].value)}
              </span>
            </div>
          )}
        </div>

        {/* ── TECH COST (admin-only) ───────────────────────────────────
            Coluna leve colada ao eCPM (sem divisor entre os dois) — ambos
            são métricas financeiras admin e formam um grupo visual. Sem
            pill tintada pra não criar um segundo bloco pesado ao lado do
            eCPM: só label "TECH adm" + valor colorido pela régua de tech
            cost (≤8% verde / ≤10% amarelo / acima vermelho). "—" quando a
            campanha não tem PI/budget (bonificada, sem CPM-CPCV).
            justify-center alinha o valor com o eCPM ao lado. */}
        <div className="hidden md:flex flex-col justify-center shrink-0 w-[64px]">
          <div className="flex items-baseline gap-1 leading-none">
            <span className="text-[9px] uppercase tracking-[0.14em] font-bold text-fg-muted">
              tech
            </span>
            <span
              className="text-[7.5px] uppercase tracking-widest font-semibold text-fg-subtle/70"
              title="Custo real DSP (com survey) / valor do PI cliente — não exibir para o cliente"
            >
              adm
            </span>
          </div>
          <span className={cn(
            "text-[14px] font-bold tabular-nums tracking-tight mt-1 block",
            ended ? "text-fg-subtle" : (techCostPct != null ? techCostToneClass(techCostPct) : "text-fg-subtle")
          )}>
            {techCostPct != null ? `${techCostPct.toFixed(1)}%` : "—"}
          </span>
        </div>

        <Divider />

        {/* ── PACING (DSP row + VID row, separados) ──────────────────
            Cada linha some quando o formato não existe na campanha — em
            vez de "—" placeholder. Largura da coluna fica fixa pra
            alinhamento entre cards continuar consistente. */}
        <div className="hidden md:flex flex-col justify-center gap-2 shrink-0 w-[160px]">
          {hasDisplay && <PacingRow label="DSP" pacing={display_pacing} ended={ended} subBars={displaySubBars} />}
          {hasVideo   && <PacingRow label="VID" pacing={video_pacing}   ended={ended} subBars={videoSubBars} />}
        </div>

        <Divider />

        {/* ── RESULTADOS (CTR + VTR) ─────────────────────────────────
            CTR só existe se há display; VTR só se há vídeo. Mesma régua
            de visibilidade do bloco de pacing. */}
        <div className="hidden md:flex flex-col justify-center gap-2 shrink-0 w-[90px]">
          {hasDisplay && (
            <ResultRow
              label="CTR"
              value={display_ctr != null ? formatPct(display_ctr, 2) : null}
              colorClass={ended ? "text-fg-subtle" : (display_ctr != null ? ctrColorClass(display_ctr, !!display_has_abs) : "text-fg-subtle")}
            />
          )}
          {hasVideo && (
            <ResultRow
              label="VTR"
              value={video_vtr != null ? formatPct(video_vtr, 1) : null}
              colorClass={ended ? "text-fg-subtle" : (video_vtr != null ? vtrColorClass(video_vtr) : "text-fg-subtle")}
            />
          )}
        </div>

        <Divider />

        {/* ── Owners (slot fixo) + Acessos + CTA (min-w fixo) ──────
            Mobile: ocupa a row toda (justify-between distribui avatares
            à esquerda e CTA à direita) abaixo dos KPIs.
            Desktop: shrink-fit ao final da row horizontal. */}
        <div className="flex items-center gap-3 md:shrink-0 md:self-center justify-between md:justify-start">
          {/* Slot fixo 44px com justify-end: vazio, 1 ou 2 avatares,
           *  o botão fica sempre no mesmo X. Mobile sempre mostra (UX
           *  consistente com desktop). */}
          <div className="flex w-11 justify-start md:justify-end items-center">
            {cpName && <Avatar name={cpName} role="cp" size="sm" title={`CP: ${cpName}`} />}
            {csName && <Avatar name={csName} role="cs" size="sm" className={cpName ? "-ml-1.5" : ""} title={`CS: ${csName}`} />}
          </div>
          <AccessBadge shortToken={short_token} ended={ended} />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenReport?.(short_token);
            }}
            className={cn(
              "inline-flex items-center justify-center gap-1 h-9 md:h-8 px-3 rounded-md text-xs font-semibold cursor-pointer",
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

      {/* Overlay de pausa — dima todo o conteúdo do card com tint da canvas,
          equivalente visual a opacity-65 mas SEM o problema de cascade do
          opacity CSS (que ofuscaria também o PausedBadge). O badge tem
          z-10 e fica acima desse overlay, mantendo a cor original. */}
      {paused && (
        <div
          aria-hidden
          className="absolute inset-0 bg-canvas/35 pointer-events-none z-[5]"
        />
      )}
    </Card>
  );
}

/** Divisor vertical entre colunas. Some no mobile (md:block). */
function Divider() {
  return <div className="w-px bg-border self-stretch hidden md:block" />;
}

/**
 * Badge minimalista de acessos do report compartilhado.
 *
 * Estados visuais:
 *   - Saudável (acessou recente): ícone + número em fg-muted
 *   - Stale (≥7d sem acesso):     ícone + número em warning + texto "há Xd"
 *   - Nunca acessado:             ícone + "—" em fg-subtle (mais apagado)
 *
 * Pra campanhas encerradas, render ainda acontece mas com menos peso visual
 * (acessos pós-fechamento ainda são úteis pra entender se o cliente
 * consumiu o histórico).
 *
 * Fonte: cache em módulo (`accessSummaryCache`) populado por
 * prefetchAccessSummaries() chamado pelo CampaignMenuV2 logo após
 * listCampaigns. Render sync — null vira `0` sem flash.
 */
function AccessBadge({ shortToken, ended }) {
  const { summary, loading } = useCachedAccessSummary(shortToken);

  // Skeleton enquanto loading + sem dado em cache. Pulse animation
  // discreta no slot do badge mantém o alinhamento da coluna (admin
  // não vê "0" piscando e virando o número real).
  if (loading && !summary) {
    return (
      <div
        className="inline-flex items-center justify-end gap-1 w-[44px] cursor-default"
        aria-label="Carregando acessos..."
      >
        <span className="block w-3 h-3 rounded-sm bg-fg-subtle/15 animate-pulse" />
        <span className="block w-4 h-2.5 rounded-sm bg-fg-subtle/15 animate-pulse" />
      </div>
    );
  }

  const totalAccesses  = summary?.total_pageviews ?? 0;
  const uniqueSessions = summary?.unique_sessions ?? 0;
  const lastAccessAt   = summary?.last_access_at || null;

  // Derivações do summary: dias desde último acesso (granularidade dia),
  // flag de stale (>=7d sem acesso) e neverAccessed (sem nenhum evento).
  const neverAccessed = totalAccesses === 0;
  const daysSinceLast = lastAccessAt
    ? Math.max(0, Math.floor((Date.now() - new Date(lastAccessAt).getTime()) / 86_400_000))
    : null;
  const stale = !neverAccessed && (daysSinceLast == null || daysSinceLast >= 7);

  // Cor + label do estado
  const tone = neverAccessed ? "subtle" : (stale && !ended ? "warning" : "muted");
  const colorClass =
    tone === "warning" ? "text-warning"
    : tone === "subtle" ? "text-fg-subtle"
    : "text-fg-muted";

  // Slot do badge tem largura fixa pra que CTAs ("Ver Report" / "Histórico")
  // alinhem em coluna entre todas as linhas — admin escaneia vertical e
  // qualquer drift visual cansa. Slot dimensionado pra caber até 3 dígitos
  // (999 acessos em 30d é teto realista). Conteúdo right-aligned cola o
  // valor no lado do botão; números curtos deixam padding à esquerda do
  // ícone, mantendo o slot estável.
  //
  // Sinal de "stale" e "nunca acessou" sai 100% pela COR + tooltip — sem
  // sub-texto inline ("· há Xd"), que era a fonte principal de misalignment.
  const tooltipBody = neverAccessed
    ? "Sem acessos registrados nos últimos 30d"
    : `${totalAccesses} acessos · ${uniqueSessions} sessões únicas · último ${daysSinceLast === 0 ? "hoje" : `há ${daysSinceLast}d`}${stale && !ended ? " (sem acesso há +7d)" : ""}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "inline-flex items-center justify-end gap-1 w-[44px] text-[11px] font-semibold tabular-nums whitespace-nowrap cursor-default",
            colorClass,
            ended && !stale && "opacity-60",
          )}
          aria-label={tooltipBody}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
          >
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>{totalAccesses}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[220px] text-[11.5px]">
        {tooltipBody}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Linha de date range com destaque de urgência na data final. Quando o
 * end_date é hoje ou amanhã, o texto vira "→ hoje" (danger semibold) ou
 * "→ amanhã" (warning semibold) — usa o slot que já existia, sem badge
 * novo ou borda extra. Operação enxerga urgência no scan vertical sem
 * poluir o card.
 */
function DateRangeLine({ startISO, endISO }) {
  const parts = getDateRangeParts(startISO, endISO);
  if (!parts) return null;
  const cls = endUrgencyClass(parts.endUrgency);
  return (
    <p className="text-[10.5px] text-fg-subtle mt-0.5 tabular-nums">
      {parts.startStr} → <span className={cls}>{parts.endStr}</span>
    </p>
  );
}

/**
 * Badge "NEW" — campanha entrou em vôo nas últimas 48h. Visualmente
 * diferente dos outros badges (que são bordered-soft pastel) por design:
 * recipe FILLED com gradient signature + texto branco + shine sweep
 * contínuo (CSS em v2.css `.badge-new`). A inversão de recipe carrega
 * o sinal "isto é diferente, repare aqui" sem precisar de cor extra.
 *
 * Sumir automaticamente: a flag vem de `isRecentlyStarted(start_date)`,
 * que recalcula a cada render. Não há mutation/cron — após 48h do start
 * o badge simplesmente para de renderizar.
 */
function NewBadge() {
  return (
    <span
      className="badge-new badge-pop-in relative overflow-hidden inline-flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold text-white px-1.5 py-0.5 rounded"
      title="Campanha nova — está em vôo há ≤ 2 dias"
    >
      <svg
        className="relative z-[1]"
        width="9" height="9"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M12 1.5l2.6 6.3 6.4.6-4.9 4.4 1.5 6.3L12 15.8 6.4 19.1l1.5-6.3L3 8.4l6.4-.6L12 1.5z" />
      </svg>
      <span className="relative z-[1]">new</span>
    </span>
  );
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
      className="badge-pop-in inline-flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold text-signature px-1.5 py-0.5 rounded bg-signature/8 border border-signature/30"
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

/**
 * Badge "BONIFICADA" — campanha 100% cortesia HYPR (todo volume contratado
 * é bônus, sem custo faturado). Cor warning (dourado) carrega a conotação
 * de "presente". Visualmente irmão do MergedBadge, mas usando o token
 * --color-warning pra distinguir de "agrupado".
 */
function BonusBadge() {
  return (
    <span
      className="badge-pop-in inline-flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold text-warning px-1.5 py-0.5 rounded bg-warning-soft border border-warning/40"
      title="Campanha 100% bonificada — todo volume entregue é cortesia HYPR"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 12 20 22 4 22 4 12" />
        <rect x="2" y="7" width="20" height="5" />
        <line x1="12" y1="22" x2="12" y2="7" />
        <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
        <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
      </svg>
      bonificada
    </span>
  );
}

/**
 * Badge "ENCERRADA ANTES DO PREVISTO" — campanha terminou antes da end_date
 * original por decisão do admin (cancelamento, solicitação externa). Tom
 * danger soft pra comunicar "perda/anomalia" sem alarmar como erro crítico.
 * Substitui o label "encerrada" plain quando aplicável — a campanha É
 * encerrada, só que antecipadamente.
 *
 * Quando `reason` está presente, hover abre tooltip com o motivo + data
 * definitiva. Sem reason, tooltip simples explicando o estado.
 */
function EarlyEndedBadge({ reason, date }) {
  const badge = (
    <span
      className="badge-pop-in inline-flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold text-danger px-1.5 py-0.5 rounded bg-danger-soft border border-danger/30 cursor-help"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
      </svg>
      antes do previsto
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>
        <EarlyEndedTooltipBody reason={reason} date={date} />
      </TooltipContent>
    </Tooltip>
  );
}

function EarlyEndedTooltipBody({ reason, date }) {
  const fmt = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yy = d.getUTCFullYear();
    return `${dd}/${mm}/${yy}`;
  };
  const dateStr = fmt(date);
  return (
    <div className="space-y-1 leading-snug">
      <p className="font-semibold text-danger">Encerrada antes do previsto</p>
      {dateStr && (
        <p className="text-fg-muted">
          <span className="text-fg-subtle">Data:</span> {dateStr}
        </p>
      )}
      {reason ? (
        <p className="text-fg-muted">
          <span className="text-fg-subtle">Motivo:</span> {reason}
        </p>
      ) : (
        <p className="text-fg-subtle italic">Sem motivo registrado.</p>
      )}
    </div>
  );
}

/**
 * Badge "PAUSADA" — campanha em vôo que foi pausada temporariamente pelo
 * admin (ex: cliente pediu pra parar X dias, problema no DSP). Cor
 * signature azul comunica "congelada, vai voltar" — distinto do warning
 * (aguardando fechamento) e do danger (urgente). Card NÃO esmaece porque
 * a campanha continua viva, só dormindo.
 *
 * Hover abre tooltip com motivo da pausa (se admin registrou).
 */
function PausedBadge({ reason }) {
  const badge = (
    <span
      className="badge-pop-in relative z-10 inline-flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold text-signature px-1.5 py-0.5 rounded bg-signature/8 border border-signature/30 cursor-help"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="6"  y="4" width="4" height="16" rx="1" />
        <rect x="14" y="4" width="4" height="16" rx="1" />
      </svg>
      pausada
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>
        <div className="space-y-1 leading-snug">
          <p className="font-semibold text-signature">Pausada</p>
          {reason ? (
            <p className="text-fg-muted">
              <span className="text-fg-subtle">Motivo:</span> {reason}
            </p>
          ) : (
            <p className="text-fg-subtle italic">Sem motivo registrado.</p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Badge "AGUARDANDO FECHAMENTO" — campanha passou da data final mas o admin
 * ainda não marcou como encerrada (no drawer). Cor warning âmbar pra puxar
 * atenção sem parecer erro. Some quando o admin marca como encerrada OU
 * quando passaram 30 dias do fim (auto-close).
 */
function AwaitingClosureBadge() {
  return (
    <span
      className="badge-pop-in inline-flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold text-warning px-1.5 py-0.5 rounded bg-warning-soft border border-warning/40"
      title="Campanha terminou — falta fazer o fechamento (sheet final, faturamento). Marcar como encerrada no drawer."
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 15 14" />
      </svg>
      aguardando fechamento
    </span>
  );
}

/**
 * Badge "ABS" — campanha com Brand Safety pre-bid (DV ABS / IAS) ativo em
 * pelo menos uma mídia. Sinaliza pra operação que os thresholds de eCPM
 * e CTR no Top Performers estão sendo avaliados em régua mais permissiva
 * (inventário pre-bid é estruturalmente mais caro). Cor success (verde)
 * porque é um atributo "positivo" da campanha — garantia de inventário.
 */
function AbsBadge() {
  return (
    <span
      className="badge-pop-in inline-flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold text-success px-1.5 py-0.5 rounded bg-success-soft border border-success/30"
      title="Brand Safety pre-bid (DV ABS / IAS) ativo — thresholds permissivos no scoring"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" />
      </svg>
      abs
    </span>
  );
}

/** Ícone minimalista do formato — substitui o label textual DSP/VID. */
function FormatIcon({ label }) {
  if (label === "DSP") {
    // Image (lucide): retângulo + sol + montanha — universal pra display estático.
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      </svg>
    );
  }
  if (label === "VID") {
    // Video (lucide): câmera com play — universal pra vídeo.
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m22 8-6 4 6 4V8Z" />
        <rect x="2" y="6" width="14" height="12" rx="2" ry="2" />
      </svg>
    );
  }
  return null;
}

/** Linha de pacing: ícone do formato · valor fixo · mini-barra fluida.
 *
 *  Larguras de ícone e valor são fixas pra DSP e VID alinharem
 *  verticalmente. A barra ocupa o restante da coluna até o divisor.
 *  Quando não há valor: mostra "—" e oculta a barra (não há o que medir).
 *
 *  Ícones (em vez de texto "DSP"/"VID"): operação reconhece formato por
 *  símbolo mais rápido do que ler 3 letras, e libera espaço visual. O
 *  label textual fica no `title` pra acessibilidade/hover. */
function PacingRow({ label, pacing, ended, subBars }) {
  const has = pacing != null && !isNaN(pacing);
  // Quando há frentes O2O+OOH e alguma está under (<100%), força tier
  // "attention" mesmo que a média esteja saudável. Caso operacional típico:
  // O2O super-over compensa OOH under na média agregada, escondendo um
  // pacing problemático de uma frente. A barra amarela sinaliza "tem frente
  // que precisa de atenção, abre pra ver".
  const hasFrenteUnder = !!subBars?.some((s) => s.pacing != null && s.pacing < 100);
  const baseTier = pacingTier(pacing);
  const effectiveTier = ended
    ? "ended"
    : (hasFrenteUnder && (baseTier === "healthy" || baseTier === "over")
        ? "attention"
        : baseTier);
  const colorClass = ended
    ? "text-fg-subtle"
    : (has
        ? (hasFrenteUnder && (baseTier === "healthy" || baseTier === "over")
            ? "text-warning"
            : pacingColorClass(pacing))
        : "text-fg-subtle");
  const tooltip = label === "DSP" ? "Display" : label === "VID" ? "Vídeo" : label;

  const rowContent = (
    <div className="flex items-center gap-2 leading-none">
      <span
        className="text-fg-subtle w-7 shrink-0 flex items-center"
        title={subBars ? undefined : tooltip}
        aria-label={tooltip}
      >
        <FormatIcon label={label} />
      </span>
      <span className={cn("text-[13px] font-bold tabular-nums w-12 shrink-0 text-right", colorClass)}>
        {has ? formatPacingValue(pacing) : "—"}
      </span>
      {/* ⚠️ inline quando há frente under (sub-100%) escondida pela média.
          Sinal pré-hover — sem ele, admin vê só barra amarela e pode interpretar
          como "atenção genérica". Ícone deixa explícito "tem desequilíbrio". */}
      {hasFrenteUnder && (
        <span
          className="text-warning shrink-0 -ml-0.5"
          aria-label="Uma das frentes está abaixo de 100%"
          title="Uma das frentes está abaixo de 100% — abra pra ver"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2 1 21h22L12 2zm0 6c.6 0 1 .4 1 1v5c0 .6-.4 1-1 1s-1-.4-1-1V9c0-.6.4-1 1-1zm0 9.5a1.2 1.2 0 1 1 0 2.5 1.2 1.2 0 0 1 0-2.5z" />
          </svg>
        </span>
      )}
      {has && <PacingBar pacing={pacing} tier={effectiveTier} />}
    </div>
  );

  // Sem breakdown (frente única ou detalhe ainda não chegou): row simples.
  if (!subBars || subBars.length < 2) return rowContent;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-default">{rowContent}</div>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="px-3 py-2">
        <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-fg-subtle mb-1.5">
          {tooltip} · pacing por frente
        </div>
        <div className="flex flex-col gap-1">
          {subBars.map((s) => (
            <FrenteTooltipRow key={s.label} label={s.label} pacing={s.pacing} />
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Linha compacta dentro do tooltip — label da frente + valor colorido. */
function FrenteTooltipRow({ label, pacing }) {
  const has = pacing != null && !isNaN(pacing);
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[11px] font-semibold text-fg-muted">{label}</span>
      <span className={cn(
        "text-[12px] font-bold tabular-nums",
        has ? pacingColorClass(pacing) : "text-fg-subtle"
      )}>
        {has ? formatPacingValue(pacing) : "—"}
      </span>
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
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          // Transição de width quando o pacing muda (refetch da lista
          // atualizando dado). Antes a barra "pulava" pro novo valor —
          // agora desliza em 500ms expo-out. Color (bg-*) também transiciona
          // pra cobrir caso de o tier mudar junto (ex: 95% attention → 105% over).
          "transition-[width,background-color] duration-500 ease-out",
          HEALTH_BAR[tier]
        )}
        style={{ width: `${fillPct}%` }}
      />
      <span
        aria-hidden
        className="absolute right-0 top-[-2px] bottom-[-2px] w-px bg-fg-subtle/45"
      />
    </div>
  );
}
