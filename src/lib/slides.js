// src/lib/slides.js
//
// Helpers de URL do Google Slides — compartilhados entre o popup admin de
// fechamento (validação do link de pós-venda) e o modal de preview no report
// do cliente (conversão pra URL de embed).
//
// Formatos aceitos:
//   https://docs.google.com/presentation/d/<FILE_ID>/edit#slide=...
//   https://docs.google.com/presentation/d/e/<PUBLISHED_ID>/pub?start=...
//
// O embed usa o endpoint /embed do próprio Slides, que renderiza o deck
// navegável dentro de um iframe (setas, fullscreen) sem abrir nova aba.
// Funciona pra decks compartilhados "qualquer pessoa com o link" ou
// publicados na web.

const GOOGLE_SLIDES_RE = /docs\.google\.com\/presentation\/d\/(e\/)?([-\w]+)/i;

/** true quando a URL aponta pra uma apresentação do Google Slides. */
export function isGoogleSlidesUrl(raw) {
  return GOOGLE_SLIDES_RE.test((raw || "").trim());
}

/**
 * Converte qualquer link de Slides (edit/view/pub) na URL de embed pra
 * iframe. Retorna null quando a URL não é um Slides reconhecível —
 * caller decide o fallback (ex: card de link externo).
 */
export function slidesEmbedUrl(raw) {
  const m = (raw || "").trim().match(GOOGLE_SLIDES_RE);
  if (!m) return null;
  const prefix = m[1] ? "e/" : "";
  // start=false: não inicia autoplay; delayms alto evita auto-avanço caso
  // o Google ignore o start=false em decks publicados.
  return `https://docs.google.com/presentation/d/${prefix}${m[2]}/embed?start=false&loop=false&delayms=60000`;
}
