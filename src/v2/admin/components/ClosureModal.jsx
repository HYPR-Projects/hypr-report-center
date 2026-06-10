// src/v2/admin/components/ClosureModal.jsx
//
// Popup do fechamento de campanha — abre quando o admin clica em "Marcar
// como encerrada" no CampaignDrawer (mode="close") ou em "Pós-venda &
// fechamento" numa campanha já encerrada (mode="edit").
//
// Coleta:
//   • Link do pós-venda (Google Slides, opcional) + se foi apresentado ou
//     enviado ao cliente. Quando presente, vira o chip "Pós-venda" no header
//     do report do cliente, com preview embutido do deck (iframe /embed).
//   • Link de material adicional (opcional) + mesma pergunta.
//   • Quantidade de checkups semanais (obrigatório) — e-mails de fup/resumo
//     mandados ao cliente. Métrica interna, NÃO aparece no report.
//
// Nested dialog sobre o Drawer (ambos Radix) — o DismissableLayer só fecha a
// camada do topo, então interagir aqui não derruba o drawer por baixo.

import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../../../ui/cn";
import { saveCampaignClosure, saveClosureDetails } from "../../../lib/api";
import { isGoogleSlidesUrl } from "../../../lib/slides";
import { toast } from "../../../lib/toast";

export function ClosureModal({
  open,
  onOpenChange,
  campaign,            // {short_token, client_name, campaign_name}
  mode = "close",      // "close" → encerra + salva detalhes | "edit" → só detalhes
  initialDetails = null,
  onSaved,             // chamado após save OK — (short_token, details)
}) {
  const [posVendaUrl, setPosVendaUrl]   = useState("");
  const [posVendaMode, setPosVendaMode] = useState(null); // "apresentado" | "enviado"
  const [extraUrl, setExtraUrl]         = useState("");
  const [extraMode, setExtraMode]       = useState(null);
  const [checkups, setCheckups]         = useState("");
  const [busy, setBusy]                 = useState(false);
  const [error, setError]               = useState(null);

  // Reset/prefill toda vez que abre — edit mode pré-popula com o que já
  // foi salvo; close mode começa limpo.
  useEffect(() => {
    if (!open) return;
    setPosVendaUrl(initialDetails?.pos_venda_url || "");
    setPosVendaMode(initialDetails?.pos_venda_mode || null);
    setExtraUrl(initialDetails?.extra_url || "");
    setExtraMode(initialDetails?.extra_mode || null);
    setCheckups(
      initialDetails?.weekly_checkups != null
        ? String(initialDetails.weekly_checkups)
        : "",
    );
    setBusy(false);
    setError(null);
  }, [open, initialDetails]);

  const posVendaFilled = posVendaUrl.trim().length > 0;
  const posVendaIsSlides = posVendaFilled && isGoogleSlidesUrl(posVendaUrl);
  const extraFilled = extraUrl.trim().length > 0;

  const checkupsNum = useMemo(() => {
    if (checkups.trim() === "") return null;
    const n = Number(checkups);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }, [checkups]);

  const canSave =
    !busy &&
    checkupsNum != null &&                       // obrigatório
    (!posVendaFilled || (posVendaIsSlides && posVendaMode)) &&
    (!extraFilled || extraMode);

  const handleSave = async () => {
    if (!canSave || !campaign?.short_token) return;
    setBusy(true);
    setError(null);
    const details = {
      pos_venda_url:   posVendaFilled ? posVendaUrl.trim() : null,
      pos_venda_mode:  posVendaFilled ? posVendaMode : null,
      extra_url:       extraFilled ? extraUrl.trim() : null,
      extra_mode:      extraFilled ? extraMode : null,
      weekly_checkups: checkupsNum,
    };
    try {
      if (mode === "close") {
        await saveCampaignClosure({
          short_token: campaign.short_token,
          closed: true,
          details,
        });
      } else {
        await saveClosureDetails({ short_token: campaign.short_token, details });
        toast.success("Dados do fechamento atualizados");
      }
      onSaved?.(campaign.short_token, details);
      onOpenChange?.(false);
    } catch (e) {
      setError(e?.message || "Erro ao salvar. Tente de novo.");
    } finally {
      setBusy(false);
    }
  };

  const isClose = mode === "close";

  return (
    <Dialog.Root open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-[60] bg-black/60 backdrop-blur-[3px]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "duration-200",
          )}
        />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-[70]",
            "-translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-32px)] max-w-[560px]",
            "max-h-[calc(100vh-48px)] overflow-hidden",
            "rounded-2xl border border-border-strong bg-canvas-elevated shadow-2xl",
            "flex flex-col outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
            "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            "duration-200",
          )}
        >
          {/* ── Header ──────────────────────────────────────────────── */}
          <div className="px-6 pt-6 pb-5 border-b border-border bg-surface-2/60 relative shrink-0">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(ellipse at top right, var(--color-signature-glow) 0%, transparent 70%)",
              }}
            />
            <div className="relative">
              <div className="flex items-center gap-2 mb-2">
                <span className="inline-block w-6 h-0.5 rounded-full bg-signature" aria-hidden />
                <Dialog.Title asChild>
                  <span className="text-[10.5px] font-bold uppercase tracking-[1.5px] text-signature">
                    {isClose ? "Encerrar campanha" : "Pós-venda & fechamento"}
                  </span>
                </Dialog.Title>
              </div>
              <h2 className="text-lg font-bold text-fg leading-tight tracking-[-0.3px] line-clamp-1">
                {campaign?.client_name || "Campanha"}
              </h2>
              <Dialog.Description asChild>
                <p className="mt-0.5 text-xs text-fg-muted line-clamp-1">
                  {campaign?.campaign_name}
                  {campaign?.short_token && (
                    <span className="font-mono text-fg-subtle"> · {campaign.short_token}</span>
                  )}
                </p>
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Fechar"
              disabled={busy}
              className={cn(
                "absolute top-4 right-4 inline-flex items-center justify-center w-8 h-8 rounded-md",
                "text-fg-muted hover:text-fg hover:bg-surface transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </Dialog.Close>
          </div>

          {/* ── Body ────────────────────────────────────────────────── */}
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
            {/* Pós-venda */}
            <section>
              <SectionLabel
                icon={<SlidesIcon className="size-3.5" />}
                title="Pós-venda"
                hint="Link do Google Slides · opcional"
              />
              <input
                type="url"
                value={posVendaUrl}
                onChange={(e) => setPosVendaUrl(e.target.value)}
                disabled={busy}
                placeholder="https://docs.google.com/presentation/d/..."
                className={fieldClass(posVendaFilled && !posVendaIsSlides)}
              />
              {posVendaFilled && !posVendaIsSlides && (
                <FieldNote tone="danger">
                  Precisa ser um link do Google Slides (docs.google.com/presentation).
                </FieldNote>
              )}
              {posVendaIsSlides && (
                <>
                  <FieldNote tone="success">
                    O cliente verá o deck com preview embutido no report.
                  </FieldNote>
                  <p className="mt-1 text-[10.5px] text-fg-subtle leading-snug">
                    Confirme que o deck está compartilhado como{" "}
                    <span className="font-semibold text-fg-muted">
                      “qualquer pessoa com o link”
                    </span>{" "}
                    — senão o preview mostra a tela de login do Google.
                  </p>
                </>
              )}
              {posVendaFilled && (
                <DeliveryModeSegment
                  value={posVendaMode}
                  onChange={setPosVendaMode}
                  disabled={busy}
                />
              )}
            </section>

            {/* Material adicional */}
            <section>
              <SectionLabel
                icon={<PaperclipIcon className="size-3.5" />}
                title="Material adicional"
                hint="Qualquer outro link usado com o cliente · opcional"
              />
              <input
                type="url"
                value={extraUrl}
                onChange={(e) => setExtraUrl(e.target.value)}
                disabled={busy}
                placeholder="https://..."
                className={fieldClass(false)}
              />
              {extraFilled && (
                <DeliveryModeSegment
                  value={extraMode}
                  onChange={setExtraMode}
                  disabled={busy}
                />
              )}
            </section>

            {/* Checkups semanais */}
            <section>
              <SectionLabel
                icon={<MailCheckIcon className="size-3.5" />}
                title="Checkups semanais"
                hint="E-mails de fup/resumo enviados ao cliente · obrigatório"
              />
              <div className="flex items-center gap-1.5">
                <StepperButton
                  label="Diminuir"
                  disabled={busy || (checkupsNum ?? 0) <= 0}
                  onClick={() => setCheckups(String(Math.max(0, (checkupsNum ?? 0) - 1)))}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M5 12h14" /></svg>
                </StepperButton>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={checkups}
                  onChange={(e) => setCheckups(e.target.value)}
                  disabled={busy}
                  placeholder="Ex: 4"
                  className={cn(
                    fieldClass(checkups.trim() !== "" && checkupsNum == null),
                    "w-20 text-center tabular-nums",
                    // Esconde os spinners nativos — o stepper custom já cobre
                    "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
                  )}
                />
                <StepperButton
                  label="Aumentar"
                  disabled={busy}
                  onClick={() => setCheckups(String((checkupsNum ?? 0) + 1))}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                </StepperButton>
              </div>
              {checkups.trim() !== "" && checkupsNum == null && (
                <FieldNote tone="danger">Use um número inteiro (0 ou mais).</FieldNote>
              )}
              <p className="mt-1.5 text-[10.5px] text-fg-subtle italic">
                Métrica interna — não aparece no report do cliente.
              </p>
            </section>

            {error && (
              <div className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2.5 text-xs text-danger font-medium">
                {error}
              </div>
            )}
          </div>

          {/* ── Footer ──────────────────────────────────────────────── */}
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border bg-surface shrink-0">
            <button
              type="button"
              onClick={() => onOpenChange?.(false)}
              disabled={busy}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-fg-muted hover:text-fg hover:bg-surface-strong transition-colors disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className={cn(
                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold",
                "bg-signature text-white hover:bg-signature-hover transition-colors",
                "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
              )}
            >
              {busy && <BusySpinner />}
              {busy
                ? "Salvando..."
                : isClose
                  ? "Marcar como encerrada"
                  : "Salvar alterações"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Building blocks ─────────────────────────────────────────────────────

function SectionLabel({ icon, title, hint }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="text-signature shrink-0">{icon}</span>
      <span className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle">
        {title}
      </span>
      {hint && (
        <span className="text-[10.5px] text-fg-subtle font-normal normal-case tracking-normal">
          — {hint}
        </span>
      )}
    </div>
  );
}

function fieldClass(invalid) {
  return cn(
    "block w-full rounded-md border bg-surface px-3 py-2 text-sm text-fg",
    "transition-shadow duration-150",
    "placeholder:text-fg-subtle/70",
    "focus-visible:outline-none focus-visible:ring-2",
    invalid
      ? "border-danger/50 focus-visible:ring-danger/50"
      : "border-border focus-visible:ring-signature/50",
  );
}

function FieldNote({ tone, children }) {
  return (
    <p
      className={cn(
        "mt-1.5 text-[11px] font-medium",
        tone === "danger" ? "text-danger" : "text-success",
      )}
    >
      {children}
    </p>
  );
}

/**
 * Segmento "Apresentado | Enviado" — aparece quando o link foi preenchido.
 * Obrigatório nesse caso (o botão de salvar trava sem seleção).
 */
function DeliveryModeSegment({ value, onChange, disabled }) {
  return (
    <div className="mt-2.5">
      <span className="block text-[10px] uppercase tracking-widest font-bold text-fg-subtle mb-1.5">
        Como chegou ao cliente?
      </span>
      <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 gap-0.5">
        {[
          { key: "apresentado", label: "Apresentado", icon: <PresentIcon className="size-3" /> },
          { key: "enviado",     label: "Enviado",     icon: <SendIcon className="size-3" /> },
        ].map((opt) => {
          const selected = value === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              disabled={disabled}
              onClick={() => onChange(opt.key)}
              aria-pressed={selected}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold",
                "transition-colors cursor-pointer disabled:cursor-not-allowed",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                selected
                  ? "bg-signature text-white"
                  : "text-fg-muted hover:text-fg hover:bg-surface-strong",
              )}
            >
              {opt.icon}
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepperButton({ label, disabled, onClick, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center w-9 h-[38px] rounded-md shrink-0",
        "border border-border bg-surface text-fg-muted",
        "hover:text-fg hover:bg-surface-strong transition-colors cursor-pointer",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature/50",
      )}
    >
      {children}
    </button>
  );
}

function BusySpinner() {
  return (
    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── Icons (lucide outline, mesma família do CampaignDrawer) ─────────────

function SlidesIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function PaperclipIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function MailCheckIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      <path d="m16 19 2 2 4-4" />
    </svg>
  );
}

function PresentIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
    </svg>
  );
}

function SendIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}
