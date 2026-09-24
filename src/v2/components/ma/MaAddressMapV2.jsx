// src/v2/components/ma/MaAddressMapV2.jsx
//
// Mapa dos endereços (Top endereços do Tap to Map e da Loja mais próxima).
// Mesmo MapLibre + basemap CARTO do PDOOH, com marcadores numerados na ordem
// da tabela e tamanho proporcional às interações. Clique no marcador ou na
// linha da tabela foca o endereço.
//
// Sem MapLibre (CDN bloqueada, rede lenta), cai num mapa esquemático em SVG
// com as posições relativas — a tabela ao lado continua sendo a leitura
// principal.

import { useEffect, useRef } from "react";
import { fmt } from "../../../shared/format";
import { useMapLibreStatus } from "../../../shared/useMapLibre";
import { useTheme } from "../../hooks/useTheme";

const STYLE_DARK = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const STYLE_LIGHT = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSS_ID = "ma-map-css";
function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const st = document.createElement("style");
  st.id = CSS_ID;
  st.textContent = `
.ma-marker{display:grid;place-items:center;border-radius:9999px;background:var(--color-chart-s1);color:#fff;font:700 11px/1 Urbanist,system-ui,sans-serif;border:2px solid var(--color-surface-2);box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer}
.ma-marker[data-active="true"]{outline:2px solid var(--color-fg);outline-offset:1px}
.ma-popup .maplibregl-popup-content{border-radius:10px;padding:10px 12px;background:var(--color-surface-2);color:var(--color-fg);border:1px solid var(--color-border);font-family:inherit}
.ma-popup .maplibregl-popup-tip{display:none}
.ma-popup .maplibregl-popup-close-button{color:var(--color-fg-subtle);font-size:15px;padding:2px 6px}
`;
  document.head.appendChild(st);
}

function popupHtml(p, i) {
  const rows = (p.rows || [])
    .map(([l, v]) => `<div><div style="font-size:10px;color:var(--color-fg-subtle);text-transform:uppercase;letter-spacing:.05em">${esc(l)}</div><div style="font-size:13px;font-weight:700">${esc(v)}</div></div>`)
    .join("");
  return `<div style="font-size:13px;font-weight:700;margin-bottom:2px">${i + 1}. ${esc(p.name)}</div>${p.subtitle ? `<div style="font-size:11px;color:var(--color-fg-subtle);margin-bottom:8px">${esc(p.subtitle)}</div>` : ""}<div style="display:flex;gap:14px">${rows}</div>`;
}

const radiusFor = (w, max) => 10 + Math.sqrt((w || 0) / (max || 1)) * 9;

export function MaAddressMapV2({ points = [], focusKey = null, onFocus, height = 320 }) {
  const geo = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && (p.lat !== 0 || p.lng !== 0));
  const { lib, failed } = useMapLibreStatus();
  const [theme] = useTheme();

  if (!geo.length) {
    return (
      <div className="grid place-items-center rounded-lg bg-canvas-deeper text-[12px] text-fg-subtle" style={{ height }}>
        Sem coordenadas para mostrar no mapa.
      </div>
    );
  }
  if (failed || !lib) {
    return failed ? (
      <SchematicMap points={geo} focusKey={focusKey} onFocus={onFocus} height={height} />
    ) : (
      <div className="relative overflow-hidden skeleton-shimmer grid place-items-center rounded-lg bg-canvas-deeper text-[12px] text-fg-subtle" style={{ height }} aria-busy="true">
        <span className="relative">Carregando mapa…</span>
      </div>
    );
  }
  return <LiveMap key={theme} lib={lib} isDark={theme !== "light"} points={geo} focusKey={focusKey} onFocus={onFocus} height={height} />;
}

function LiveMap({ lib, isDark, points, focusKey, onFocus, height }) {
  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const popupRef = useRef(null);
  const onFocusRef = useRef(onFocus);
  useEffect(() => {
    onFocusRef.current = onFocus;
  }, [onFocus]);

  useEffect(() => {
    if (!boxRef.current) return undefined;
    ensureCss();
    let map;
    try {
      map = new lib.Map({
        container: boxRef.current,
        style: isDark ? STYLE_DARK : STYLE_LIGHT,
        center: [points[0].lng, points[0].lat],
        zoom: 11,
        attributionControl: { compact: true },
        cooperativeGestures: true,
        locale: {
          "CooperativeGesturesHandler.WindowsHelpText": "Use Ctrl + scroll para dar zoom no mapa",
          "CooperativeGesturesHandler.MacHelpText": "Use ⌘ + scroll para dar zoom no mapa",
          "CooperativeGesturesHandler.MobileHelpText": "Use dois dedos para mover o mapa",
        },
      });
    } catch {
      return undefined;
    }
    mapRef.current = map;
    map.addControl(new lib.NavigationControl({ showCompass: false }), "top-left");
    const max = Math.max(...points.map((p) => p.weight || 0), 1);
    markersRef.current = points.map((p, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "ma-marker";
      const r = radiusFor(p.weight, max);
      el.style.width = `${r * 2}px`;
      el.style.height = `${r * 2}px`;
      el.textContent = String(i + 1);
      el.setAttribute("aria-label", `${i + 1}. ${p.name}`);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onFocusRef.current?.(p.key);
      });
      return { key: p.key, el, marker: new lib.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map) };
    });
    if (points.length > 1) {
      const b = new lib.LngLatBounds();
      points.forEach((p) => b.extend([p.lng, p.lat]));
      map.fitBounds(b, { padding: 48, maxZoom: 14, duration: 0 });
    }
    return () => {
      popupRef.current?.remove();
      markersRef.current.forEach((m) => m.marker.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [lib, isDark, points]);

  useEffect(() => {
    const map = mapRef.current;
    markersRef.current.forEach((m) => m.el.setAttribute("data-active", String(m.key === focusKey)));
    if (!map || !focusKey) return;
    const i = points.findIndex((p) => p.key === focusKey);
    if (i < 0) return;
    const p = points[i];
    map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 13), speed: 1.4, essential: true });
    popupRef.current?.remove();
    popupRef.current = new lib.Popup({ className: "ma-popup", offset: 18, maxWidth: "320px" })
      .setLngLat([p.lng, p.lat])
      .setHTML(popupHtml(p, i))
      .addTo(map);
  }, [focusKey, points, lib]);

  return <div ref={boxRef} className="rounded-lg overflow-hidden" style={{ height }} />;
}

// Mapa esquemático: projeção equiretangular simples dentro da caixa dos
// pontos. Honesto sobre o que é — sem ruas desenhadas.
function SchematicMap({ points, focusKey, onFocus, height }) {
  const W = 900;
  const H = Math.round((height / 320) * 300);
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const spanLat = maxLat - minLat || 0.01;
  const spanLng = maxLng - minLng || 0.01;
  const pad = 42;
  const max = Math.max(...points.map((p) => p.weight || 0), 1);
  const x = (lng) => pad + ((lng - minLng) / spanLng) * (W - pad * 2);
  const y = (lat) => pad + ((maxLat - lat) / spanLat) * (H - pad * 2);
  return (
    <div className="rounded-lg overflow-hidden bg-canvas-deeper">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto" role="img" aria-label="Mapa esquemático dos endereços">
        <defs>
          <pattern id="ma-grid" width="45" height="45" patternUnits="userSpaceOnUse">
            <path d="M45 0H0V45" fill="none" stroke="var(--color-border)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#ma-grid)" />
        {points.map((p, i) => {
          const r = radiusFor(p.weight, max) * 1.1;
          const active = p.key === focusKey;
          return (
            <g
              key={p.key}
              role="button"
              tabIndex={0}
              aria-label={`${i + 1}. ${p.name}`}
              onClick={() => onFocus?.(p.key)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onFocus?.(p.key); } }}
              style={{ cursor: "pointer" }}
            >
              <title>{`${i + 1}. ${p.name}${p.rows?.length ? ` · ${p.rows.map(([l, v]) => `${l}: ${v}`).join(" · ")}` : ""}`}</title>
              <circle cx={x(p.lng)} cy={y(p.lat)} r={r + 3} fill="var(--color-surface-2)" />
              <circle cx={x(p.lng)} cy={y(p.lat)} r={r} fill="var(--color-chart-s1)" stroke={active ? "var(--color-fg)" : "none"} strokeWidth="2.5" />
              <text x={x(p.lng)} y={y(p.lat) + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff">
                {i + 1}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="px-3 py-2 text-[11px] text-fg-subtle border-t border-border">
        Mapa simplificado (posições relativas). {fmt(points.length)} endereço{points.length === 1 ? "" : "s"} com coordenada.
      </p>
    </div>
  );
}
