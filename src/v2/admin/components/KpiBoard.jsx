// src/v2/admin/components/KpiBoard.jsx
//
// A moldura colapsável dos KPIs. Vale pro menu (MetricStrip) e pro PMP
// (PmpKpiStrip) — as duas faixas de números do admin.
//
// O PROBLEMA QUE RESOLVE
// ────────────────────────────────────────────────────────────────────────
// A faixa de KPIs ocupava ~110px fixos em TODAS as views, inclusive nas
// duas onde ela não é o assunto: na Lista e no Diagnóstico o usuário está
// varrendo linha por linha, e oito cards agregados no topo são contexto que
// ele já leu. Somando com o herói, os alertas, o toggle e a toolbar, dava
// ~490px de chrome antes do primeiro dado — 54% de um viewport de 900px.
//
// A "solução" que existia no PMP era pior: `layout !== "analytics"`
// escondia os KPIs por completo naquela aba. Um bloco que aparece e
// desaparece conforme a aba impede o usuário de construir modelo mental de
// onde as coisas moram — e não dava escolha a quem QUERIA ver os números
// ali.
//
// Aqui é uma decisão do usuário, persistida por seção. Fechado, o board
// vira uma linha de 36px com o resumo em texto — os quatro números que
// respondem "como está o mês" sem ocupar um quinto da tela.
//
// PERSISTÊNCIA POR SEÇÃO, NÃO POR VIEW
// Quem fecha o board na Lista quer ele fechado no Diagnóstico também (está
// varrendo tabelas). Mas fechar no menu não deve fechar no PMP — são
// contextos de trabalho diferentes, com números diferentes.

import { useCallback, useEffect, useState } from "react";
import { cn } from "../../../ui/cn";

const LS_PREFIX = "hypr.admin.kpiBoard.";

function readClosed(scope) {
  try { return localStorage.getItem(LS_PREFIX + scope) === "1"; }
  catch { return false; }
}

export function KpiBoard({
  // "reports" | "pmp" — chave de persistência
  scope,
  title,
  // Resumo mostrado quando fechado: [{ label, value, tone }]
  summary = [],
  // Chips de alerta/worklist (linha inferior do board)
  alerts,
  children,
  className,
}) {
  const [closed, setClosed] = useState(() => readClosed(scope));

  useEffect(() => {
    try { localStorage.setItem(LS_PREFIX + scope, closed ? "1" : "0"); }
    catch { /* ignore */ }
  }, [scope, closed]);

  const toggle = useCallback(() => setClosed((v) => !v), []);

  return (
    <section
      aria-label={title}
      className={cn(
        "mb-4 rounded-xl border border-border bg-canvas-elevated overflow-hidden",
        className,
      )}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!closed}
        className={cn(
          "w-full h-9 flex items-center gap-2.5 px-3.5 cursor-pointer",
          "border-0 bg-transparent text-left transition-colors",
          "hover:bg-surface",
          !closed && "border-b border-border",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
          "focus-visible:ring-inset",
        )}
      >
        <span className="shrink-0 text-[9.5px] font-extrabold uppercase tracking-[0.14em] text-fg-subtle">
          {title}
        </span>

        {/* Resumo só quando fechado — é o que substitui a grade. */}
        {closed && summary.length > 0 && (
          <span className="flex items-center gap-3 min-w-0 overflow-hidden">
            {summary.map((s) => (
              <span key={s.label} className="text-[11.5px] text-fg-muted whitespace-nowrap">
                {s.label}{" "}
                <b
                  className={cn(
                    "font-bold tabular-nums",
                    s.tone === "success" ? "text-success" :
                    s.tone === "warning" ? "text-warning" :
                    s.tone === "danger"  ? "text-danger"  :
                    s.tone === "signature" ? "text-signature" : "text-fg",
                  )}
                >
                  {s.value}
                </b>
              </span>
            ))}
          </span>
        )}

        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          className={cn(
            "ml-auto shrink-0 text-fg-subtle transition-transform duration-200",
            closed && "-rotate-90",
          )}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {!closed && (
        <>
          {/* @container: a faixa de KPIs decide o número de colunas pela
              largura DO BOARD, não do viewport. Com o rail, um viewport de
              1024px dá ~730px de board — oito colunas ali seriam 85px cada, e
              "R$ 1.794.308,80" não cabe em 85px. Breakpoint de viewport não
              enxerga o rail; container query enxerga.

              Sem padding: a grade encosta nas bordas do board e os KPIs são
              CÉLULAS separadas por filete, não cards flutuando dentro de um
              card. Card-dentro-de-card era o que fazia a faixa parecer pesada
              — duas bordas arredondadas concêntricas com 16px entre elas, oito
              vezes. O painel de instrumentos é um objeto só. */}
          <div className="@container">{children}</div>
          {alerts && <div className="px-3.5 py-2.5 border-t border-border bg-surface">{alerts}</div>}
        </>
      )}
    </section>
  );
}
