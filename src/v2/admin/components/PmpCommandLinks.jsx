// src/v2/admin/components/PmpCommandLinks.jsx
//
// Vinculação de N checklists do Hypr Command a uma line (deal de pagamento).
//
// Por que N: o cliente aproveita o MESMO deal e roda campanhas diferentes em
// cima dele — cada uma com seu checklist (token) e seu PI. O modelo antigo
// (1 token por line) obrigava a escolher um e perdia o orçamento das outras;
// o % de entrega saía contra um PI menor do que o contratado.
//
// Regras (espelham backend/pmp_lines.set_line_tokens):
//   • tokens[0] é o PRINCIPAL — vai pro campo `code` da line no Xandr. Trocar
//     o principal = PUT no Xandr; adicionar/remover extras não toca no Xandr.
//   • PI da line = SOMA dos investments dos checklists casados. Override
//     manual continua ganhando (é exceção, mostrada como tal).
//   • Token que não existe no espelho do Command pode ser vinculado (o espelho
//     atualiza no sync das 04h), mas fica sinalizado — e não soma PI.
//
// Peças:
//   CommandLinksBlock  — bloco do drawer: lista editável (remover, tornar
//                        principal) + picker inline pra adicionar.
//   CommandLinkPicker  — sugestões automáticas + busca manual com preview
//                        (cliente · campanha · PI) antes de confirmar.
//   LinkCommandPopup   — Drawer com o picker, pra entrada direta da lista
//                        ("🔗 vincular" numa line sem PI).

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Drawer, DrawerContent, DrawerHeader, DrawerBody,
} from "../../../ui/Drawer";
import { Button } from "../../../ui/Button";
import { Skeleton } from "../../../ui/Skeleton";
import { cn } from "../../../ui/cn";
import { fmt } from "../../../shared/format";
import { suggestPmpLinks, lookupPmpChecklists } from "../../../lib/api";
import { formatBRL } from "../lib/pmpFormat";
import {
  lineTokens, lineChecklists, commandPiTotal, matchedChecklistCount,
  withoutToken, asPrimary, normalizeToken, isValidToken,
} from "../lib/pmpTokens";

// ─── Ícones ──────────────────────────────────────────────────────────────────
export function SpinnerIcon({ className, size = 12 }) {
  return (
    <svg className={cn("animate-spin", className)} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3.5" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

function IconX({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12"/>
    </svg>
  );
}

function IconStar({ size = 11, filled = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden>
      <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
    </svg>
  );
}

function IconPlus({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14"/>
    </svg>
  );
}

function IconWarn({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 9v4M12 17h.01"/>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>
    </svg>
  );
}

// Botão de ícone pequeno e quadrado (ações por linha).
function IconButton({ title, onClick, disabled, danger, children, className }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent",
              "text-fg-subtle hover:text-fg hover:bg-surface hover:border-border transition-colors",
              "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent",
              danger && "hover:text-danger hover:bg-danger/10 hover:border-danger/30",
              className,
            )}>
      {children}
    </button>
  );
}

// ─── Descrição de conflito (mesmo texto nos dois lugares) ────────────────────
function conflictText(err) {
  const list = Array.isArray(err?.conflicts) && err.conflicts.length
    ? err.conflicts
    : (err?.conflict_line_id ? [{ line_id: err.conflict_line_id }] : []);
  if (list.length === 0) return err?.message || "Conflito";
  const where = list.map(c => `line ${c.line_id}${c.line_name ? ` (${c.line_name})` : ""}`).join(", ");
  return `Token já vinculado a ${where}. O mesmo token em duas lines conta o PI 2× nos KPIs — a não ser que elas estejam agrupadas sob o mesmo PI.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// CommandLinksBlock — bloco do drawer
// ═══════════════════════════════════════════════════════════════════════════
/**
 * @param {object}   line          line enriquecida
 * @param {boolean}  canEdit
 * @param {(tokens:string[], opts?:{force?:boolean}) => Promise<any>} onSetTokens
 *        recebe a LISTA COMPLETA nova (principal primeiro). Deve rejeitar
 *        com err.is_conflict quando o backend devolver 409.
 */
export function CommandLinksBlock({ line, canEdit = false, onSetTokens }) {
  const tokens = useMemo(() => lineTokens(line), [line]);
  const checklists = useMemo(() => lineChecklists(line), [line]);
  const total = commandPiTotal(line);
  const matched = matchedChecklistCount(line);

  const [adding, setAdding] = useState(false);
  const [busyKey, setBusyKey] = useState(null);   // "remove:TOKEN" | "primary:TOKEN" | null
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [err, setErr] = useState(null);
  const confirmTimer = useRef(null);

  // Troca de line → zera estado transitório (o drawer não desmonta entre lines).
  useEffect(() => {
    setAdding(false); setBusyKey(null); setConfirmRemove(null); setErr(null);
  }, [line?.source, line?.line_id]);

  useEffect(() => () => clearTimeout(confirmTimer.current), []);

  const run = useCallback(async (key, nextTokens) => {
    if (busyKey) return;
    setErr(null); setBusyKey(key);
    try { await onSetTokens(nextTokens); }
    catch (e) { setErr(e?.message || "Erro ao salvar vínculo"); }
    finally { setBusyKey(null); setConfirmRemove(null); }
  }, [busyKey, onSetTokens]);

  const askRemove = (t) => {
    setConfirmRemove(t);
    clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmRemove(null), 3500);
  };

  const isXandr = (line?.source || "xandr") === "xandr";
  const busy = busyKey != null;

  // Vazio: CTA único e claro — é a ação que destrava PI/pacing da line.
  if (tokens.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-warning/40 bg-warning/[0.04] px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="lbl-section text-warning">Hypr Command · sem checklist</div>
            <div className="text-[11px] text-fg-muted mt-1 leading-relaxed">
              Sem vínculo não há PI — a line não entra no pacing nem no % de entrega.
              Vincule 1 ou mais checklists; com vários, o PI é a <span className="text-fg">soma</span>.
            </div>
          </div>
        </div>
        {canEdit && !adding && (
          <Button variant="primary" size="sm" className="mt-3" onClick={() => setAdding(true)}>
            🔗 Vincular ao Hypr Command
          </Button>
        )}
        {canEdit && adding && (
          <div className="mt-3">
            <CommandLinkPicker line={line} tokens={tokens} autoFocus
                               onAdd={(t, opts) => onSetTokens([...tokens, t], opts)}
                               onCancel={() => setAdding(false)} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-signature/30 bg-signature/[0.04]">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="min-w-0">
          <div className="lbl-section text-signature">
            Hypr Command · {tokens.length === 1 ? "1 checklist" : `${tokens.length} checklists`}
          </div>
          <div className="text-[11px] text-fg-muted mt-0.5 tabular-nums">
            {total != null ? (
              <>PI {tokens.length > 1 ? "somado " : ""}<span className="text-fg font-medium">{formatBRL(total)}</span></>
            ) : (
              <span className="text-warning">nenhum checklist encontrado no Command</span>
            )}
            {tokens.length > 1 && matched < tokens.length && (
              <span className="text-warning"> · {tokens.length - matched} sem match</span>
            )}
            {line?.pi_overridden && (
              <span className="text-warning"> · override manual ativo ({formatBRL(line.pi_brl)})</span>
            )}
          </div>
        </div>
        {canEdit && (
          <button type="button" onClick={() => setAdding(a => !a)} disabled={busy}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 px-2.5 rounded-md border text-[11px] transition-colors shrink-0",
                    adding ? "border-border bg-surface text-fg"
                           : "border-signature/40 bg-signature/10 text-signature hover:bg-signature/20",
                    busy && "opacity-50 cursor-not-allowed",
                  )}>
            {adding ? <><IconX /> Fechar</> : <><IconPlus /> Adicionar</>}
          </button>
        )}
      </div>

      <ul className="px-3 pb-3 space-y-1.5">
        {checklists.map((c) => {
          const t = c.short_token;
          const removing = busyKey === `remove:${t}`;
          const promoting = busyKey === `primary:${t}`;
          const rowBusy = removing || promoting;
          const confirming = confirmRemove === t;
          const notFound = c.found === false;
          return (
            <li key={t}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2 transition-colors",
                  rowBusy ? "border-signature/50 bg-signature/[0.08]" : "border-border bg-canvas/40",
                  busy && !rowBusy && "opacity-60",
                )}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  {rowBusy && <SpinnerIcon className="text-signature" />}
                  <span className={cn("font-mono text-xs", notFound ? "text-warning" : "text-signature")}>{t}</span>
                  {c.primary && (
                    <span className="lbl-micro px-1.5 py-0.5 rounded bg-signature/10 text-signature border border-signature/20"
                          title={isXandr ? "Token principal — é o `code` da line no Xandr" : "Token principal"}>
                      principal
                    </span>
                  )}
                  {notFound && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-warning"
                          title="Não existe no espelho do Command (atualiza no sync das 04h). Não soma PI até casar.">
                      <IconWarn /> não encontrado
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-fg-muted truncate mt-0.5"
                     title={[c.client, c.campaign_name, c.agency].filter(Boolean).join(" · ")}>
                  {c.found === null
                    ? <span className="text-fg-subtle">detalhes após o próximo refresh</span>
                    : notFound
                      ? <span className="text-fg-subtle">—</span>
                      : <>{c.client || "?"} <span className="mx-1 text-fg-subtle">·</span> {c.campaign_name || "?"}{c.agency ? <span className="text-fg-subtle"> · {c.agency}</span> : null}</>}
                </div>
              </div>
              <div className={cn("text-right text-[12px] tabular-nums shrink-0", c.investment != null ? "text-fg" : "text-fg-subtle")}>
                {c.investment != null ? formatBRL(c.investment) : "—"}
              </div>
              {canEdit && (
                <div className="flex items-center gap-0.5 shrink-0">
                  {!c.primary && (
                    <IconButton title={isXandr ? "Tornar principal (escreve este token no code da line no Xandr)" : "Tornar principal"}
                                disabled={busy}
                                onClick={() => run(`primary:${t}`, asPrimary(tokens, t))}>
                      <IconStar />
                    </IconButton>
                  )}
                  {confirming ? (
                    <button type="button" disabled={busy}
                            onClick={() => run(`remove:${t}`, withoutToken(tokens, t))}
                            className="h-6 px-2 rounded-md bg-danger text-on-semantic text-[10px] font-semibold hover:opacity-90 disabled:opacity-50">
                      {tokens.length === 1 ? "Desvincular?" : "Remover?"}
                    </button>
                  ) : (
                    <IconButton title={tokens.length === 1 ? "Desvincular do Command" : "Remover este checklist"}
                                danger disabled={busy} onClick={() => askRemove(t)}>
                      <IconX />
                    </IconButton>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {tokens.length > 1 && total != null && (
        <div className="flex items-center justify-between px-4 pb-3 -mt-1 text-[11px]">
          <span className="text-fg-muted">
            PI total = soma de {matched} checklist{matched === 1 ? "" : "s"}
            {line?.pi_overridden ? " (ignorado pelo override manual)" : ""}
          </span>
          <span className={cn("tabular-nums font-semibold", line?.pi_overridden ? "text-fg-subtle line-through" : "text-fg")}>
            {formatBRL(total)}
          </span>
        </div>
      )}

      {err && (
        <div className="mx-3 mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {err}
        </div>
      )}

      {canEdit && adding && (
        <div className="border-t border-signature/20 px-4 py-3">
          <div className="text-[11px] text-fg-muted mb-2.5">
            Adicionar checklist — o PI dele <span className="text-fg">soma</span> ao{tokens.length > 1 ? "s" : ""} atual{tokens.length > 1 ? "is" : ""}.
          </div>
          <CommandLinkPicker line={line} tokens={tokens} autoFocus hideCancelButton
                             onAdd={(t, opts) => onSetTokens([...tokens, t], opts)}
                             onCancel={() => setAdding(false)} />
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CommandLinkPicker — sugestões + busca manual com preview
// ═══════════════════════════════════════════════════════════════════════════
/**
 * @param {object}   line
 * @param {string[]} tokens     já vinculados (saem das sugestões)
 * @param {(token:string, opts?:{force?:boolean}) => Promise<any>} onAdd
 * @param {() => void} [onCancel]
 * @param {boolean}  [autoFocus]
 * @param {boolean}  [hideCancelButton] esconde o "Fechar" do rodapé (o bloco
 *                               do drawer já tem o toggle no cabeçalho); Esc
 *                               continua chamando onCancel.
 */
export function CommandLinkPicker({ line, tokens = [], onAdd, onCancel, autoFocus = false, hideCancelButton = false }) {
  const [suggestions, setSuggestions] = useState(null);   // null = carregando
  const [sugErr, setSugErr] = useState(null);
  const [manual, setManual] = useState("");
  const [preview, setPreview] = useState(null);           // { loading, result, token }
  const [busyToken, setBusyToken] = useState(null);
  const [err, setErr] = useState(null);
  const [conflict, setConflict] = useState(null);         // { token, err }
  const inputRef = useRef(null);
  const lookupSeq = useRef(0);

  const lineId = line?.line_id;
  const linked = useMemo(() => new Set(tokens.map(normalizeToken)), [tokens]);

  // Sugestões automáticas (fuzzy por nome da line / cliente).
  useEffect(() => {
    if (!lineId) return;
    let cancelled = false;
    setSuggestions(null); setSugErr(null);
    suggestPmpLinks(lineId)
      .then(list => { if (!cancelled) setSuggestions(Array.isArray(list) ? list : []); })
      .catch(e => { if (!cancelled) { setSuggestions([]); setSugErr(e?.message || "erro"); } });
    return () => { cancelled = true; };
  }, [lineId]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Preview do token digitado (debounce). Só consulta quando o formato é
  // válido — evita bater no backend a cada tecla de um token pela metade.
  const manualNorm = normalizeToken(manual);
  const manualValid = isValidToken(manualNorm);
  const manualLinked = manualNorm && linked.has(manualNorm);
  useEffect(() => {
    if (!manualValid || manualLinked) { setPreview(null); return; }
    const seq = ++lookupSeq.current;
    setPreview({ loading: true, token: manualNorm, result: null });
    const h = setTimeout(() => {
      lookupPmpChecklists([manualNorm])
        .then(list => {
          if (lookupSeq.current !== seq) return;
          setPreview({ loading: false, token: manualNorm, result: list?.[0] || { short_token: manualNorm, found: false } });
        })
        .catch(() => {
          if (lookupSeq.current !== seq) return;
          // Sem preview não bloqueia: dá pra vincular às cegas, como antes.
          setPreview({ loading: false, token: manualNorm, result: null, failed: true });
        });
    }, 350);
    return () => clearTimeout(h);
  }, [manualNorm, manualValid, manualLinked]);

  const visibleSuggestions = useMemo(
    () => (suggestions || []).filter(s => s?.short_token && !linked.has(normalizeToken(s.short_token))),
    [suggestions, linked],
  );

  const tryAdd = async (rawToken, force = false) => {
    const t = normalizeToken(rawToken);
    if (!t || busyToken) return;
    if (!isValidToken(t)) { setErr(`Token inválido: ${t}`); return; }
    if (linked.has(t)) { setErr(`${t} já está vinculado a esta line.`); return; }
    setErr(null); setConflict(null); setBusyToken(t);
    try {
      await onAdd(t, { force });
      setManual(""); setPreview(null);
    } catch (e) {
      if (e?.is_conflict) setConflict({ token: t, err: e });
      else setErr(e?.message || "Erro ao vincular");
    } finally {
      setBusyToken(null);
    }
  };

  const isBusy = busyToken != null;
  const previewResult = preview && !preview.loading ? preview.result : null;

  return (
    <div className="space-y-4">
      {/* Busca manual — primeiro, porque é o caminho quando o operador já
          sabe o token (o caso mais comum ao ADICIONAR um 2º checklist). */}
      <div className="space-y-2">
        <div className="lbl-section">Token do checklist</div>
        <div className="flex items-center gap-2">
          <input ref={inputRef} type="text" value={manual}
                 onChange={e => { setManual(e.target.value.toUpperCase()); setErr(null); setConflict(null); }}
                 onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); tryAdd(manual); } if (e.key === "Escape" && onCancel) onCancel(); }}
                 placeholder="ex: NO2015"
                 disabled={isBusy}
                 spellCheck={false}
                 className={cn(
                   "flex-1 h-9 px-3 rounded-md bg-surface border border-border text-sm text-fg uppercase font-mono",
                   "focus:outline-none focus:ring-2 focus:ring-signature/40",
                   isBusy && "opacity-60 cursor-not-allowed",
                 )} />
          <Button variant="primary" size="sm"
                  onClick={() => tryAdd(manual)}
                  disabled={!manualValid || manualLinked || isBusy}>
            {busyToken && busyToken === manualNorm
              ? <span className="inline-flex items-center gap-1.5"><SpinnerIcon /> Vinculando…</span>
              : "Vincular"}
          </Button>
        </div>
        {manualNorm && !manualValid && (
          <div className="text-[11px] text-fg-subtle">Token: letras e números, 2 a 40 caracteres (ex: NO2015).</div>
        )}
        {manualLinked && (
          <div className="text-[11px] text-warning">{manualNorm} já está vinculado a esta line.</div>
        )}
        {preview?.loading && (
          <div className="flex items-center gap-2 text-[11px] text-fg-subtle"><SpinnerIcon /> procurando no Command…</div>
        )}
        {previewResult && previewResult.found && (
          <div className="rounded-md border border-success/30 bg-success/[0.06] px-3 py-2">
            <div className="text-[12px] text-fg">
              {previewResult.client || "?"} <span className="text-fg-subtle mx-1">·</span> {previewResult.campaign_name || "?"}
            </div>
            <div className="text-[11px] text-fg-muted mt-0.5 tabular-nums">
              {previewResult.agency || "—"} · PI {previewResult.investment != null ? formatBRL(previewResult.investment) : "—"}
              {" · "}{previewResult.cp_name || "?"} / {previewResult.cs_name || "?"}
            </div>
          </div>
        )}
        {previewResult && !previewResult.found && (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[11px] text-warning">
            <IconWarn />
            <span>
              <span className="font-mono">{preview.token}</span> não existe no espelho do Command (checklists novos entram no sync das 04h).
              Dá pra vincular mesmo assim — o PI só soma quando o checklist aparecer.
            </span>
          </div>
        )}
        {preview && !preview.loading && preview.failed && (
          <div className="text-[11px] text-fg-subtle">Não consegui consultar o Command agora; a vinculação continua funcionando.</div>
        )}
      </div>

      {/* Sugestões automáticas */}
      <div className="space-y-2">
        <div className="lbl-section">Sugestões automáticas</div>
        {suggestions == null && <Skeleton className="h-14 w-full rounded-md" />}
        {suggestions != null && visibleSuggestions.length === 0 && (
          <div className="text-[11px] text-fg-subtle">
            {sugErr ? `Sem sugestões (${sugErr}).` : "Nenhuma sugestão pelo nome da line — use o token acima."}
          </div>
        )}
        {visibleSuggestions.map(s => {
          const t = normalizeToken(s.short_token);
          const linkingThis = busyToken === t;
          const dimmed = isBusy && !linkingThis;
          return (
            <button key={t} type="button" onClick={() => tryAdd(t)} disabled={isBusy}
                    className={cn(
                      "w-full text-left rounded-lg border px-3.5 py-2.5 transition-all",
                      linkingThis ? "border-signature/60 bg-signature/[0.08]" : "border-border bg-surface/40",
                      !isBusy && "hover:bg-surface hover:border-border-strong cursor-pointer",
                      dimmed && "opacity-40",
                      isBusy && "cursor-default",
                    )}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-mono text-xs text-signature">
                  {linkingThis && <SpinnerIcon className="text-signature" />}
                  {t}
                </div>
                <div className={cn("text-[10px] tabular-nums", linkingThis ? "text-signature font-semibold" : "text-fg-subtle")}>
                  {linkingThis ? "vinculando…" : `match ${fmt((s.score || 0) * 100, 0)}%`}
                </div>
              </div>
              <div className="text-[12.5px] text-fg mt-1">{s.client} <span className="text-fg-subtle mx-1">·</span> {s.campaign_name}</div>
              <div className="text-[11px] text-fg-muted mt-0.5 tabular-nums">
                {s.agency || "—"} · PI {s.investment != null ? formatBRL(s.investment) : "—"} · {s.cp_name || "?"} / {s.cs_name || "?"}
              </div>
            </button>
          );
        })}
      </div>

      {(err || conflict) && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {conflict ? conflictText(conflict.err) : err}
          {conflict && (
            <button type="button" onClick={() => tryAdd(conflict.token, true)} disabled={isBusy}
                    className="block mt-2 text-warning underline-offset-2 hover:underline text-[11px] disabled:opacity-40 disabled:no-underline">
              {isBusy ? "Vinculando…" : `Vincular ${conflict.token} mesmo assim`}
            </button>
          )}
        </div>
      )}

      {onCancel && !hideCancelButton && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={isBusy}>Fechar</Button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LinkCommandPopup — Drawer pra entrada direta da lista
// ═══════════════════════════════════════════════════════════════════════════
/**
 * @param {(token:string, opts?:{force?:boolean}) => Promise<any>} onLink
 *        o pai monta a lista (tokens atuais + novo), grava e fecha o popup.
 */
export function LinkCommandPopup({ open, onOpenChange, line, onLink }) {
  const [busy, setBusy] = useState(false);
  const tokens = useMemo(() => lineTokens(line), [line]);
  useEffect(() => { setBusy(false); }, [line]);
  if (!line) return null;
  const isXandr = (line.source || "xandr") === "xandr";
  const handleAdd = async (t, opts) => {
    setBusy(true);
    try { await onLink(t, opts); }
    finally { setBusy(false); }
  };
  return (
    <Drawer open={open} onOpenChange={busy ? () => {} : onOpenChange}>
      <DrawerContent widthClass="sm:w-[540px]">
        <DrawerHeader title={tokens.length ? "Adicionar checklist do Command" : "Vincular ao Hypr Command"}
                      subtitle={`Line ${line.line_id} · ${line.line_name || ""}`} />
        <DrawerBody>
          <div className="text-xs text-fg-muted mb-5 leading-relaxed">
            {tokens.length === 0 ? (
              <>
                Escolha o checklist do Command.
                {isXandr
                  ? <> Vai escrever o token no campo <code className="text-fg bg-surface px-1 rounded">code</code> da line no Xandr e</>
                  : <> Vai</>}
                {" "}puxar PI, agência e owners automaticamente. Depois dá pra somar outros checklists no mesmo deal.
              </>
            ) : (
              <>
                Esta line já tem {tokens.length === 1 ? "o checklist" : "os checklists"}{" "}
                {tokens.map(t => <span key={t} className="font-mono text-signature">{t} </span>)}
                — o PI do novo <span className="text-fg">soma</span> ao atual.
              </>
            )}
          </div>
          <CommandLinkPicker line={line} tokens={tokens} autoFocus onAdd={handleAdd} />
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
