// src/shared/chunkReload.js
//
// Recupera sozinho quando um chunk de código não carrega por causa de deploy.
//
// Por que existe
// ──────────────
// Cada rota, e vários modais, são `lazy()`: o JS só é baixado quando a tela
// abre. Os arquivos têm hash no nome e todo deploy troca os hashes. Quem está
// com a aba aberta desde antes do deploy ainda tem o index antigo na memória,
// que aponta pros arquivos antigos — que não existem mais no deploy novo. O
// `vercel.json` reescreve qualquer path desconhecido pro `index.html`, então o
// navegador recebe HTML onde esperava JS, o import falha e o ErrorBoundary
// mostrava "Algo quebrou". A pessoa dava F5 e funcionava: era só código velho.
//
// Como funciona
// ─────────────
//  1. `installChunkReload()` escuta o `vite:preloadError` (disparado pelo
//     helper que envolve todo `import()` dinâmico no build) e só MARCA o erro.
//     Não recarrega nada aqui: o mesmo evento dispara também pra preload em
//     idle (lazyWithPreload) que ninguém pediu — recarregar nesse caso tiraria
//     a página de quem está digitando.
//  2. Quem decide é o ErrorBoundary: se a falha chegou nele, uma tela de fato
//     não conseguiu renderizar. Aí `reloadForChunkError()` antecipa o F5.
//
// Guardas do reload
// ─────────────────
//  - Uma vez por janela de 60s (sessionStorage): se o chunk continua falhando
//    depois do reload, o problema não é deploy — o boundary mostra o erro em
//    vez de entrar em loop.
//  - Offline: recarregar sem rede troca a tela de erro pela página de
//    "sem internet" do navegador. Aí não recarrega.
//  - Sem sessionStorage (modo privado restrito): sem como guardar a marca,
//    não há proteção contra loop — então não recarrega.

const KEY = "hypr.chunkReloadAt";
const WINDOW_MS = 60_000;

// Fallback por mensagem pra erro que não passou pelo evento do Vite. Chrome,
// Firefox, Safari e o preload de CSS do Vite, nessa ordem.
const CHUNK_MSG = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export function installChunkReload() {
  if (typeof window === "undefined") return;
  window.addEventListener("vite:preloadError", (event) => {
    // O Vite relança ESTE mesmo objeto de erro depois do evento — a marca
    // chega intacta no ErrorBoundary via React.lazy.
    try {
      if (event?.payload && typeof event.payload === "object") {
        event.payload.__hyprChunkError = true;
      }
    } catch {
      /* objeto congelado — o fallback por mensagem cobre */
    }
  });
}

export function isChunkLoadError(err) {
  if (!err) return false;
  if (err.__hyprChunkError === true) return true;
  return CHUNK_MSG.test(String(err?.message || ""));
}

/** Sem efeito colateral: diz se um reload agora seria permitido pelas guardas. */
export function canReloadForChunkError() {
  if (typeof window === "undefined") return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    const last = Number(sessionStorage.getItem(KEY)) || 0;
    return Date.now() - last >= WINDOW_MS;
  } catch {
    return false;
  }
}

/** Recarrega se as guardas permitirem. Devolve true quando o reload foi disparado. */
export function reloadForChunkError() {
  if (!canReloadForChunkError()) return false;
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
