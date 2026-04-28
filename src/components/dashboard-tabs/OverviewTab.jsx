import { C } from "../../shared/theme";
import { fmt, fmtR } from "../../shared/format";
import KpiCard from "../KpiCard";
import PacingBar from "../PacingBar";
import MediaSummary from "../MediaSummary";
import DualChart from "../DualChart";
import CollapsibleTable from "../CollapsibleTable";
import DetailTable from "../DetailTable";
import TabChat from "../TabChat";

/**
 * Tab "Visão Geral" — KPIs consolidados, pacing por mídia, gráficos diários,
 * tabela detalhada e bloco editável de Alcance & Frequência (admin only).
 *
 * Por que ficar separada
 * ----------------------
 * Antes vivia inline no ClientDashboard ocupando ~117 linhas. Extrair
 * libera espaço pra leitura do roteamento entre tabs e isola o cálculo
 * de pacing display (única tab que tem fórmula própria — Video usa o
 * pacing já calculado pelo backend).
 *
 * Props
 * -----
 * - `data`: payload completo da campanha (precisa de `data.campaign`,
 *   `totals`, `daily`, etc. — passados via aggregates);
 * - `aggregates`: derivados memoizados de `data` (totals, detail, charts);
 * - `theme`: cTheme do ClientDashboard;
 * - `token`, `isAdmin`, `adminJwt`: contexto de auth;
 * - `alcance`, `frequencia`: state controlado do pai (persistido no backend);
 * - `setAlcance`, `setFrequencia`, `editingAfReach`, `setEditingAfReach`,
 *   `savingAf`, `saveAf`: handlers/state do bloco A&F.
 */
const OverviewTab = ({
  data, aggregates, theme,
  token, isAdmin, adminJwt,
  alcance, frequencia,
  setAlcance, setFrequencia,
  editingAfReach, setEditingAfReach,
  savingAf, saveAf,
}) => {
  const camp = data.campaign;
  const {
    totals, detail0, detail,
    chartDisplay, chartVideo,
    display, video,
    totalImpressions, totalCusto, totalCustoOver,
    isFiltered, budgetProRata,
  } = aggregates;

  const cbg2  = theme.bg2;
  const cbg3  = theme.bg3;
  const cbdr  = theme.bdr;
  const ctext = theme.text;
  const cmuted = theme.muted;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* KPI Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 8 }}>
        <KpiCard
          label={isFiltered ? "Budget (período)" : "Budget Total"}
          value={fmtR(isFiltered ? budgetProRata : camp.budget_contracted)}
          theme={theme}
        />
        {display.length > 0 && <KpiCard label="CPM Neg." value={fmtR(camp.cpm_negociado)} theme={theme}/>}
        {video.length   > 0 && <KpiCard label="CPCV Neg." value={fmtR(camp.cpcv_negociado)} theme={theme}/>}
        <KpiCard label="Imp. Visíveis" value={fmt(totalImpressions)} theme={theme}/>
        {video.length > 0 && <KpiCard label="Views 100%" value={fmt(totals.reduce((s,t)=>s+(t.completions||0),0))} theme={theme}/>}
        <KpiCard label="Custo Efetivo" value={fmtR(totalCusto)} color={C.blue} theme={theme}/>
        <KpiCard label="Custo Ef. + Over" value={fmtR(totalCustoOver)} color={C.blue} theme={theme}/>
      </div>

      {/* Pacing — escondido quando há filtro de período (não faz sentido em janela parcial).
          Display calcula no front porque o backend ainda não expõe pacing display agregado.
          Video tem pacing já no totals[0]. */}
      {!isFiltered && display.length > 0 && (
        <PacingBar
          theme={theme}
          label="Pacing Display"
          pacing={(()=>{
            const contracted = (display[0]?.contracted_o2o_display_impressions||0)+(display[0]?.contracted_ooh_display_impressions||0);
            const bonus      = (display[0]?.bonus_o2o_display_impressions||0)+(display[0]?.bonus_ooh_display_impressions||0);
            const totalNeg   = contracted + bonus;
            const delivered  = display.reduce((s,r)=>s+(r.viewable_impressions||0), 0);
            if (!camp.start_date || !camp.end_date || !totalNeg) return 0;
            const [sy,sm,sd] = camp.start_date.split("-").map(Number);
            const [ey,em,ed] = camp.end_date.split("-").map(Number);
            const start = new Date(sy, sm-1, sd);
            const end   = new Date(ey, em-1, ed);
            const now   = new Date();
            if (now > end) return delivered / totalNeg * 100;
            const total   = (end - start) / 864e5 + 1;
            const elapsed = now < start ? 0 : now > end ? total : Math.floor((now - start) / 864e5);
            const expected = totalNeg * (elapsed / total);
            return expected > 0 ? (delivered / expected * 100) : 0;
          })()}
          budget={(display[0]?.o2o_display_budget||0)+(display[0]?.ooh_display_budget||0)}
          cost={display.reduce((s,r)=>s+(r.effective_total_cost||0), 0)}
        />
      )}
      {!isFiltered && video.length > 0 && (
        <PacingBar
          theme={theme}
          label="Pacing Video"
          pacing={video[0]?.pacing || 0}
          budget={(video[0]?.o2o_video_budget||0)+(video[0]?.ooh_video_budget||0)}
          cost={video.reduce((s,r)=>s+(r.effective_total_cost||0), 0)}
        />
      )}

      {/* Display + Video summaries */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 12 }}>
        <MediaSummary rows={totals} type="DISPLAY" theme={theme} detail0={detail0} camp={camp}/>
        <MediaSummary rows={totals} type="VIDEO"   theme={theme} detail0={detail0} camp={camp}/>
      </div>

      {/* Display chart: Imp. Visíveis x CTR */}
      {chartDisplay.length > 0 && (
        <div style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.blue, marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>
            Display — Imp. Visíveis × CTR Diário
          </div>
          <DualChart data={chartDisplay} xKey="date" y1Key="viewable_impressions" y2Key="ctr" label1="Imp. Visíveis" label2="CTR %" color1={C.blue} color2={C.blueLight}/>
        </div>
      )}

      {/* Video chart: Views 100% x VTR */}
      {chartVideo.length > 0 && (
        <div style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.darkMuted, marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>
            Video — Views 100% × VTR Diário
          </div>
          <DualChart data={chartVideo} xKey="date" y1Key="video_view_100" y2Key="vtr" label1="Views 100%" label2="VTR %" color1={C.blue} color2={C.blueLight}/>
        </div>
      )}

      {/* Detail table */}
      <CollapsibleTable title="Tabela Consolidada" theme={theme}>
        <DetailTable detail={detail} campaignName={camp.campaign_name}/>
      </CollapsibleTable>

      {/* Alcance & Frequência — admin pode editar; cliente vê read-only */}
      <div style={{ background: cbg2, border: `1px solid ${cbdr}`, borderRadius: 12, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, textTransform: "uppercase", letterSpacing: 1 }}>
            Alcance & Frequência
          </div>
          {isAdmin && !editingAfReach && (
            <button onClick={() => setEditingAfReach(true)} style={{ background: "none", border: `1px solid ${cbdr}`, color: cmuted, borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
              ✏️ Editar
            </button>
          )}
          {isAdmin && editingAfReach && (
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setEditingAfReach(false)} style={{ background: "none", border: `1px solid ${cbdr}`, color: cmuted, borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>
                Cancelar
              </button>
              <button onClick={saveAf} disabled={savingAf} style={{ background: C.blue, color: "#fff", border: "none", borderRadius: 7, padding: "5px 14px", cursor: "pointer", fontSize: 12, fontWeight: 700, opacity: savingAf ? 0.6 : 1 }}>
                {savingAf ? "Salvando..." : "✓ Salvar"}
              </button>
            </div>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
          <div style={{ background: cbg3, borderRadius: 10, padding: "16px 20px" }}>
            <div style={{ fontSize: 11, color: cmuted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Alcance</div>
            {isAdmin && editingAfReach
              ? <input value={alcance} onChange={e => setAlcance(e.target.value)} placeholder="Ex: 1.250.000" style={{ width: "100%", background: cbg2, border: `1px solid ${C.blue}60`, borderRadius: 7, padding: "8px 12px", color: ctext, fontSize: 16, fontWeight: 800, outline: "none" }}/>
              : <div style={{ fontSize: 22, fontWeight: 800, color: ctext }}>{alcance || "—"}</div>
            }
          </div>
          <div style={{ background: cbg3, borderRadius: 10, padding: "16px 20px" }}>
            <div style={{ fontSize: 11, color: cmuted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Frequência</div>
            {isAdmin && editingAfReach
              ? <input value={frequencia} onChange={e => setFrequencia(e.target.value)} placeholder="Ex: 3.2x" style={{ width: "100%", background: cbg2, border: `1px solid ${C.blue}60`, borderRadius: 7, padding: "8px 12px", color: ctext, fontSize: 16, fontWeight: 800, outline: "none" }}/>
              : <div style={{ fontSize: 22, fontWeight: 800, color: ctext }}>{frequencia || "—"}</div>
            }
          </div>
        </div>
        {!isAdmin && !alcance && !frequencia && (
          <p style={{ fontSize: 12, color: cmuted, marginTop: 12, opacity: 0.7 }}>
            Dados de alcance e frequência serão disponibilizados em breve.
          </p>
        )}
      </div>

      <TabChat token={token} tabName="Visão Geral" author={isAdmin ? "HYPR" : "Cliente"} adminJwt={adminJwt} theme={theme}/>

    </div>
  );
};

export default OverviewTab;
