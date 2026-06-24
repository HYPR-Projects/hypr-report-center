// src/v2/admin/components/WeeklyCheckupTracker.jsx
//
// Tracker de check-ups semanais — substitui o campo agregado que o admin
// preenchia só no fechamento. Agora o CS marca, SEMANA A SEMANA durante a
// veiculação, cada check-up enviado ao cliente.
//
// O número de slots vem da duração da campanha: 1 por semana de veiculação
// (start_date → early_end_date||end_date, em janelas de 7 dias). Cada semana
// tem seu intervalo de datas e um estado relativo a hoje (enviado / esta
// semana / atrasado / a partir de). Isso transforma "quantos check-ups foram
// mandados?" — antes só visível no fim — em acompanhamento ao vivo.
//
// NÃO conta e-mail de onboarding nem de finalização: só os check-ups
// semanais. Métrica interna, admin-only — nunca entra no report do cliente.
//
// Persistência: salva o log inteiro (lista das semanas marcadas) a cada
// toggle, otimista. weekly_checkups (contagem) é derivado no backend.

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../ui/cn";
import { saveWeeklyCheckups } from "../../../lib/api";
import { toast } from "../../../lib/toast";

// ── Helpers de data (local, sem drift de timezone) ───────────────────────
function parseISO(s) {
  if (!s || typeof s !== "string") return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}
function fmtDDMM(date) {
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}`;
}
function fmtDDMMfromISO(iso) {
  const d = parseISO(iso);
  return d ? fmtDDMM(d) : null;
}

/**
 * Quebra a campanha em semanas de veiculação. Retorna [] quando faltam datas
 * (o componente cai num fallback simples nesse caso).
 */
function buildWeeks(startISO, endISO) {
  const s = parseISO(startISO);
  const e = parseISO(endISO);
  if (!s || !e) return [];
  const days = Math.round((e - s) / 86400000) + 1;
  if (!Number.isFinite(days) || days <= 0) return [];
  const count = Math.min(104, Math.ceil(days / 7));
  const weeks = [];
  for (let i = 1; i <= count; i++) {
    const wStart = addDays(s, (i - 1) * 7);
    let wEnd = addDays(s, i * 7 - 1);
    if (wEnd > e) wEnd = e;
    weeks.push({ week: i, start: wStart, end: wEnd });
  }
  return weeks;
}

export function WeeklyCheckupTracker({ campaign, initialLog, onSaved }) {
  const shortToken = campaign?.short_token;
  const startISO = campaign?.start_date;
  const endISO = campaign?.early_end_date || campaign?.end_date;

  // Mapa week → sent_at (null = enviado sem data registrada). Só as semanas
  // presentes aqui estão marcadas como enviadas.
  const [sent, setSent] = useState(() => logToMap(initialLog));
  const [saveState, setSaveState] = useState("idle"); // idle|saving|saved|error
  // Save debounced + serializado + coalescido. DML no BigQuery custa ~2s por
  // MERGE, então salvar a cada toggle enfileira esperas. Em vez disso a UI é
  // 100% otimista (o estado muda na hora) e o write acontece em background:
  // toggles em rajada viram UM save; nunca há dois MERGEs concorrentes na
  // mesma linha (o flush re-dispara se algo mudou durante o save em voo).
  const savedTimer   = useRef(null);
  const debounceTimer = useRef(null);
  const savingRef    = useRef(false);   // há save em voo?
  const dirtyRef     = useRef(null);    // último mapa pendente de gravar

  useEffect(() => {
    setSent(logToMap(initialLog));
  }, [initialLog]);

  useEffect(() => () => {
    clearTimeout(savedTimer.current);
    clearTimeout(debounceTimer.current);
  }, []);

  const weeks = useMemo(() => buildWeeks(startISO, endISO), [startISO, endISO]);
  const todayISO = useMemo(() => toISO(new Date()), []);
  const today = useMemo(() => parseISO(todayISO), [todayISO]);
  const campaignOver = !!campaign?.closed_at || (() => {
    const e = parseISO(endISO);
    return e ? e < today : false;
  })();

  const doneCount = weeks.filter((w) => sent.has(w.week)).length;
  const total = weeks.length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;

  // Grava o último mapa pendente. Se algo mudou enquanto o save estava em voo,
  // re-dispara ao terminar (coalesce) — garante que o BQ converge pro estado
  // final sem MERGEs concorrentes.
  const flush = () => {
    const map = dirtyRef.current;
    if (map == null || !shortToken) return;
    dirtyRef.current = null;
    savingRef.current = true;
    setSaveState("saving");
    const log = mapToLog(map);
    saveWeeklyCheckups({ short_token: shortToken, log })
      .then(() => {
        // Ainda há mudança pendente → re-dispara; só notifica o pai no estado
        // FINAL convergido (evita o pai resetar a UI pra um log intermediário).
        if (dirtyRef.current != null) { savingRef.current = false; flush(); return; }
        savingRef.current = false;
        onSaved?.(log);
        setSaveState("saved");
        clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaveState("idle"), 1500);
      })
      .catch(() => {
        savingRef.current = false;
        setSaveState("error");
        toast.error("Não consegui salvar o check-up. Tente de novo.");
      });
  };

  // Agenda o save (debounce 500ms). Toggles em rajada coalescem num MERGE só.
  const scheduleSave = (nextMap) => {
    if (!shortToken) return;
    dirtyRef.current = nextMap;
    setSaveState("saving"); // feedback imediato (a UI já mudou; isto é só o badge)
    if (savingRef.current) return; // save em voo cuidará do dirty ao terminar
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(flush, 500);
  };

  const toggleWeek = (week) => {
    setSent((prev) => {
      const next = new Map(prev);
      if (next.has(week.week)) {
        next.delete(week.week);
      } else {
        // Default: data de hoje, travada ao período da campanha (não faz
        // sentido registrar envio antes do início nem no futuro).
        const def = clampSentDefault(week, today, todayISO);
        next.set(week.week, def);
      }
      scheduleSave(next);
      return next;
    });
  };

  const setWeekDate = (week, value) => {
    setSent((prev) => {
      const next = new Map(prev);
      if (!next.has(week.week)) return prev;
      next.set(week.week, value || null);
      scheduleSave(next);
      return next;
    });
  };

  return (
    <div className="mb-5 rounded-lg border border-border bg-surface-2/40 px-3 py-3">
      {/* Header: título + progresso + status de save */}
      <div className="flex items-center gap-2 mb-1">
        <span className="text-signature shrink-0"><CheckupIcon /></span>
        <span className="text-[11px] uppercase tracking-widest font-bold text-fg-subtle">
          Check-ups semanais
        </span>
        {total > 0 && (
          <span className="ml-auto inline-flex items-center gap-1.5 tabular-nums">
            <span className="text-[13px] font-bold text-fg">{doneCount}</span>
            <span className="text-[11px] text-fg-subtle">/ {total}</span>
          </span>
        )}
        <SaveBadge state={saveState} />
      </div>

      {total > 0 ? (
        <>
          {/* Barra de progresso fina */}
          <div className="mt-1.5 mb-3 h-1.5 rounded-full bg-surface-strong overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500 ease-out",
                doneCount === total ? "bg-success" : "bg-signature",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>

          {/* Lista de semanas */}
          <div className="flex flex-col gap-1.5">
            {weeks.map((w) => (
              <WeekRow
                key={w.week}
                week={w}
                sentAt={sent.has(w.week) ? sent.get(w.week) : undefined}
                done={sent.has(w.week)}
                status={weekStatus(w, sent.has(w.week), today, campaignOver)}
                startISO={startISO}
                maxISO={todayISO}
                onToggle={() => toggleWeek(w)}
                onDateChange={(v) => setWeekDate(w, v)}
              />
            ))}
          </div>

          <p className="mt-3 text-[10.5px] text-fg-subtle leading-snug">
            1 check-up por semana de veiculação · só os semanais (sem onboarding
            nem finalização). Métrica interna — não aparece no report do cliente.
          </p>
        </>
      ) : (
        <p className="mt-1 text-[11.5px] text-fg-muted leading-snug">
          Defina as datas de início e fim da campanha para acompanhar os
          check-ups semana a semana.
        </p>
      )}
    </div>
  );
}

// ── Linha de uma semana ──────────────────────────────────────────────────
function WeekRow({ week, done, sentAt, status, startISO, maxISO, onToggle, onDateChange }) {
  const range = `${fmtDDMM(week.start)} – ${fmtDDMM(week.end)}`;
  return (
    <div
      className={cn(
        "group flex items-center gap-2.5 rounded-md border px-2.5 py-2 transition-colors",
        done
          ? "border-success/40 bg-success-soft"
          : status === "current"
            ? "border-signature/50 bg-signature/5"
            : status === "overdue"
              ? "border-warning/40 bg-warning-soft/60"
              : "border-border bg-surface",
      )}
    >
      {/* Toggle (checkbox circular) */}
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={`Semana ${week.week} — ${done ? "marcar como não enviado" : "marcar como enviado"}`}
        onClick={onToggle}
        className={cn(
          "relative inline-flex items-center justify-center size-6 rounded-full shrink-0 cursor-pointer",
          "transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature/50",
          done
            ? "bg-success text-white border border-success"
            : "border-2 border-border-strong text-transparent hover:border-signature",
        )}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </button>

      {/* Semana + intervalo */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-semibold text-fg">Semana {week.week}</span>
          <StatusChip status={status} done={done} sentAt={sentAt} />
        </div>
        <span className="text-[10.5px] text-fg-subtle tabular-nums">{range}</span>
      </div>

      {/* Data do envio — só quando enviado. Compacta, opcional. */}
      {done && (
        <input
          type="date"
          value={sentAt || ""}
          min={startISO || undefined}
          max={maxISO || undefined}
          onChange={(e) => onDateChange(e.target.value)}
          aria-label={`Data do envio — semana ${week.week}`}
          className={cn(
            "shrink-0 w-[7.5rem] rounded-md border border-border bg-surface px-2 py-1",
            "text-[11px] font-mono tabular-nums text-fg-muted transition-shadow",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature/40",
          )}
        />
      )}
    </div>
  );
}

// Chip de status à direita do "Semana N".
function StatusChip({ status, done, sentAt }) {
  if (done) {
    const dt = fmtDDMMfromISO(sentAt);
    return (
      <span className="text-[10px] font-semibold text-success">
        {dt ? `Enviado · ${dt}` : "Enviado"}
      </span>
    );
  }
  if (status === "current") {
    return <span className="text-[10px] font-semibold text-signature">Esta semana</span>;
  }
  if (status === "overdue") {
    return <span className="text-[10px] font-semibold text-warning">Atrasado</span>;
  }
  if (status === "missed") {
    return <span className="text-[10px] font-semibold text-fg-subtle">Não enviado</span>;
  }
  return null; // future → sem chip (o intervalo de datas já dá o contexto)
}

function SaveBadge({ state }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center" aria-label="Salvando">
        <svg className="animate-spin text-fg-subtle" width="13" height="13" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex items-center text-success" aria-label="Salvo">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-flex items-center text-danger" aria-label="Erro ao salvar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
        </svg>
      </span>
    );
  }
  return null;
}

function CheckupIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 13V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h8" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      <path d="m16 19 2 2 4-4" />
    </svg>
  );
}

// ── Lógica de estado/serialização ─────────────────────────────────────────
function weekStatus(week, done, today, campaignOver) {
  if (done) return "done";
  const startISO = toISO(week.start);
  const endISO = toISO(week.end);
  const t = toISO(today);
  if (t > endISO) return campaignOver ? "missed" : "overdue";
  if (t >= startISO && t <= endISO) return "current";
  return "future";
}

// Default da data ao marcar: hoje, clampado ao período da semana/campanha.
function clampSentDefault(week, today, todayISO) {
  const startISO = toISO(week.start);
  const endISO = toISO(week.end);
  if (todayISO < startISO) return startISO; // campanha futura → começo da semana
  if (todayISO > endISO) return endISO;      // semana já passou → fim da semana
  return todayISO;
}

function logToMap(log) {
  const m = new Map();
  if (Array.isArray(log)) {
    for (const it of log) {
      const w = Number(it?.week);
      if (Number.isInteger(w) && w >= 1) m.set(w, it?.sent_at || null);
    }
  }
  return m;
}

function mapToLog(map) {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, sent_at]) => ({ week, sent_at: sent_at || null }));
}
