import { useState, useEffect } from "react";

// MapLibre GL via CDN (mesmo padrão do antigo useLeaflet) — mantém a lib
// fora do bundle. Pin no major 5 via jsdelivr.
const JS_URL  = "https://cdn.jsdelivr.net/npm/maplibre-gl@5/dist/maplibre-gl.js";
const CSS_URL = "https://cdn.jsdelivr.net/npm/maplibre-gl@5/dist/maplibre-gl.css";

export const useMapLibre = () => {
  const [lib, setLib] = useState(() => window.maplibregl || null);

  useEffect(() => {
    // Já carregado por outro mount: o estado inicial normalmente já o tem;
    // o microtask cobre a corrida entre o 1º render e o efeito.
    if (window.maplibregl) {
      Promise.resolve().then(() => setLib((cur) => cur || window.maplibregl));
      return undefined;
    }

    if (!document.querySelector(`link[href="${CSS_URL}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = CSS_URL;
      document.head.appendChild(link);
    }

    // Reusa o <script> se outro mount já iniciou o load (remount por troca de tema)
    let script = document.querySelector(`script[src="${JS_URL}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = JS_URL;
      document.head.appendChild(script);
    }
    const onLoad = () => setLib(window.maplibregl);
    script.addEventListener("load", onLoad);
    return () => script.removeEventListener("load", onLoad);
  }, []);

  return lib;
};

/**
 * Igual ao useMapLibre, mas diz quando desistir: script bloqueado (rede
 * corporativa, CDN fora) ou lento demais. Quem usa mostra um fallback
 * estático em vez de "Carregando mapa..." para sempre.
 */
// Falha lembrada no módulo: a partir da 1ª, os próximos mapas da sessão
// vão direto pro fallback em vez de esperar o timeout de novo.
let loadFailed = false;

export const useMapLibreStatus = (timeoutMs = 6000) => {
  const lib = useMapLibre();
  const [failed, setFailed] = useState(loadFailed);

  useEffect(() => {
    if (lib || loadFailed) return undefined;
    const fail = () => { loadFailed = true; setFailed(true); };
    const script = document.querySelector(`script[src="${JS_URL}"]`);
    const onError = () => fail();
    script?.addEventListener("error", onError);
    const t = setTimeout(() => { if (!window.maplibregl) fail(); }, timeoutMs);
    return () => {
      clearTimeout(t);
      script?.removeEventListener("error", onError);
    };
  }, [lib, timeoutMs]);

  return { lib, failed: !lib && failed };
};
