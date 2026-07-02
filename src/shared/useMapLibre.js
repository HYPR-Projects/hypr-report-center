import { useState, useEffect } from "react";

// MapLibre GL via CDN (mesmo padrão do antigo useLeaflet) — mantém a lib
// fora do bundle. Pin no major 5 via jsdelivr.
const JS_URL  = "https://cdn.jsdelivr.net/npm/maplibre-gl@5/dist/maplibre-gl.js";
const CSS_URL = "https://cdn.jsdelivr.net/npm/maplibre-gl@5/dist/maplibre-gl.css";

export const useMapLibre = () => {
  const [lib, setLib] = useState(() => window.maplibregl || null);

  useEffect(() => {
    if (window.maplibregl) { setLib(window.maplibregl); return; }

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
