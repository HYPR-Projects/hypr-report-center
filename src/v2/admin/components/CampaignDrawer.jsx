// src/v2/admin/components/CampaignDrawer.jsx
//
// Drawer lateral aberto ao clicar num card/linha de campanha.
// Centraliza todas as ações secundárias que viviam como botões no card:
//
//   - Ver Report      → abre o report em nova aba
//   - Copiar Link     → copy share_id link (resolve sob demanda se preciso)
//   - Editar Owner    → abre OwnerModal (legacy, mantido)
//   - Adicionar Loom  → abre LoomModal (legacy, mantido)
//   - Adicionar Survey→ abre SurveyModal (legacy, mantido)
//   - Trocar Logo     → abre LogoModal (legacy, mantido)
//
// Reusa os modais legacy intactos (LogoModal, LoomModal, SurveyModal,
// OwnerModal) — eles continuam funcionando e não tem por que duplicar.
// O drawer é só um hub de ações com visual atualizado.

import { useEffect, useState } from "react";
import { Drawer, DrawerContent, DrawerHeader, DrawerBody, DrawerFooter } from "../../../ui/Drawer";
import { Button } from "../../../ui/Button";
import { cn } from "../../../ui/cn";
import { Avatar } from "../../../ui/Avatar";
import { AbsToggle } from "./AbsToggle";
import { TokenChip } from "./TokenChip";
import {
  getNegotiation,
  getCampaign,
  saveCampaignClosure,
  saveCampaignPause,
  saveCampaignEarlyEnd,
  clearCampaignEarlyEnd,
} from "../../../lib/api";
import {
  formatPacingValue,
  formatPct,
  pacingColorClass,
  ctrColorClass,
  vtrColorClass,
  getCampaignStatus,
  getDateRangeParts,
  endUrgencyClass,
  isEarlyEnded,
  localPartFromEmail,
} from "../lib/format";

const ICON = {
  link: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  ),
  loom: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  ),
  survey: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 12h6M9 8h6M9 16h6" />
    </svg>
  ),
  logo: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  ),
  rmnd: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" />
    </svg>
  ),
  pdooh: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="14" rx="2" />
      <path d="M2 9h20" />
      <path d="M8 18v3M16 18v3M6 21h12" />
    </svg>
  ),
  nego: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  ),
  owner: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
    </svg>
  ),
  merge: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6"  cy="6"  r="3" />
      <circle cx="6"  cy="18" r="3" />
      <circle cx="18" cy="12" r="3" />
      <path d="M9 6c4 0 6 2 6 6M9 18c4 0 6-2 6-6" />
    </svg>
  ),
  external: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14 21 3" />
    </svg>
  ),
  check: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  closure: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  pause: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6"  y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  ),
  resume: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  ),
  earlyEnd: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  ),
  revert: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  ),
};

export function CampaignDrawer({
  campaign,
  open,
  onOpenChange,
  onCopyLink,
  copiedState,         // matches `${token}` | `${token}:loading` | `${token}:error` | null
  onLoom,
  onSurvey,
  onLogo,
  onRmnd,
  onPdooh,
  onOwner,
  onMerge,
  onNegotiation,       // chamado quando admin clica em "Negociado" — recebe (campaign, negotiation)
  onAbsChange,         // chamado após admin salvar override de ABS — pai refaz lista
  onClosureChange,     // chamado após admin marcar campanha como encerrada — pai refaz lista
  onPauseChange,       // chamado após admin pausar/retomar campanha — pai atualiza otimisticamente
  onEarlyEndChange,    // chamado após admin setar/reverter encerramento antecipado
  onOpenReport,
  teamMap = {},
}) {
  // Negociação (Sales Center) — fetch lazy quando o drawer abre. Botão
  // "Negociado" só aparece quando a campanha tem registro no Sales Center.
  // Mesmo padrão do CampaignHeaderV2 do report.
  const drawerToken = campaign?.short_token;
  const [negotiation, setNegotiation] = useState(null);
  // Loading flag separado pra ocupar o slot do botão "Ver Negociado" desde
  // que o drawer abre, com placeholder/spinner — evita layout shift quando
  // o fetch resolve e empurra os botões abaixo (admin tava clicando errado
  // porque o pin "pulava").
  const [negotiationLoading, setNegotiationLoading] = useState(false);
  // reportData é necessário pro modal detectar features/táticas como
  // "Ativado" vs "Pendente". Sem ele, badges sempre caem em pendente
  // (mesma checagem usa totals/detail por tactic_type). Fetch só dispara
  // depois que confirmamos que há negociação — não paga BigQuery à toa.
  const [reportData, setReportData] = useState(null);
  const [negoBusy, setNegoBusy] = useState(false);
  // Estado local do botão "Marcar como encerrada" — idle | saving | done | error.
  // Reseta toda vez que o drawer abre/troca de campanha.
  const [closureBusy, setClosureBusy] = useState("idle");
  useEffect(() => { setClosureBusy("idle"); }, [drawerToken, open]);
  // Mesmo padrão pro toggle de pausa — resetado quando o drawer abre/troca.
  const [pauseBusy, setPauseBusy] = useState("idle");
  useEffect(() => { setPauseBusy("idle"); }, [drawerToken, open]);
  // Encerramento antecipado: form inline (data + motivo) com modo edição.
  // showEarlyEndForm controla expansão do bloco de form abaixo do botão.
  const [showEarlyEndForm, setShowEarlyEndForm] = useState(false);
  const [earlyEndBusy, setEarlyEndBusy] = useState("idle");
  const [earlyEndDateInput, setEarlyEndDateInput] = useState("");
  const [earlyEndReasonInput, setEarlyEndReasonInput] = useState("");
  useEffect(() => {
    setShowEarlyEndForm(false);
    setEarlyEndBusy("idle");
    setEarlyEndDateInput("");
    setEarlyEndReasonInput("");
  }, [drawerToken, open]);
  useEffect(() => {
    if (!open || !drawerToken) {
      setNegotiation(null);
      setReportData(null);
      setNegotiationLoading(false);
      return;
    }
    let cancelled = false;
    setNegotiationLoading(true);
    getNegotiation(drawerToken).then((n) => {
      if (cancelled) return;
      setNegotiation(n);
      setNegotiationLoading(false);
      if (!n) return;
      // pré-carrega reportData em background pra que o click em
      // "Ver Negociado" abra o modal já com badges Ativado/Pendente
      // corretas. Falha silenciosa cai em null e modal abre mesmo assim.
      getCampaign(drawerToken)
        .then((d) => { if (!cancelled) setReportData(d); })
        .catch(() => { if (!cancelled) setReportData(null); });
    });
    return () => { cancelled = true; };
  }, [open, drawerToken]);

  const handleNegoClick = async () => {
    if (!negotiation) return;
    if (reportData) {
      onNegotiation?.(campaign, negotiation, reportData);
      return;
    }
    // Fallback: pré-fetch ainda em andamento — espera resolver pra abrir
    // modal com dados completos.
    setNegoBusy(true);
    try {
      const d = await getCampaign(drawerToken);
      onNegotiation?.(campaign, negotiation, d);
    } catch {
      onNegotiation?.(campaign, negotiation, null);
    } finally {
      setNegoBusy(false);
    }
  };
  if (!campaign) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent />
      </Drawer>
    );
  }

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
    merge_id,
    display_has_abs,
    video_has_abs,
    closed_at,
    paused_at,
    early_end_date,
    early_end_reason,
  } = campaign;

  const status   = getCampaignStatus(end_date, closed_at, paused_at, early_end_date);
  const awaiting = status === "awaiting_closure";
  const paused   = status === "paused";
  const earlyEnded = isEarlyEnded(early_end_date);
  // Pausa só faz sentido em vôo. Após end_date, o ciclo natural toma conta.
  const canPause = status === "in_flight" || status === "paused";
  // Encerramento antecipado: faz sentido enquanto a campanha está em vôo
  // ou aguardando fechamento (admin pode marcar retroativamente). Já com
  // closed_at não faz sentido (campanha já fechada definitivamente).
  const canEarlyEnd = !closed_at && !earlyEnded && (
    status === "in_flight" || status === "paused" || status === "awaiting_closure"
  );

  // Limites do input de data: min = start_date, max = end_date original.
  // O backend não valida o range — confiamos no input do navegador + UX.
  const earlyEndDateMin = start_date || "";
  const earlyEndDateMax = end_date   || "";

  const handleCloseCampaign = async () => {
    if (!short_token || closureBusy === "saving") return;
    setClosureBusy("saving");
    try {
      await saveCampaignClosure({ short_token, closed: true });
      setClosureBusy("done");
      // Propaga na hora — o handler do pai atualiza só o array `campaigns`
      // (card atrás reflete imediatamente). O drawerCampaign NÃO é tocado,
      // então `awaiting` continua true, o botão fica montado e a animação
      // de sucesso roda completa em paralelo. Quando o user fechar o drawer
      // e reabrir, o campaign vem da lista atualizada com closed_at.
      onClosureChange?.(short_token);
    } catch {
      setClosureBusy("error");
    }
  };

  const handleTogglePause = async () => {
    if (!short_token || pauseBusy === "saving") return;
    const nextPaused = !paused; // inversão do estado atual
    setPauseBusy("saving");
    try {
      await saveCampaignPause({ short_token, paused: nextPaused });
      setPauseBusy("idle"); // toggle limpo — sem estado de "done" persistente
      onPauseChange?.(short_token, nextPaused);
    } catch {
      setPauseBusy("error");
    }
  };

  const handleOpenEarlyEndForm = () => {
    // Pré-popula com hoje (default mais comum — campanha encerrou hoje).
    // Cap dentro da janela start/end caso hoje esteja fora.
    const todayISO = new Date().toISOString().slice(0, 10);
    let initial = todayISO;
    if (earlyEndDateMax && todayISO > earlyEndDateMax) initial = earlyEndDateMax;
    if (earlyEndDateMin && initial < earlyEndDateMin)  initial = earlyEndDateMin;
    setEarlyEndDateInput(initial);
    setEarlyEndReasonInput("");
    setEarlyEndBusy("idle");
    setShowEarlyEndForm(true);
  };

  const handleConfirmEarlyEnd = async () => {
    if (!short_token || !earlyEndDateInput || earlyEndBusy === "saving") return;
    setEarlyEndBusy("saving");
    try {
      await saveCampaignEarlyEnd({
        short_token,
        early_end_date: earlyEndDateInput,
        reason: earlyEndReasonInput.trim(),
      });
      setEarlyEndBusy("idle");
      setShowEarlyEndForm(false);
      onEarlyEndChange?.(short_token, {
        early_end_date:   earlyEndDateInput,
        early_end_reason: earlyEndReasonInput.trim(),
      });
    } catch {
      setEarlyEndBusy("error");
    }
  };

  const handleRevertEarlyEnd = async () => {
    if (!short_token || earlyEndBusy === "saving") return;
    setEarlyEndBusy("saving");
    try {
      await clearCampaignEarlyEnd({ short_token });
      setEarlyEndBusy("idle");
      onEarlyEndChange?.(short_token, null);
    } catch {
      setEarlyEndBusy("error");
    }
  };

  // Sinal automático veio do BQ pela CTE abs_signals (DV360 fee + Xandr DV/IAS
  // + override). Se já está true, é porque sistema detectou OU override já
  // está marcado — em ambos os casos o toggle deve aparecer ON. Mas o admin
  // só consegue *editar* quando é override (sinal automático ou ausência).
  // O AbsToggle bate em get_abs_override pra distinguir.
  const autoDetected = !!(display_has_abs || video_has_abs);

  const cpName = cp_email ? (teamMap[cp_email] || localPartFromEmail(cp_email)) : null;
  const csName = cs_email ? (teamMap[cs_email] || localPartFromEmail(cs_email)) : null;

  const copyState =
    copiedState === short_token              ? "done"
    : copiedState === `${short_token}:loading` ? "loading"
    : copiedState === `${short_token}:error`   ? "error"
    : "idle";

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader
          title={client_name}
          subtitle={
            <span className="inline-flex items-center gap-2 flex-wrap font-sans tracking-normal">
              <span>{campaign_name}</span>
              <TokenChip
                token={short_token}
                variant="report"
                icon={<CircleIcon className="size-3" />}
              />
            </span>
          }
        />
        <DrawerBody>
          {/* Badge "agrupado" — sinaliza que ações como Loom/Logo/Survey
              continuam afetando ESTE token, mas o report público mostra
              dados unificados de todos os membros do grupo. */}
          {merge_id && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-signature/8 border border-signature/30 flex items-center gap-2">
              <span className="text-signature shrink-0">{ICON.merge}</span>
              <p className="text-xs text-fg-muted leading-snug">
                <span className="text-fg font-semibold">Agrupado</span> com outros tokens deste cliente.
                O link do report mostra a visão unificada.
              </p>
            </div>
          )}

          {/* Date range — end destacado em vermelho/âmbar quando hoje/amanhã */}
          <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-1">
            Período
          </div>
          <DrawerDateRange startISO={start_date} endISO={end_date} />

          {/* Métricas */}
          <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-2">
            Performance
          </div>
          <div className="grid grid-cols-2 gap-2 mb-5">
            {display_pacing != null && <DrawerStat label="DSP Pacing" value={formatPacingValue(display_pacing)} colorClass={pacingColorClass(display_pacing)} />}
            {video_pacing   != null && <DrawerStat label="VID Pacing" value={formatPacingValue(video_pacing)}   colorClass={pacingColorClass(video_pacing)} />}
            {display_ctr    != null && <DrawerStat label="CTR"        value={formatPct(display_ctr, 2)} colorClass={ctrColorClass(display_ctr)} />}
            {video_vtr      != null && <DrawerStat label="VTR"        value={formatPct(video_vtr, 1)}  colorClass={vtrColorClass(video_vtr)} />}
            {(display_pacing == null && video_pacing == null) && (
              <p className="col-span-2 text-xs text-fg-subtle italic">
                Sem delivery ainda — campanha pode não ter começado.
              </p>
            )}
          </div>

          {/* Brand Safety pre-bid (ABS) — toggle pra cobrir casos onde o sinal
              automático do BQ não detecta (Xandr Curate em open exchange, etc).
              Refetch da lista admin é responsabilidade do componente pai via
              onChange — backend já invalida o _list_cache, então só precisa
              forçar re-render. */}
          <div className="mb-5">
            <AbsToggle
              shortToken={short_token}
              autoDetected={autoDetected}
              onChange={onAbsChange}
            />
          </div>

          {/* Observação admin de encerramento antecipado — só aparece se
              admin marcou. Mostra data definitiva + motivo (admin-only,
              não vai pro report do cliente). */}
          {earlyEnded && (
            <EarlyEndedNote
              date={early_end_date}
              reason={early_end_reason}
              originalEnd={end_date}
            />
          )}

          {/* Owners */}
          <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-2">
            Owners
          </div>
          <div className="space-y-2 mb-5">
            <OwnerRow role="cp" name={cpName} email={cp_email} />
            <OwnerRow role="cs" name={csName} email={cs_email} />
          </div>

          {/* Ações */}
          <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-2">
            Ações
          </div>
          <div className="space-y-1.5">
            {/* "Marcar como encerrada" — só aparece em campanhas aguardando
                fechamento. Posicionado no topo porque é o CTA principal
                quando o admin abre o drawer dessa campanha (ela apareceu
                com badge âmbar justamente pra ele agir aqui). */}
            {awaiting && (
              <ActionButton
                icon={
                  closureBusy === "saving" ? <Spinner />
                  : closureBusy === "done" ? <ClosureSuccessIcon />
                  : ICON.closure
                }
                label={
                  closureBusy === "saving" ? "Marcando como encerrada..."
                  : closureBusy === "done"  ? "Encerrada!"
                  : closureBusy === "error" ? "Erro — tentar de novo"
                  : "Marcar como encerrada"
                }
                variant={
                  closureBusy === "done"  ? "success"
                  : closureBusy === "error" ? "danger"
                  : "warning"
                }
                disabled={closureBusy === "saving" || closureBusy === "done"}
                onClick={handleCloseCampaign}
              />
            )}
            {/* Encerramento antecipado — admin define data real do fim
                (≤ end_date original) + motivo. Form inline expande abaixo
                do botão. Quando já encerrada antecipadamente, mostra
                "Reverter" no lugar. */}
            {canEarlyEnd && !showEarlyEndForm && (
              <ActionButton
                icon={ICON.earlyEnd}
                label="Encerrar antecipadamente"
                variant="default"
                onClick={handleOpenEarlyEndForm}
              />
            )}
            {showEarlyEndForm && (
              <EarlyEndForm
                dateValue={earlyEndDateInput}
                onDateChange={setEarlyEndDateInput}
                reasonValue={earlyEndReasonInput}
                onReasonChange={setEarlyEndReasonInput}
                dateMin={earlyEndDateMin}
                dateMax={earlyEndDateMax}
                busy={earlyEndBusy}
                onConfirm={handleConfirmEarlyEnd}
                onCancel={() => setShowEarlyEndForm(false)}
              />
            )}
            {earlyEnded && (
              <ActionButton
                icon={earlyEndBusy === "saving" ? <Spinner /> : ICON.revert}
                label={
                  earlyEndBusy === "saving" ? "Revertendo..."
                  : earlyEndBusy === "error" ? "Erro — tentar de novo"
                  : "Reverter encerramento antecipado"
                }
                variant={earlyEndBusy === "error" ? "danger" : "default"}
                disabled={earlyEndBusy === "saving"}
                onClick={handleRevertEarlyEnd}
              />
            )}
            {/* Pausar/Retomar — toggle reversível, só faz sentido enquanto a
                campanha está em vôo (in_flight ou paused). Após end_date o
                fluxo natural (awaiting_closure → ended) toma conta. */}
            {canPause && (
              <ActionButton
                icon={
                  pauseBusy === "saving" ? <Spinner />
                  : paused ? ICON.resume
                  : ICON.pause
                }
                label={
                  pauseBusy === "saving" ? (paused ? "Retomando..." : "Pausando...")
                  : pauseBusy === "error" ? "Erro — tentar de novo"
                  : paused ? "Retomar campanha"
                  : "Pausar campanha"
                }
                variant={
                  pauseBusy === "error" ? "danger"
                  : paused ? "highlight"  // signature — campanha pausada destaca o "retomar"
                  : "default"
                }
                disabled={pauseBusy === "saving"}
                onClick={handleTogglePause}
              />
            )}
            <ActionButton
              icon={
                copyState === "done"    ? ICON.check
                : copyState === "loading" ? <Spinner />
                : ICON.link
              }
              label={
                copyState === "done"    ? "Link copiado!"
                : copyState === "loading" ? "Copiando link..."
                : copyState === "error"   ? "Erro — tentar de novo"
                : "Copiar link do cliente"
              }
              variant={copyState === "done" ? "success" : copyState === "error" ? "danger" : "default"}
              disabled={copyState === "loading"}
              onClick={() => onCopyLink?.(campaign)}
            />
            <ActionButton icon={ICON.owner}  label="Gerenciar owner (CP/CS)" onClick={() => onOwner?.(campaign)} />
            {/* Slot de "Ver Negociado": ocupado por placeholder enquanto o
                fetch de getNegotiation tá em voo, pra evitar que o botão
                apareça depois e empurre os de baixo (admin clicava errado).
                Quando resolve sem negociação, o slot some — aceitável porque
                o usuário ainda não terminou de processar o painel. */}
            {(negotiationLoading || negotiation) && (
              <ActionButton
                icon={(negotiationLoading || negoBusy) ? <Spinner /> : ICON.nego}
                label={
                  negotiationLoading ? "Carregando negociado…"
                  : negoBusy ? "Carregando dados..."
                  : "Ver Negociado"
                }
                variant={negotiationLoading ? "default" : "highlight"}
                disabled={negotiationLoading || negoBusy}
                onClick={negotiationLoading ? undefined : handleNegoClick}
              />
            )}
            <ActionButton
              icon={ICON.merge}
              label={merge_id ? "Gerenciar agrupamento" : "Agrupar com outros tokens"}
              variant={merge_id ? "highlight" : "default"}
              onClick={() => onMerge?.(campaign)}
            />
            <ActionButton icon={ICON.loom}   label="Adicionar/editar Loom"    onClick={() => onLoom?.(short_token)} />
            <ActionButton icon={ICON.survey} label="Gerenciar Survey"          onClick={() => onSurvey?.(short_token)} />
            <ActionButton icon={ICON.logo}   label="Trocar logo"               onClick={() => onLogo?.(short_token)} />
            <ActionButton icon={ICON.rmnd}   label="Gerenciar RMND (Amazon Ads)" onClick={() => onRmnd?.(short_token)} />
            <ActionButton icon={ICON.pdooh}  label="Gerenciar PDOOH"            onClick={() => onPdooh?.(short_token)} />
          </div>
        </DrawerBody>

        <DrawerFooter>
          <Button
            variant="primary"
            size="md"
            fullWidth
            onClick={() => {
              onOpenReport?.(short_token);
              onOpenChange?.(false);
            }}
            iconRight={ICON.external}
          >
            Abrir Report
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * Linha de período no drawer com destaque de urgência. Quando o end_date
 * é hoje/amanhã, a parte final vira "hoje" (danger) / "amanhã" (warning)
 * em peso semibold. Senão renderiza igual antes.
 */
function DrawerDateRange({ startISO, endISO }) {
  const parts = getDateRangeParts(startISO, endISO);
  if (!parts) {
    return <p className="text-sm font-mono tabular-nums text-fg mb-5">—</p>;
  }
  return (
    <p className="text-sm font-mono tabular-nums text-fg mb-5">
      {parts.startStr} → <span className={endUrgencyClass(parts.endUrgency)}>{parts.endStr}</span>
    </p>
  );
}

function DrawerStat({ label, value, colorClass }) {
  return (
    <div className="rounded-lg bg-surface border border-border px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">{label}</div>
      <div className={cn("text-lg font-bold tracking-tight tabular-nums mt-0.5", colorClass)}>{value}</div>
    </div>
  );
}

function OwnerRow({ role, name, email }) {
  if (!email) {
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface border border-border border-dashed">
        <div className="w-7 h-7 rounded-full bg-surface-strong flex items-center justify-center">
          <span className="text-fg-subtle text-[10px]">?</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">{role.toUpperCase()}</div>
          <p className="text-xs text-fg-subtle italic">Não atribuído</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface border border-border">
      <Avatar name={name} role={role} size="md" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">{role.toUpperCase()}</div>
        <p className="text-xs text-fg truncate font-medium">{name}</p>
        <p className="text-[10.5px] text-fg-subtle truncate font-mono">{email}</p>
      </div>
    </div>
  );
}

const ACTION_VARIANTS = {
  default:   "text-fg hover:bg-surface-strong border-border",
  success:   "text-success border-success/40 bg-success-soft",
  danger:    "text-danger border-danger/40 bg-danger-soft",
  // Warning: campanha aguardando fechamento — destaque âmbar pra puxar
  // atenção do admin (essa é a ação principal quando o drawer abriu pra
  // uma campanha recém-finalizada).
  warning:   "text-warning border-warning/40 bg-warning-soft hover:bg-warning/15",
  // Merge ativo: sinaliza que a campanha está mesclada sem agredir
  // visualmente (signature soft, não primário) — ainda navega ao clicar.
  highlight: "text-signature border-signature/40 bg-signature/5 hover:bg-signature/10",
};

function ActionButton({ icon, label, variant = "default", onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer",
        "text-sm font-medium border transition-colors",
        "disabled:opacity-60 disabled:cursor-not-allowed",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        ACTION_VARIANTS[variant] || ACTION_VARIANTS.default,
        variant === "default" && "bg-surface"
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
    </button>
  );
}

/**
 * Bloco "OBSERVAÇÃO ADMIN" — mostra dados do encerramento antecipado.
 * Admin-only (não vai pro report do cliente). Cor danger soft pra
 * comunicar "atenção/perda" sem ser alarme bloqueador.
 */
function EarlyEndedNote({ date, reason, originalEnd }) {
  const fmt = (iso) => {
    if (!iso) return "—";
    // YYYY-MM-DD → DD/MM/YYYY (display PT-BR). Usa UTC pra evitar drift
    // de timezone igual o resto do projeto.
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yy = d.getUTCFullYear();
    return `${dd}/${mm}/${yy}`;
  };
  return (
    <div className="mb-5 rounded-lg border border-danger/30 bg-danger-soft px-3 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-danger">{ICON.earlyEnd}</span>
        <span className="text-[11px] uppercase tracking-widest font-bold text-danger">
          Encerrada antes do previsto
        </span>
      </div>
      <p className="text-[11.5px] text-fg-muted leading-snug">
        <span className="font-semibold text-fg">Data definitiva:</span> {fmt(date)}
        <span className="text-fg-subtle"> · original {fmt(originalEnd)}</span>
      </p>
      {reason && (
        <p className="text-[11.5px] text-fg-muted leading-snug mt-1">
          <span className="font-semibold text-fg">Motivo:</span> {reason}
        </p>
      )}
      <p className="text-[10px] text-fg-subtle italic mt-2">
        Observação admin — não aparece no report do cliente.
      </p>
    </div>
  );
}

/**
 * Form inline pra encerramento antecipado. Expande abaixo do botão "Encerrar
 * antecipadamente" quando o admin clica. Dois campos: data (input date com
 * min=start, max=end original) + motivo (textarea opcional).
 */
function EarlyEndForm({
  dateValue, onDateChange,
  reasonValue, onReasonChange,
  dateMin, dateMax,
  busy,
  onConfirm, onCancel,
}) {
  const saving = busy === "saving";
  const hasDate = !!dateValue;
  return (
    <div className="rounded-lg border border-danger/40 bg-danger-soft/60 px-3 py-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-danger">{ICON.earlyEnd}</span>
        <span className="text-[11px] uppercase tracking-widest font-bold text-danger">
          Encerrar antecipadamente
        </span>
      </div>
      <label className="block">
        <span className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">
          Data definitiva do fim
        </span>
        <input
          type="date"
          value={dateValue}
          onChange={(e) => onDateChange(e.target.value)}
          min={dateMin || undefined}
          max={dateMax || undefined}
          disabled={saving}
          className="mt-1 block w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm font-mono tabular-nums text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50"
        />
      </label>
      <label className="block">
        <span className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">
          Motivo <span className="text-fg-subtle font-normal normal-case tracking-normal">(opcional, admin-only)</span>
        </span>
        <textarea
          rows={2}
          value={reasonValue}
          onChange={(e) => onReasonChange(e.target.value)}
          disabled={saving}
          placeholder="Ex: cliente cancelou após problema na campanha X..."
          className="mt-1 block w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-fg resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50"
        />
      </label>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-3 py-1.5 rounded-md text-xs font-semibold text-fg-muted hover:text-fg hover:bg-surface transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={saving || !hasDate}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-danger text-white hover:bg-danger/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        >
          {saving && <Spinner />}
          {saving ? "Encerrando..." : busy === "error" ? "Tentar de novo" : "Confirmar"}
        </button>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Ícone de sucesso do fechamento — check desenhado em stroke draw +
 * halo verde que expande e some. Ambas animações disparam ao mount
 * (quando closureBusy vira "done" e o React troca o ícone).
 *
 * Wrapper span é relative+fixed-size pra ancorar o halo absolutamente
 * sem quebrar o layout do ActionButton (que renderiza `{icon}` dentro
 * de um span shrink-0). pathLength=100 no SVG normaliza o comprimento
 * da path, deixando a animação independente da geometria exata.
 */
function ClosureSuccessIcon() {
  return (
    <span className="closure-icon-pop relative inline-flex items-center justify-center w-[14px] h-[14px]">
      <span
        aria-hidden="true"
        className="closure-halo absolute rounded-full bg-success pointer-events-none"
        style={{ width: 26, height: 26 }}
      />
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="relative"
      >
        <path className="closure-check-path" pathLength="100" d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  );
}

// Mesmo ícone de leading do TokenChip no header do report — círculo com
// linha vertical dentro. Usado quando o chip aparece em headers (drawer
// admin, report público) pra reforçar a leitura "info da campanha".
function CircleIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}
