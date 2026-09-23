// src/v2/components/CommentsDrawerV2.jsx
//
// Painel de comentários do report, aberto pelo botão do topo. Junta num
// lugar as conversas que antes ficavam no rodapé de RMND, PDOOH e Brand
// Lift (mesmas threads, mesmas mensagens) e ganha a conversa "Geral" para
// o report como um todo. Abre na thread da aba em que a pessoa está.

import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Drawer, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader } from "../../ui/Drawer";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { ChipGroupV2 } from "./ChipGroupV2";
import { parseCommentTime } from "../../shared/commentThreads";

function whenLabel(value) {
  const ms = parseCommentTime(value);
  if (ms == null) return value ? String(value).slice(0, 16) : "";
  return new Date(ms).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function CommentsDrawerV2({ open, onOpenChange, threads, initialThread, comments, onSend, isAdmin = false, loaded = true }) {
  const [thread, setThread] = useState(initialThread || threads[0]?.value);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [wasOpen, setWasOpen] = useState(open);
  const listRef = useRef(null);

  // Ao abrir, vai para a conversa da aba atual (ajuste durante o render,
  // sem effect: não depende da identidade de `threads`, que muda a cada
  // render do dashboard).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setThread(initialThread || threads[0]?.value);
      setError(null);
    }
  }

  const current = threads.some((t) => t.value === thread) ? thread : threads[0]?.value;
  const messages = comments.filter((c) => c.metric_name === current);
  const countBy = (value) => comments.filter((c) => c.metric_name === value).length;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, current, open]);

  const submit = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend({ thread: current, text });
      setText("");
    } catch (e) {
      setError(e?.message || "Não foi possível enviar");
    } finally {
      setSending(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent widthClass="sm:w-[440px]">
        <DrawerHeader title="Comentários" />
        <div className="px-6 pt-3 pb-3 border-b border-border space-y-3">
          <Dialog.Description className="text-xs text-fg-muted leading-relaxed">
            Conversa entre {isAdmin ? "o cliente" : "você"} e a HYPR sobre este report.
          </Dialog.Description>
          {threads.length > 1 && (
            <ChipGroupV2
              label="Conversa"
              value={current}
              onChange={setThread}
              options={threads.map((t) => ({ value: t.value, label: t.label, count: countBy(t.value) || null }))}
            />
          )}
        </div>
        <DrawerBody className="px-0 py-0">
          <div ref={listRef} className="h-full overflow-y-auto px-6 py-4 space-y-3" aria-live="polite">
            {!loaded ? (
              <p className="text-center text-sm text-fg-subtle py-8">Carregando…</p>
            ) : messages.length === 0 ? (
              <p className="text-center text-sm text-fg-subtle py-8">
                Nenhuma mensagem nesta conversa ainda.
              </p>
            ) : (
              messages.map((m, i) => {
                const hypr = m.author === "HYPR";
                return (
                  <div key={`${m.created_at}-${i}`} className={cn("flex flex-col", hypr ? "items-end" : "items-start")}>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-1">
                      {hypr ? "HYPR" : "Cliente"}
                    </span>
                    <div
                      className={cn(
                        "max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px] leading-snug whitespace-pre-wrap break-words",
                        hypr
                          ? "bg-signature-fill text-on-signature rounded-br-sm"
                          : "bg-surface-strong text-fg border border-border rounded-bl-sm",
                      )}
                    >
                      {m.comment}
                    </div>
                    <span className="text-[10px] text-fg-subtle mt-1 tabular-nums">{whenLabel(m.created_at)}</span>
                  </div>
                );
              })
            )}
          </div>
        </DrawerBody>
        <DrawerFooter className="flex-col items-stretch gap-2">
          <label htmlFor="comment-input" className="sr-only">Mensagem</label>
          <textarea
            id="comment-input"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={isAdmin ? "Responder como HYPR…" : "Escreva sua mensagem…"}
            maxLength={2000}
            className="w-full resize-none rounded-lg border border-border-strong bg-canvas-deeper px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-fg-subtle" role={error ? "alert" : undefined}>
              {error ? <span className="text-danger">{error}</span> : "Enter envia · Shift+Enter quebra a linha"}
            </span>
            <Button size="sm" onClick={submit} loading={sending} disabled={!text.trim() || sending}>
              Enviar
            </Button>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
