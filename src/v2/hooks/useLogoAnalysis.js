// src/v2/hooks/useLogoAnalysis.js
//
// Analisa uma logo (data URL ou URL) e classifica em uma de 3 categorias:
//
//   • 'monochrome-light' — pixels claros sobre transparente. Ex: Nintendo
//     branca, Apple white, Adidas white. Pode ser invertida sem perda
//     (vira "monochrome-dark") via CSS filter.
//
//   • 'monochrome-dark' — pixels escuros sobre transparente. Ex: Apple
//     preta, Adidas preta, Nintendo preta (pill preto + texto branco).
//     Pode ser invertida pra ficar clara.
//
//   • 'colored' — logo com cores saturadas reais (Coca-Cola vermelho,
//     Spotify verde, McDonald's amarelo). NUNCA inverte — quebra a
//     identidade visual da marca.
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
// para cada pixel não-transparente (alpha >= 25) calcula:
//
//   • Luminance perceptual (W3C sRGB):
//       L = 0.299·R + 0.587·G + 0.114·B            (0-255)
//
//   • Chroma absoluta (NÃO saturation HSL):
//       C = max(R,G,B) - min(R,G,B)                (0-255)
//
//     Por que chroma absoluta e NÃO saturation HSL:
//     Saturation HSL = (max-min)/max é normalizada e infla absurdamente
//     pra pixels escuros — RGB(15,25,35) (cinza escuro com leve tinta)
//     tem sat 0.57, mesmo sendo praticamente cinza ao olho humano. Brand
//     assets reais raramente usam preto puro #000 — o pill da Nintendo,
//     por exemplo, é tipicamente algo como #1a1a1f com leve tinta. Com
//     saturation HSL isso classificaria como "colored" e nunca seria
//     invertido. Chroma absoluta (max-min) é alinhada com a percepção
//     humana: RGB(15,25,35) tem chroma 20, claramente não-colorido.
//
// Classificação:
//   1. Pixel é "colorful" se chroma > 40 (~15% do range RGB)
//   2. Logo é colored se >25% dos pixels não-transparentes são colorful
//   3. Senão, monochrome — split por luminance:
//      avg_luminance > 160 → monochrome-light
//      avg_luminance ≤ 160 → monochrome-dark
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

const CHROMA_THRESHOLD = 40;            // pixels com chroma > 40 são "colorful"
const COLORFUL_RATIO_THRESHOLD = 0.25;  // logo é colored se >25% dos pixels são colorful
const LUMINANCE_THRESHOLD = 160;
const ALPHA_THRESHOLD = 25;             // pixels com alpha < 25 ignorados (transparente)
const SAMPLE_STEP = 8;                  // grid 8x8 → ~1.5% dos pixels

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
        let colorfulCount = 0;
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

            // Chroma absoluta — quanto o pixel "se afasta" de cinza neutro
            const chroma = Math.max(r, g, b) - Math.min(r, g, b);
            if (chroma > CHROMA_THRESHOLD) colorfulCount += 1;

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
        const colorfulRatio = colorfulCount / counted;

        let result;
        if (colorfulRatio > COLORFUL_RATIO_THRESHOLD) {
          result = "colored";
        } else {
          result = avgLum > LUMINANCE_THRESHOLD ? "monochrome-light" : "monochrome-dark";
        }

        if (import.meta.env?.DEV) {
          console.log(
            `[useLogoAnalysis] avgLum=${avgLum.toFixed(1)} colorfulRatio=${colorfulRatio.toFixed(3)} → ${result}`
          );
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
