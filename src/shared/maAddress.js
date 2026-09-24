// src/shared/maAddress.js
//
// Endereços do Tap to Map e da Loja mais próxima chegam como uma string só,
// no formato do geocoder ("Rua X, 123, Bairro, Cidade - UF, 00000-000,
// Brasil"). Aqui ela vira { street, district, city, uf } para a lista mostrar
// a rua em destaque, "bairro · cidade/UF" embaixo, e para o filtro por cidade.
// Texto fora do padrão (nome de loja, "Loja Moema") passa inteiro como rua.

const CEP = /^\d{5}-?\d{3}$/;
const CITY_UF = /^(.+?)\s+-\s+([A-Z]{2})$/;

export function parseAddress(text) {
  const raw = String(text || "").trim();
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  while (parts.length && /^brasil$/i.test(parts[parts.length - 1])) parts.pop();
  while (parts.length && CEP.test(parts[parts.length - 1])) parts.pop();
  let city = null;
  let uf = null;
  const cityIdx = parts.findIndex((p) => CITY_UF.test(p));
  if (cityIdx > 0) {
    const m = CITY_UF.exec(parts[cityIdx]);
    city = m[1];
    uf = m[2];
    parts.splice(cityIdx);
  }
  let district = null;
  if (city && parts.length >= 2) {
    // "Rua X, 123" não tem bairro: o último pedaço é número.
    const last = parts[parts.length - 1];
    if (!/^\d+[A-Za-z]?$/.test(last)) district = parts.pop();
  }
  const street = parts.join(", ") || raw;
  return { street, district, city, uf };
}

/** "Parque Prado · Campinas/SP" (o que existir). */
export function addressSubtitle(a) {
  if (!a) return "";
  const cityUf = a.city ? `${a.city}${a.uf ? `/${a.uf}` : ""}` : null;
  return [a.district, cityUf].filter(Boolean).join(" · ");
}

/**
 * Cidades presentes na lista, da que soma mais `weight` para a que soma
 * menos. Endereço sem cidade reconhecida fica fora (o filtro "Todas" cobre).
 */
export function citiesOf(items, weight = (x) => x.weight || 0) {
  const acc = new Map();
  for (const it of items || []) {
    const c = it.address?.city;
    if (!c) continue;
    const key = `${c}|${it.address.uf || ""}`;
    const cur = acc.get(key) || { key, city: c, uf: it.address.uf || null, count: 0, weight: 0 };
    cur.count += 1;
    cur.weight += Number(weight(it)) || 0;
    acc.set(key, cur);
  }
  return [...acc.values()].sort((a, b) => b.weight - a.weight || b.count - a.count || a.city.localeCompare(b.city));
}
