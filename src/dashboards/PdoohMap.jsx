import { useEffect, useRef } from "react";
import { C } from "../shared/theme";
import { useLeaflet } from "../shared/useLeaflet";

// Tiles do CARTO — dark/light pra acompanhar o tema do app.
const TILE_DARK  = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const TILE_LIGHT = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

// Gradientes do heatmap por tema. No dark, escala azul→branco (pontas claras
// chamam atenção contra fundo escuro). No light, invertemos pro azul mais
// escuro nas pontas pra preservar contraste contra fundo claro.
const GRADIENT_DARK  = { 0.2: "#0000ff", 0.4: "#3397B9", 0.6: "#C5EAF6", 0.8: "#ffffff" };
const GRADIENT_LIGHT = { 0.2: "#bae6fd", 0.4: "#3397B9", 0.6: "#0c4a6e", 0.8: "#082f49" };

const PdoohMap = ({ points, isDark = true }) => {
  const mapRef = useRef(null);
  const instanceRef = useRef(null);
  const heatRef = useRef(null);
  const L = useLeaflet();

  useEffect(()=>{
    if (!L || !mapRef.current) return;
    if (!L.heatLayer) return;

    // Destroi instância anterior se existir (re-mount limpo quando troca o tema)
    if (instanceRef.current) {
      instanceRef.current.remove();
      instanceRef.current = null;
    }

    instanceRef.current = L.map(mapRef.current, { zoomControl: true, scrollWheelZoom: false }).setView([-15.7801, -47.9292], 4);
    L.tileLayer(isDark ? TILE_DARK : TILE_LIGHT, {
      attribution: '&copy; CARTO',
      maxZoom: 18,
    }).addTo(instanceRef.current);

    if (points.length > 0) {
      const maxVal = Math.max(...points.map(p => p[2]));
      const heatPoints = points.map(p => [p[0], p[1], p[2] / maxVal]);
      heatRef.current = L.heatLayer(heatPoints, {
        radius: 40, blur: 30, maxZoom: 10,
        gradient: isDark ? GRADIENT_DARK : GRADIENT_LIGHT,
      }).addTo(instanceRef.current);
    }
  }, [L, points, isDark]);

  if (!L) return <div style={{height:400,display:"flex",alignItems:"center",justifyContent:"center",color:C.muted,fontSize:13}}>Carregando mapa...</div>;

  return <div ref={mapRef} style={{height:400,borderRadius:8,overflow:"hidden"}}/>;
};

export default PdoohMap;
