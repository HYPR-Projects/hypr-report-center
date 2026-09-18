// src/v2/admin/components/DspLandingAuditModal.jsx
//
// "A Amazon parou porque não teve entrega ou porque a integração quebrou?"
//
// O painel "Estado das bases" não responde isso, e não tem como: ele mede
// MAX(date) por fonte, e DSP sem campanha no ar e connector quebrado produzem
// exatamente a mesma tela. Até 18/09/2026 a resposta dependia de alguém com
// gcloud abrir o BigQuery na mão — ou seja, dependia de não ser o ad ops, que
// é justamente quem faz a pergunta.
//
// Mesma função do `?action=pmp_pubmatic_audit` no PMP (falha #8 da auditoria
// da PubMatic): transformar "a fonte não atualizou" de discussão em
// diagnóstico, com o culpado escrito.
//
// A ARMADILHA que este modal evita: com MAX(date) parado em D-5, os dias
// seguintes estão ausentes da staging POR DEFINIÇÃO, então "o dia existe?" não
// separa nada sozinho. O que separa é simultaneidade (todas as campanhas
// caindo no mesmo dia é cano; uma de cada vez é fim de flight) e contrato
// (campanha com fim no futuro parada não tem leitura de mercado). O backend
// já entrega o veredito pronto; aqui a gente mostra a evidência embaixo dele,
// pra ninguém ter de confiar no veredito no escuro.

import { useEffect, useState } from "react";
import { cn } from "../../../ui/cn";
import { getDspLandingAudit } from "../../../lib/api";
import { fmtBrDate, humanizeSource } from "../lib/dspFreshness";

const VERDICT_TONE = {
  integracao:           { ring: "border-danger/40",  bg: "bg-danger/10",  text: "text-danger"  },
  integracao_provavel:  { ring: "border-danger/40",  bg: "bg-danger/10",  text: "text-danger"  },
  dbt:                  { ring: "border-warning/40", bg: "bg-warning/10", text: "text-warning" },
  consolidacao:         { ring: "border-warning/40", bg: "bg-warning/10", text: "text-warning" },
  sem_entrega:          { ring: "border-success/40", bg: "bg-success/10", text: "text-success" },
  sem_entrega_provavel: { ring: "border-success/40", bg: "bg-success/10", text: "text-success" },
  ok:                   { ring: "border-success/40", bg: "bg-success/10", text: "text-success" },
};
const fallbackTone = { ring: "border-border", bg: "bg-surface-strong", text: "text-fg-muted" };

const fmtInt = new Intl.NumberFormat("pt-BR");

export function DspLandingAuditModal({ source, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let cancelled = false;
    getDspLandingAudit(source)
      .then((data) => { if (!cancelled) setState({ loading: false, error: null, data }); })
      .catch((e)   => { if (!cancelled) setState({ loading: false, error: e, data: null }); });
    return () => { cancelled = true; };
  }, [source]);

  // Esc fecha. Sem isto o único jeito de sair é o mouse, e este modal abre a
  // partir de um popover que já era navegável por teclado.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const d = state.data;
  const tone = VERDICT_TONE[d?.verdict?.code] || fallbackTone;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dsp-audit-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in p-4"
    >
      <div className="w-[min(620px,100%)] max-h-[85vh] overflow-y-auto rounded-2xl border border-border bg-canvas-elevated shadow-xl">
        <div className="sticky top-0 px-5 py-4 border-b border-border bg-canvas-elevated flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <span className="lbl-section text-fg-muted">Por que a fonte parou</span>
            <h2 id="dsp-audit-title" className="text-base font-bold text-fg">
              {humanizeSource(source)}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="size-8 rounded-full border border-border text-fg-muted hover:bg-surface-strong hover:text-fg transition-colors cursor-pointer"
          >
            ✕
          </button>
        </div>

        {state.loading ? (
          <p className="px-5 py-8 text-[13px] text-fg-subtle italic">Consultando a base…</p>
        ) : state.error ? (
          <p className="px-5 py-8 text-[13px] text-danger">
            {state.error.message || "Não foi possível auditar a fonte."}
          </p>
        ) : (
          <div className="px-5 py-4 space-y-5">
            {/* Veredito primeiro. A evidência vem abaixo pra conferência, não
                pra interpretação — quem abre isto quer saber de quem é a culpa. */}
            <div className={cn("rounded-xl border p-3", tone.ring, tone.bg)}>
              <p className={cn("text-[13px] font-bold", tone.text)}>{d.verdict.title}</p>
              <p className="mt-1 text-[12px] leading-snug text-fg-muted">{d.verdict.detail}</p>
            </div>

            <Section title="Onde congelou" hint="staging = o que a DSP escreve · unified = o que o report serve">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="staging"  value={fmtBrDate(d.maxes.raw)} />
                <Stat label="tratada"  value={fmtBrDate(d.maxes.treated)} />
                <Stat label="unified"  value={fmtBrDate(d.maxes.unified)} />
              </div>
            </Section>

            {/* Um quadrado por dia. Série cheia que para seco = o export rodava
                todo dia e deixou de rodar. Buraco no meio conta a mesma
                história antes da ponta. */}
            <Section title="Dias com linha na staging (30d)" hint="cheio = a fonte escreveu · vazio = não escreveu nada">
              <div className="flex flex-wrap gap-1">
                {d.staging_days.map((day) => (
                  <span
                    key={day.date}
                    title={`${fmtBrDate(day.date)} · ${day.rows ? `${fmtInt.format(day.rows)} linhas` : "ausente"}`}
                    className={cn(
                      "size-3.5 rounded-[3px] border",
                      day.rows > 0
                        ? "bg-success/70 border-success/70"
                        : "bg-transparent border-danger/50",
                    )}
                  />
                ))}
              </div>
            </Section>

            <Section title="Entrega diária (21d)" hint="campanhas caindo TODAS no mesmo dia é cano; uma de cada vez é fim de flight">
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-[11.5px] tabular-nums">
                  <thead className="bg-surface-strong text-fg-muted">
                    <tr>
                      <th className="text-left px-2 py-1 font-medium">dia</th>
                      <th className="text-right px-2 py-1 font-medium">imps</th>
                      <th className="text-right px-2 py-1 font-medium">campanhas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.unified_daily.slice(-12).map((row) => (
                      <tr key={row.date} className="border-t border-border/50">
                        <td className="px-2 py-1 text-fg-muted">{fmtBrDate(row.date)}</td>
                        <td className="px-2 py-1 text-right text-fg">{fmtInt.format(row.impressions)}</td>
                        <td className="px-2 py-1 text-right text-fg">{row.tokens}</td>
                      </tr>
                    ))}
                    {d.unified_daily.length === 0 && (
                      <tr><td colSpan={3} className="px-2 py-2 text-fg-subtle italic">Sem entrega na janela.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Section>

            {/* A prova que não admite leitura de mercado. */}
            <Section
              title={`Campanhas no ar sem dado (${d.live_without_data.length})`}
              hint="fim contratado no futuro, entrega interrompida"
            >
              {d.live_without_data.length === 0 ? (
                <p className="text-[12px] text-fg-subtle italic">
                  Nenhuma. Enfraquece a hipótese de erro, mas não a mata: checklist
                  com fim já vencido some daqui do mesmo jeito.
                </p>
              ) : (
                <ul className="space-y-1">
                  {d.live_without_data.map((c) => (
                    <li key={c.short_token} className="text-[12px] flex gap-2">
                      <span className="font-mono text-fg-subtle shrink-0">{c.short_token}</span>
                      <span className="flex-1 min-w-0 truncate">
                        <span className="font-medium text-fg">{c.client_name}</span>
                        <span className="text-fg-muted"> · {c.campaign_name}</span>
                      </span>
                      <span className="text-fg-subtle font-mono shrink-0 tabular-nums">
                        últ. {fmtBrDate(c.last_date)} · fim {fmtBrDate(c.end_date)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, hint, children }) {
  return (
    <section>
      <h3 className="lbl-section text-fg-muted">{title}</h3>
      {hint && <p className="mb-1.5 text-[10.5px] text-fg-subtle leading-snug">{hint}</p>}
      {children}
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className="text-[13px] font-mono tabular-nums text-fg">{value}</div>
    </div>
  );
}
