// src/shared/chunkReload.js
//
// Recarrega a página UMA vez quando um chunk de código não carrega.
//
// Por que existe
// ──────────────
// Cada rota, e vários modais, são `lazy()`: o JS só é baixado quando a tela
// abre. Os arquivos têm hash no nome e todo deploy troca os hashes. Quem está
// com a aba aberta desde antes do deploy ainda tem o index antigo na memória,
// que aponta pros arquivos antigos — que não existem mais no deploy novo. O
// `vercel.json` reescreve qualquer path desconhecido pro `index.html`, então o
// navegador recebe HTML onde esperava JS, o import falha e o ErrorBoundary
// mostra "Algo quebrou". A pessoa dá F5 e funciona: era só código velho.
//
// O Vite avisa essa falha pelo evento `vite:preloadError` (disparado pelo
// helper que envolve todo `import()` dinâmico no build). Aqui a gente só
// antecipa o F5 que a pessoa daria.
//
// Guardas
// ───────
//  - Uma vez por janela de 60s (sessionStorage): se o chunk continua falhando
//    depois do reload, o problema não é deploy — deixa o erro seguir pro
//    ErrorBoundary em vez de entrar em loop de reload.
//  - Offline: recarregar sem rede troca a tela de erro pela página de
//    "sem internet" do navegador. Aí é melhor não fazer nada.
//  - Sem sessionStorage (modo privado restrito): sem como guardar a marca,
//    não há proteção contra loop — então não recarrega.
//
// O evento NÃO é cancelado (sem preventDefault): o erro continua chegando no
// `catch`/ErrorBoundary de quem fez o import, exatamente como antes. O reload
// só corre na frente.

const KEY = "hypr.chunkReloadAt";
const WINDOW_MS = 60_000;

export function installChunkReload() {
  if (typeof window === "undefined") return;
  window.addEventListener("vite:preloadError", () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    try {
      const last = Number(sessionStorage.getItem(KEY)) || 0;
      if (Date.now() - last < WINDOW_MS) return;
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      return;
    }
    window.location.reload();
  });
}
