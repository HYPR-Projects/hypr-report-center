import { useEffect, useRef, useState } from "react";
import { C } from "../shared/theme";
import { useLeaflet } from "../shared/useLeaflet";

// Tiles do CARTO — dark/light pra acompanhar o tema do app.
const TILE_DARK  = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const TILE_LIGHT = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

// Escala térmica clássica (azul → ciano → verde → amarelo → vermelho).
// Funciona contra os dois fundos de tile, então vale pros dois temas.
const GRADIENT = {
  0.2: "#2563eb",
  0.4: "#06b6d4",
  0.6: "#22c55e",
  0.8: "#eab308",
  1.0: "#ef4444",
};

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

const PdoohMap = ({ points, isDark = true }) => {
  const mapRef = useRef(null);
  const instanceRef = useRef(null);
  const heatRef = useRef(null);
  const hintTimer = useRef(null);
  const [showHint, setShowHint] = useState(false);
  const L = useLeaflet();

  useEffect(()=>{
    if (!L || !mapRef.current) return;
    if (!L.heatLayer) return;

    // Destroi instância anterior se existir (re-mount limpo quando troca o tema)
    if (instanceRef.current) {
      instanceRef.current.remove();
      instanceRef.current = null;
    }

    const map = L.map(mapRef.current, { zoomControl: true, scrollWheelZoom: false }).setView([-15.7801, -47.9292], 4);
    instanceRef.current = map;
    L.tileLayer(isDark ? TILE_DARK : TILE_LIGHT, {
      attribution: '&copy; CARTO',
      maxZoom: 18,
    }).addTo(map);

    if (points.length > 0) {
      const maxVal = Math.max(...points.map(p => p[2]));
      const heatPoints = points.map(p => [p[0], p[1], p[2] / maxVal]);
      heatRef.current = L.heatLayer(heatPoints, {
        radius: 40, blur: 30, maxZoom: 10,
        gradient: GRADIENT,
      }).addTo(map);
    }

    // Zoom por scroll só com modificador (Shift/⌘/Ctrl) pressionado, pro mapa
    // não sequestrar o scroll da página. Habilita o handler nativo do Leaflet
    // no keydown e desabilita no keyup/blur (blur cobre ⌘+Tab no Mac).
    const el = mapRef.current;
    const hasModifier = (e) => e.shiftKey || e.metaKey || e.ctrlKey;
    const onKeyDown = (e) => { if (hasModifier(e)) map.scrollWheelZoom.enable(); };
    const onKeyUp = (e) => { if (!hasModifier(e)) map.scrollWheelZoom.disable(); };
    const onBlur = () => map.scrollWheelZoom.disable();
    const onWheel = (e) => {
      if (hasModifier(e)) { setShowHint(false); return; }
      setShowHint(true);
      clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setShowHint(false), 1400);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    el.addEventListener("wheel", onWheel);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      el.removeEventListener("wheel", onWheel);
      clearTimeout(hintTimer.current);
    };
  }, [L, points, isDark]);

  if (!L) return <div style={{height:400,display:"flex",alignItems:"center",justifyContent:"center",color:C.muted,fontSize:13}}>Carregando mapa...</div>;

  return (
    <div style={{position:"relative"}}>
      <div ref={mapRef} style={{height:400,borderRadius:8,overflow:"hidden"}}/>
      <div style={{
        position:"absolute", inset:0, zIndex:1000, pointerEvents:"none",
        display:"flex", alignItems:"center", justifyContent:"center",
        background:"rgba(15,23,42,0.45)", borderRadius:8,
        opacity: showHint ? 1 : 0, transition:"opacity .25s ease",
      }}>
        <span style={{color:"#fff",fontSize:13,fontWeight:600,textAlign:"center",padding:"0 16px"}}>
          Segure {IS_MAC ? "⌘ ou Shift" : "Ctrl ou Shift"} e use o scroll para dar zoom
        </span>
      </div>
    </div>
  );
};

export default PdoohMap;
