// src/v2/dashboards/OverviewV2.jsx
//
// Visão Geral V2.
//
// LAYOUT, NA ORDEM
//   1. KpiCardV2 grid — 7 indicadores principais
//   2. PacingBarV2 (Display + Video) — escondido com filtro ativo
//   3. MediaSummaryV2 — Negociado vs Efetivo destacado (diferencial do ADR)
//   4. DualChartV2 — séries diárias Display (Imp.Visíveis × CTR) e Video
//      (Views 100% × VTR)
//   5. CollapsibleSectionV2 + DataTableV2 — tabela detalhada com filtro
//      de mídia e download CSV
//   6. AlcanceFrequenciaV2 — bloco editável admin
//
// HISTÓRICO
//   PRs 06–09 (Fase 2) introduziram este dashboard como filho único do
//   ClientDashboardV2. Na PR-10 (commit 3) o shell ganhou Tabs Radix e
//   passou a hospedar mais de uma tab — wrapper visual (canvas, max-w),
//   CampaignHeader, filtro de período e o useMemo de aggregates SUBIRAM
//   pro shell. Este componente passou a receber `aggregates` por prop.
//
// CONTRATO COM ClientDashboardV2
//   Recebe `data`, `aggregates` (já calculado para mainRange atual),
//   token, isAdmin, adminJwt. Não faz fetch nem gerencia período —
//   tudo isso é responsabilidade do shell.

import { fmt, fmtR } from "../../shared/format";

import { KpiCardV2 } from "../components/KpiCardV2";
import { PacingBarV2 } from "../components/PacingBarV2";
import { MediaSummaryV2 } from "../components/MediaSummaryV2";
import { DualChartV2 } from "../components/DualChartV2";
import { CollapsibleSectionV2 } from "../components/CollapsibleSectionV2";
import { DataTableV2 } from "../components/DataTableV2";
import { AlcanceFrequenciaV2 } from "../components/AlcanceFrequenciaV2";

export default function OverviewV2({ data, aggregates, token, isAdmin, adminJwt }) {
  const camp = data.campaign;
  const {
    totalImpressions, totalCusto, totalCustoOver,
    display, video, totals,
    isFiltered, budgetProRata, budgetTotal,
    chartDisplay, chartVideo, detail,
  } = aggregates;

  const hasDisplay = display.length > 0;
  const hasVideo = video.length > 0;
  const totalViews100 = totals.reduce((s, t) => s + (t.completions || 0), 0);

  return (
    <div className="space-y-6">
      {/* KPI grid */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
          Indicadores
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <KpiCardV2
            label={isFiltered ? "Budget (período)" : "Budget Total"}
            value={fmtR(isFiltered ? budgetProRata : budgetTotal)}
            hint={
              isFiltered
                ? "Budget contratado proporcionalizado pelo período do filtro (linear, dias/dias-totais)."
                : "Budget contratado total da campanha."
            }
          />

          {hasDisplay && (
            <KpiCardV2
              label="CPM Negociado"
              value={fmtR(camp.cpm_negociado)}
              hint="CPM acordado em contrato — aplicado às mídias Display."
            />
          )}

          {hasVideo && (
            <KpiCardV2
              label="CPCV Negociado"
              value={fmtR(camp.cpcv_negociado)}
              hint="Custo por completion negociado — aplicado às mídias Video."
            />
          )}

          <KpiCardV2
            label="Imp. Visíveis"
            value={fmt(totalImpressions)}
            hint="Soma de viewable impressions no período selecionado."
          />

          {hasVideo && (
            <KpiCardV2
              label="Views 100%"
              value={fmt(totalViews100)}
              hint="Completions de vídeo (visualizações até 100%)."
            />
          )}

          <KpiCardV2
            label="Custo Efetivo"
            value={fmtR(totalCusto)}
            accent
            hint="Custo real entregue no período — derivado do delivery × CPM/CPCV efetivo."
          />

          <KpiCardV2
            label="Custo Efetivo + Over"
            value={fmtR(totalCustoOver)}
            accent
            hint="Inclui valor da over-delivery (entrega acima do contratado)."
          />
        </div>
      </section>

      {/* Pacing — escondido quando há filtro de período (não faz sentido
          em janela parcial). Display calcula no front (backend não expõe
          pacing display agregado). Video tem pacing já no row[0] do backend. */}
      {!isFiltered && (hasDisplay || hasVideo) && (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {hasDisplay && (
            <PacingBarV2
              label="Pacing Display"
              pacing={computeDisplayPacing(display, camp)}
              budget={display.reduce(
                (s, r) => s + (r.o2o_display_budget || 0) + (r.ooh_display_budget || 0),
                0,
              )}
              cost={display.reduce((s, r) => s + (r.effective_total_cost || 0), 0)}
            />
          )}
          {hasVideo && (
            <PacingBarV2
              label="Pacing Video"
              pacing={video[0]?.pacing || 0}
              budget={video.reduce(
                (s, r) => s + (r.o2o_video_budget || 0) + (r.ooh_video_budget || 0),
                0,
              )}
              cost={video.reduce((s, r) => s + (r.effective_total_cost || 0), 0)}
            />
          )}
        </section>
      )}

      {/* Resumo por mídia: Negociado vs Efetivo (diferencial citado no ADR) */}
      {(hasDisplay || hasVideo) && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
            Resumo por mídia
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {hasDisplay && <MediaSummaryV2 type="DISPLAY" rows={display} />}
            {hasVideo && <MediaSummaryV2 type="VIDEO" rows={video} />}
          </div>
        </section>
      )}

      {/* Charts diários — só se tiver dados */}
      {(chartDisplay.length > 0 || chartVideo.length > 0) && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle mb-3">
            Performance diária
          </h2>
          <div className="space-y-3">
            {chartDisplay.length > 0 && (
              <div className="rounded-xl border border-border bg-surface p-5">
                <div className="text-[11px] font-bold uppercase tracking-widest text-signature mb-3">
                  Display — Imp. Visíveis × CTR
                </div>
                <DualChartV2
                  data={chartDisplay}
                  xKey="date"
                  y1Key="viewable_impressions"
                  y2Key="ctr"
                  label1="Imp. Visíveis"
                  label2="CTR %"
                />
              </div>
            )}
            {chartVideo.length > 0 && (
              <div className="rounded-xl border border-border bg-surface p-5">
                <div className="text-[11px] font-bold uppercase tracking-widest text-signature mb-3">
                  Video — Views 100% × VTR
                </div>
                <DualChartV2
                  data={chartVideo}
                  xKey="date"
                  y1Key="video_view_100"
                  y2Key="vtr"
                  label1="Views 100%"
                  label2="VTR %"
                />
              </div>
            )}
          </div>
        </section>
      )}

      {/* Tabela detalhada (colapsável) */}
      {detail.length > 0 && (
        <section>
          <CollapsibleSectionV2 title="Tabela Consolidada">
            <DataTableV2 detail={detail} campaignName={camp.campaign_name} />
          </CollapsibleSectionV2>
        </section>
      )}

      {/* Alcance & Frequência */}
      <section>
        <AlcanceFrequenciaV2
          token={token}
          isAdmin={isAdmin}
          adminJwt={adminJwt}
          initialAlcance={data.alcance}
          initialFrequencia={data.frequencia}
        />
      </section>
    </div>
  );
}

// ─── Helpers locais ──────────────────────────────────────────────────────
//
// Pacing Display calculado no front (backend só calcula Video). Lógica
// idêntica à inline do Legacy em components/dashboard-tabs/OverviewTab.jsx
// — replicada aqui pra não obrigar refactor do Legacy nessa PR.
//
// Quando o Legacy for removido (pós-Fase 7), essa função pode ser
// movida pra shared/aggregations.js ou ficar como é.
function computeDisplayPacing(displayRows, camp) {
  if (!displayRows.length || !camp.start_date || !camp.end_date) return 0;

  const contracted = displayRows.reduce(
    (s, r) =>
      s +
      (r.contracted_o2o_display_impressions || 0) +
      (r.contracted_ooh_display_impressions || 0),
    0,
  );
  const bonus = displayRows.reduce(
    (s, r) =>
      s +
      (r.bonus_o2o_display_impressions || 0) +
      (r.bonus_ooh_display_impressions || 0),
    0,
  );
  const totalNeg = contracted + bonus;
  if (!totalNeg) return 0;

  const delivered = displayRows.reduce(
    (s, r) => s + (r.viewable_impressions || 0),
    0,
  );

  const [sy, sm, sd] = camp.start_date.split("-").map(Number);
  const [ey, em, ed] = camp.end_date.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const now = new Date();

  if (now > end) return (delivered / totalNeg) * 100;

  const total = (end - start) / 864e5 + 1;
  const elapsed = now < start ? 0 : Math.floor((now - start) / 864e5);
  const expected = totalNeg * (elapsed / total);
  return expected > 0 ? (delivered / expected) * 100 : 0;
}
