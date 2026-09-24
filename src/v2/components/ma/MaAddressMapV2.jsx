// src/v2/components/ma/MaAddressMapV2.jsx
//
// Mapa dos endereços (Top endereços do Tap to Map e da Loja mais próxima).
// Mesmo MapLibre + basemap CARTO do PDOOH, com marcadores numerados na ordem
// do ranking e tamanho proporcional ao peso (exibições/identificações).
//
// Câmera previsível (regras e testes em maMapCamera.js):
//   • o mapa é criado UMA vez; re-render, refetch e troca de tema não o
//     recriam (o tema troca só o basemap, com setStyle);
//   • marcadores sincronizam quando o conjunto de pontos muda de conteúdo;
//     o enquadramento geral só acontece na 1ª carga ou quando o conjunto muda
//     e o usuário ainda não mexeu no mapa;
//   • focar um ponto nunca afasta: desliza (easeTo) quando está perto ou
//     visível, corta com fade curto quando está longe;
//   • `fit` ({ keys, n }) enquadra um subconjunto a pedido (filtro por
//     cidade, "Ver todos"); só muda quando `n` muda.
//
// Sem MapLibre (CDN bloqueada, rede lenta), cai num mapa esquemático em SVG
// com as posições relativas — a lista ao lado continua sendo a leitura
// principal.

import { useEffect, useMemo, useRef } from "react";
import { fmt } from "../../../shared/format";
import { useMapLibreStatus } from "../../../shared/useMapLibre";
import { prefersReducedMotion } from "../../lib/motion";
import { useTheme } from "../../hooks/useTheme";
import { haversineKm, planFocus, pointsSignature } from "./maMapCamera";

const STYLE_DARK = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const STYLE_LIGHT = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

const CSS_ID = "ma-map-css";
function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const st = document.createElement("style");
  st.id = CSS_ID;
  st.textContent = `
.ma-marker{display:grid;place-items:center;border-radius:9999px;background:var(--color-signature);color:#fff;font:700 11px/1 Urbanist,system-ui,sans-serif;border:2px solid var(--color-surface-2);box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;padding:0}
.ma-marker[data-active="true"]{outline:2px solid var(--color-fg);outline-offset:1px;z-index:2}
.ma-marker:focus-visible{outline:2px solid var(--color-signature);outline-offset:2px}
.ma-popup .maplibregl-popup-content{border-radius:12px;padding:12px 14px;background:var(--color-surface-2);color:var(--color-fg);border:1px solid var(--color-border);font-family:inherit;box-shadow:0 6px 20px rgba(0,0,0,.18)}
.ma-popup .maplibregl-popup-tip{display:none}
.ma-popup .maplibregl-popup-close-button{color:var(--color-fg-subtle);font-size:16px;padding:2px 7px}
`;
  document.head.appendChild(st);
}

// Popup no padrão de número da aba: rótulo em caixa alta em cima, valor.
function popupHtml(p, i) {
  const rows = (p.rows || [])
    .map(([l, v]) => `<div><div style="font-size:11px;font-weight:700;color:var(--color-fg-subtle);text-transform:uppercase;letter-spacing:.06em">${esc(l)}</div><div style="margin-top:4px;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums">${esc(v)}</div></div>`)
    .join("");
  return `<div style="font-size:13px;font-weight:700;padding-right:14px">${i + 1}. ${esc(p.name)}</div>${p.subtitle ? `<div style="font-size:12px;color:var(--color-fg-subtle);margin-top:2px">${esc(p.subtitle)}</div>` : ""}<div style="display:flex;gap:18px;margin-top:10px">${rows}</div>`;
}

const radiusFor = (w, max) => 10 + Math.sqrt((w || 0) / (max || 1)) * 9;

function boundsOf(lib, pts) {
  const b = new lib.LngLatBounds();
  pts.forEach((p) => b.extend([p.lng, p.lat]));
  return b;
}

export function MaAddressMapV2({ points = [], focusKey = null, onFocus, fit = null, height = 320, minHeight, className }) {
  const { lib, failed } = useMapLibreStatus();
  const [theme] = useTheme();
  // Filtro com identidade estável: só muda quando o conteúdo muda.
  const sig = pointsSignature(points);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geo = useMemo(() => points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && (p.lat !== 0 || p.lng !== 0)), [sig]);
  const style = { height: height ?? undefined, minHeight };

  if (!geo.length) {
    return (
      <div className={`grid place-items-center rounded-lg bg-canvas-deeper text-[13px] text-fg-subtle ${className || ""}`} style={style}>
        Sem coordenadas para mostrar no mapa.
      </div>
    );
  }
  if (failed || !lib) {
    return failed ? (
      <SchematicMap points={geo} focusKey={focusKey} onFocus={onFocus} className={className} />
    ) : (
      <div className={`relative overflow-hidden skeleton-shimmer grid place-items-center rounded-lg bg-canvas-deeper text-[13px] text-fg-subtle ${className || ""}`} style={style} aria-busy="true">
        <span className="relative">Carregando mapa…</span>
      </div>
    );
  }
  return <LiveMap lib={lib} isDark={theme !== "light"} points={geo} focusKey={focusKey} onFocus={onFocus} fit={fit} style={style} className={className} />;
}

function LiveMap({ lib, isDark, points, focusKey, onFocus, fit, style, className }) {
  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const popupRef = useRef(null);
  const closingRef = useRef(false);
  const lastFocusRef = useRef(null);
  const framedSigRef = useRef(null);
  const userMovedRef = useRef(false);
  const styleRef = useRef(isDark ? STYLE_DARK : STYLE_LIGHT);
  const onFocusRef = useRef(onFocus);
  const pointsRef = useRef(points);
  const sig = pointsSignature(points);
  // Marcadores também dependem de número e peso (troca de período).
  const markerSig = `${sig}#${points.map((p) => `${p.rank ?? ""}:${p.weight ?? ""}`).join(",")}`;

  useEffect(() => {
    onFocusRef.current = onFocus;
    pointsRef.current = points;
  });

  // Mapa: uma instância por montagem.
  useEffect(() => {
    if (!boxRef.current) return undefined;
    ensureCss();
    let map;
    const first = pointsRef.current[0];
    try {
      map = new lib.Map({
        container: boxRef.current,
        style: styleRef.current,
        center: [first.lng, first.lat],
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
    // Movimento feito pela pessoa (arrastar, zoom, botões) tem originalEvent;
    // os nossos (easeTo, fitBounds) não.
    const markUser = (e) => { if (e.originalEvent) userMovedRef.current = true; };
    map.on("dragstart", markUser);
    map.on("zoomstart", markUser);
    const popup = new lib.Popup({ className: "ma-popup", offset: 18, maxWidth: "320px", focusAfterOpen: false });
    popup.on("close", () => {
      // Fechar no "×" limpa o foco (linha destacada e reclique no mesmo ponto).
      if (closingRef.current) return;
      lastFocusRef.current = null;
      onFocusRef.current?.(null);
    });
    popupRef.current = popup;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => map.resize()) : null;
    ro?.observe(boxRef.current);
    return () => {
      ro?.disconnect();
      closingRef.current = true;
      popup.remove();
      markersRef.current.forEach((m) => m.marker.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
      popupRef.current = null;
      framedSigRef.current = null;
      lastFocusRef.current = null;
    };
  }, [lib]);

  // Tema: troca só o basemap. Marcadores e popup são DOM e ficam.
  useEffect(() => {
    const next = isDark ? STYLE_DARK : STYLE_LIGHT;
    if (next === styleRef.current) return;
    styleRef.current = next;
    mapRef.current?.setStyle(next);
  }, [isDark]);

  // Marcadores: sincronizam quando o conjunto muda de conteúdo.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const pts = pointsRef.current;
    markersRef.current.forEach((m) => m.marker.remove());
    const max = Math.max(...pts.map((p) => p.weight || 0), 1);
    markersRef.current = pts.map((p, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "ma-marker";
      const r = radiusFor(p.weight, max);
      el.style.width = `${r * 2}px`;
      el.style.height = `${r * 2}px`;
      el.textContent = String(p.rank ?? i + 1);
      el.setAttribute("aria-label", `${p.rank ?? i + 1}. ${p.name}`);
      el.setAttribute("data-active", String(p.key === lastFocusRef.current));
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onFocusRef.current?.(p.key);
      });
      return { key: p.key, el, marker: new lib.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map) };
    });
    // Enquadra na 1ª carga; num conjunto novo, só se a pessoa não mexeu.
    if (framedSigRef.current == null || (framedSigRef.current !== sig && !userMovedRef.current)) {
      const firstTime = framedSigRef.current == null;
      if (pts.length > 1) {
        map.fitBounds(boundsOf(lib, pts), { padding: 56, maxZoom: 14, duration: firstTime || prefersReducedMotion() ? 0 : 500 });
      } else {
        map.jumpTo({ center: [pts[0].lng, pts[0].lat], zoom: 13 });
      }
    }
    framedSigRef.current = sig;
    if (lastFocusRef.current && !pts.some((p) => p.key === lastFocusRef.current)) {
      closingRef.current = true;
      popupRef.current?.remove();
      closingRef.current = false;
      lastFocusRef.current = null;
    }
  }, [markerSig, sig, lib]);

  // Foco: só quando o focusKey muda de verdade. Nunca afasta.
  useEffect(() => {
    const map = mapRef.current;
    markersRef.current.forEach((m) => m.el.setAttribute("data-active", String(m.key === focusKey)));
    if (!map) return;
    if (!focusKey) {
      lastFocusRef.current = null;
      closingRef.current = true;
      popupRef.current?.remove();
      closingRef.current = false;
      return;
    }
    if (focusKey === lastFocusRef.current) return;
    const pts = pointsRef.current;
    const i = pts.findIndex((p) => p.key === focusKey);
    if (i < 0) return;
    lastFocusRef.current = focusKey;
    const p = pts[i];
    const target = [p.lng, p.lat];
    const c = map.getCenter();
    const plan = planFocus({
      zoom: map.getZoom(),
      inView: map.getBounds().contains(target),
      distanceKm: haversineKm({ lat: c.lat, lng: c.lng }, p),
      reducedMotion: prefersReducedMotion(),
    });
    map.stop();
    if (plan.mode === "ease") {
      map.easeTo({ center: target, zoom: plan.zoom, duration: 600, easing: easeOutCubic, essential: true });
    } else {
      if (!prefersReducedMotion()) boxRef.current?.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
      map.jumpTo({ center: target, zoom: plan.zoom });
    }
    // addTo de um popup aberto dispara "close" antes de reabrir: não é a
    // pessoa fechando.
    closingRef.current = true;
    popupRef.current?.setLngLat(target).setHTML(popupHtml(p, p.rank != null ? p.rank - 1 : i)).addTo(map);
    closingRef.current = false;
  }, [focusKey, sig]);

  // Enquadramento pedido (filtro por cidade, "Ver todos").
  const fitN = fit?.n ?? 0;
  const fitRef = useRef(fit);
  useEffect(() => {
    fitRef.current = fit;
  });
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitN) return;
    const keys = fitRef.current?.keys;
    const pts = pointsRef.current.filter((p) => !keys || keys.includes(p.key));
    if (!pts.length) return;
    userMovedRef.current = !!keys; // "Ver todos" devolve o enquadramento automático
    map.stop();
    const duration = prefersReducedMotion() ? 0 : 600;
    if (pts.length === 1) {
      map.easeTo({ center: [pts[0].lng, pts[0].lat], zoom: Math.max(map.getZoom(), 13), duration, easing: easeOutCubic });
    } else {
      map.fitBounds(boundsOf(lib, pts), { padding: 56, maxZoom: 14, duration });
    }
  }, [fitN, lib]);

  return <div ref={boxRef} className={`rounded-lg overflow-hidden ${className || ""}`} style={style} />;
}

// Mapa esquemático: projeção equiretangular simples dentro da caixa dos
// pontos. Honesto sobre o que é — sem ruas desenhadas.
function SchematicMap({ points, focusKey, onFocus, className }) {
  const W = 900;
  const H = 420;
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
    <div className={`flex flex-col rounded-lg overflow-hidden bg-canvas-deeper ${className || ""}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="block w-full h-auto flex-1 min-h-0" role="img" aria-label="Mapa esquemático dos endereços">
        <defs>
          <pattern id="ma-grid" width="45" height="45" patternUnits="userSpaceOnUse">
            <path d="M45 0H0V45" fill="none" stroke="var(--color-border)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#ma-grid)" />
        {points.map((p, i) => {
          const r = radiusFor(p.weight, max) * 1.1;
          const active = p.key === focusKey;
          const n = p.rank ?? i + 1;
          return (
            <g
              key={p.key}
              role="button"
              tabIndex={0}
              aria-label={`${n}. ${p.name}`}
              onClick={() => onFocus?.(p.key)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onFocus?.(p.key); } }}
              style={{ cursor: "pointer" }}
            >
              <title>{`${n}. ${p.name}${p.rows?.length ? ` · ${p.rows.map(([l, v]) => `${l}: ${v}`).join(" · ")}` : ""}`}</title>
              <circle cx={x(p.lng)} cy={y(p.lat)} r={r + 3} fill="var(--color-surface-2)" />
              <circle cx={x(p.lng)} cy={y(p.lat)} r={r} fill="var(--color-signature)" stroke={active ? "var(--color-fg)" : "none"} strokeWidth="2.5" />
              <text x={x(p.lng)} y={y(p.lat) + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff">
                {n}
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
