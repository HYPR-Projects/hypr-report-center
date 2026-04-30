// src/v2/hooks/useLogoAnalysis.js
//
// Analisa uma logo (data URL ou URL) e classifica em uma de 3 categorias:
//
//   • 'monochrome-light' — pixels claros sobre transparente. Ex: Nintendo
//     branca, Apple white, Adidas white. Pode ser invertida sem perda
//     (vira "monochrome-dark") via CSS filter.
//
//   • 'monochrome-dark' — pixels escuros sobre transparente. Ex: Apple
//     preta, Adidas preta. Pode ser invertida pra ficar clara.
//
//   • 'colored' — logo com cores saturadas (Coca-Cola vermelho, Spotify
//     verde, McDonald's amarelo). NUNCA inverte — quebra a identidade
//     visual da marca.
//
// Por que esses 3 buckets
// ───────────────────────
// O sistema usa a classificação pra decidir se aplica `filter: invert(1)`
// quando o tema visual conflita com a logo:
//   tema light + logo monochrome-light  → inverte (logo vira escura)
//   tema dark  + logo monochrome-dark   → inverte (logo vira clara)
//   logo colored                         → SEMPRE renderiza como veio
//
// Algoritmo de classificação
// ──────────────────────────
// Carrega a imagem num canvas off-screen, faz sample em grid 8x8 e
// calcula DUAS métricas em pixels não-transparentes (alpha >= 25):
//
//   1. Luminance perceptual (W3C sRGB):
//      L = 0.299·R + 0.587·G + 0.114·B
//
//   2. Saturation HSL:
//      S = (max - min) / max         se max > 0
//      Mede o quanto o pixel "tem cor" vs cinza neutro. Pixels mono-
//      cromáticos (preto, branco, cinza) têm S ≈ 0. Coca-Cola vermelho
//      tem S ≈ 1.
//
// Thresholds calibrados empiricamente:
//   AVG_SATURATION < 0.18 → monochrome (preto/branco/cinza dominantes)
//   AVG_LUMINANCE  > 160  → light variant (claro)
//   AVG_LUMINANCE <= 160  → dark variant (escuro)
//   AVG_SATURATION >= 0.18 → colored
//
// Sample em grid 8x8 = ~1.5% dos pixels. Suficiente pra caracterizar
// uma logo sem custo perceptível mesmo em imagem 2000x2000.
//
// Cache module-level por src — a mesma data URL é só processada uma
// vez por sessão (header do report, thumbnail no admin etc).
//
// Retorna
// ───────
//   'monochrome-light' | 'monochrome-dark' | 'colored' | null
//   null = ainda calculando OU falha de carregamento. Caller deve
//          tratar como "não inverter" (preserva comportamento legado).

import { useEffect, useState } from "react";

const analysisCache = new Map();

const SATURATION_THRESHOLD = 0.18;
const LUMINANCE_THRESHOLD = 160;
const ALPHA_THRESHOLD = 25; // pixels com alpha < 25 ignorados (transparente)
const SAMPLE_STEP = 8;       // grid 8x8 → ~1.5% dos pixels

export function useLogoAnalysis(src) {
  // Cache hit é resolvido SÍNCRONO via derivação (sem setState no effect):
  // a primeira lookup do Map é instantânea, e re-renders só acontecem se
  // o `src` mudar — caso em que o React re-roda esta linha naturalmente.
  const cached = src ? analysisCache.get(src) : undefined;
  const [asyncResult, setAsyncResult] = useState(null);

  useEffect(() => {
    if (!src) return;
    if (analysisCache.has(src)) return; // cache hit — derivação cuida

    let cancelled = false;
    const img = new Image();
    // crossOrigin não é necessário pra data: URLs (caso típico hoje), mas
    // se um dia trocarmos pra URLs externas (CDN), sem isso o canvas vira
    // tainted e getImageData lança SecurityError.
    img.crossOrigin = "anonymous";

    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        const w = (canvas.width = img.naturalWidth || img.width);
        const h = (canvas.height = img.naturalHeight || img.height);
        if (w === 0 || h === 0) {
          analysisCache.set(src, null);
          setAsyncResult(null);
          return;
        }

        const ctx = canvas.getContext("2d", { willReadFrequently: false });
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;

        let totalLum = 0;
        let totalSat = 0;
        let counted = 0;

        for (let y = 0; y < h; y += SAMPLE_STEP) {
          for (let x = 0; x < w; x += SAMPLE_STEP) {
            const i = (y * w + x) * 4;
            const a = data[i + 3];
            if (a < ALPHA_THRESHOLD) continue;

            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            // Luminance perceptual W3C
            totalLum += 0.299 * r + 0.587 * g + 0.114 * b;

            // Saturation (HSL): chroma normalizado pelo brilho
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            totalSat += max === 0 ? 0 : (max - min) / max;

            counted += 1;
          }
        }

        if (counted === 0) {
          // 100% transparente — logo "vazia". Default seguro = não inverte.
          analysisCache.set(src, null);
          setAsyncResult(null);
          return;
        }

        const avgLum = totalLum / counted;
        const avgSat = totalSat / counted;

        let result;
        if (avgSat < SATURATION_THRESHOLD) {
          result = avgLum > LUMINANCE_THRESHOLD ? "monochrome-light" : "monochrome-dark";
        } else {
          result = "colored";
        }

        analysisCache.set(src, result);
        setAsyncResult(result);
      } catch (err) {
        // Falha de getImageData (ex: canvas tainted, browser policy)
        // → null silencioso. Caller não inverte (comportamento legado).
        if (import.meta.env?.DEV) {
          console.warn("[useLogoAnalysis] falha:", err);
        }
        analysisCache.set(src, null);
        setAsyncResult(null);
      }
    };

    img.onerror = () => {
      if (cancelled) return;
      analysisCache.set(src, null);
      setAsyncResult(null);
    };

    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  return cached !== undefined ? cached : asyncResult;
}
