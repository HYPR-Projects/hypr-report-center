// src/v2/hooks/useReportTracking.js
//
// Hook que dispara eventos de acesso ao ClientDashboardV2 pro endpoint
// `POST ?action=track_access` no backend. Pareado com
// backend/access_tracking.py.
//
// Eventos disparados:
//   - pageview     — 1x no mount do dashboard
//   - heartbeat    — a cada 60s ENQUANTO a aba estiver visível
//   - tab_change   — quando user troca de aba dentro do report
//   - session_end  — flush final via navigator.sendBeacon em pagehide /
//                    visibilitychange=hidden. Captura duração total
//                    mesmo quando o user fecha a aba sem aviso.
//
// Defaults:
//   - Skip TOTAL quando isAdmin=true. Admin não infla métricas, nem
//     mesmo com is_internal=true (mais limpo + sem PII admin trafegando).
//   - Heartbeat só dispara com document.visibilityState === "visible"
//     (aba ativa). Aba em background não conta — tempo médio real.
//   - Session_id é UUID per-tab via sessionStorage. Mesma aba, mesmo
//     report = mesma sessão. Trocar de report (shortToken muda) = nova
//     sessão (porque a key inclui o token).
//   - Falhas no fetch são silenciadas — analytics degradado é OK,
//     report quebrado não é.
//
// API:
//   useReportTracking({ shortToken, shareId, isAdmin, currentTabId })
//
// O caller passa currentTabId — quando ele muda, hook emite tab_change
// automaticamente. Mantém o hook stateless do ponto de vista do consumer.

import { useCallback, useEffect, useRef } from "react";
import { API_URL } from "../../shared/config";

// Cadência do heartbeat. Backend tolera retries duplicados via event_id,
// então essa cadência pode ser ajustada sem perigo de inflacionar.
const HEARTBEAT_INTERVAL_MS = 60_000;

// Janela de inatividade — se o user não fez nenhuma interação (mouse,
// teclado, scroll, touch) nos últimos N ms, o heartbeat pula. Sem isso,
// uma aba visível ABERTA sem ninguém olhando emite 1 heartbeat/min
// "infinito" e infla tempo médio.
//
// 2 minutos cobre pausas naturais (ler uma seção longa, pegar café por
// 1min) sem perder a sessão. Mais agressivo (30s) cortaria leitura
// pausada legítima.
const IDLE_THRESHOLD_MS = 2 * 60_000;

// Storage key prefixada com short_token: trocar de report na mesma aba
// gera nova session — comportamento esperado (cada visita é uma "vez").
const sessionKey = (shortToken) => `hypr.tracking.session.${shortToken}`;
const sessionStartKey = (shortToken) => `hypr.tracking.start.${shortToken}`;

function uuid() {
  // crypto.randomUUID() requer HTTPS + browser moderno (todos suportados
  // hoje em prod). Fallback raríssimo (Safari < 15.4 sem WebCrypto pleno):
  // Math.random — colisão astronomicamente improvável no escopo necessário.
  try {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* falls through */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function getOrCreateSession(shortToken) {
  if (typeof window === "undefined") return null;
  try {
    let id = sessionStorage.getItem(sessionKey(shortToken));
    let startedAt = parseInt(sessionStorage.getItem(sessionStartKey(shortToken)) || "0", 10);
    if (!id) {
      id = uuid();
      startedAt = Date.now();
      sessionStorage.setItem(sessionKey(shortToken), id);
      sessionStorage.setItem(sessionStartKey(shortToken), String(startedAt));
    }
    return { id, startedAt };
  } catch {
    // sessionStorage pode falhar em modos privados / ITP — caímos
    // pra sessão in-memory que dura só esse mount.
    return { id: uuid(), startedAt: Date.now() };
  }
}

function buildPayload(session, shortToken, shareId, eventType, extra = {}) {
  return {
    // event_id gerado no client — garante idempotência REAL: retry
    // de um mesmo fetch (eg keepalive timeout) reusa o mesmo id, e o
    // ROW_NUMBER PARTITION BY event_id no rollup dedupa. Sem isso,
    // cada retry vira uma linha extra e enviesa "tempo médio" pra cima.
    event_id:    uuid(),
    short_token: shortToken,
    share_id:    shareId || null,
    session_id:  session.id,
    event_type:  eventType,
    duration_ms: Date.now() - session.startedAt,
    viewport_w:  typeof window !== "undefined" ? window.innerWidth : null,
    viewport_h:  typeof window !== "undefined" ? window.innerHeight : null,
    referrer:    typeof document !== "undefined" ? document.referrer : "",
    client_ts:   new Date().toISOString(),
    ...extra,
  };
}

function send(payload, { useBeacon = false } = {}) {
  // sendBeacon é fire-and-forget e SOBREVIVE a navegação/unload —
  // crítico pro session_end. Para pageview/heartbeat usamos fetch
  // normal pra ter `keepalive: true` (sobrevive ao unload também e
  // permite leitura de erro pra log local).
  const url = `${API_URL}?action=track_access`;
  const body = JSON.stringify(payload);

  if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    try {
      const blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(url, blob);
      return;
    } catch {
      // Fallback pra fetch abaixo
    }
  }

  try {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      // keepalive=true sobrevive ao unload (limite 64KB — irrelevante
      // aqui, payload típico < 1KB).
      keepalive: true,
    }).catch(() => {
      // Silencioso — degraded tracking é OK
    });
  } catch {
    // window indisponível (SSR) ou outras falhas — silencioso
  }
}

export function useReportTracking({ shortToken, shareId, isAdmin, currentTabId }) {
  // Refs pra não disparar re-render quando atualizamos session/timers.
  const sessionRef = useRef(null);
  const prevTabRef = useRef(null);
  const mountedRef = useRef(false);

  // Inicialização + pageview. Roda 1x por shortToken — re-mount com token
  // diferente gera nova sessão. Skip total pra admin (não emite nada).
  useEffect(() => {
    if (!shortToken || isAdmin) return;
    mountedRef.current = true;

    const session = getOrCreateSession(shortToken);
    if (!session) return;
    sessionRef.current = session;

    // Pageview inicial
    send(buildPayload(session, shortToken, shareId, "pageview", {
      tab_id: currentTabId || null,
    }));
    prevTabRef.current = currentTabId || null;

    return () => {
      mountedRef.current = false;
    };
    // currentTabId NÃO entra nas deps — não queremos refire de pageview
    // quando o user troca de aba (isso vira tab_change abaixo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortToken, shareId, isAdmin]);

  // Heartbeat — só dispara com aba visível E user ativo nos últimos
  // IDLE_THRESHOLD_MS. Combinação dos dois é essencial pra "tempo
  // médio" refletir engagement real, não tempo de aba aberta esquecida.
  useEffect(() => {
    if (!shortToken || isAdmin) return;
    const session = sessionRef.current;
    if (!session) return;

    let intervalId = null;
    // Atividade inicial = agora. Garante que o primeiro heartbeat
    // dispara mesmo se o user só ler sem mover o mouse no 1º minuto.
    let lastActivityAt = Date.now();

    const onActivity = () => { lastActivityAt = Date.now(); };
    // Eventos que indicam presença real do user. `passive: true` evita
    // bloquear scroll/touch — só observamos.
    const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"];
    const addActivity = () => ACTIVITY_EVENTS.forEach((ev) =>
      window.addEventListener(ev, onActivity, { passive: true }),
    );
    const removeActivity = () => ACTIVITY_EVENTS.forEach((ev) =>
      window.removeEventListener(ev, onActivity),
    );

    const tick = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      // Idle skip — user inativo há mais de 2min = não conta engagement
      if (Date.now() - lastActivityAt > IDLE_THRESHOLD_MS) return;
      send(buildPayload(session, shortToken, shareId, "heartbeat", {
        tab_id: prevTabRef.current || null,
      }));
    };

    const start = () => {
      if (intervalId) return;
      intervalId = window.setInterval(tick, HEARTBEAT_INTERVAL_MS);
    };
    const stop = () => {
      if (!intervalId) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };

    // Liga listeners de atividade + timer se já está visível
    addActivity();
    if (document.visibilityState === "visible") start();

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Volta da aba — considera "voltou a interagir" pra acertar
        // o primeiro heartbeat sem ter que mexer o mouse.
        lastActivityAt = Date.now();
        start();
      } else {
        stop();
        // Heartbeat final de "saiu" — só se ativo recentemente (senão
        // estaríamos contando tempo de aba aberta sem ninguém olhando).
        if (Date.now() - lastActivityAt <= IDLE_THRESHOLD_MS) {
          send(buildPayload(session, shortToken, shareId, "heartbeat", {
            tab_id: prevTabRef.current || null,
          }), { useBeacon: true });
        }
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      removeActivity();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [shortToken, shareId, isAdmin]);

  // Tab change — emite quando o currentTabId muda (depois do mount).
  useEffect(() => {
    if (!shortToken || isAdmin) return;
    const session = sessionRef.current;
    if (!session) return;
    // Skip a primeira execução (já capturada como tab_id no pageview)
    if (prevTabRef.current === currentTabId) return;
    if (prevTabRef.current === null && currentTabId) {
      // Caso edge: pageview disparou sem tab_id e agora o user clicou
      // numa aba. Atualiza ref sem emitir tab_change (não é troca real).
      prevTabRef.current = currentTabId;
      return;
    }
    send(buildPayload(session, shortToken, shareId, "tab_change", {
      tab_id:      currentTabId || null,
      prev_tab_id: prevTabRef.current || null,
    }));
    prevTabRef.current = currentTabId || null;
  }, [currentTabId, shortToken, shareId, isAdmin]);

  // Session end — flush em pagehide / beforeunload. sendBeacon sobrevive
  // ao unload; fetch normal seria abortado.
  useEffect(() => {
    if (!shortToken || isAdmin) return;
    const session = sessionRef.current;
    if (!session) return;

    const flush = () => {
      send(buildPayload(session, shortToken, shareId, "session_end", {
        tab_id: prevTabRef.current || null,
      }), { useBeacon: true });
    };

    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
    };
  }, [shortToken, shareId, isAdmin]);

  // Função exposta pros componentes do report disparar tracking de
  // cliques em CTAs específicos (Abrir Sheets, Download CSV, etc).
  // Aceita um cta_id string que vai pro backend gravado em `tab_id`
  // (reuso de coluna). Skip-admin idêntico aos outros events.
  const trackCta = useCallback((ctaId) => {
    if (!shortToken || isAdmin || !ctaId) return;
    const session = sessionRef.current;
    if (!session) return;
    send(buildPayload(session, shortToken, shareId, "cta_click", {
      tab_id: String(ctaId),
    }));
  }, [shortToken, shareId, isAdmin]);

  return { trackCta };
}
