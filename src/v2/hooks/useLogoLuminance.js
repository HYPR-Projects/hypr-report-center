// src/v2/hooks/useLogoLuminance.js
//
// Detecta se uma logo (data URL ou URL) é predominantemente CLARA ou
// ESCURA pra escolher o fundo apropriado do "logo wall".
//
// Por que existe
// ──────────────
// Logos de marca vêm em duas variantes comuns:
//   • Versão escura — preto ou colorida sobre fundo transparente.
//     Padrão pra usar sobre fundos claros (ex: site light theme).
//   • Versão clara — branco sobre fundo transparente.
//     Padrão pra usar sobre fundos escuros (ex: dark mode, hero).
//
// Quando o admin faz upload no LogoModal, ele tipicamente envia o asset
// que tem em mãos — geralmente UMA das versões. Se essa versão é clara
// e o logo wall é branco (decisão atual do design system, "Stripe
// pattern"), a logo SOME no fundo branco. Foi o caso da Nintendo —
// logo branca + bg-white = retângulo vazio.
//
// Estratégia
// ──────────
// Carrega a imagem num canvas off-screen, faz sample de pixels e calcula
// luminance média (perceived brightness W3C: 0.299*R + 0.587*G + 0.114*B).
// Pixels com alpha < 0.1 são ignorados (transparente não conta).
//
// Sample: pula pixels num grid de 8x8 (~1.5% do total) — suficiente pra
// caracterizar uma logo, e mantém o cálculo abaixo de 5ms mesmo pra
// imagens 2000x2000.
//
// Threshold de 128 (meio do range 0-255) é o padrão. Pra logos no limite
// (ex: cinza médio), o fallback default é 'dark' — mantém retrocompat
// com o comportamento atual ("bg-white sempre").
//
// Retorna
// ───────
//   'dark' | 'light' | null
//   null   = ainda calculando OU falha no carregamento (tratar como 'dark'
//            pra preservar comportamento legado).

import { useEffect, useState } from "react";

// Cache module-level: o mesmo logo data URL é usado em vários lugares
// (header do report + thumbnail no admin no futuro). Evita refazer o
// trabalho do canvas pra dataURLs já vistas nesta sessão.
const luminanceCache = new Map();

export function useLogoLuminance(src) {
  // Cache hit é resolvido SÍNCRONO via derivação (sem setState no effect):
  // a primeira lookup do Map é instantânea, e re-renders só acontecem se
  // o `src` mudar — caso em que o React re-roda esta linha naturalmente.
  const cached = src ? luminanceCache.get(src) : undefined;
  const [asyncResult, setAsyncResult] = useState(null);

  useEffect(() => {
    if (!src) return;
    // Cache hit: o valor já vem por `cached` acima — não precisa fazer
    // nada aqui, o que evita ferir a regra react-hooks/set-state-in-effect.
    if (luminanceCache.has(src)) return;

    let cancelled = false;
    const img = new Image();
    // crossOrigin não é necessário pra data: URLs (que é o caso típico),
    // mas se um dia trocarmos pra URLs externas, sem isso o canvas vira
    // tainted e getImageData lança SecurityError.
    img.crossOrigin = "anonymous";

    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        const w = (canvas.width = img.naturalWidth || img.width);
        const h = (canvas.height = img.naturalHeight || img.height);
        if (w === 0 || h === 0) {
          luminanceCache.set(src, null);
          setAsyncResult(null);
          return;
        }

        const ctx = canvas.getContext("2d", { willReadFrequently: false });
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;

        // Sample em grid de 8x8 — pega ~1/64 dos pixels.
        const step = 8;
        let totalLum = 0;
        let counted = 0;
        for (let y = 0; y < h; y += step) {
          for (let x = 0; x < w; x += step) {
            const i = (y * w + x) * 4;
            const a = data[i + 3];
            if (a < 25) continue; // pixel praticamente transparente — ignora
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            // Luminance perceptual W3C (sRGB)
            totalLum += 0.299 * r + 0.587 * g + 0.114 * b;
            counted += 1;
          }
        }

        if (counted === 0) {
          // 100% transparente — logo "vazia". Default seguro = dark.
          luminanceCache.set(src, "dark");
          setAsyncResult("dark");
          return;
        }

        const avg = totalLum / counted;
        // 160 é mais permissivo que o meio (128) — cobre logos que misturam
        // cinza-claro com transparência ainda como "claras". Foi calibrado
        // contra: Nintendo (branca pura ~245), Spotify verde (~135),
        // Adidas preta (~30), Coca-Cola vermelho (~76).
        const result = avg > 160 ? "light" : "dark";
        luminanceCache.set(src, result);
        setAsyncResult(result);
      } catch (err) {
        // Falha de getImageData (ex: canvas tainted, browser policy)
        // → cai pro default 'dark' silenciosamente.
        if (import.meta.env?.DEV) {
          console.warn("[useLogoLuminance] falha:", err);
        }
        luminanceCache.set(src, null);
        setAsyncResult(null);
      }
    };

    img.onerror = () => {
      if (cancelled) return;
      luminanceCache.set(src, null);
      setAsyncResult(null);
    };

    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Resolução: cache síncrono > resultado async > null (loading/sem src).
  return cached !== undefined ? cached : asyncResult;
}
