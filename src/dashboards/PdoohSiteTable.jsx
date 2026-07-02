import { useMemo, useState } from "react";
import { C } from "../shared/theme";
import { fmt } from "../shared/format";

const PAGE_SIZE = 15;

// Tabela de performance por endereço (SITE do HYPR_PDOOH_REPORT — shopping,
// condomínio, terminal etc). Recebe os sites já agregados (pdoohSites.js,
// compartilhado com o mapa). Como uma campanha pode ter milhares de locais,
// a tabela tem busca + ordenação + paginação client-side. Linhas com
// geolocalização são clicáveis → onSiteClick(site) foca o ponto no mapa.
const PdoohSiteTable = ({ sites, theme, onSiteClick }) => {
  const { bg2, bg3, bdr, text, muted } = theme;
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("impressions");
  const [sortDir, setSortDir] = useState(-1);
  const [page, setPage] = useState(0);
  const [hoverKey, setHoverKey] = useState(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? sites.filter(s => `${s.name} ${s.city} ${s.owner} ${s.type}`.toLowerCase().includes(q))
      : sites;
    return [...base].sort((a, b) => {
      if (sortKey === "name") return sortDir * String(a.name).localeCompare(String(b.name), "pt-BR");
      return sortDir * ((a[sortKey] || 0) - (b[sortKey] || 0));
    });
  }, [sites, search, sortKey, sortDir]);

  if (sites.length === 0) return null;

  const hasGeo = sites.some(s => s.lat !== 0 && s.lng !== 0);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const onSort = (key) => {
    if (sortKey === key) { setSortDir(d => -d); }
    else { setSortKey(key); setSortDir(key === "name" ? 1 : -1); }
    setPage(0);
  };
  const arrow = (key) => sortKey === key ? (sortDir === -1 ? " ↓" : " ↑") : "";

  const th = (label, key, align = "left") => (
    <th onClick={() => onSort(key)} style={{
      color: sortKey === key ? C.blue : muted, fontWeight: 600, fontSize: 12,
      textAlign: align, padding: "0 8px 8px 0", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap",
    }}>{label}{arrow(key)}</th>
  );

  const navBtn = (label, disabled, onClick) => (
    <button disabled={disabled} onClick={onClick} style={{
      background: bg3, color: disabled ? bdr : muted, border: `1px solid ${bdr}`,
      padding: "4px 12px", borderRadius: 6, cursor: disabled ? "default" : "pointer", fontSize: 12,
    }}>{label}</button>
  );

  return (
    <div style={{ background: bg2, border: `1px solid ${bdr}`, borderRadius: 12, padding: 20, marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: muted, textTransform: "uppercase", letterSpacing: 1 }}>Performance por Endereço</div>
          <div style={{ fontSize: 11, color: muted, marginTop: 4 }}>
            {fmt(sites.length)} locais · {fmt(sites.reduce((s, x) => s + x.screens, 0))} telas
            {hasGeo && onSiteClick ? " · clique numa linha para ver no mapa" : ""}
          </div>
        </div>
        <input
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0); }}
          placeholder="Buscar local, cidade ou media owner..."
          style={{
            background: bg3, color: text, border: `1px solid ${bdr}`, borderRadius: 8,
            padding: "8px 12px", fontSize: 12, minWidth: 260, outline: "none",
          }}
        />
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            {th("Local", "name")}
            <th style={{ color: muted, fontWeight: 600, fontSize: 12, textAlign: "left", padding: "0 8px 8px 0", whiteSpace: "nowrap" }}>Cidade</th>
            <th style={{ color: muted, fontWeight: 600, fontSize: 12, textAlign: "left", padding: "0 8px 8px 0", whiteSpace: "nowrap" }}>Media Owner</th>
            {th("Telas", "screens", "right")}
            {th("Impressões", "impressions", "right")}
            {th("Plays", "plays", "right")}
          </tr></thead>
          <tbody>
            {pageRows.map((s) => {
              const clickable = onSiteClick && s.lat !== 0 && s.lng !== 0;
              return (
                <tr key={s.key}
                  onClick={clickable ? () => onSiteClick(s) : undefined}
                  onMouseEnter={clickable ? () => setHoverKey(s.key) : undefined}
                  onMouseLeave={clickable ? () => setHoverKey(null) : undefined}
                  title={clickable ? "Ver no mapa" : undefined}
                  style={{
                    borderTop: `1px solid ${bdr}`,
                    cursor: clickable ? "pointer" : "default",
                    background: hoverKey === s.key ? bg3 : "transparent",
                    transition: "background 0.15s",
                  }}>
                  <td style={{ fontWeight: 600, padding: "10px 8px 10px 0", color: text, maxWidth: 340 }}>
                    {clickable && <span aria-hidden="true" style={{ fontSize: 11, marginRight: 6, opacity: hoverKey === s.key ? 1 : 0.45 }}>📍</span>}
                    {s.name}
                    <div style={{ fontSize: 11, fontWeight: 400, color: muted, marginTop: 2 }}>{s.type}</div>
                  </td>
                  <td style={{ padding: "10px 8px 10px 0", color: text, whiteSpace: "nowrap" }}>{s.city}</td>
                  <td style={{ padding: "10px 8px 10px 0", color: text, whiteSpace: "nowrap" }}>{s.owner}</td>
                  <td style={{ padding: "10px 8px 10px 0", color: text, textAlign: "right" }}>{fmt(s.screens)}</td>
                  <td style={{ padding: "10px 8px 10px 0", color: text, textAlign: "right" }}>{fmt(s.impressions)}</td>
                  <td style={{ padding: "10px 0", color: text, textAlign: "right" }}>{fmt(s.plays)}</td>
                </tr>
              );
            })}
            {pageRows.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 24, textAlign: "center", color: muted, fontSize: 13 }}>Nenhum local encontrado para "{search}".</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: muted }}>
            {fmt(safePage * PAGE_SIZE + 1)}–{fmt(Math.min((safePage + 1) * PAGE_SIZE, filtered.length))} de {fmt(filtered.length)}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            {navBtn("← Anterior", safePage === 0, () => setPage(p => Math.max(0, p - 1)))}
            {navBtn("Próxima →", safePage >= pageCount - 1, () => setPage(p => Math.min(pageCount - 1, p + 1)))}
          </div>
        </div>
      )}
    </div>
  );
};

export default PdoohSiteTable;
