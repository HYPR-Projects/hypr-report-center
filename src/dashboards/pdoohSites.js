// Agregação por endereço (SITE) do PDOOH — compartilhada entre a tabela de
// performance e o mapa, pra garantir que clique na linha ↔ ponto no mapa
// referenciam exatamente o mesmo registro (mesma chave name||city).

// Aliases pra lat/lng — o HYPR_PDOOH_REPORT usa SCREEN_LATITUDE/SCREEN_LONGITUDE,
// bases legadas usavam LATITUDE/LONGITUDE ou LAT/LNG.
export const getLat = (r) => {
  const v = r["LATITUDE"] ?? r["SCREEN_LATITUDE"] ?? r["LAT"] ?? r["Lat"] ?? r["lat"];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const getLng = (r) => {
  const v = r["LONGITUDE"] ?? r["SCREEN_LONGITUDE"] ?? r["LNG"] ?? r["LON"] ?? r["LONG"] ?? r["Lng"] ?? r["lng"];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function aggregateSites(rows) {
  const bySite = new Map();
  rows.forEach(r => {
    // Fallback pra SCREEN em bases que não trazem SITE
    const name = r["SITE"] || r["Site"] || r["site"] || r["SCREEN"] || null;
    if (!name) return;
    const city = r["CITY"] || "—";
    const key = `${name}||${city}`;
    let s = bySite.get(key);
    if (!s) {
      s = { key, name, city, owners: new Set(), types: new Set(), screens: new Set(), impressions: 0, plays: 0, lat: 0, lng: 0 };
      bySite.set(key, s);
    }
    if (r["MEDIA_OWNER"]) s.owners.add(r["MEDIA_OWNER"]);
    if (r["MEDIA_TYPE"]) s.types.add(String(r["MEDIA_TYPE"]).split(">")[0].trim());
    if (r["SCREEN"]) s.screens.add(r["SCREEN"]);
    s.impressions += Number(r["IMPRESSIONS"]) || 0;
    s.plays += Number(r["PLAYS"]) || 0;
    if (s.lat === 0 || s.lng === 0) {
      const lat = getLat(r), lng = getLng(r);
      if (lat !== 0 && lng !== 0) { s.lat = lat; s.lng = lng; }
    }
  });
  return [...bySite.values()].map(s => ({
    key: s.key,
    name: s.name,
    city: s.city,
    owner: [...s.owners].join(", ") || "—",
    type: [...s.types].join(", ") || "—",
    screens: s.screens.size || 1,
    impressions: Math.round(s.impressions),
    plays: s.plays,
    lat: s.lat,
    lng: s.lng,
  }));
}
