import { C } from "../../shared/theme";
import { fmt, fmtP, fmtP2, fmtR } from "../../shared/format";
import {
  groupByDate, groupBySize, groupByAudience,
  buildLineOptions, computeVideoKpis,
} from "../../shared/aggregations";
import Tabs from "../Tabs";
import MultiLineSelect from "../MultiLineSelect";
import DualChart from "../DualChart";
import CollapsibleTable from "../CollapsibleTable";
import PerfTable from "../PerfTable";
import TabChat from "../TabChat";

const TACTIC_TABS = ["O2O", "OOH"];

/**
 * Tab "Video" — gêmea da DisplayTab mas operando em VIDEO completions/VTR
 * em vez de impressions/CTR. Diferença chave: pacing e CPCV vêm direto
 * do backend (totals[0].pacing, .effective_cpcv_amount, .rentabilidade)
 * porque a fórmula de video é mais sensível e o backend já normaliza
 * datas reais por frente.
 *
 * Props
 * -----
 * Mesmo contrato do DisplayTab, com `vidTab`/`vidLines` no lugar de
 * `dispTab`/`dispLines`.
 */
const VideoTab = ({
  aggregates, camp, theme,
  token, isAdmin, adminJwt,
  isDarkClient,
  vidTab, setVidTab,
  vidLines, setVidLines,
}) => {
  const { totals, detail0 } = aggregates;

  const cbg2  = theme.bg2;
  const cbdr  = theme.bdr;
  const ctext = theme.text;
  const cmuted = theme.muted;

  return (
    <div>
      <Tabs
        tabs={TACTIC_TABS}
        active={vidTab}
        onChange={(t) => { setVidTab(t); setVidLines([]); }}
        small
        theme={theme}
      />
      {(() => {
        const rows       = totals.filter(r => r.media_type === "VIDEO" && r.tactic_type === vidTab);
        const detailAllV = detail0.filter(r => r.media_type === "VIDEO" && r.line_name?.toLowerCase().includes(vidTab.toLowerCase()));
        const lineNamesV = buildLineOptions(detailAllV);
        const detail     = vidLines.length === 0 ? detailAllV : detailAllV.filter(r => vidLines.includes(r.line_name));

        // Agregações pra os charts e KPIs — funções puras em aggregations.js.
        // groupByDate fallbacka video_view_100 → completions automaticamente
        // pra rows antigas que ainda usavam o nome velho.
        const daily      = groupByDate(detail, "video_view_100", "viewable_impressions", "vtr");
        const byAudience = groupByAudience(detailAllV, "video_view_100", "viewable_impressions", "vtr");
        const bySize     = groupBySize(detail, "video_view_100", "viewable_impressions", "vtr");

        const k = computeVideoKpis({ rows, detail, tactic: vidTab });
        const { cost, views100, starts, vtr, budget, cpcvNeg, cpcvEf, rentab, pac, pacBase, pacOver } = k;

        return (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, padding: "10px 16px", background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 10 }}>
              <span style={{ fontSize: 12, color: cmuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, flexShrink: 0 }}>Line Item:</span>
              <MultiLineSelect lines={lineNamesV} selected={vidLines} onChange={setVidLines} theme={theme}/>
              {vidLines.length > 0 && (
                <button onClick={() => setVidLines([])} style={{ background: "none", border: `1px solid ${cbdr}`, color: cmuted, borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12, flexShrink: 0 }}>
                  ✕ Limpar
                </button>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginBottom: 20 }}>
              {[
                { l: "Budget Contratado", v: fmtR(budget) },
                { l: "Views Contratadas", v: fmt(vidTab === "O2O" ? (rows[0]?.contracted_o2o_video_completions || 0) : (rows[0]?.contracted_ooh_video_completions || 0)) },
                { l: "Views Bonus",       v: fmt(vidTab === "O2O" ? (rows[0]?.bonus_o2o_video_completions || 0)      : (rows[0]?.bonus_ooh_video_completions || 0)) },
                { l: "CPCV Negociado",    v: fmtR(cpcvNeg) },
              ].map(({ l, v }) => (
                <div key={l} style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 10, padding: "14px 16px" }}>
                  <div style={{ fontSize: 11, color: cmuted, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4, color: ctext }}>{v}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginBottom: 20 }}>
              {[
                { l: "Views Start",     v: fmt(starts) },
                { l: "Views 100%",      v: fmt(views100) },
                { l: "VTR",             v: fmtP2(vtr) },
                { l: "CPCV Efetivo",    v: fmtR(cpcvEf), blue: true },
                { l: "Rentabilidade",   v: fmtP(rentab), color: rentab > 0 ? C.blue : rentab < 0 ? C.red : C.white },
              ].map(({ l, v, blue, color }) => (
                <div key={l} style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 10, padding: "14px 16px" }}>
                  <div style={{ fontSize: 11, color: cmuted, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, marginTop: 4, color: color || (blue ? C.blue : ctext) }}>{v}</div>
                </div>
              ))}
            </div>

            <div style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
              {(() => {
                const barC  = pac >= 100 ? "#2ECC71" : pac >= 70 ? "#F1C40F" : "#E74C3C";
                const overC = isDarkClient ? "#C5EAF6" : "#246C84";
                return (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: cmuted, textTransform: "uppercase", letterSpacing: 1 }}>Pacing {vidTab}</span>
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

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
              <div style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>Views 100% × VTR Diário</div>
                <DualChart data={daily} xKey="date" y1Key="video_view_100" y2Key="vtr" label1="Views 100%" label2="VTR %" color1={C.blue} color2={C.blueLight}/>
              </div>
              <div style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>Views 100% × VTR por Tamanho</div>
                <DualChart data={bySize} xKey="size" y1Key="video_view_100" y2Key="vtr" label1="Views 100%" label2="VTR %" color1={C.blue} color2={C.blueLight}/>
              </div>
            </div>

            <div style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>Views 100% × VTR por Audiência</div>
              <DualChart data={byAudience} xKey="audience" y1Key="video_view_100" y2Key="vtr" label1="Views 100%" label2="VTR %" color1={C.blue} color2={C.blueLight}/>
            </div>

            <CollapsibleTable title="Detalhamento Diário" theme={theme}>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
                <button onClick={() => {
                  const headers = ["Data", "Campanha", "Line", "Criativo", "Tamanho", "Tática", "Imp. Visíveis", "Video Start", "Views 25%", "Views 50%", "Views 75%", "Views 100%", "VTR", "Custo Ef."];
                  const csv = [headers, ...detail.map(r => [r.date, r.campaign_name, r.line_name, r.creative_name, r.creative_size, r.tactic_type, r.viewable_impressions, r.video_starts, r.video_view_25, r.video_view_50, r.video_view_75, r.video_view_100, r.vtr ?? 0, r.effective_total_cost])]
                    .map(r => r.map(v => `"${v ?? ""}`).join(",")).join("\n");
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                  a.download = `video_${vidTab}_${camp.campaign_name}.csv`;
                  a.click();
                }} style={{ background: C.blue, color: C.white, border: "none", padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                  ⬇ Download CSV
                </button>
              </div>
              <PerfTable rows={detail} type="VIDEO"/>
            </CollapsibleTable>

            <TabChat token={token} tabName="Video" author={isAdmin ? "HYPR" : "Cliente"} adminJwt={adminJwt} theme={theme}/>
          </div>
        );
      })()}
    </div>
  );
};

export default VideoTab;
