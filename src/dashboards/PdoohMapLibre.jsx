import { useEffect, useRef, useState } from "react";
import { C } from "../shared/theme";
import { fmt } from "../shared/format";
import { useMapLibre } from "../shared/useMapLibre";

// Basemaps GL gratuitos da CARTO (mesmo fornecedor dos tiles raster antigos).
const STYLE_DARK  = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const STYLE_LIGHT = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

const SRC = "pdooh-sites";
const LAYER_HEAT = "pdooh-heat";
const LAYER_POINTS = "pdooh-points";

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Popup do MapLibre é estilizado via classe — injeta o CSS de tema uma vez.
const POPUP_CSS_ID = "pdooh-popup-css";
const ensurePopupCss = () => {
  if (document.getElementById(POPUP_CSS_ID)) return;
  const st = document.createElement("style");
  st.id = POPUP_CSS_ID;
  st.textContent = `
.pdooh-popup .maplibregl-popup-content { border-radius: 10px; padding: 12px 14px; box-shadow: 0 8px 24px rgba(0,0,0,.35); font-family: inherit; }
.pdooh-popup .maplibregl-popup-close-button { font-size: 16px; padding: 2px 6px; color: #78909C; }
.pdooh-popup.dark .maplibregl-popup-content { background: ${C.dark}; color: ${C.white}; }
.pdooh-popup.dark.maplibregl-popup-anchor-bottom .maplibregl-popup-tip,
.pdooh-popup.dark.maplibregl-popup-anchor-bottom-left .maplibregl-popup-tip,
.pdooh-popup.dark.maplibregl-popup-anchor-bottom-right .maplibregl-popup-tip { border-top-color: ${C.dark}; }
.pdooh-popup.dark.maplibregl-popup-anchor-top .maplibregl-popup-tip,
.pdooh-popup.dark.maplibregl-popup-anchor-top-left .maplibregl-popup-tip,
.pdooh-popup.dark.maplibregl-popup-anchor-top-right .maplibregl-popup-tip { border-bottom-color: ${C.dark}; }
.pdooh-popup.dark.maplibregl-popup-anchor-left .maplibregl-popup-tip { border-right-color: ${C.dark}; }
.pdooh-popup.dark.maplibregl-popup-anchor-right .maplibregl-popup-tip { border-left-color: ${C.dark}; }
`;
  document.head.appendChild(st);
};

const popupHtml = (p) => `
  <div style="font-size:13px;font-weight:700;line-height:1.3;margin-bottom:2px">${esc(p.name)}</div>
  <div style="font-size:11px;color:#78909C;margin-bottom:10px">${esc(p.type)} · ${esc(p.city)} · ${esc(p.owner)}</div>
  <div style="display:flex;gap:16px">
    <div><div style="font-size:10px;color:#78909C;text-transform:uppercase;letter-spacing:.5px">Telas</div><div style="font-size:14px;font-weight:700">${fmt(p.screens)}</div></div>
    <div><div style="font-size:10px;color:#78909C;text-transform:uppercase;letter-spacing:.5px">Impressões</div><div style="font-size:14px;font-weight:700">${fmt(p.impressions)}</div></div>
    <div><div style="font-size:10px;color:#78909C;text-transform:uppercase;letter-spacing:.5px">Plays</div><div style="font-size:14px;font-weight:700">${fmt(p.plays)}</div></div>
  </div>`;

const buildGeoJSON = (sites, metric) => {
  const geo = sites.filter(s => s.lat !== 0 && s.lng !== 0);
  const max = Math.max(1, ...geo.map(s => s[metric] || 0));
  return {
    type: "FeatureCollection",
    features: geo.map(s => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      properties: {
        name: s.name, city: s.city, owner: s.owner, type: s.type,
        screens: s.screens, impressions: s.impressions, plays: s.plays,
        hw: (s[metric] || 0) / max,                 // peso do heatmap (linear)
        pw: Math.sqrt((s[metric] || 0) / max),      // raio dos pontos (sqrt pra não esmagar os pequenos)
      },
    })),
  };
};

const PdoohMapLibre = ({ sites, metric, mode, isDark = true, focus }) => {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const popupRef = useRef(null);
  const readyRef = useRef(false);
  const [failed, setFailed] = useState(false);
  const ml = useMapLibre();

  // Refs com os valores correntes — o handler de load do mapa (assíncrono)
  // e os callbacks de clique sempre leem o estado mais recente por aqui.
  const sitesRef = useRef(sites);   sitesRef.current = sites;
  const metricRef = useRef(metric); metricRef.current = metric;
  const modeRef = useRef(mode);     modeRef.current = mode;
  const isDarkRef = useRef(isDark); isDarkRef.current = isDark;
  const pendingFocusRef = useRef(null);

  const closePopup = () => { popupRef.current?.remove(); popupRef.current = null; };

  const openPopup = (map, props, lngLat) => {
    closePopup();
    popupRef.current = new window.maplibregl.Popup({
      className: `pdooh-popup${isDarkRef.current ? " dark" : ""}`,
      maxWidth: "300px",
      offset: 10,
    }).setLngLat(lngLat).setHTML(popupHtml(props)).addTo(map);
  };

  const focusSite = (map, key) => {
    const s = sitesRef.current.find(x => x.key === key);
    if (!s || s.lat === 0 || s.lng === 0) return;
    map.flyTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 14), speed: 1.6, essential: true });
    openPopup(map, s, [s.lng, s.lat]);
  };

  // Cria o mapa (re-cria na troca de tema — setStyle descartaria as layers)
  useEffect(() => {
    if (!ml || !containerRef.current) return;
    ensurePopupCss();
    let map;
    try {
      map = new ml.Map({
        container: containerRef.current,
        style: isDark ? STYLE_DARK : STYLE_LIGHT,
        center: [-47.9292, -15.7801],
        zoom: 3.5,
        attributionControl: { compact: true },
        // Scroll só dá zoom com ⌘/Ctrl (o MapLibre mostra a dica nativamente)
        cooperativeGestures: true,
        locale: {
          "CooperativeGesturesHandler.WindowsHelpText": "Use Ctrl + scroll para dar zoom no mapa",
          "CooperativeGesturesHandler.MacHelpText": "Use ⌘ + scroll para dar zoom no mapa",
          "CooperativeGesturesHandler.MobileHelpText": "Use dois dedos para mover o mapa",
        },
      });
    } catch {
      setFailed(true);
      return;
    }
    mapRef.current = map;
    readyRef.current = false;
    map.addControl(new ml.NavigationControl({ showCompass: false }), "top-left");

    map.on("load", () => {
      const data = buildGeoJSON(sitesRef.current, metricRef.current);
      map.addSource(SRC, { type: "geojson", data });

      map.addLayer({
        id: LAYER_HEAT, type: "heatmap", source: SRC,
        layout: { visibility: modeRef.current === "heat" ? "visible" : "none" },
        paint: {
          "heatmap-weight": ["get", "hw"],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 3, 1, 15, 3],
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(0,0,0,0)",
            0.2, "#2563eb",
            0.4, "#06b6d4",
            0.6, "#22c55e",
            0.8, "#eab308",
            1, "#ef4444",
          ],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 4, 18, 10, 40, 14, 60],
          "heatmap-opacity": 0.85,
        },
      });

      map.addLayer({
        id: LAYER_POINTS, type: "circle", source: SRC,
        layout: { visibility: modeRef.current === "points" ? "visible" : "none" },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "pw"], 0, 4, 1, 16],
          "circle-color": C.blue,
          "circle-opacity": 0.85,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff",
        },
      });

      map.on("click", LAYER_POINTS, (e) => {
        const f = e.features?.[0];
        if (f) openPopup(map, f.properties, f.geometry.coordinates);
      });
      map.on("mouseenter", LAYER_POINTS, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", LAYER_POINTS, () => { map.getCanvas().style.cursor = ""; });

      // Enquadra os pontos da campanha
      if (data.features.length > 0) {
        const b = new ml.LngLatBounds();
        data.features.forEach(f => b.extend(f.geometry.coordinates));
        map.fitBounds(b, { padding: 48, maxZoom: 11, duration: 0 });
      }

      readyRef.current = true;
      if (pendingFocusRef.current) {
        focusSite(map, pendingFocusRef.current);
        pendingFocusRef.current = null;
      }
    });

    map.on("error", (e) => {
      // Erros de tile individuais são normais; só falha de estilo derruba o mapa
      if (!readyRef.current && e?.error?.message?.includes("style")) setFailed(true);
    });

    return () => {
      closePopup();
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, [ml, isDark]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dados / métrica mudaram → atualiza o source
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.getSource(SRC)?.setData(buildGeoJSON(sites, metric));
  }, [sites, metric]);

  // Alterna calor ↔ pontos
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setLayoutProperty(LAYER_HEAT, "visibility", mode === "heat" ? "visible" : "none");
    map.setLayoutProperty(LAYER_POINTS, "visibility", mode === "points" ? "visible" : "none");
    if (mode === "heat") closePopup();
  }, [mode]);

  // Clique na tabela → voa até o endereço e abre o popup
  useEffect(() => {
    if (!focus) return;
    const map = mapRef.current;
    if (!map || !readyRef.current) { pendingFocusRef.current = focus.key; return; }
    focusSite(map, focus.key);
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed) return <div style={{height:400,display:"flex",alignItems:"center",justifyContent:"center",color:C.muted,fontSize:13}}>Não foi possível carregar o mapa neste navegador.</div>;
  if (!ml) return <div style={{height:400,display:"flex",alignItems:"center",justifyContent:"center",color:C.muted,fontSize:13}}>Carregando mapa...</div>;

  return <div ref={containerRef} style={{height:400,borderRadius:8,overflow:"hidden"}}/>;
};

export default PdoohMapLibre;
