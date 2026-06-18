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
import { CoreProductsOverride } from "./CoreProductsOverride";
import { TokenChip } from "./TokenChip";
import { ClosureModal } from "./ClosureModal";
import { AudienceOverridesModal } from "./AudienceOverridesModal";
import {
  getNegotiation,
  getCampaign,
  getClosureDetails,
  saveCampaignPause,
  saveCampaignEarlyEnd,
  clearCampaignEarlyEnd,
  getFreezeStatus,
  rebuildReportSnapshot,
} from "../../../lib/api";
import { isFeatureAdmin } from "../../../shared/auth";
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
import { buildFrenteSubBars } from "../lib/useFrenteBreakdown";

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
  audience: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
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
  snapshot: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
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
  posvenda: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
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
  analytics: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 3 3 5-6" />
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
  onAnalytics,         // chamado quando admin clica em "Analytics de acessos"
  onNegotiation,       // chamado quando admin clica em "Negociado" — recebe (campaign, negotiation)
  onAbsChange,         // chamado após admin salvar override de ABS — pai refaz lista
  onClosureChange,     // chamado após admin marcar campanha como encerrada — pai refaz lista
  onPauseChange,       // chamado após admin pausar/retomar campanha — pai atualiza otimisticamente
  onEarlyEndChange,    // chamado após admin setar/reverter encerramento antecipado
  onOpenReport,
  teamMap = {},
  user,
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
  // Popup de fechamento (pós-venda + checkups). closureModalMode distingue
  // o fluxo "encerrar agora" (close) do "editar dados de campanha já
  // encerrada" (edit, pré-populado via getClosureDetails).
  const [audienceModalOpen, setAudienceModalOpen] = useState(false);
  useEffect(() => { setAudienceModalOpen(false); }, [drawerToken, open]);

  const [closureModalOpen, setClosureModalOpen] = useState(false);
  const [closureModalMode, setClosureModalMode] = useState("close");
  const [closureInitialDetails, setClosureInitialDetails] = useState(null);
  // idle | loading | error — estado do botão "Pós-venda & fechamento"
  // enquanto o prefill do edit mode está em voo.
  const [editClosureBusy, setEditClosureBusy] = useState("idle");
  useEffect(() => {
    setClosureModalOpen(false);
    setClosureModalMode("close");
    setClosureInitialDetails(null);
    setEditClosureBusy("idle");
  }, [drawerToken, open]);
  // Resumo do fechamento (pós-venda + checkups) — exibido no topo do drawer
  // de campanha encerrada. Fetch lazy quando o drawer abre; depois de um
  // save no popup, atualiza direto do payload salvo (sem refetch).
  const drawerClosedAt = campaign?.closed_at;
  const [closureSummary, setClosureSummary] = useState(null);
  useEffect(() => {
    setClosureSummary(null);
    if (!open || !drawerToken || !drawerClosedAt) return;
    let cancelled = false;
    getClosureDetails({ short_token: drawerToken })
      .then((d) => { if (!cancelled) setClosureSummary(d); })
      .catch(() => { /* sem resumo — drawer segue normal */ });
    return () => { cancelled = true; };
  }, [open, drawerToken, drawerClosedAt]);
  // Mesmo padrão pro toggle de pausa — resetado quando o drawer abre/troca.
  const [pauseBusy, setPauseBusy] = useState("idle");
  useEffect(() => { setPauseBusy("idle"); }, [drawerToken, open]);
  // Pausa com motivo: form inline igual o de encerramento antecipado.
  // showPauseForm controla expansão da gaveta; só usado quando admin
  // está PAUSANDO (não retomando — retomar é direto).
  const [showPauseForm, setShowPauseForm] = useState(false);
  const [pauseReasonInput, setPauseReasonInput] = useState("");
  useEffect(() => {
    setShowPauseForm(false);
    setPauseReasonInput("");
  }, [drawerToken, open]);
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
  // Reset automático do "done" pra "idle" depois da animação de sucesso
  // do toggle de pausa (~1.5s — janela do pop+halo). Mantido AQUI no topo
  // do componente (antes do early-return) pra contar como hook estável —
  // mover pra depois do `if (!campaign)` viola a regra dos hooks (count
  // muda entre render com campaign=null e campaign=obj → React error #310).
  useEffect(() => {
    if (pauseBusy !== "done") return;
    const t = setTimeout(() => setPauseBusy("idle"), 1500);
    return () => clearTimeout(t);
  }, [pauseBusy]);
  // Snapshot/freeze: status do report (frozen + frozen_at) e estado do botão
  // "Atualizar snapshot". Só feature-admins veem/buscam — report encerrado
  // serve snapshot verbatim, então edição de checklist (volumetria etc.) numa
  // campanha encerrada só aparece pro cliente depois de reconstruir.
  const [freezeInfo, setFreezeInfo] = useState(null); // {frozen, frozen_at} | null
  const [snapshotBusy, setSnapshotBusy] = useState("idle"); // idle|saving|done|error
  useEffect(() => { setSnapshotBusy("idle"); }, [drawerToken, open]);
  useEffect(() => {
    if (snapshotBusy !== "done") return;
    const t = setTimeout(() => setSnapshotBusy("idle"), 2000);
    return () => clearTimeout(t);
  }, [snapshotBusy]);
  useEffect(() => {
    setFreezeInfo(null);
    if (!open || !drawerToken || !isFeatureAdmin(user)) return;
    let cancelled = false;
    getFreezeStatus({ short_token: drawerToken })
      .then((info) => { if (!cancelled) setFreezeInfo(info); })
      .catch(() => { /* sem status — seção some, drawer segue normal */ });
    return () => { cancelled = true; };
  }, [open, drawerToken, user]);
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
    });
    // Detail full sempre — alimenta o bloco "Pacing por frente" (O2O/OOH
    // breakdown) e também o modal "Ver Negociado" (que precisa de
    // features/táticas detectadas). Antes, só carregava se houvesse
    // negotiation — drawer sem nego abria sem dados pra computar pacing
    // por frente. Falha silenciosa: bloco de frente some, restante do
    // drawer funciona normal.
    getCampaign(drawerToken)
      .then((d) => { if (!cancelled) setReportData(d); })
      .catch(() => { if (!cancelled) setReportData(null); });
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
    paused_reason,
    early_end_date,
    early_end_reason,
    setup,
  } = campaign;

  const status   = getCampaignStatus(end_date, closed_at, paused_at, early_end_date);
  const awaiting = status === "awaiting_closure";
  const paused   = status === "paused";
  const earlyEnded = isEarlyEnded(early_end_date);

  // Pacing por frente (O2O/OOH) calculado a partir do detail full carregado
  // em background. Cada subBars é null quando há frente única; nesse caso
  // o bloco "Pacing por frente" some inteiro (não há o que comparar).
  const displaySubBars = reportData ? buildFrenteSubBars(reportData, "DISPLAY") : null;
  const videoSubBars   = reportData ? buildFrenteSubBars(reportData, "VIDEO")   : null;
  const hasFrenteBreakdown = !!(displaySubBars || videoSubBars);
  // Pausa só faz sentido em vôo. Após end_date, o ciclo natural toma conta.
  const canPause = status === "in_flight" || status === "paused";
  // Encerramento antecipado: faz sentido enquanto a campanha está em vôo
  // ou aguardando fechamento (admin pode marcar retroativamente). Já com
  // closed_at não faz sentido (campanha já fechada definitivamente).
  const canEarlyEnd = !closed_at && !earlyEnded && (
    status === "in_flight" || status === "paused" || status === "awaiting_closure"
  );

  // Limites do input de data: min = start_date, max = min(end_date, hoje).
  // "Antecipado" implica que a campanha já terminou — não faz sentido
  // agendar pro futuro. Backend valida o mesmo range; o cap aqui é UX.
  const todayISO = new Date().toISOString().slice(0, 10);
  const earlyEndDateMin = start_date || "";
  const earlyEndDateMax = end_date
    ? (end_date < todayISO ? end_date : todayISO)
    : todayISO;

  // "Marcar como encerrada" agora abre o popup de fechamento — o save
  // acontece lá dentro (closure + pós-venda + checkups numa request só).
  // Pré-carrega detalhes existentes ANTES de abrir: campanha que foi
  // encerrada → reaberta → encerrada de novo tem pós-venda salvo, e abrir
  // o popup vazio sobrescreveria tudo com branco no save. Best-effort:
  // se o fetch falhar (raro), abre vazio em vez de travar o fechamento.
  const handleCloseCampaign = async () => {
    if (!short_token || closureBusy === "loading" || closureBusy === "done") return;
    setClosureBusy("loading");
    let details = null;
    try {
      details = await getClosureDetails({ short_token });
    } catch { /* abre vazio */ }
    setClosureBusy("idle");
    setClosureInitialDetails(details);
    setClosureModalMode("close");
    setClosureModalOpen(true);
  };

  // Save OK no popup. No fluxo close, dispara a animação de sucesso do
  // botão e propaga pro pai (mesmo contrato de antes: o handler atualiza
  // só o array `campaigns`; o drawerCampaign não é tocado, então o botão
  // fica montado e a animação roda completa). O resumo no topo atualiza
  // direto do payload salvo — sem esperar refetch.
  const handleClosureSaved = (_token, details) => {
    setClosureSummary(details || null);
    if (closureModalMode === "close") {
      setClosureBusy("done");
      onClosureChange?.(short_token);
    }
  };

  // "Pós-venda & fechamento" em campanha já encerrada — pré-carrega os
  // detalhes salvos e abre o popup em modo edição.
  const handleEditClosure = async () => {
    if (!short_token || editClosureBusy === "loading") return;
    setEditClosureBusy("loading");
    try {
      const details = await getClosureDetails({ short_token });
      setClosureInitialDetails(details);
      setClosureModalMode("edit");
      setClosureModalOpen(true);
      setEditClosureBusy("idle");
    } catch {
      setEditClosureBusy("error");
    }
  };

  // Pausar = abre form (motivo opcional). Retomar = direto, sem form.
  // Separamos os dois fluxos porque a UX é diferente: pausar é uma
  // decisão com contexto (vale registrar por quê); retomar é apenas
  // voltar ao estado normal.
  const handleOpenPauseForm = () => {
    setPauseReasonInput("");
    setPauseBusy("idle");
    setShowPauseForm(true);
  };

  const handleConfirmPause = async () => {
    if (!short_token || pauseBusy === "saving") return;
    setPauseBusy("saving");
    try {
      await saveCampaignPause({
        short_token,
        paused: true,
        reason: pauseReasonInput.trim(),
      });
      setPauseBusy("done");
      setShowPauseForm(false);
      onPauseChange?.(short_token, true, pauseReasonInput.trim());
    } catch {
      setPauseBusy("error");
    }
  };

  const handleResume = async () => {
    if (!short_token || pauseBusy === "saving") return;
    setPauseBusy("saving");
    try {
      await saveCampaignPause({ short_token, paused: false });
      setPauseBusy("done");
      onPauseChange?.(short_token, false, null);
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

  // Reconstrói o snapshot congelado a partir dos dados ao vivo — re-roda as
  // queries do report e re-congela. Usado quando o admin editou o checklist
  // (volumetria, CPM negociado…) de uma campanha já encerrada e o número novo
  // não apareceu pro cliente, pois o report serve o snapshot verbatim.
  const handleRebuildSnapshot = async () => {
    if (!short_token || snapshotBusy === "saving") return;
    setSnapshotBusy("saving");
    try {
      await rebuildReportSnapshot({
        short_token,
        note: `rebuild manual via admin${user?.email ? ` — ${user.email}` : ""}`,
      });
      setSnapshotBusy("done");
      // Atualiza o frozen_at exibido (cache do backend já foi invalidado).
      getFreezeStatus({ short_token })
        .then((info) => setFreezeInfo(info))
        .catch(() => { /* mantém o frozen_at anterior */ });
    } catch {
      setSnapshotBusy("error");
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
              continuam afetando ESTE token, mas o cliente tem acesso aos
              outros meses via o seletor no header. "Abrir Report" agora
              entra direto NESTE mês (não mais no active_token), então
              admin não precisa navegar pra ver os dados do token clicado. */}
          {merge_id && (
            <div className="drawer-section-rise mb-4 px-3 py-2 rounded-lg bg-signature/8 border border-signature/30 flex items-center gap-2">
              <span className="text-signature shrink-0">{ICON.merge}</span>
              <p className="text-xs text-fg-muted leading-snug">
                <span className="text-fg font-semibold">Agrupado</span> com outros tokens deste cliente.
                O link abre neste mês — cliente alterna entre meses no seletor do header.
              </p>
            </div>
          )}

          {/* Date range — end destacado em vermelho/âmbar quando hoje/amanhã.
              Stagger interno: cada seção sobe 6px + fade com offset crescente
              de 40ms entre elas. Roda em paralelo com o slide do painel
              (drawer-content), dando sensação de "orquestrado, vivo" ao abrir. */}
          <div className="drawer-section-rise">
            <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-1">
              Período
            </div>
            <DrawerDateRange startISO={start_date} endISO={end_date} />
          </div>

          {/* Performance — strip inline de 4 colunas. Substitui o grid de
              4 cards (~120px de altura) por uma linha enxuta (~60px). As
              cores carregam o sinal de saúde, sem precisar de chrome de
              card pra cada métrica. */}
          <div className="drawer-section-rise drawer-stagger-1">
            <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-2">
              Performance
            </div>
            <div className="mb-5">
              {(display_pacing != null || video_pacing != null || display_ctr != null || video_vtr != null) ? (
                <div className="rounded-lg bg-surface border border-border px-3 py-2.5 grid grid-cols-4 gap-2">
                  {display_pacing != null && <DrawerInlineStat label="DSP" value={formatPacingValue(display_pacing)} colorClass={pacingColorClass(display_pacing)} />}
                  {video_pacing   != null && <DrawerInlineStat label="VID" value={formatPacingValue(video_pacing)}   colorClass={pacingColorClass(video_pacing)} />}
                  {display_ctr    != null && <DrawerInlineStat label="CTR" value={formatPct(display_ctr, 2)} colorClass={ctrColorClass(display_ctr, !!display_has_abs)} />}
                  {video_vtr      != null && <DrawerInlineStat label="VTR" value={formatPct(video_vtr, 1)}  colorClass={vtrColorClass(video_vtr)} />}
                </div>
              ) : (
                <p className="text-xs text-fg-subtle italic">
                  Sem delivery ainda — campanha pode não ter começado.
                </p>
              )}
            </div>
          </div>

          {/* Pacing por frente — quebra DSP/VID em O2O e OOH. Só aparece
              quando a campanha tem ambas as frentes em pelo menos uma das
              mídias (caso O2O-only ou OOH-only não tem o que comparar). O
              detalhe é carregado em background pelo useEffect — bloco
              aparece quando reportData chega; até lá não renderiza nada
              (não há skeleton pra não ocupar espaço de algo que talvez nem
              vá existir naquela campanha). */}
          {hasFrenteBreakdown && (
            <div className="drawer-section-rise drawer-stagger-1">
              <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-2">
                Pacing por frente
              </div>
              <div className="rounded-lg bg-surface border border-border px-3 py-2.5 flex flex-col gap-2.5 mb-5">
                {displaySubBars && (
                  <FrenteGroup mediaLabel="DSP" subBars={displaySubBars} />
                )}
                {videoSubBars && (
                  <FrenteGroup mediaLabel="VID" subBars={videoSubBars} />
                )}
              </div>
            </div>
          )}

          {/* Brand Safety pre-bid (ABS) — toggle pra cobrir casos onde o sinal
              automático do BQ não detecta (Xandr Curate em open exchange, etc).
              Refetch da lista admin é responsabilidade do componente pai via
              onChange — backend já invalida o _list_cache, então só precisa
              forçar re-render. */}
          <div className="drawer-section-rise drawer-stagger-2 mb-5">
            <AbsToggle
              shortToken={short_token}
              autoDetected={autoDetected}
              onChange={onAbsChange}
            />
          </div>

          {/* Core products no report — curadoria de quais frentes aparecem.
              Vence o checklist_info: blinda frente removida no Command que a
              pipeline ainda materializa stale (frente "fantasma"). Backend
              invalida o cache; onChange só força re-render da lista. */}
          <div className="drawer-section-rise drawer-stagger-2 mb-5">
            <CoreProductsOverride
              shortToken={short_token}
              onChange={onAbsChange}
            />
          </div>

          {/* Observação admin de pausa — quando campanha está pausada,
              mostra desde quando + motivo. Some assim que o admin retoma. */}
          {paused && (
            <div className="drawer-section-rise drawer-stagger-3">
              <PausedNote pausedAt={paused_at} reason={paused_reason} />
            </div>
          )}

          {/* Observação admin de encerramento antecipado — só aparece se
              admin marcou. Mostra data definitiva + motivo (admin-only,
              não vai pro report do cliente). */}
          {earlyEnded && (
            <div className="drawer-section-rise drawer-stagger-3">
              <EarlyEndedNote
                date={early_end_date}
                reason={early_end_reason}
                originalEnd={end_date}
              />
            </div>
          )}

          {/* Resumo do fechamento — o que foi registrado no popup ao
              encerrar (pós-venda, material extra, checkups). Só pra
              campanha encerrada e quando os detalhes já chegaram. */}
          {!!closed_at && closureSummary && (
            <div className="drawer-section-rise drawer-stagger-3">
              <ClosureSummaryNote details={closureSummary} />
            </div>
          )}

          {/* Setup pendente — itens esperados (Loom + negociados no Sales
              Center) ainda não ativados. Espelha o chip âmbar do card; some
              em campanha encerrada (não vai mais ativar nada). */}
          {!closed_at && setup && (
            <div className="drawer-section-rise drawer-stagger-3">
              <SetupPendingNote setup={setup} />
            </div>
          )}

          {/* Owners — agora em duas colunas side-by-side. Email completo
              fica no tooltip (title) pra não comer largura, e cada pill
              cai pra ~40px de altura (vs ~50px do card antigo). Total da
              seção encolhe de ~110px → ~60px. */}
          <div className="drawer-section-rise drawer-stagger-4">
            <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-2">
              Owners
            </div>
            <div className="grid grid-cols-2 gap-2 mb-5">
              <OwnerPill role="cp" name={cpName} email={cp_email} />
              <OwnerPill role="cs" name={csName} email={cs_email} />
            </div>
          </div>

          {/* Ações agrupadas por intenção. Ordem das seções segue frequência
              de uso esperada — Link primeiro (copiar pro cliente é a ação
              mais comum), Lifecycle (encerrar/pausar) logo depois quando
              relevante, e o resto em ordem decrescente de uso. */}

          {/* ── 1. LINK DO CLIENTE — Copiar + Analytics ─────────────── */}
          <ActionGroup label="Link do cliente" className="drawer-section-rise drawer-stagger-5">
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
            <ActionButton
              icon={ICON.analytics}
              label="Analytics de acessos"
              onClick={() => onAnalytics?.(campaign)}
            />
          </ActionGroup>

          {/* ── 2. LIFECYCLE — Encerrar / Pausar ─────────────────────────
              Renderiza só quando há alguma ação de ciclo disponível, pra
              não sobrar um header "Status" vazio em campanhas onde tudo já
              tá resolvido (encerrada e não pausável). */}
          {(awaiting || canEarlyEnd || earlyEnded || canPause || closed_at) && (
            <ActionGroup label="Status" className="drawer-section-rise drawer-stagger-5">
              {/* "Marcar como encerrada" — só aparece em campanhas aguardando
                  fechamento. CTA âmbar pra puxar atenção (foi por isso que
                  o admin abriu o drawer dessa campanha). Abre o popup de
                  fechamento (pós-venda + checkups); o save acontece lá. */}
              {awaiting && (
                <ActionButton
                  icon={
                    closureBusy === "loading" ? <Spinner />
                    : closureBusy === "done" ? <ClosureSuccessIcon />
                    : ICON.closure
                  }
                  label={
                    closureBusy === "loading" ? "Abrindo fechamento..."
                    : closureBusy === "done" ? "Encerrada!"
                    : "Marcar como encerrada"
                  }
                  variant={closureBusy === "done" ? "success" : "warning"}
                  disabled={closureBusy === "loading" || closureBusy === "done"}
                  onClick={handleCloseCampaign}
                />
              )}
              {/* Campanha já encerrada — admin pode revisar/corrigir os
                  dados do fechamento (pós-venda, material, checkups). */}
              {!!closed_at && (
                <ActionButton
                  icon={editClosureBusy === "loading" ? <Spinner /> : ICON.posvenda}
                  label={
                    editClosureBusy === "loading" ? "Carregando fechamento..."
                    : editClosureBusy === "error" ? "Erro — tentar de novo"
                    : "Pós-venda & fechamento"
                  }
                  variant={editClosureBusy === "error" ? "danger" : "default"}
                  disabled={editClosureBusy === "loading"}
                  onClick={handleEditClosure}
                />
              )}
              {canEarlyEnd && !showEarlyEndForm && (
                <ActionButton
                  icon={ICON.earlyEnd}
                  label="Encerrar antecipadamente"
                  variant="default"
                  onClick={handleOpenEarlyEndForm}
                />
              )}
              {canEarlyEnd && (
                <div className={cn("action-expand", showEarlyEndForm && "is-open")}>
                  <div className="action-expand-content" inert={!showEarlyEndForm || undefined}>
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
                  </div>
                </div>
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
              {canPause && !showPauseForm && (
                <ActionButton
                  icon={
                    pauseBusy === "saving" ? <Spinner />
                    : pauseBusy === "done"
                      ? (paused ? <PauseSuccessIcon /> : <ResumeSuccessIcon />)
                    : paused ? ICON.resume
                    : ICON.pause
                  }
                  label={
                    pauseBusy === "saving" ? (paused ? "Retomando..." : "Pausando...")
                    : pauseBusy === "done"  ? (paused ? "Pausada!" : "Retomada!")
                    : pauseBusy === "error" ? "Erro — tentar de novo"
                    : paused ? "Retomar campanha"
                    : "Pausar campanha"
                  }
                  variant={
                    pauseBusy === "done"  ? (paused ? "highlight" : "success")
                    : pauseBusy === "error" ? "danger"
                    : paused ? "highlight"
                    : "default"
                  }
                  disabled={pauseBusy === "saving" || pauseBusy === "done"}
                  onClick={paused ? handleResume : handleOpenPauseForm}
                />
              )}
              {canPause && !paused && (
                <div className={cn("action-expand", showPauseForm && "is-open")}>
                  <div className="action-expand-content" inert={!showPauseForm || undefined}>
                    <PauseForm
                      reasonValue={pauseReasonInput}
                      onReasonChange={setPauseReasonInput}
                      busy={pauseBusy}
                      onConfirm={handleConfirmPause}
                      onCancel={() => setShowPauseForm(false)}
                    />
                  </div>
                </div>
              )}
            </ActionGroup>
          )}

          {/* ── 2b. SNAPSHOT — só feature-admin, e só em report congelado.
              Report encerrado é auto-congelado: o cliente vê o snapshot,
              não os dados ao vivo. Edição de checklist (volumetria, CPM…)
              numa campanha encerrada só aparece depois de reconstruir. */}
          {isFeatureAdmin(user) && freezeInfo?.frozen && (
            <ActionGroup label="Snapshot" className="drawer-section-rise drawer-stagger-5">
              <p className="text-[11px] text-fg-subtle leading-snug mb-1 px-0.5">
                Report congelado — o cliente vê o snapshot, não os dados ao vivo.
                Edições no checklist (volumetria, CPM negociado…) só aparecem após reconstruir.
                {freezeInfo.frozen_at && (
                  <> Congelado em <span className="text-fg-muted">{formatFrozenAt(freezeInfo.frozen_at)}</span>.</>
                )}
              </p>
              <ActionButton
                icon={
                  snapshotBusy === "saving" ? <Spinner />
                  : snapshotBusy === "done" ? <ClosureSuccessIcon />
                  : ICON.snapshot
                }
                label={
                  snapshotBusy === "saving" ? "Reconstruindo..."
                  : snapshotBusy === "done"  ? "Snapshot atualizado!"
                  : snapshotBusy === "error" ? "Erro — tentar de novo"
                  : "Atualizar snapshot"
                }
                variant={
                  snapshotBusy === "done"  ? "success"
                  : snapshotBusy === "error" ? "danger"
                  : "default"
                }
                disabled={snapshotBusy === "saving" || snapshotBusy === "done"}
                onClick={handleRebuildSnapshot}
              />
            </ActionGroup>
          )}

          {/* ── 3. CONTEÚDO DO REPORT — o que o cliente vê dentro do report. */}
          <ActionGroup label="Conteúdo do report" className="drawer-section-rise drawer-stagger-5">
            <ActionButton icon={ICON.loom}     label="Adicionar/editar Loom"   onClick={() => onLoom?.(short_token)} />
            <ActionButton icon={ICON.survey}   label="Gerenciar Survey"        onClick={() => onSurvey?.(short_token)} />
            <ActionButton icon={ICON.audience} label="Editar nomes de audiência" onClick={() => setAudienceModalOpen(true)} />
            <ActionButton icon={ICON.logo}     label="Trocar logo"             onClick={() => onLogo?.(short_token)} />
          </ActionGroup>

          {/* ── 4. ATRIBUIÇÕES — owner, agrupamento, e "Ver Negociado"
              (quando existe registro no Sales Center). Tudo aqui é
              metadado admin-only — não muda o que o cliente vê. */}
          <ActionGroup label="Atribuições" className="drawer-section-rise drawer-stagger-5">
            <ActionButton icon={ICON.owner} label="Gerenciar owner (CP/CS)" onClick={() => onOwner?.(campaign)} />
            <ActionButton
              icon={ICON.merge}
              label={merge_id ? "Gerenciar agrupamento" : "Agrupar com outros tokens"}
              variant={merge_id ? "highlight" : "default"}
              onClick={() => onMerge?.(campaign)}
            />
            {/* Slot de "Ver Negociado": ocupado por placeholder enquanto o
                fetch de getNegotiation tá em voo, pra evitar layout shift
                quando resolve e empurra os de baixo. Quando resolve sem
                negociação o slot some. */}
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
          </ActionGroup>

          {/* ── 5. MÍDIAS EXTERNAS — uploads de plataformas adjacentes
              (Amazon Ads, PDOOH). Última seção porque uso é nichado. */}
          <ActionGroup label="Mídias externas" className="drawer-section-rise drawer-stagger-5">
            <ActionButton icon={ICON.rmnd}  label="Gerenciar RMND (Amazon Ads)" onClick={() => onRmnd?.(short_token)} />
            <ActionButton icon={ICON.pdooh} label="Gerenciar PDOOH"             onClick={() => onPdooh?.(short_token)} />
          </ActionGroup>
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

      {/* Popup de fechamento — nested dialog sobre o drawer (Radix empilha
          as camadas; interagir aqui não fecha o drawer por baixo). */}
      <ClosureModal
        open={closureModalOpen}
        onOpenChange={setClosureModalOpen}
        campaign={{ short_token, client_name, campaign_name, start_date, end_date, early_end_date }}
        mode={closureModalMode}
        initialDetails={closureInitialDetails}
        onSaved={handleClosureSaved}
      />

      {/* Gestão dos nomes de audiência do anunciante. Lista as audiências cruas
          da campanha (reportData.detail) + overrides já existentes. `key`
          inclui a presença do reportData pra remontar (re-seed do hook) quando
          o detail termina de carregar. */}
      <AudienceOverridesModal
        key={`aud-${short_token}-${reportData ? "r" : "n"}`}
        open={audienceModalOpen}
        onOpenChange={setAudienceModalOpen}
        clientName={client_name}
        shortToken={short_token}
        detailRows={reportData?.detail}
        overrideMap={reportData?.audience_overrides}
      />
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

/**
 * Versão inline do DrawerStat — usada na strip compacta de Performance.
 * Layout: label tiny em cima (10px uppercase), valor bold em baixo. Cada
 * coluna do grid 4-col cai aqui. Sem borda/bg (o wrapper já tem).
 */
function DrawerInlineStat({ label, value, colorClass }) {
  return (
    <div className="text-center">
      <div className="text-[9.5px] uppercase tracking-widest font-bold text-fg-subtle">{label}</div>
      <div className={cn("text-[15px] font-bold tracking-tight tabular-nums leading-tight mt-0.5", colorClass)}>
        {value}
      </div>
    </div>
  );
}

/** Grupo de duas linhas (O2O + OOH) sob um label de mídia (DSP/VID).
 *  Reusa a barra horizontal sutil + valor textual em estilo igual à do card,
 *  pra manter consistência visual entre o card e o drawer. */
function FrenteGroup({ mediaLabel, subBars }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[9.5px] uppercase tracking-widest font-bold text-fg-subtle">
        {mediaLabel === "DSP" ? "Display" : "Vídeo"}
      </div>
      {subBars.map((s) => (
        <FrenteLine key={s.label} label={s.label} pacing={s.pacing} />
      ))}
    </div>
  );
}

function FrenteLine({ label, pacing }) {
  const has = pacing != null && !isNaN(pacing);
  const tier = pacingTierLocal(pacing);
  const fillPct = has ? Math.min(100, Math.max(0, Number(pacing))) : 0;
  const fillBg = {
    over:      "bg-signature",
    healthy:   "bg-success",
    attention: "bg-warning",
    critical:  "bg-danger",
  }[tier] || "bg-fg-subtle/40";
  return (
    <div className="flex items-center gap-2 leading-none">
      <span className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle w-9 shrink-0">
        {label}
      </span>
      <div className="relative h-[3px] flex-1 min-w-[40px] rounded-full bg-fg-subtle/15 overflow-visible">
        {has && (
          <span
            className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out", fillBg)}
            style={{ width: `${fillPct}%` }}
          />
        )}
        <span aria-hidden className="absolute right-0 top-[-2px] bottom-[-2px] w-px bg-fg-subtle/45" />
      </div>
      <span className={cn(
        "text-[12px] font-bold tabular-nums w-14 shrink-0 text-right",
        has ? pacingColorClass(pacing) : "text-fg-subtle"
      )}>
        {has ? formatPacingValue(pacing) : "—"}
      </span>
    </div>
  );
}

function pacingTierLocal(pacing) {
  if (pacing == null || isNaN(pacing)) return null;
  if (pacing < 90)  return "critical";
  if (pacing < 100) return "attention";
  if (pacing < 125) return "healthy";
  return "over";
}

/**
 * Versão compacta do OwnerRow — pensada pra grid 2-col side-by-side.
 * Avatar size sm, nome truncado em 1 linha, role acima como caption.
 * Email completo fica no `title` (tooltip nativo).
 */
function OwnerPill({ role, name, email }) {
  if (!email) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-surface border border-border border-dashed min-w-0">
        <div className="w-6 h-6 rounded-full bg-surface-strong flex items-center justify-center shrink-0">
          <span className="text-fg-subtle text-[10px]">?</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[9px] uppercase tracking-widest font-bold text-fg-subtle leading-none">{role.toUpperCase()}</div>
          <p className="text-[11px] text-fg-subtle italic truncate leading-tight mt-0.5">Sem owner</p>
        </div>
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-surface border border-border min-w-0"
      title={email}
    >
      <Avatar name={name} role={role} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="text-[9px] uppercase tracking-widest font-bold text-fg-subtle leading-none">{role.toUpperCase()}</div>
        <p className="text-[11px] text-fg truncate font-medium leading-tight mt-0.5">{name}</p>
      </div>
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

/**
 * Wrapper de uma sub-seção de ações no drawer. Cada grupo tem um label
 * uppercase 10px (mesmo padrão de PERÍODO / PERFORMANCE / OWNERS) e
 * stack interno com gap-1.5 entre os botões. Margin-bottom de 5 separa
 * grupos sem precisar de divider explícito.
 */
// frozen_at vem do backend como ISO tz-aware (UTC). Mostra data+hora em BRT,
// curto (DD/MM HH:mm). Best-effort: string inválida → "".
function formatFrozenAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    return d.toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
      timeZone: "America/Sao_Paulo",
    });
  } catch {
    return "";
  }
}

function ActionGroup({ label, className, children }) {
  return (
    <div className={cn("mb-5", className)}>
      <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-2">
        {label}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

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
 * Resumo do fechamento — o que foi registrado no popup ao encerrar:
 * pós-venda (com modo + data), material adicional e checkups semanais.
 * Tom success soft (fechamento completo é estado "bom"). Links clicáveis
 * abrem em nova aba; itens não registrados aparecem esmaecidos pra o
 * admin ver de relance o que falta preencher.
 */
function ClosureSummaryNote({ details }) {
  const fmtDate = (iso) => {
    if (!iso) return null;
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return null;
    return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
  };
  const modeLabel = (mode, date) => {
    if (!mode) return null;
    const base = mode === "apresentado" ? "apresentado" : "enviado";
    const dt = fmtDate(date);
    return dt ? `${base} em ${dt}` : base;
  };
  return (
    <div className="mb-5 rounded-lg border border-success/30 bg-success-soft px-3 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-success">{ICON.posvenda}</span>
        <span className="text-[11px] uppercase tracking-widest font-bold text-success">
          Fechamento
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <ClosureSummaryRow
          label="Pós-venda"
          ok={!!details.pos_venda_url}
          detail={modeLabel(details.pos_venda_mode, details.pos_venda_date)}
          href={details.pos_venda_url}
        />
        <ClosureSummaryRow
          label="Material adicional"
          ok={!!details.extra_url}
          detail={modeLabel(details.extra_mode, details.extra_date)}
          href={details.extra_url}
        />
        <ClosureSummaryRow
          label="Checkups semanais"
          ok={details.weekly_checkups != null}
          detail={
            details.weekly_checkups != null
              ? `${details.weekly_checkups} checkup${details.weekly_checkups === 1 ? "" : "s"}`
              : null
          }
        />
      </div>
    </div>
  );
}

// Labels dos itens de setup pendente — mesma régua do SetupChip do card.
const SETUP_PENDING_LABEL = {
  loom:   "Loom",
  survey: "Survey (negociado)",
  pdooh:  "PDOOH (negociado)",
  rmnd:   "RMND (negociado)",
};

/**
 * Bloco "Setup pendente" — itens esperados da campanha ainda não ativados
 * no hub. Âmbar (cobrança operacional, não erro). Os botões de ativação
 * (Loom/Survey/RMND/PDOOH) estão logo abaixo nas seções de ação do drawer.
 */
function SetupPendingNote({ setup }) {
  return (
    <div className="mb-5 rounded-lg border border-warning/40 bg-warning-soft px-3 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-warning">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </span>
        <span className="text-[11px] uppercase tracking-widest font-bold text-warning">
          Setup pendente · {setup.done}/{setup.total}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {(setup.missing || []).map((key) => (
          <div key={key} className="flex items-center gap-2 leading-snug">
            <span aria-hidden className="size-1.5 rounded-full shrink-0 bg-warning/70" />
            <span className="text-[11.5px] text-fg-muted">
              {SETUP_PENDING_LABEL[key] || key}
            </span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-fg-subtle italic mt-2">
        Ative pelos botões abaixo — itens negociados constam no Sales Center.
      </p>
    </div>
  );
}

/** Linha do resumo de fechamento — dot de presença + label + detalhe/link. */
function ClosureSummaryRow({ label, ok, detail, href }) {
  return (
    <div className="flex items-baseline gap-2 leading-snug">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full shrink-0 self-center",
          ok ? "bg-success" : "bg-fg-subtle/30",
        )}
      />
      <span className="text-[11.5px] font-semibold text-fg w-[8.5rem] shrink-0">{label}</span>
      {ok ? (
        href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11.5px] text-signature hover:underline truncate min-w-0"
          >
            {detail || "abrir"}
          </a>
        ) : (
          <span className="text-[11.5px] text-fg-muted truncate min-w-0">{detail}</span>
        )
      ) : (
        <span className="text-[11.5px] text-fg-subtle italic">não registrado</span>
      )}
    </div>
  );
}

/**
 * Bloco "OBSERVAÇÃO ADMIN" da pausa — mostra desde quando + motivo (se
 * houver). Cor signature soft pra casar com a família visual da pausa.
 */
function PausedNote({ pausedAt, reason }) {
  // pausedAt vem como ISO timestamp (não date) — formata pra "dd/mm/yyyy"
  // ignorando horas (não relevante pro contexto operacional).
  const fmt = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = d.getFullYear();
    return `${dd}/${mm}/${yy}`;
  };
  return (
    <div className="mb-5 rounded-lg border border-signature/30 bg-signature/5 px-3 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-signature">{ICON.pause}</span>
        <span className="text-[11px] uppercase tracking-widest font-bold text-signature">
          Pausada
        </span>
      </div>
      <p className="text-[11.5px] text-fg-muted leading-snug">
        <span className="font-semibold text-fg">Desde:</span> {fmt(pausedAt)}
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
 * Form inline pra pausa. Expande abaixo do botão "Pausar campanha". Um
 * campo só (motivo, opcional). Padrão visual igual o EarlyEndForm mas em
 * signature blue (cor da família "pausada"), pra reforçar diferenciação.
 */
function PauseForm({
  reasonValue, onReasonChange,
  busy,
  onConfirm, onCancel,
}) {
  const saving = busy === "saving";
  return (
    <div className="rounded-lg border border-signature/40 bg-signature/5 px-3 py-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-signature">{ICON.pause}</span>
        <span className="text-[11px] uppercase tracking-widest font-bold text-signature">
          Pausar campanha
        </span>
      </div>
      <label className="block">
        <span className="text-[10px] uppercase tracking-widest font-bold text-fg-subtle">
          Motivo <span className="text-fg-subtle font-normal normal-case tracking-normal">(opcional, admin-only)</span>
        </span>
        <textarea
          rows={2}
          value={reasonValue}
          onChange={(e) => onReasonChange(e.target.value)}
          disabled={saving}
          placeholder="Ex: cliente solicitou pausa enquanto revê creative..."
          className="mt-1 block w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-fg resize-none transition-shadow duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature/50"
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
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-signature text-white hover:bg-signature-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        >
          {saving && <Spinner />}
          {saving ? "Pausando..." : busy === "error" ? "Tentar de novo" : "Confirmar pausa"}
        </button>
      </div>
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
          className="mt-1 block w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm font-mono tabular-nums text-fg transition-shadow duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50"
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
          className="mt-1 block w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-fg resize-none transition-shadow duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50"
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

/**
 * Ícone animado disparado quando o admin acabou de pausar uma campanha.
 * Reusa as mesmas keyframes do ClosureSuccessIcon (check draw + halo +
 * pop) mas com halo em signature blue, casando com a cor da família
 * "pausada" e diferenciando visualmente do fechamento (verde).
 */
function PauseSuccessIcon() {
  return (
    <span className="closure-icon-pop relative inline-flex items-center justify-center w-[14px] h-[14px]">
      <span
        aria-hidden="true"
        className="closure-halo absolute rounded-full bg-signature pointer-events-none"
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

/**
 * Ícone animado disparado quando o admin acabou de retomar uma campanha.
 * Halo success green sugere "voltou ao ativo, bom".
 */
function ResumeSuccessIcon() {
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
