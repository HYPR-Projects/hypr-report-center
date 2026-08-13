// src/v2/admin/components/CampaignNotes.jsx
//
// Notas internas da campanha — thread estilo chat, ADMIN-ONLY.
//
// Por que existe: o time precisava registrar "o que aconteceu" numa
// campanha (pausa combinada com o cliente, troca de criativo, DSP com
// problema, decisão de cortar budget) num lugar que sobrevivesse ao Slack
// e que qualquer pessoa visse ao abrir a campanha. Antes esse contexto
// morria em DM e ninguém sabia por que o pacing tinha caído em julho.
//
// NÃO é o chat do report (`saveComment`/`getComments`, que o cliente vê).
// Aqui até a leitura exige JWT admin — nota interna nunca vai pro report
// nem pro Portal do Cliente. O selo "não visível ao cliente" no header
// existe pra deixar isso explícito pra quem escreve.
//
// Superfícies de acesso (mesma thread, mesmo componente):
//   • Diagnóstico → AlertCampaignSheet (drawer da row)
//   • Visão mensal → CampaignDrawer (clique no card)
//
// Identidade: o autor é o email do JWT (resolvido no backend). Aqui só
// resolvemos o DISPLAY — teamMap primeiro, depois o nome da sessão Google
// denormalizado na row, e por último o local-part do email.
//
// Escrita otimista: a nota aparece na thread na hora (BQ DML leva ~2s) e
// o contador do card é patchado via notesSummaryCache. Se o write falhar,
// a nota é removida e o texto volta pro composer — nunca perdemos o que
// a pessoa digitou.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../ui/cn";
import { Skeleton } from "../../../ui/Skeleton";
import { toast } from "../../../lib/toast";
import { loadSession } from "../../../shared/auth";
import { localPartFromEmail } from "../lib/format";
import { patchNoteSummary, useCachedNoteSummary } from "../lib/notesSummaryCache";
import {
  listCampaignNotes,
  saveCampaignNote,
  deleteCampaignNote,
} from "../../../lib/api";

const MAX_BODY_LEN = 4000;

// ── Datas ────────────────────────────────────────────────────────────────
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function parseTs(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtHour(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "03/08/2026 às 09:17" — timestamp completo pro tooltip da hora. */
function fmtFullTs(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()} às ${fmtHour(d)}`;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/** Separador de dia da thread: "hoje", "ontem", "3 de ago", "3 de ago de 2025". */
function fmtDayLabel(d) {
  const now = new Date();
  if (sameDay(d, now)) return "hoje";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yesterday)) return "ontem";
  const base = `${d.getDate()} de ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} de ${d.getFullYear()}`;
}

// ── Identidade ───────────────────────────────────────────────────────────
/**
 * Quem sou eu. Lê da sessão em vez de receber por prop porque o componente
 * é montado em dois lugares (sheet do Diagnóstico e drawer do menu) e um
 * deles não recebia `user` — plumbing extra só pra isso seria ruído.
 */
function useMe() {
  return useMemo(() => {
    const u = loadSession()?.user || null;
    return {
      email: (u?.email || "").toLowerCase(),
      name: u?.name || null,
    };
  }, []);
}

function resolveAuthorName(note, teamMap) {
  const email = (note.author_email || "").toLowerCase();
  return teamMap?.[email] || note.author_name || localPartFromEmail(email) || "—";
}

/** Iniciais (até 2) — mesma regra do ui/Avatar, sem herdar as cores por role. */
function initialsFrom(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function NoteAvatar({ name }) {
  return (
    <div
      aria-hidden
      className={cn(
        "shrink-0 inline-flex items-center justify-center size-[22px] rounded-full",
        "bg-surface-3 text-fg text-[9.5px] font-bold leading-none tracking-tight",
      )}
      title={name}
    >
      {initialsFrom(name)}
    </div>
  );
}

// ── Ícones (inline, mesmo peso de traço do resto do admin) ────────────────
const LockIcon = (props) => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

const SendIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 12h13M12 5l7 7-7 7" />
  </svg>
);

// ── Bolha ────────────────────────────────────────────────────────────────
/**
 * Coluna ÚNICA (não alternando lados como WhatsApp). Motivo: num painel de
 * 480px, bolha à direita + bolha à esquerda com largura variável deixa as
 * duas bordas irregulares, e nome/hora/ações de cada bloco caem num eixo
 * diferente — visualmente bagunçado justo num componente que é um log.
 * Aqui todo mundo compartilha o mesmo gutter de avatar e a bolha ocupa a
 * largura inteira: nomes, horas e ações empilham num só eixo.
 *
 * Quem escreveu se distingue pelo avatar + nome (e pelo tint signature na
 * própria nota), não pela posição.
 *
 * `showMeta` false quando a mensagem anterior é do mesmo autor em menos de
 * 10min — aí a bolha entra sem repetir nome/avatar. Mantém a thread limpa
 * quando alguém escreve 3 linhas seguidas, sem esconder autoria de verdade.
 *
 * Editar/apagar só aparecem na própria nota (`canEdit`) — o backend também
 * filtra por author_email, então a regra não depende da UI.
 */
function NoteBubble({
  note, mine, authorName, showMeta, canEdit,
  onEdit, onDelete, busy,
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const created = parseTs(note.created_at);
  const edited = !!note.updated_at && note.updated_at !== note.created_at;

  return (
    <div className="flex gap-2">
      {/* Gutter fixo do avatar: preenchido na 1ª mensagem do bloco, vazio nas
          continuações — a bolha nunca sai do eixo. */}
      <div className="w-[22px] shrink-0">
        {showMeta && <NoteAvatar name={authorName} />}
      </div>

      <div className="min-w-0 flex-1 flex flex-col items-stretch">
        {showMeta && (
          <div className="flex items-baseline gap-1.5 mb-1">
            <span className="text-[11px] font-bold text-fg leading-none">
              {mine ? "Você" : authorName}
            </span>
            {created && (
              <span
                className="text-[10px] text-fg-subtle leading-none tabular-nums"
                // A hora curta basta na leitura (o separador de dia dá o
                // contexto); a data completa fica no tooltip pra quando o
                // admin precisa citar o momento exato num incidente.
                title={fmtFullTs(created)}
              >
                {fmtHour(created)}
              </span>
            )}
          </div>
        )}

        <div
          className={cn(
            "rounded-lg px-3 py-2 border transition-opacity",
            mine
              ? "bg-signature-soft border-signature/20"
              : "bg-surface border-border",
            busy && "opacity-50",
          )}
        >
          <p className="text-[12.5px] text-fg leading-relaxed whitespace-pre-wrap break-words">
            {note.body}
          </p>
        </div>

        {/* Rodapé: "editada" + ações da própria nota. Sem reserva de altura
            quando não há nada a mostrar (nota de outra pessoa não editada) —
            reservar 14px em toda bolha inflava a thread inteira. */}
        <div className={cn(
          "flex items-center gap-2",
          (edited || canEdit) && "mt-1 h-3.5",
        )}>
          {edited && (
            <span className="text-[9.5px] text-fg-subtle italic">editada</span>
          )}
          {canEdit && !busy && (
            confirmingDelete ? (
              <span className="flex items-center gap-1.5 text-[9.5px]">
                <span className="text-fg-muted">apagar?</span>
                <button
                  type="button"
                  onClick={() => { setConfirmingDelete(false); onDelete(); }}
                  className="font-bold text-danger hover:underline cursor-pointer"
                >
                  sim
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="text-fg-muted hover:text-fg cursor-pointer"
                >
                  não
                </button>
              </span>
            ) : (
              // Sempre visíveis (não só no hover): no mobile não existe
              // hover, e "sumir até passar o mouse" já escondeu ação demais
              // nesse admin. Ficam em fg-subtle 9.5px — presentes sem
              // competir com o texto da nota.
              <span className="flex items-center gap-2 text-[9.5px] text-fg-subtle">
                <button
                  type="button"
                  onClick={onEdit}
                  className="hover:text-fg cursor-pointer"
                >
                  editar
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="hover:text-danger cursor-pointer"
                >
                  apagar
                </button>
              </span>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// ── Composer ─────────────────────────────────────────────────────────────
function Composer({ value, onChange, onSubmit, onCancelEdit, editing, sending, autoFocus }) {
  const ref = useRef(null);

  // Auto-grow: 1 linha em repouso, cresce até ~5 linhas e depois rola.
  //
  // Com o textarea VAZIO limpamos a altura inline em vez de medir. Medir
  // scrollHeight antes do CSS assentar (primeiro paint do dev server, fonte
  // ainda carregando) devolvia um valor absurdo e o composer nascia com
  // ~5 linhas de altura; sem inline height, `rows={1}` garante a linha
  // única. Só medimos quando há texto — aí o layout já está estável.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!value) { el.style.height = ""; return; }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 118)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus || editing) ref.current?.focus();
  }, [autoFocus, editing]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (e.key === "Escape" && editing) {
      e.preventDefault();
      onCancelEdit();
    }
  };

  const canSend = value.trim().length > 0 && !sending;

  return (
    <div className="space-y-1.5">
      {editing && (
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-signature">
            Editando nota
          </span>
          <button
            type="button"
            onClick={onCancelEdit}
            className="text-[10px] text-fg-muted hover:text-fg cursor-pointer"
          >
            cancelar
          </button>
        </div>
      )}
      <div className={cn(
        "flex items-end gap-2 rounded-xl border bg-canvas-elevated px-2.5 py-2 transition-colors",
        "border-border focus-within:border-signature/50",
      )}>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          maxLength={MAX_BODY_LEN}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Escreva uma nota…"
          className={cn(
            "flex-1 min-w-0 resize-none bg-transparent outline-none",
            "text-[12.5px] text-fg placeholder:text-fg-subtle leading-relaxed",
            "scrollbar-thin",
          )}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSend}
          aria-label={editing ? "Salvar edição" : "Enviar nota"}
          className={cn(
            "shrink-0 inline-flex items-center justify-center size-7 rounded-lg transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
            canSend
              ? "bg-signature-fill text-on-signature hover:bg-signature-hover cursor-pointer"
              : "bg-surface-strong text-fg-disabled cursor-not-allowed",
          )}
        >
          <SendIcon />
        </button>
      </div>
      <p className="px-0.5 text-[9.5px] text-fg-subtle">
        Enter envia · Shift+Enter quebra linha
      </p>
    </div>
  );
}

// ── Componente principal ─────────────────────────────────────────────────
/**
 * Props:
 *   shortToken    — campanha alvo (obrigatório)
 *   teamMap       — { email → nome } pra resolver o autor
 *   className     — wrapper
 *   autoFocus     — foca o composer ao montar (default false)
 *   collapsible   — renderiza como seção clicável fechada por padrão,
 *                   mostrando só a contagem. Usado no drawer admin, que
 *                   já é longo; no Diagnóstico a thread abre expandida.
 */
export function CampaignNotes({
  shortToken,
  teamMap = {},
  className,
  // Visual de card aplicado só no CORPO (thread + composer), não na seção
  // inteira. Antes o AlertCampaignSheet passava o card via `className`, o que
  // jogava o título "NOTAS INTERNAS" para DENTRO da caixa — recuado pelo
  // padding, enquanto ALERTAS / SNAPSHOT / LINES CRÍTICAS nasciam na margem
  // do drawer. Era o único título da coluna fora do alinhamento.
  bodyClassName,
  autoFocus = false,
  collapsible = false,
}) {
  const me = useMe();
  const [notes, setNotes] = useState([]);
  const [state, setState] = useState("loading"); // loading | ready | error
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [sending, setSending] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [open, setOpen] = useState(!collapsible);
  const scrollRef = useRef(null);

  // Espelha a contagem no cache do card sempre que a thread muda — o badge
  // do card fica certo sem esperar o próximo batch.
  const syncBadge = useCallback((list) => {
    const last = list[list.length - 1];
    patchNoteSummary(shortToken, {
      count: list.length,
      last_at: last?.created_at ?? null,
      last_author_email: last?.author_email ?? null,
      last_author_name: last?.author_name ?? null,
      last_snippet: last?.body ? last.body.replace(/\s+/g, " ").slice(0, 140) : null,
    });
  }, [shortToken]);

  const load = useCallback(() => {
    if (!shortToken) return;
    let cancelled = false;
    setState("loading");
    listCampaignNotes({ short_token: shortToken })
      .then((rows) => {
        if (cancelled) return;
        setNotes(rows);
        setState("ready");
        syncBadge(rows);
      })
      .catch(() => {
        if (cancelled) return;
        setState("error");
      });
    return () => { cancelled = true; };
  }, [shortToken, syncBadge]);

  // Fetch lazy: quando colapsado, só busca ao abrir — o drawer admin monta
  // várias seções e não queremos pagar a query de notas se ninguém abriu.
  useEffect(() => {
    if (!open) return;
    return load();
  }, [open, load]);

  // Rola pro fim quando a thread chega/cresce (chat: o mais recente é o
  // que importa). `scrollTop = scrollHeight` sem animação — animar aqui
  // faria a thread "voar" cada vez que o drawer abre.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [notes.length, state]);

  const handleSubmit = async () => {
    const body = draft.trim();
    if (!body || sending) return;

    // ── Edição ──────────────────────────────────────────────────────────
    if (editingId) {
      const target = notes.find((n) => n.note_id === editingId);
      if (!target) { setEditingId(null); return; }
      const previous = target.body;
      setSending(true);
      setNotes((list) => list.map((n) => (
        n.note_id === editingId
          ? { ...n, body, updated_at: new Date().toISOString() }
          : n
      )));
      try {
        await saveCampaignNote({ short_token: shortToken, body, note_id: editingId });
        setEditingId(null);
        setDraft("");
      } catch (err) {
        // Rollback do texto — o draft continua no composer pra não perder a edição.
        setNotes((list) => list.map((n) => (
          n.note_id === editingId ? { ...n, body: previous } : n
        )));
        toast.error(err?.message || "Não consegui salvar a edição.");
      } finally {
        setSending(false);
      }
      return;
    }

    // ── Nota nova (otimista) ────────────────────────────────────────────
    const tempId = `temp-${Date.now()}`;
    const optimistic = {
      note_id: tempId,
      short_token: shortToken,
      author_email: me.email,
      author_name: me.name,
      body,
      created_at: new Date().toISOString(),
      updated_at: null,
      pending: true,
    };
    setSending(true);
    setBusyId(tempId);
    setDraft("");
    setNotes((list) => {
      const next = [...list, optimistic];
      syncBadge(next);
      return next;
    });
    try {
      const saved = await saveCampaignNote({
        short_token: shortToken,
        body,
        author_name: me.name,
      });
      setNotes((list) => {
        const next = list.map((n) => (
          n.note_id === tempId ? { ...(saved || n), pending: false } : n
        ));
        syncBadge(next);
        return next;
      });
    } catch (err) {
      setNotes((list) => {
        const next = list.filter((n) => n.note_id !== tempId);
        syncBadge(next);
        return next;
      });
      setDraft(body); // devolve o texto — nunca perde o que foi digitado
      toast.error(err?.message || "Não consegui salvar a nota.");
    } finally {
      setSending(false);
      setBusyId(null);
    }
  };

  const handleDelete = async (noteId) => {
    const snapshot = notes;
    setBusyId(noteId);
    setNotes((list) => {
      const next = list.filter((n) => n.note_id !== noteId);
      syncBadge(next);
      return next;
    });
    if (editingId === noteId) { setEditingId(null); setDraft(""); }
    try {
      await deleteCampaignNote({ note_id: noteId });
    } catch (err) {
      setNotes(snapshot);
      syncBadge(snapshot);
      toast.error(err?.message || "Não consegui apagar a nota.");
    } finally {
      setBusyId(null);
    }
  };

  const handleEdit = (note) => {
    setEditingId(note.note_id);
    setDraft(note.body);
  };

  // Pré-computa o que cada bolha precisa: nome resolvido, se é minha e se
  // repete o bloco do autor anterior (mesma pessoa em < 10min).
  const rendered = useMemo(() => {
    let prev = null;
    let prevDay = null;
    return notes.map((n) => {
      const created = parseTs(n.created_at);
      const authorEmail = (n.author_email || "").toLowerCase();
      const sameAuthor = prev && (prev.author_email || "").toLowerCase() === authorEmail;
      const prevCreated = prev ? parseTs(prev.created_at) : null;
      const closeInTime = created && prevCreated
        ? (created - prevCreated) < 10 * 60 * 1000
        : false;
      const dayLabel = created ? fmtDayLabel(created) : null;
      const newDay = dayLabel && dayLabel !== prevDay;
      prev = n;
      if (dayLabel) prevDay = dayLabel;
      return {
        note: n,
        mine: !!me.email && authorEmail === me.email,
        authorName: resolveAuthorName(n, teamMap),
        showMeta: !(sameAuthor && closeInTime && !newDay),
        dayLabel: newDay ? dayLabel : null,
      };
    });
  }, [notes, teamMap, me.email]);

  // Contagem do header. Colapsado (drawer admin) a thread ainda não foi
  // buscada, então cai no summary batched do menu — sem isso o header dizia
  // "Notas internas" sem número e ninguém sabia que havia registro ali.
  const cachedSummary = useCachedNoteSummary(shortToken);
  const count = state === "ready" ? notes.length : (cachedSummary?.count || 0);

  return (
    <section className={className}>
      {/* Header — título + contagem + selo admin-only. Clicável quando
          colapsável (drawer admin). */}
      <div className="flex items-center justify-between gap-2 mb-2">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            // -ml-4 tira o chevron do fluxo da margem: ele mede 10px + 6px de
            // gap, então sem isso o TEXTO "Notas internas" começava 16px depois
            // da margem esquerda do drawer — o único dos 13 títulos de seção
            // fora da coluna. Puxando o botão, o chevron avança para a calha e
            // o texto cai exatamente onde caem "Período", "Performance",
            // "Brand Safety" e os outros.
            className="flex items-center gap-1.5 -ml-4 group cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature/40"
          >
            <svg
              width="10" height="10" viewBox="0 0 12 12" aria-hidden fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={cn(
                "text-fg-subtle transition-transform duration-150 group-hover:text-fg",
                open ? "rotate-0" : "-rotate-90",
              )}
            >
              <polyline points="3 4.5 6 7.5 9 4.5" />
            </svg>
            <span className="lbl-section group-hover:text-fg transition-colors">
              Notas internas
            </span>
            {count > 0 && (
              <span className="text-[10px] font-bold text-signature tabular-nums">
                {count}
              </span>
            )}
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="lbl-section">
              Notas internas
            </span>
            {count > 0 && (
              <span className="text-[10px] font-bold text-signature tabular-nums">
                {count}
              </span>
            )}
          </div>
        )}
        <span
          className="inline-flex items-center gap-1 text-[9.5px] text-fg-subtle shrink-0"
          title="Notas internas nunca aparecem no report nem no Portal do Cliente"
        >
          <LockIcon />
          não visível ao cliente
        </span>
      </div>

      {open && (
        <div className={cn("space-y-2.5", bodyClassName)}>
          {state === "loading" && (
            <div className="space-y-2" aria-label="Carregando notas...">
              <Skeleton className="h-9 w-3/5" />
              <Skeleton className="h-9 w-2/5 ml-auto" />
            </div>
          )}

          {state === "error" && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 flex items-center justify-between gap-2">
              <p className="text-[11px] text-danger">Não consegui carregar as notas.</p>
              <button
                type="button"
                onClick={load}
                className="text-[10.5px] font-semibold text-fg-muted hover:text-fg cursor-pointer"
              >
                tentar de novo
              </button>
            </div>
          )}

          {/* Empty state centrado e curto. A versão longa em itálico ocupava
              3 linhas coladas na borda e desalinhava o bloco todo. */}
          {state === "ready" && count === 0 && (
            <p className="text-center text-[11px] text-fg-subtle leading-snug py-1">
              Nenhuma nota ainda. Registre aqui o que aconteceu nessa campanha.
            </p>
          )}

          {state === "ready" && count > 0 && (
            <div
              ref={scrollRef}
              // max-h-[200px]: teto baixo de propósito. A thread é registro,
              // não a informação principal do sheet/drawer — deixar crescer
              // até 300px+ empurrava Snapshot e as ações admin pra baixo.
              // Passando disso, rola aqui dentro (já ancorado no fim).
              // scrollbar-thin + pr-3: a barra nativa (larga) cobria a borda
              // das bolhas alinhadas à direita.
              // border-t: delimita o começo da thread. Sem isso, quando ela
              // abre rolada no fim, o rodapé da nota cortada no topo colava
              // no header e parecia ação DO header.
              className="max-h-[200px] overflow-y-auto scrollbar-thin pr-3 pt-2 space-y-2 border-t border-border/60"
            >
              {rendered.map(({ note, mine, authorName, showMeta, dayLabel }) => (
                <div key={note.note_id} className="space-y-2">
                  {dayLabel && (
                    <div className="flex items-center gap-2 pt-1">
                      <span className="h-px flex-1 bg-border" />
                      <span className="text-[9.5px] uppercase tracking-wider font-semibold text-fg-subtle">
                        {dayLabel}
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  <NoteBubble
                    note={note}
                    mine={mine}
                    authorName={authorName}
                    showMeta={showMeta}
                    canEdit={mine && !note.pending}
                    busy={busyId === note.note_id}
                    onEdit={() => handleEdit(note)}
                    onDelete={() => handleDelete(note.note_id)}
                  />
                </div>
              ))}
            </div>
          )}

          {state !== "loading" && (
            <Composer
              value={draft}
              onChange={setDraft}
              onSubmit={handleSubmit}
              onCancelEdit={() => { setEditingId(null); setDraft(""); }}
              editing={!!editingId}
              sending={sending}
              autoFocus={autoFocus}
            />
          )}
        </div>
      )}
    </section>
  );
}
