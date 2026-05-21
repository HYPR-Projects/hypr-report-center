// src/v2/admin/components/AlertsBell.jsx
//
// Sino de alertas inteligentes no header do menu admin. Click abre popover
// com lista categorizada (Tudo / Operação / Financeiro / Sinais / Conta).
//
// Engine de geração mora em ../lib/alerts/. Componente é "burro" — recebe
// `alerts` já calculados e renderiza.
//
// Persistência: "lidos" guardados em localStorage por (ruleId+campaign+media).
// Não é "dismiss permanente" — se o alerta voltar a disparar amanhã com
// detalhes diferentes (impacto BRL mudou, projeção mudou), ele reaparece
// como não-lido. Heurística boa o bastante pra v1 sem persistência server-side.

import { useState, useMemo, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../../ui/cn";
import {
  SEVERITY,
  CATEGORY,
  CATEGORY_META,
} from "../lib/alerts/constants";
import { countBySeverity, groupByCategory } from "../lib/alerts/engine";

const READ_STORAGE_KEY = "hypr.alerts.read.v1";

// ────────────────────────────────────────────────────────────────────────
// Persistência de "lidos"
// ────────────────────────────────────────────────────────────────────────
function loadReadSet() {
  try {
    const raw = localStorage.getItem(READ_STORAGE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch { return new Set(); }
}

function saveReadSet(set) {
  try {
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...set]));
  } catch { /* ignore */ }
}

// "Fingerprint" do alerta: id + impactBrl arredondado a 100. Se o impacto
// mudou significativamente, vira "novo".
function fingerprint(a) {
  const bucket = Math.round((a.impactBrl || 0) / 100) * 100;
  return `${a.id}#${bucket}`;
}

// ────────────────────────────────────────────────────────────────────────
// Visual tokens por severidade
// ────────────────────────────────────────────────────────────────────────
const SEVERITY_TONE = {
  [SEVERITY.CRITICAL]: { dot: "bg-danger",    text: "text-danger",    ring: "ring-danger/40" },
  [SEVERITY.WARNING]:  { dot: "bg-warning",   text: "text-warning",   ring: "ring-warning/40" },
  [SEVERITY.INFO]:     { dot: "bg-fg-muted",  text: "text-fg-muted",  ring: "ring-fg-muted/40" },
  [SEVERITY.POSITIVE]: { dot: "bg-success",   text: "text-success",   ring: "ring-success/40" },
};

// ────────────────────────────────────────────────────────────────────────
// Icons
// ────────────────────────────────────────────────────────────────────────
function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Componente principal
// ────────────────────────────────────────────────────────────────────────
/**
 * Props:
 *   alerts            — Alert[] (de engine.generateAlerts)
 *   onDrillCampaign   — (short_token) => void  (clicar item abre sheet no parent)
 *   onOpenDiagnostico — () => void  (rodapé "Ver no Diagnóstico")
 */
export function AlertsBell({
  alerts = [],
  onDrillCampaign,
  onOpenDiagnostico,
}) {
  const [readSet, setReadSet] = useState(loadReadSet);
  const [activeTab, setActiveTab] = useState("all");
  const [open, setOpen] = useState(false);

  useEffect(() => { saveReadSet(readSet); }, [readSet]);

  // Conta apenas críticos NÃO lidos pro badge — mantém minimalista.
  const unreadCriticalCount = useMemo(() => {
    return alerts.filter((a) => a.severity === SEVERITY.CRITICAL && !readSet.has(fingerprint(a))).length;
  }, [alerts, readSet]);

  const totalCount = alerts.length;
  const counts = useMemo(() => countBySeverity(alerts), [alerts]);
  const grouped = useMemo(() => groupByCategory(alerts), [alerts]);

  const filtered = useMemo(() => {
    if (activeTab === "all") return alerts;
    return grouped[activeTab] || [];
  }, [alerts, activeTab, grouped]);

  const markAllRead = () => {
    const next = new Set(readSet);
    for (const a of alerts) next.add(fingerprint(a));
    setReadSet(next);
  };

  const markOneRead = (alert) => {
    const next = new Set(readSet);
    next.add(fingerprint(alert));
    setReadSet(next);
  };

  const handleItemClick = (alert) => {
    markOneRead(alert);
    // Macros (H1/H2/H3) não têm campanha individual — sem deep-dive,
    // apenas marca como visto.
    if (!alert.campaign?.short_token) return;
    setOpen(false); // fecha popover, sheet vai abrir por cima
    onDrillCampaign?.(alert.campaign.short_token);
  };

  // Tabs visíveis — só mostra a tab se a categoria tem ≥1 alerta
  const tabs = [
    { id: "all", label: "Tudo", count: totalCount },
    ...Object.entries(CATEGORY_META).map(([id, meta]) => ({
      id,
      label: meta.label,
      count: (grouped[id] || []).length,
    })).filter((t) => t.count > 0),
  ];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Alertas — ${unreadCriticalCount} críticos não vistos`}
          title={
            totalCount === 0
              ? "Sem alertas no momento"
              : `${totalCount} alertas (${counts.critical} críticos)`
          }
          className={cn(
            "relative inline-flex items-center justify-center size-9 rounded-full cursor-pointer",
            "border border-border bg-surface text-fg-muted",
            "hover:border-border-strong hover:bg-surface-strong hover:text-fg",
            "transition-[colors,transform] duration-150",
            "active:scale-90",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
          )}
        >
          <BellIcon />
          {unreadCriticalCount > 0 && (
            <span
              aria-hidden
              className={cn(
                "absolute -top-0.5 -right-0.5",
                "inline-flex items-center justify-center",
                "min-w-[16px] h-4 px-1 rounded-full",
                "text-[9px] font-bold tabular-nums leading-none",
                "bg-danger text-white",
                "ring-2 ring-canvas-elevated",
                "animate-pulse",
              )}
            >
              {unreadCriticalCount > 99 ? "99+" : unreadCriticalCount}
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          align="end"
          collisionPadding={16}
          className={cn(
            "z-50 w-[420px] max-w-[calc(100vw-32px)]",
            "rounded-xl border border-border bg-canvas-elevated shadow-lg",
            "overflow-hidden",
            "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
            "focus-visible:outline-none",
          )}
        >
          {/* ── Header ──────────────────────────────────────────────── */}
          <div className="px-4 py-3 border-b border-border bg-surface-strong flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">
                Alertas
              </span>
              {totalCount > 0 && (
                <span className="text-[11px] text-fg-muted tabular-nums">
                  {totalCount} · <span className="text-danger">{counts.critical}</span>
                  {counts.warning > 0 && (
                    <> · <span className="text-warning">{counts.warning}</span></>
                  )}
                </span>
              )}
            </div>
            {totalCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-[11px] text-fg-muted hover:text-fg font-medium cursor-pointer"
                title="Marcar tudo como visto"
              >
                Marcar tudo
              </button>
            )}
          </div>

          {/* ── Tabs ────────────────────────────────────────────────── */}
          {totalCount > 0 && tabs.length > 1 && (
            <div className="flex items-center gap-1 px-2 py-2 border-b border-border overflow-x-auto">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 h-7 rounded-md cursor-pointer",
                    "text-[11px] font-medium whitespace-nowrap transition-colors",
                    activeTab === t.id
                      ? "bg-canvas-deeper text-fg"
                      : "text-fg-muted hover:bg-surface hover:text-fg",
                  )}
                >
                  {t.label}
                  <span className={cn(
                    "inline-flex items-center justify-center min-w-[18px] h-4 px-1 rounded-full",
                    "text-[10px] font-bold tabular-nums",
                    activeTab === t.id ? "bg-surface text-fg-muted" : "bg-surface text-fg-subtle",
                  )}>
                    {t.count}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* ── Lista ───────────────────────────────────────────────── */}
          <div className="max-h-[420px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <p className="text-[12px] text-fg-muted italic">
                  {totalCount === 0
                    ? "Nenhum alerta no momento — operação saudável."
                    : "Nenhum alerta nesta categoria."}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border/40">
                {filtered.map((a) => {
                  const tone = SEVERITY_TONE[a.severity] || SEVERITY_TONE[SEVERITY.INFO];
                  const isRead = readSet.has(fingerprint(a));
                  const clickable = !!(a.campaign?.short_token && onDrillCampaign);
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={clickable ? () => handleItemClick(a) : () => markOneRead(a)}
                        className={cn(
                          "w-full text-left px-4 py-3",
                          "flex items-start gap-3",
                          "transition-colors cursor-pointer",
                          "hover:bg-surface",
                          "focus-visible:outline-none focus-visible:bg-surface",
                          isRead && "opacity-55",
                        )}
                      >
                        <span className={cn(
                          "shrink-0 mt-1 size-2 rounded-full",
                          tone.dot,
                          a.severity === SEVERITY.CRITICAL && !isRead && "animate-pulse",
                        )} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[12.5px] font-semibold text-fg leading-snug">
                            {a.message}
                          </p>
                          <p className="mt-0.5 text-[11px] text-fg-muted leading-snug">
                            {a.detail}
                          </p>
                        </div>
                        {clickable && (
                          <span className="shrink-0 text-fg-subtle mt-1" aria-hidden>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* ── Footer ──────────────────────────────────────────────── */}
          {totalCount > 0 && onOpenDiagnostico && (
            <div className="px-4 py-2.5 border-t border-border bg-surface-strong">
              <button
                type="button"
                onClick={() => { setOpen(false); onOpenDiagnostico(); }}
                className="w-full text-[11px] text-fg-muted hover:text-fg font-medium cursor-pointer"
              >
                Ver no Diagnóstico →
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
