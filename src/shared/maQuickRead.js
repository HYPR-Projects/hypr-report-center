// src/shared/maQuickRead.js
//
// "Leitura rápida" do detalhe da peça Max Attention: duas ou três frases
// montadas por regra a partir dos números do período, para quem só lê a
// primeira dobra. Sem IA e sem juízo de valor: descreve o que aconteceu
// ("ainda é rara"), nunca qualifica ("baixo desempenho"). O texto aparece
// para o cliente, então qualquer frase nova aqui precisa passar nesse filtro.

import { fmt } from "./format.js";
import { buildFunnel, funnelConversions } from "./maMetrics.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Abaixo de 10%, uma casa (0,6% não vira "1%").
const pctInt = (part, whole) => {
  const v = (part / whole) * 100;
  return `${fmt(v, v < 10 ? 1 : 0)}%`;
};

// Abaixo desta fração (ações de loja ÷ quem explorou o mapa), a passagem
// do mapa para a loja é descrita como rara.
const RARE_STORE_SHARE = 0.01;

function tapToMap(s, engaged) {
  const out = [];
  const acts = [
    { key: "overlay_dismissed", text: "arrastou a capa", v: num(s.overlay_dismissed) },
    { key: "map_interaction", text: "mexeu no mapa", v: num(s.map_interaction) },
    { key: "overlay_click", text: "clicou na capa", v: num(s.overlay_click) },
  ].sort((a, b) => b.v - a.v);
  const top = acts[0];
  if (top.v > 0 && top.v / engaged >= 0.5) {
    out.push(
      top.v / engaged >= 0.9
        ? `Quase todo mundo que interagiu ${top.text} (${pctInt(top.v, engaged)}).`
        : `${pctInt(top.v, engaged)} de quem interagiu ${top.text}.`,
    );
  }
  const explored = num(s.map_interaction);
  if (explored > 0 && top.key !== "map_interaction") {
    out.push(`${pctInt(explored, engaged)} foi além e explorou o mapa.`);
  }
  // Pessoas que clicaram num CTA de loja (distintas); sem a etapa, a soma
  // por botão é o teto.
  const store = num(s.cta_location) || num(s.cta_directions) + num(s.cta_whatsapp) + num(s.cta_website);
  if (explored > 0) {
    if (store === 0) out.push("Ninguém abriu rota, WhatsApp ou site no período até aqui.");
    else if (store / explored < RARE_STORE_SHARE) out.push("A passagem do mapa para rota, WhatsApp ou site ainda é rara no período.");
    else out.push(`${fmt(store)} ${store === 1 ? "pessoa abriu" : "pessoas abriram"} rota, WhatsApp ou site.`);
  }
  return out;
}

/** Frase de leitura rápida da peça, ou null quando não há o que dizer. */
export function quickRead(piece, media) {
  const s = piece?.steps;
  const engaged = num(media?.engaged);
  if (!s || engaged <= 0) return null;
  let parts = [];
  if (piece.format === "tap-to-map") parts = tapToMap(s, engaged);
  if (!parts.length) {
    const viewed = num(s.viewable);
    if (viewed > 0 && engaged <= viewed) parts.push(`${pctInt(engaged, viewed)} de quem viu a peça interagiu com ela.`);
    const { biggestDrop } = funnelConversions(buildFunnel(piece).steps);
    if (biggestDrop) parts.push(`A etapa com mais perda é “${biggestDrop.from} → ${biggestDrop.to}”.`);
  }
  return parts.length ? parts.join(" ") : null;
}
