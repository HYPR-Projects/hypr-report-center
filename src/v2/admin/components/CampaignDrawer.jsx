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

import { Drawer, DrawerContent, DrawerHeader, DrawerBody, DrawerFooter } from "../../../ui/Drawer";
import { Button } from "../../../ui/Button";
import { cn } from "../../../ui/cn";
import { Avatar } from "../../../ui/Avatar";
import {
  formatDateRange,
  formatPacingValue,
  formatPct,
  pacingColorClass,
  ctrColorClass,
  vtrColorClass,
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
  owner: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
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
  onOwner,
  onOpenReport,
  teamMap = {},
}) {
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
  } = campaign;

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
        <DrawerHeader title={client_name} subtitle={`${campaign_name}  ·  ${short_token}`} />
        <DrawerBody>
          {/* Date range */}
          <div className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle mb-1">
            Período
          </div>
          <p className="text-sm font-mono tabular-nums text-fg mb-5">
            {formatDateRange(start_date, end_date) || "—"}
          </p>

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
            <ActionButton icon={ICON.loom}   label="Adicionar/editar Loom"    onClick={() => onLoom?.(short_token)} />
            <ActionButton icon={ICON.survey} label="Gerenciar Survey"          onClick={() => onSurvey?.(short_token)} />
            <ActionButton icon={ICON.logo}   label="Trocar logo"               onClick={() => onLogo?.(short_token)} />
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
  default: "text-fg hover:bg-surface-strong border-border",
  success: "text-success border-success/40 bg-success-soft",
  danger:  "text-danger border-danger/40 bg-danger-soft",
};

function ActionButton({ icon, label, variant = "default", onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg",
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

function Spinner() {
  return (
    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
