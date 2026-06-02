// src/v2/lib/exportElementPng.js
//
// Captura um nó DOM (card de gráfico ou tabela) como PNG de alta resolução
// pra colar em materiais de apresentação. Usado pelo DownloadPngButtonV2,
// que aparece só pra admin no canto superior direito de cada card.
//
// Por que html-to-image (e não html2canvas)
//   Os gráficos são SVG (recharts). html2canvas rasteriza SVG mal e não
//   lida bem com fontes — html-to-image serializa o nó via foreignObject,
//   embute as web fonts e renderiza SVG nativamente, saindo nítido.
//
// Por que toSvg + rasterização própria (e não toPng do html-to-image)
//   O createImage interno do html-to-image resolve dentro de um
//   requestAnimationFrame (após img.decode()). Em aba não-focada/headless o
//   rAF é estrangulado e nunca dispara → o toPng trava pra sempre. Usamos
//   só o toSvg (que não depende de rAF) e rasterizamos o SVG num <canvas>
//   com img.onload puro — robusto mesmo com a aba em background.
//
// Fundo (background)
//   - "theme":       preenche com --color-canvas (a cor de fundo da página
//                    no tema atual). O card tem bg translúcido (bg-surface),
//                    então preencher com o canvas reproduz exatamente o que
//                    aparece na tela — dark ou light.
//   - "transparent": sem preenchimento de fundo (PNG com alpha). Ideal pra
//                    quem vai colar sobre um fundo escuro/branded próprio.
//
// Alta qualidade
//   pixelRatio 2–3 (limitado pelo devicePixelRatio) → imagem em 2x/3x sem
//   serrilhado, boa pra projeção e zoom em slide.
//
// Fontes (Urbanist via @fontsource, self-hosted/same-origin)
//   Em vez de deixar o html-to-image varrer TODOS os stylesheets do
//   documento (inclui folhas cross-origin do gtag/Google Sign-In, cujo
//   fetch trava por segundos), pré-computamos o CSS de @font-face só das
//   folhas same-origin e passamos via `fontEmbedCSS`. Isso faz o
//   html-to-image pular a varredura própria — exporta rápido e sem travar.
//   O resultado é cacheado: só a 1ª exportação paga o custo de inlinar.
//
// Exclusão
//   Qualquer elemento com `data-export-ignore` (ex.: o próprio botão de
//   baixar) é removido do clone antes de rasterizar.

import { toSvg } from "html-to-image";

// Resolve a cor de fundo da página no tema atual (dark/light). Lê do
// <html> via getComputedStyle — mesma fonte que o useThemeColors usa.
function resolveCanvasColor() {
  if (typeof document === "undefined") return "#1C262F";
  const cs = getComputedStyle(document.documentElement);
  return cs.getPropertyValue("--color-canvas").trim() || "#1C262F";
}

// "Diageo · Curva de Pacing" → "Diageo_Curva_de_Pacing". Remove acentos e
// caracteres inválidos pra nome de arquivo em qualquer SO.
export function slugifyFilename(s) {
  const slug = String(s || "report")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // remove acentos (combining marks)
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return slug || "report";
}

// Ignora o nó (e sua subárvore) se ele tiver o atributo data-export-ignore.
// html-to-image chama o filtro pra cada nó do clone; nós de texto não têm
// dataset, então o guard de instanceof cobre isso.
function exportFilter(el) {
  if (el instanceof HTMLElement && el.dataset.exportIgnore !== undefined) {
    return false;
  }
  return true;
}

// ─── Font embed CSS (cacheado) ────────────────────────────────────────

async function fetchAsDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// Varre só as folhas same-origin (acessíveis sem CORS), coleta as regras
// @font-face e inlina cada url() como dataURL. Folhas cross-origin (gtag,
// Google Sign-In) lançam ao ler cssRules — são ignoradas no try/catch,
// evitando o fetch que trava o html-to-image.
async function buildFontEmbedCSS() {
  if (typeof document === "undefined") return "";

  const faces = []; // { cssText, baseHref }
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin → pula
    }
    if (!rules) continue;
    const baseHref = sheet.href || document.baseURI;
    for (const rule of Array.from(rules)) {
      // CSSFontFaceRule: type === 5 (constante legada) ou checa o nome
      if (rule.type === 5 || rule.constructor?.name === "CSSFontFaceRule") {
        faces.push({ cssText: rule.cssText, baseHref });
      }
    }
  }

  const out = [];
  for (const { cssText, baseHref } of faces) {
    let text = cssText;
    const urls = [
      ...cssText.matchAll(/url\((['"]?)([^'")]+)\1\)/g),
    ].map((m) => m[2]);
    for (const u of urls) {
      if (u.startsWith("data:")) continue;
      try {
        const abs = new URL(u, baseHref);
        if (abs.origin !== window.location.origin) continue; // só same-origin
        const dataUrl = await fetchAsDataUrl(abs.href);
        text = text.split(u).join(dataUrl);
      } catch {
        // recurso indisponível → mantém url original (degradação suave)
      }
    }
    out.push(text);
  }
  return out.join("\n");
}

let _fontCssPromise = null;
function getFontEmbedCSS() {
  if (!_fontCssPromise) {
    _fontCssPromise = buildFontEmbedCSS().catch(() => "");
  }
  return _fontCssPromise;
}

// Carrega uma data/blob URL num <img> com onload puro (sem rAF/decode, que
// travam em aba background). Resolve com o elemento já pronto pra desenhar.
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("falha ao carregar SVG no <img>"));
    img.src = url;
  });
}

// Espera o recharts (ResponsiveContainer via ResizeObserver) redesenhar o
// SVG na largura nova depois que estreitamos o card. Faz polling do width do
// <svg> interno; resolve quando bater no alvo (com tolerância) ou no timeout.
function waitForChartReflow(node, targetWidth, timeoutMs = 900) {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      const svg = node.querySelector(".recharts-surface") || node.querySelector("svg");
      const w = svg ? svg.getBoundingClientRect().width : 0;
      if (!svg || w <= targetWidth + 4 || performance.now() - start > timeoutMs) {
        resolve();
      } else {
        setTimeout(tick, 24);
      }
    };
    // dá um tick pro ResizeObserver disparar antes da 1ª checagem
    setTimeout(tick, 24);
  });
}

// Deixa o card compacto pra exportação e roda `fn` com o layout já
// reflutuado, restaurando os estilos depois. A tela fica intacta fora do
// instante da captura. Dois modos:
//
//   - GRÁFICO (maxWidth): estreita o card pra maxWidth (se estiver mais
//     largo) e espera o recharts (ResponsiveContainer) redesenhar.
//   - TABELA (fitContent): as tabelas são `w-full` e no report esticam pra
//     largura cheia, espalhando as colunas com muito espaço em branco. Aqui
//     tiramos o w-full (table → width:auto) e deixamos o card em max-content,
//     então a tabela encolhe pro tamanho natural do conteúdo (colunas juntas)
//     sem clipar nenhuma coluna. Não precisa esperar reflow assíncrono.
//
// Sem maxWidth nem fitContent, é no-op.
async function withCompactWidth(node, { maxWidth = null, fitContent = false }, fn) {
  const needFixed =
    !fitContent && maxWidth && node.getBoundingClientRect().width > maxWidth;
  if (!fitContent && !needFixed) {
    return fn();
  }

  const prev = {
    width: node.style.width,
    maxWidth: node.style.maxWidth,
    transition: node.style.transition,
  };
  const tables = fitContent ? Array.from(node.querySelectorAll("table")) : [];
  const prevTableWidths = tables.map((t) => t.style.width);

  node.style.transition = "none";
  try {
    if (fitContent) {
      // table.w-full estica pra 100% do card — trocamos por width:auto pra a
      // tabela medir o conteúdo, e o card em max-content embrulha o resultado.
      tables.forEach((t) => {
        t.style.width = "auto";
      });
      node.style.width = "max-content";
      node.style.maxWidth = "none";
      node.getBoundingClientRect(); // força reflow síncrono
      await new Promise((r) => setTimeout(r, 30));
    } else {
      node.style.maxWidth = `${maxWidth}px`;
      node.style.width = `${maxWidth}px`;
      await waitForChartReflow(node, maxWidth);
    }
    return await fn();
  } finally {
    node.style.width = prev.width;
    node.style.maxWidth = prev.maxWidth;
    node.style.transition = prev.transition;
    tables.forEach((t, i) => {
      t.style.width = prevTableWidths[i];
    });
  }
}

// ─── Export ───────────────────────────────────────────────────────────

export async function exportElementToPng(
  node,
  {
    filename = "grafico",
    background = "theme",
    pixelRatio,
    maxWidth = null,
    fitContent = false,
  } = {},
) {
  if (!node) return;

  const ratio =
    pixelRatio ||
    Math.min(3, Math.max(2, Math.round(window.devicePixelRatio || 1) || 1));

  const backgroundColor =
    background === "transparent" ? null : resolveCanvasColor();

  // Pré-computa (e cacheia) o CSS das fontes same-origin. Passar
  // fontEmbedCSS faz o html-to-image NÃO varrer os stylesheets sozinho —
  // evita o fetch de folhas cross-origin que trava a exportação.
  const fontEmbedCSS = await getFontEmbedCSS();

  // Deixa o card compacto pra slide: gráficos estreitam pra maxWidth;
  // tabelas (fitContent) encolhem pro tamanho natural do conteúdo. Tudo
  // abaixo roda com o layout já reflutuado.
  await withCompactWidth(node, { maxWidth, fitContent }, async () => {
    // 1) Serializa o nó num SVG (foreignObject) — passo que não depende de rAF.
    const svgUrl = await toSvg(node, { fontEmbedCSS, filter: exportFilter });

    // 2) Rasteriza o SVG num <canvas> na resolução desejada. Mede DEPOIS de
    //    estreitar, pra o canvas casar com o gráfico já redesenhado.
    const rect = node.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(rect.width));
    const height = Math.max(1, Math.ceil(rect.height));

    const img = await loadImage(svgUrl);

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    if (backgroundColor) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(img, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/png");

    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${slugifyFilename(filename)}.png`;
    a.click();
  });
}
