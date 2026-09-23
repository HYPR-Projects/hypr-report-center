// src/v2/hooks/useReportComments.js
//
// Conversas do report (chat cliente ↔ HYPR), todas as threads de uma vez:
// o backend devolve tudo por short_token e cada mensagem traz a thread em
// `metric_name` (GERAL, RMND, PDOOH, SURVEY). Antes cada aba montava o seu
// TabChat e fazia o próprio polling; agora um hook só alimenta o painel de
// comentários do topo e o contador do botão.
//
// Report mesclado: o Brand Lift mostrava uma conversa por mês, gravada no
// short_token de cada membro. `surveyTokens` traz esses tokens e as
// mensagens SURVEY deles entram na conversa "Brand Lift" (leitura; o que se
// envia agora vai para o token do report).
//
// Polling: 30 s com o painel aberto, 120 s fechado (só pro contador).
// Não lidas: mensagens da outra parte depois do último acesso ao painel,
// guardado por navegador (localStorage). Sem storage, conta todas.

import { useEffect, useRef, useState } from "react";
import { getComments, saveComment } from "../../lib/api";
import { countUnread, mergeCommentSources } from "../../shared/commentThreads";

const seenKey = (token) => `hypr_comments_seen:${token}`;

function readSeen(token) {
  try {
    return Number(localStorage.getItem(seenKey(token))) || 0;
  } catch {
    return 0;
  }
}

export function useReportComments({ token, open = false, viewer = "Cliente", surveyTokens = [] }) {
  const [comments, setComments] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [seenAt, setSeenAt] = useState(() => readSeen(token));
  const pendingRef = useRef([]); // mensagens enviadas ainda não refletidas no GET
  // Chave estável para o effect (o array chega novo a cada render).
  const extraKey = [...new Set(surveyTokens.filter((t) => t && t !== token))].sort().join(",");

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    let active = true;
    const extras = extraKey ? extraKey.split(",") : [];
    const load = () => {
      Promise.all([
        getComments(token, { signal: controller.signal }),
        ...extras.map((t) => getComments(t, { signal: controller.signal })),
      ])
        .then(([own, ...others]) => {
          if (!active) return;
          const all = mergeCommentSources(own, others, { onlyThread: "SURVEY" });
          // Mantém as enviadas nesta sessão que o backend ainda não devolveu
          // (DEMO não persiste; em produção o GET alcança em segundos).
          const seen = new Set(all.map((c) => `${c.metric_name}|${c.author}|${c.comment}`));
          pendingRef.current = pendingRef.current.filter((c) => !seen.has(`${c.metric_name}|${c.author}|${c.comment}`));
          setComments([...all, ...pendingRef.current]);
          setLoaded(true);
        })
        .catch((err) => {
          if (err?.name !== "AbortError" && active) setLoaded(true);
        });
    };
    load();
    const interval = setInterval(load, open ? 30_000 : 120_000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [token, open, extraKey]);

  const send = async ({ thread, author, text, adminJwt }) => {
    const comment = String(text || "").trim();
    if (!comment) return false;
    const res = await saveComment({ short_token: token, metric_name: thread, author, comment, adminJwt });
    if (res && res.ok === false) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d?.error || "Não foi possível enviar");
    }
    const msg = { metric_name: thread, author, comment, created_at: new Date().toISOString() };
    pendingRef.current = [...pendingRef.current, msg];
    setComments((prev) => [...prev, msg]);
    return true;
  };

  // Chamado ao abrir e ao fechar o painel: o que estava lá foi visto.
  const markSeen = () => {
    const now = Date.now();
    setSeenAt(now);
    try {
      localStorage.setItem(seenKey(token), String(now));
    } catch {
      /* storage bloqueado: o contador só não persiste */
    }
  };

  const unread = open ? 0 : countUnread(comments, { viewer, seenAt });

  return { comments, loaded, send, unread, markSeen };
}
