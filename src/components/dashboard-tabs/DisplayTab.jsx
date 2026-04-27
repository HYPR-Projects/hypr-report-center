import { C } from "../../shared/theme";
import { fmt, fmtP, fmtP2, fmtR } from "../../shared/format";
import { parseYmd } from "../../shared/dateFilter";
import {
  groupByDate, groupBySize, groupByAudience,
  buildLineOptions, computeDisplayKpis,
} from "../../shared/aggregations";
import Tabs from "../Tabs";
import AudienceFilter from "../AudienceFilter";
import DateRangeFilter from "../DateRangeFilter";
import DualChart from "../DualChart";
import CollapsibleTable from "../CollapsibleTable";
import PerfTable from "../PerfTable";
import TabChat from "../TabChat";

const TACTIC_TABS = ["O2O", "OOH"];

/**
 * Tab "Display" — switch O2O/OOH + filtro de audiência (line) + filtro
 * de período + KPIs + pacing + 3 charts (entrega diária, por tamanho,
 * por audiência) + tabela detalhada.
 *
 * Props
 * -----
 * - `aggregates`: { totals, daily0, detail0, isFiltered, availableDates }
 * - `camp`: data.campaign;
 * - `theme`: cTheme;
 * - `token`, `isAdmin`, `adminJwt`;
 * - `isDarkClient`: pra cores do pacing bar e tema dos filtros;
 * - `dispTab`, `setDispTab`: tactic ativa (O2O/OOH);
 * - `dispLines`, `setDispLines`: filtro de audiências (array vazio = todas);
 * - `mainRange`, `setMainRange`: filtro de período (compartilhado com
 *   Overview e Video).
 */
const DisplayTab = ({
  aggregates, camp, theme,
  token, isAdmin, adminJwt,
  isDarkClient,
  dispTab, setDispTab,
  dispLines, setDispLines,
  mainRange, setMainRange,
}) => {
  const { totals, detail0, isFiltered, availableDates } = aggregates;

  const cbg2  = theme.bg2;
  const cbdr  = theme.bdr;
  const ctext = theme.text;
  const cmuted = theme.muted;

  return (
    <div>
      {(() => {
        const rows      = totals.filter(r => r.media_type === "DISPLAY" && r.tactic_type === dispTab);
        const detailAll = detail0.filter(r => r.media_type === "DISPLAY" && r.line_name?.toLowerCase().includes(dispTab.toLowerCase()));
        const lineNames = buildLineOptions(detailAll);
        const detail    = dispLines.length === 0 ? detailAll : detailAll.filter(r => dispLines.includes(r.line_name));

        // Agregações pra os 3 charts (data, tamanho, audiência) e KPIs.
        // Tudo isolado em src/shared/aggregations.js — funções puras testáveis.
        const daily      = groupByDate(detail, "clicks", "viewable_impressions", "ctr");
        const byAudience = groupByAudience(detailAll, "clicks", "viewable_impressions", "ctr");
        const bySize     = groupBySize(detail, "clicks", "viewable_impressions", "ctr");

        const k = computeDisplayKpis({ rows, detail, detailAll, tactic: dispTab, camp });
        const { cost, impr, vi, clks, ctr, budget, cpmNeg, cpmEf, cpc, rentab, pac, pacBase, pacOver } = k;

        return (
          <div>
            {/* Toolbar única: O2O/OOH à esquerda, Audiência + Período à direita */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 16, marginBottom: 16, flexWrap: "wrap" }}>
              <Tabs
                tabs={TACTIC_TABS}
                active={dispTab}
                onChange={(t) => { setDispTab(t); setDispLines([]); }}
                small
                theme={theme}
                inline
              />
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <AudienceFilter lines={lineNames} selected={dispLines} onChange={setDispLines} theme={theme} isDark={isDarkClient}/>
                <DateRangeFilter
                  value={mainRange}
                  onChange={setMainRange}
                  minDate={parseYmd(camp.start_date)}
                  maxDate={parseYmd(camp.end_date)}
                  availableDates={availableDates}
                  isDark={isDarkClient}
                />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginBottom: 20 }}>
              {[
                { l: "Budget Contratado",  v: fmtR(budget) },
                { l: "Imp. Contratadas",   v: fmt(dispTab === "O2O" ? (rows[0]?.contracted_o2o_display_impressions || 0) : (rows[0]?.contracted_ooh_display_impressions || 0)) },
                { l: "Imp. Bonus",         v: fmt(dispTab === "O2O" ? (rows[0]?.bonus_o2o_display_impressions || 0)      : (rows[0]?.bonus_ooh_display_impressions || 0)) },
                { l: "CPM Negociado",      v: fmtR(cpmNeg) },
              ].map(({ l, v }) => (
                <div key={l} style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 10, padding: "14px 16px" }}>
                  <div style={{ fontSize: 11, color: cmuted, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4, color: ctext }}>{v}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginBottom: 20 }}>
              {[
                { l: "Impressões",      v: fmt(impr) },
                { l: "Imp. Visíveis",   v: fmt(vi) },
                { l: "CPM Efetivo",     v: fmtR(cpmEf), blue: true },
                { l: "Rentabilidade",   v: fmtP(rentab), color: rentab > 0 ? C.blue : rentab < 0 ? C.red : C.white },
                { l: "Cliques",         v: fmt(clks) },
                { l: "CTR",             v: fmtP2(ctr) },
                { l: "CPC",             v: fmtR(cpc) },
              ].map(({ l, v, blue, color }) => (
                <div key={l} style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 10, padding: "14px 16px" }}>
                  <div style={{ fontSize: 11, color: cmuted, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4, color: color || (blue ? C.blue : ctext) }}>{v}</div>
                </div>
              ))}
            </div>

            {!isFiltered && (
              <div style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
              {(() => {
                const barC  = pac >= 100 ? "#2ECC71" : pac >= 70 ? "#F1C40F" : "#E74C3C";
                const overC = isDarkClient ? "#C5EAF6" : "#246C84";
                return (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: cmuted, textTransform: "uppercase", letterSpacing: 1 }}>Pacing {dispTab}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: pac > 100 ? overC : barC }}>
                        {fmt(pac, 1)}%{pac > 100 && ` ⚡ Over de ${fmt(pac - 100, 1)}%`}
                      </span>
                    </div>
                    <div style={{ height: 8, background: isDarkClient ? C.dark3 : "#E2E8F0", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ display: "flex", height: "100%" }}>
                        <div style={{ width: `${pacBase}%`, background: barC, borderRadius: 4, transition: "width 0.8s" }}/>
                        {pacOver > 0 && <div style={{ width: `${Math.min(pacOver, 20)}%`, background: overC, borderRadius: 4 }}/>}
                      </div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                      <span style={{ fontSize: 11, color: cmuted }}>Investido: {fmtR(cost)}</span>
                      <span style={{ fontSize: 11, color: cmuted }}>Budget: {fmtR(budget)}</span>
                    </div>
                  </>
                );
              })()}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
              <div style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>Entrega × CTR Diário</div>
                <DualChart data={daily} xKey="date" y1Key="viewable_impressions" y2Key="ctr" label1="Imp. Visíveis" label2="CTR %" color1={C.blue} color2={C.blueLight}/>
              </div>
              <div style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>Entrega × CTR por Tamanho</div>
                <DualChart data={bySize} xKey="size" y1Key="viewable_impressions" y2Key="ctr" label1="Imp. Visíveis" label2="CTR %" color1={C.blue} color2={C.blueLight}/>
              </div>
            </div>

            <div style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>Entrega × CTR por Audiência</div>
              <DualChart data={byAudience} xKey="audience" y1Key="viewable_impressions" y2Key="ctr" label1="Imp. Visíveis" label2="CTR %" color1={C.blue} color2={C.blueLight}/>
            </div>

            <CollapsibleTable title="Detalhamento Diário" theme={theme}>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
                <button onClick={() => {
                  const headers = ["Data", "Campanha", "Line", "Criativo", "Tamanho", "Tática", "Impressões", "Imp. Visíveis", "Cliques", "CTR", "CPM Ef.", "Custo Ef."];
                  const csv = [headers, ...detail.map(r => [r.date, r.campaign_name, r.line_name, r.creative_name, r.creative_size, r.tactic_type, r.impressions, r.viewable_impressions, r.clicks, r.ctr, r.effective_cpm_amount, r.effective_total_cost])]
                    .map(r => r.map(v => `"${v ?? ""}`).join(",")).join("\n");
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                  a.download = `display_${dispTab}_${camp.campaign_name}.csv`;
                  a.click();
                }} style={{ background: C.blue, color: C.white, border: "none", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  ⬇ Download CSV
                </button>
              </div>
              <PerfTable rows={detail} type="DISPLAY"/>
            </CollapsibleTable>

            <TabChat token={token} tabName="Display" author={isAdmin ? "HYPR" : "Cliente"} adminJwt={adminJwt} theme={theme}/>
          </div>
        );
      })()}
    </div>
  );
};

export default DisplayTab;
