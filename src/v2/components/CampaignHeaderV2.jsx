// src/v2/components/CampaignHeaderV2.jsx
//
// Header da campanha — redesenhado em PR-13 pra bater com o mockup.
// Hero card com:
//   - Gradient sutil (radial blue glow no canto direito)
//   - Eyebrow com nome do cliente (uppercase tracking wide + barra azul)
//   - Título grande (campaign_name) com line-clamp 2
//   - Meta: período + duração + token badge
//   - Box do logo do cliente à direita (placeholder texto se não tiver)
//   - Status pill (rodando/encerrada/futura) integrado no eyebrow
//
// Bg sólido (surface-2) + border-strong garantem contraste visual
// claro contra canvas. O glow radial vem por inline style (gradient
// arbitrário, não tem utility direta).

import { useEffect, useMemo, useState } from "react";

import { useLogoAnalysis } from "../hooks/useLogoAnalysis";
import { useTheme } from "../hooks/useTheme";
import { TokenChip } from "../admin/components/TokenChip";
import { NegotiationModal } from "./NegotiationModal";
import { getNegotiation } from "../../lib/api";

const fmtDateShort = (ymd) => {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "short",
  });
};

const daysBetween = (startStr, endStr) => {
  if (!startStr || !endStr) return null;
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  return Math.round((end - start) / 86400000) + 1;
};

function deriveStatus(startStr, endStr) {
  if (!startStr || !endStr) return { dot: "neutral", label: null };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [sy, sm, sd] = startStr.split("-").map(Number);
  const [ey, em, ed] = endStr.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  if (today < start) return { dot: "warning", label: "Futura" };
  if (today > end) return { dot: "neutral", label: "Encerrada" };
  return { dot: "success", label: "Rodando" };
}

export function CampaignHeaderV2({
  campaignName,
  clientName,
  logo, // data URL base64 (PNG/JPG/SVG) — opcional. Se ausente, cai no placeholder de texto
  startDate,
  endDate,
  shortToken, // ex: "UT10QW" — vai no token-badge à direita do meta
  // ── Merge Reports ────────────────────────────────────────────────────
  // Quando o report é uma campanha mesclada, `mergeMeta` traz o grupo
  // (members + active_token). `currentView` reflete a URL `?view=<token>`:
  //   null → visão agregada (default)
  //   "<token>" → drill-down em um membro
  // `onViewChange` recebe o novo valor (null ou short_token).
  mergeMeta = null,
  currentView = null,
  onViewChange,
  isBonusOnly = false,
  // Totals legacy do checklist_info (data.totals[0]) — usado pelo
  // NegotiationModal pra preencher OOH/Display/Video que o Sales Center
  // não armazena em colunas próprias.
  legacyTotals = null,
  // Payload completo do report — usado pelo NegotiationModal pra detectar
  // se cada feature/tactic do "negociado" já está ATIVADA (entrega real
  // OU cadastro paralelo) ou PENDENTE.
  reportData = null,
}) {
  const status = deriveStatus(startDate, endDate);
  const start = fmtDateShort(startDate);
  const end = fmtDateShort(endDate);
  const days = daysBetween(startDate, endDate);
  const isMerged = !!mergeMeta;

  // Negociação (Sales Center) — fetch lazy. Em campanha merged, busca
  // por TODOS os membros em paralelo e o modal vira multi-PI com tabs;
  // em campanha single-PI, fica com 1 negociação só. Botão aparece se
  // pelo menos um membro tiver registro no Sales Center.
  const [negotiationsByToken, setNegotiationsByToken] = useState({});
  const [negoOpen, setNegoOpen] = useState(false);
  // Lista de membros pra fetch — sempre tratada como array pra unificar
  // o caminho merged vs single. Quando não há merge, vira [{short_token}].
  const negotiationMembers = useMemo(() => {
    if (mergeMeta?.members?.length) {
      return mergeMeta.members.map((m) => ({
        short_token: m.short_token,
        start_date: m.start_date,
        is_active: m.short_token === mergeMeta.active_token,
      }));
    }
    if (shortToken) return [{ short_token: shortToken }];
    return [];
  }, [shortToken, mergeMeta]);
  // Chave pro effect — string estável que muda só quando a lista de
  // tokens em si muda (não quando o mergeMeta troca de identidade).
  const memberTokensKey = negotiationMembers.map((m) => m.short_token).join(",");
  useEffect(() => {
    if (!negotiationMembers.length) return;
    let cancelled = false;
    Promise.all(
      negotiationMembers.map((m) =>
        getNegotiation(m.short_token).then((n) => [m.short_token, n]),
      ),
    ).then((entries) => {
      if (cancelled) return;
      setNegotiationsByToken(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [memberTokensKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasAnyNegotiation = Object.values(negotiationsByToken).some(Boolean);

  // Logo dinâmica entre temas com UMA única imagem
  // ──────────────────────────────────────────────
  // O sistema analisa a logo (canvas API) e classifica em 4 buckets:
  //   • monochrome-light / monochrome-dark → invert quando tema conflita
  //   • colored                            → renderiza como veio
  //   • colored-dark                       → boost em dark (clareia
  //                                          mantendo cor — ex: roxo Eudora)
  //
  // Filters CSS aplicados (PNG/JPG/SVG; alpha preservado):
  //   - invert(1)                  → monochrome contrário ao tema
  //   - brightness(1.7) contrast() → colored-dark em dark theme. Não inverte
  //     (silhueta branca destruiria identidade); clareia o roxo/marrom/etc
  //     pra ficar visível contra fundo escuro mantendo a cor da marca.
  const logoKind = useLogoAnalysis(logo);
  const [theme] = useTheme();
  const shouldInvertLogo =
    (logoKind === "monochrome-light" && theme === "light") ||
    (logoKind === "monochrome-dark" && theme === "dark");
  const shouldBoostLogo = logoKind === "colored-dark" && theme === "dark";
  const logoFilter = shouldInvertLogo
    ? "invert(1)"
    : shouldBoostLogo
      ? "brightness(1.7) contrast(1.1)"
      : undefined;

  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-border-strong bg-surface-2 p-6 md:p-8"
      aria-label="Cabeçalho da campanha"
    >
      {/* Glow radial no canto superior direito (mockup hero pattern) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at top right, var(--color-signature-glow) 0%, transparent 60%)",
        }}
      />

      <div className="relative grid grid-cols-1 md:grid-cols-[1fr_auto] gap-6 items-start">
        <div className="min-w-0">
          {/* Eyebrow: barra azul + nome do cliente + status */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="inline-block w-6 h-0.5 rounded-full bg-signature" aria-hidden />
            <span className="text-[11px] font-bold uppercase tracking-[1.5px] text-signature">
              {clientName || "Campanha"}
            </span>
            {status.label && (
              <>
                <span className="text-fg-subtle text-xs" aria-hidden>·</span>
                <StatusPill status={status} />
              </>
            )}
            {isBonusOnly && (
              <>
                <span className="text-fg-subtle text-xs" aria-hidden>·</span>
                <BonusPill />
              </>
            )}
          </div>

          {/* Título */}
          <h1 className="text-2xl md:text-3xl lg:text-[34px] font-extrabold text-fg leading-[1.15] tracking-[-0.7px] line-clamp-2">
            {campaignName || "Campanha sem nome"}
          </h1>

          {/* Meta: período + duração + token */}
          <div className="mt-3 flex items-center gap-3 flex-wrap text-sm text-fg-muted">
            {start && end ? (
              <span className="tabular-nums">
                {start} <span className="text-fg-subtle">→</span> {end}
              </span>
            ) : (
              <span className="text-fg-subtle">Período não definido</span>
            )}
            {days && (
              <>
                <span className="text-fg-subtle">·</span>
                <span className="tabular-nums">{days} {days === 1 ? "dia" : "dias"}</span>
              </>
            )}
            {shortToken && !isMerged && (
              <>
                <span className="text-fg-subtle">·</span>
                <TokenChip
                  token={shortToken}
                  variant="report"
                  icon={<CircleIcon className="size-3" />}
                />
              </>
            )}
            {isMerged && (
              <>
                <span className="text-fg-subtle">·</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-signature-soft border border-signature/40 text-signature text-[11px] font-bold tracking-wider">
                  <MergeIcon className="size-3" />
                  {mergeMeta.members.length} reports agrupados
                </span>
              </>
            )}
            {hasAnyNegotiation && (
              <>
                <span className="text-fg-subtle">·</span>
                <NegotiationButton onClick={() => setNegoOpen(true)} />
              </>
            )}
          </div>

          {/* Filtro de visão (Merge Reports) — pills com "Visão agregada"
              + cada membro. Aparece apenas quando o report é agrupado.
              Default = agregada. Click em outro pill faz refetch via
              ?view=<token> e renderiza dados single-token. */}
          {isMerged && (
            <MergeViewSwitcher
              members={mergeMeta.members}
              activeToken={mergeMeta.active_token}
              currentView={currentView}
              onChange={onViewChange}
            />
          )}
        </div>

        {/* Logo do cliente — img quando o admin fez upload, senão fallback
            texto com inicial estilizada.

            Visual: container 100% transparente quando há logo. A imagem
            flutua direto sobre o card hero, sem borda nem fundo, deixando
            o asset da marca falar por si. Sem upload, mostra placeholder
            textual com fundo translúcido + borda pra ancorar a inicial.

            Filter automático em conflito visual:
              • Logo monochrome-light em tema light → invert(1) (vira escura)
              • Logo monochrome-dark  em tema dark  → invert(1) (vira clara)
              • Logo colored-dark     em tema dark  → brightness(1.7) (clareia)
              • Restante                            → renderiza como veio

            Padding generoso (px-6 py-4) dá margem pra logo respirar dentro
            do espaço alocado em vez de encostar nas bordas. */}
        {(logo || clientName) && (
          <div
            className={`hidden md:flex items-center justify-center w-44 h-24 rounded-lg overflow-hidden transition-colors ${
              logo
                ? "px-4 py-2"
                : "border border-border bg-white/[0.03] p-3"
            }`}
          >
            {logo ? (
              <img
                src={logo}
                alt={clientName ? `Logo ${clientName}` : "Logo do cliente"}
                className="max-w-full max-h-full object-contain transition-[filter] duration-200"
                style={logoFilter ? { filter: logoFilter } : undefined}
                loading="eager"
              />
            ) : (
              <span className="text-fg-muted font-semibold text-sm tracking-wide truncate">
                {clientName}
              </span>
            )}
          </div>
        )}
      </div>

      <NegotiationModal
        open={negoOpen}
        onOpenChange={setNegoOpen}
        negotiationsByToken={negotiationsByToken}
        members={negotiationMembers}
        defaultActiveToken={currentView && currentView !== "aggregated" ? currentView : (mergeMeta?.active_token || shortToken)}
        legacyTotals={legacyTotals}
        reportData={reportData}
      />
    </section>
  );
}

// Botão "Negociado" — chip signature com ícone de documento. Mesmo
// padding/altura do token chip e da pílula de merge pra alinhar visualmente
// na meta line. Aparece só quando a campanha tem registro no Sales Center.
function NegotiationButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md cursor-pointer",
        "bg-signature-soft border border-signature/40 text-signature",
        "text-[11px] font-bold uppercase tracking-wider",
        "hover:bg-signature/15 hover:border-signature/60 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-surface-2",
      ].join(" ")}
      aria-label="Ver resumo da negociação"
    >
      <DocChipIcon className="size-3" />
      Negociado
    </button>
  );
}

function DocChipIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function StatusPill({ status }) {
  const dotClass =
    status.dot === "success"
      ? "bg-success"
      : status.dot === "warning"
        ? "bg-warning"
        : "bg-fg-subtle";
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-fg-muted">
      <span className={`size-1.5 rounded-full ${dotClass}`} aria-hidden />
      {status.label}
    </span>
  );
}

// Selo pra campanhas 100% bonificadas (cortesia HYPR). Usa o token
// warning (#EDD900 dourado) pra carregar a conotação de "presente" sem
// puxar uma cor nova. Pílula sólida pra contrastar com a StatusPill
// (que é discreta com dot+texto) — bonificada é uma característica que
// merece destaque, não uma nuance.
function BonusPill() {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-warning-soft border border-warning/40 text-warning text-[10px] font-bold uppercase tracking-wider"
      title="Campanha 100% bonificada — todo o volume entregue é cortesia HYPR"
    >
      <GiftIcon className="size-2.5" />
      Bonificada
    </span>
  );
}

function GiftIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 12 20 22 4 22 4 12" />
      <rect x="2" y="7" width="20" height="5" />
      <line x1="12" y1="22" x2="12" y2="7" />
      <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
      <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
    </svg>
  );
}

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

function MergeIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6"  cy="6"  r="2.5" />
      <circle cx="6"  cy="18" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M9 6c4 0 6 2 6 6M9 18c4 0 6-2 6-6" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MergeViewSwitcher — pills do mês (mais recente → mais antigo) + "Visão
// agregada" no fim. Convenção de URL:
//   ?view=aggregated   → visão agregada explícita
//   ?view=<token>      → drill-down em um membro
//   (sem ?view=)       → default backend = active_token (mês atual);
//                        no UI, o pill do active_token vem destacado.
// Click em qualquer pill atualiza URL e o ClientDashboardV2 refaz o fetch.
// ─────────────────────────────────────────────────────────────────────────────
function MergeViewSwitcher({ members, activeToken, currentView, onChange }) {
  // Ordem desc por start_date — mais recente primeiro. Cliente abre o
  // report e vê o mês atual em destaque, com os anteriores em ordem
  // decrescente. A agregada vem por último (resumo do conjunto).
  const sortedMembers = [...(members || [])].sort((a, b) =>
    (b.start_date || "").localeCompare(a.start_date || "")
  );
  const isAggregatedSelected =
    currentView === "aggregated" || currentView === "all";
  return (
    <div className="mt-4 flex items-center gap-1.5 flex-wrap">
      {sortedMembers.map((m) => {
        const isActive = m.short_token === activeToken;
        const monthLabel = formatMonthShort(m.start_date);
        // Sem view explícito: o backend retorna active_token, então o
        // pill do active_token vem destacado por default. Click em outro
        // pill seta view e recarrega.
        const selected =
          currentView === m.short_token ||
          (!currentView && isActive);
        return (
          <ViewPill
            key={m.short_token}
            label={monthLabel || m.short_token}
            sublabel={
              <span className="font-mono text-[9px]">{m.short_token}</span>
            }
            selected={selected}
            badge={isActive ? "atual" : null}
            onClick={() => onChange?.(m.short_token)}
          />
        );
      })}
      <ViewPill
        label="Visão agregada"
        sublabel="todos os meses"
        selected={isAggregatedSelected}
        onClick={() => onChange?.("aggregated")}
      />
    </div>
  );
}

function ViewPill({ label, sublabel, selected, badge, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
        selected
          ? "bg-signature text-white border-signature hover:bg-signature-hover"
          : "bg-surface-2 text-fg-muted border-border hover:text-fg hover:bg-surface-3 hover:border-signature/40",
      ].join(" ")}
    >
      <span>{label}</span>
      {sublabel && (
        <span
          className={
            selected
              ? "text-white/70"
              : "text-fg-subtle"
          }
        >
          {sublabel}
        </span>
      )}
      {badge && (
        <span
          className={[
            "text-[8.5px] uppercase tracking-widest font-bold px-1 py-px rounded",
            selected
              ? "bg-white/20 text-white"
              : "bg-success/15 text-success",
          ].join(" ")}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// "2026-02-01" → "Fev 26"
function formatMonthShort(ymd) {
  if (!ymd || typeof ymd !== "string") return null;
  const [yStr, mStr] = ymd.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!y || !m) return null;
  const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  return `${MESES[m - 1]} ${String(y).slice(-2)}`;
}
