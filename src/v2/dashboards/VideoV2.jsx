// src/v2/dashboards/VideoV2.jsx
//
// Aba Vídeo — Report 2.0. Mesmo desenho da aba Display:
//   1. Título "Vídeo" com a frente (O2O / OOH / Groundflow) ao lado
//   2. Negociado × Efetivo (CPCV, economia sempre visível) + faixa de contrato
//   3. 6 KPIs: imp. visíveis, views iniciadas, views 100%, VTR, conclusão,
//      viewability
//   4. Pacing da frente com o investido (ou o custo do período, com filtro)
//   5. Tendência diária: views 100% e VTR alinhados
//   6. Retenção do vídeo (início → 25% → 50% → 75% → 100%)
//   7. Explorador de entrega: Audiência · Formato · Linha criativa · Line · Dia

import { useMemo } from "react";
import { useAudienceOverrides } from "../hooks/useAudienceOverrides";
import { useLabelOverrides } from "../hooks/useLabelOverrides";
import {
  computeVideoKpis,
  applyAudienceOverride,
  applyLabelOverride,
  extractAudience,
  getCreativeLineKey,
  groupByDate,
  groupBySize,
  groupByCreativeName,
  groupByAudience,
} from "../../shared/aggregations";
import { groupByLine } from "../../shared/explorer";
import { fmt, fmtP2, fmtR } from "../../shared/format";

import { useReportTrackingContext } from "../contexts/ReportTrackingContext";
import { Card } from "../../ui/Card";
import { AlignedTrendCardV2 } from "../components/AlignedTrendCardV2";
import { ComparisonCardV2 } from "../components/ComparisonCardV2";
import { DeliveryExplorerV2 } from "../components/DeliveryExplorerV2";
import { KpiCardV2 } from "../components/KpiCardV2";
import { PacingBarV2 } from "../components/PacingBarV2";
import { RetentionCurveV2 } from "../components/RetentionCurveV2";
import { SegmentedControlV2 } from "../components/SegmentedControlV2";

const EMPTY_TOTALS = {};

const TACTIC_OPTIONS = [
  { value: "O2O", label: "O2O" },
  { value: "OOH", label: "OOH" },
  { value: "GROUNDFLOW", label: "Groundflow" },
];

// Espelha o CASE do `query_totals` no backend. ORDEM IMPORTA: Groundflow
// (token RMNF ou GROUNDFLOW) vence O2O — lines vêm como `..._O2O_GROUNDFLOW_...`.
// Delimitador pode ser `_` ou `-` (naming mistura os dois).
// `gfOn` = a campanha tem contrato de groundflow (dark test sem contrato →
// conta como O2O/OOH; espelha o _GF_CONTRACT_GATE do backend).
const GROUNDFLOW_RE = /(?:^|[_-])(?:RMNF|GROUNDFLOW)(?:[_-]|$)/i;
const O2O_RE = /(?:^|[_-])O2O(?:[_-]|$)/i;
const OOH_RE = /(?:^|[_-])OOH(?:[_-]|$)/i;
const deriveTactic = (lineName, gfOn) => {
  const ln = lineName || "";
  if (gfOn && GROUNDFLOW_RE.test(ln)) return "GROUNDFLOW";
  if (O2O_RE.test(ln)) return "O2O";
  if (OOH_RE.test(ln)) return "OOH";
  return "O2O";
};

// Formatter pra CPCV (3 casas decimais — valores tipicamente < R$ 0,50).
const fmtCpcv = (v) =>
  typeof v === "number" && v > 0
    ? `R$ ${v.toFixed(3).replace(".", ",")}`
    : "—";

export default function VideoV2({
  data,
  aggregates,
  tactic,
  setTactic,
  isAdmin = false,
}) {
  const camp = data.campaign;
  const { trackCta } = useReportTrackingContext();

  // Override de nome de audiência (Report Center, por anunciante) — igual ao
  // DisplayV2. Aplicado na quebra "Por Audiência"; editável inline só admin.
  const aud = useAudienceOverrides({
    initialMap: data.audience_overrides,
    clientName: camp.client_name,
    shortToken: camp.short_token,
    isAdmin,
  });

  // Override de NOME de formato e linha criativa — igual ao DisplayV2.
  const fmtOv = useLabelOverrides({
    dimension: "format",
    initialMap: data.label_overrides?.format,
    clientName: camp.client_name,
    shortToken: camp.short_token,
    isAdmin,
  });
  const clOv = useLabelOverrides({
    dimension: "creative_line",
    initialMap: data.label_overrides?.creative_line,
    clientName: camp.client_name,
    shortToken: camp.short_token,
    isAdmin,
  });

  // Tactics disponíveis: ver comentário equivalente em DisplayV2.
  // Objeto vazio de módulo (não `{}` literal): report sem totals criava um
  // objeto novo por render e invalidava o useMemo da `view` abaixo, que
  // refazia todos os groupBy a cada render.
  const t0Video = (data.totals || [])[0] || EMPTY_TOTALS;
  const hasDelivery = (tac) => aggregates.totals.some(
    (r) => r.media_type === "VIDEO" && r.tactic_type === tac,
  );
  const hasContract = (frente) =>
    (t0Video[`contracted_${frente}_video_completions`] || 0) > 0 ||
    (t0Video[`bonus_${frente}_video_completions`] || 0) > 0;
  // Gate do Groundflow (espelha backend): sem contrato, line é dark test → O2O.
  const hasGfContract = hasContract("groundflow");
  // Override de core products (curadoria admin): esconde frentes fora do set
  // mesmo com entrega. Backend já zerou o contrato delas; isto gateia a entrega.
  const activeCP = camp.active_core_products;
  const isActiveCP = (frente) => !activeCP || activeCP.includes(frente);
  const showByTactic = {
    O2O:        isActiveCP("O2O")        && (hasContract("o2o")        || hasDelivery("O2O")),
    OOH:        isActiveCP("OOH")        && (hasContract("ooh")        || hasDelivery("OOH")),
    GROUNDFLOW: isActiveCP("GROUNDFLOW") && hasGfContract,  // contract-only (≠ O2O/OOH): dark test não vira frente
  };
  const availableTactics = TACTIC_OPTIONS.filter((opt) => showByTactic[opt.value]);
  const effectiveTactic =
    availableTactics.find((t) => t.value === tactic)?.value
    || availableTactics[0]?.value
    || tactic;

  // Filtros multi-select (audience/line/creative/size/formato) ficam no
  // GlobalDataFilterBarV2 do dashboard pai — já aplicados upstream em
  // computeAggregates. Aqui só fatiamos por mídia e tactic.
  const view = useMemo(() => {
    const totals = aggregates.totals.filter(
      (r) => r.media_type === "VIDEO" && r.tactic_type === effectiveTactic,
    );
    const detailAll = aggregates.detail.filter(
      (r) => r.media_type === "VIDEO" && deriveTactic(r.line_name, hasGfContract) === effectiveTactic,
    );

    const kpis = computeVideoKpis({
      rows: totals,
      detail: detailAll,
      tactic: effectiveTactic,
      checklist: t0Video,
    });

    // Normaliza creative_size pra Video: backend retorna "0x0" quando o
    // DSP não preenche dimensões em criativos de video, mas operacionalmente
    // é o mesmo formato 16:9 standard. Unifica antes do groupBySize pra
    // evitar 2 linhas separadas pra mesma coisa na Distribuição por Tamanho.
    const detailNormalized = detailAll.map((r) =>
      r.creative_size === "0x0" ? { ...r, creative_size: "16x9" } : r,
    );

    const daily = groupByDate(detailAll, "video_view_100", "viewable_impressions", "vtr");
    const bySize = groupBySize(detailNormalized, "video_view_100", "viewable_impressions", "vtr", fmtOv.overrideMap);
    const byCreative = groupByCreativeName(detailAll, "video_view_100", "viewable_impressions", "vtr", clOv.overrideMap);
    const byAudience = groupByAudience(detailAll, "video_view_100", "viewable_impressions", "vtr", aud.overrideMap);

    return { totals, detailAll, detailNormalized, kpis, daily, bySize, byCreative, byAudience };
  }, [aggregates, effectiveTactic, t0Video, hasGfContract, aud.overrideMap, fmtOv.overrideMap, clOv.overrideMap]);

  const { totals, detailAll, detailNormalized, kpis, daily, bySize, byCreative, byAudience } = view;
  // Alias mantido pelos consumers internos (`detailFiltered`). Pós-refactor
  // filtered === all dentro do VideoV2 (filtro real é upstream em
  // computeAggregates).
  const detailFiltered = detailAll;

  // Empty state vs notStarted (mesma lógica do DisplayV2):
  //  - notStarted: há contrato sem delivery — mostra contratual + disclaimer
  //  - isEmpty: zero contrato E zero delivery (defensivo)
  const isEmpty = totals.length === 0 && view.detailAll.length === 0 && !kpis.notStarted;

  // Views contratadas e bonus — fallback pro checklist (t0Video) quando
  // a tactic ainda não entregou (caso "notStarted").
  const row0 = totals[0] || t0Video || {};
  const _frente = (effectiveTactic || "O2O").toLowerCase();
  const contractedViews = row0[`contracted_${_frente}_video_completions`] || 0;
  const bonusViews       = row0[`bonus_${_frente}_video_completions`]      || 0;

  // CPCV "com bonus": equivalente ao cpmNegBonus do Display. Mesmo budget
  // dividido pela entrega total prometida (contracted + bonus completions).
  // Reflete o que o cliente paga POR view 100% entregue de fato (incluindo
  // bonus). Só calcula quando bonus > 0 — sem bonus, manter o cpcv contratual
  // já cobre.
  const cpcvNegBonus = bonusViews > 0 && contractedViews > 0 && kpis.cpcvNeg > 0
    ? (kpis.cpcvNeg * contractedViews) / (contractedViews + bonusViews)
    : null;

  // CPCV Efetivo PROJETADO — ver doc equivalente em DisplayV2 (cpmEfProjected).
  // Aqui a unidade é views 100% (completions) em vez de impressões visíveis.
  const cpcvEfProjected = (() => {
    if (!bonusViews || bonusViews <= 0) return null;
    if (!contractedViews || !kpis.cpcvNeg || !(kpis.pac > 0)) return null;
    const totalPromise = contractedViews + bonusViews;
    const budget = kpis.cpcvNeg * contractedViews;
    const pacingRatio = Math.min(kpis.pac / 100, 1);
    const projectedViews = pacingRatio * totalPromise;
    if (projectedViews <= 0) return null;
    const projectedCost = projectedViews > contractedViews
      ? budget
      : kpis.cpcvNeg * projectedViews;
    return projectedCost / projectedViews;
  })();
  // A projeção só vale enquanto a entrega factual ainda NÃO realizou a
  // economia. Assim que a entrega real (completions) ultrapassa
  // contratadas+bonus, o cpcvEf factual (= budget / completions) já caiu
  // ABAIXO da projeção — que fica travada em budget/(contratadas+bonus)
  // pelo cap de pacing em 100%. Nesse ponto o factual É a verdade
  // entregue, não estimativa, então mostramos ele. Ex.: pacing 401,3% →
  // factual R$0,05 vence a projeção capada em R$0,200.
  const useProjection =
    cpcvEfProjected !== null &&
    !(kpis.cpcvEf != null && kpis.cpcvEf < cpcvEfProjected);
  // A economia (célula do ComparisonCard) sai da mesma fonte do efetivo
  // exibido: (tabela − efetivo projetado) / tabela, igual à Rentabilidade.
  const cpcvEfDisplay = useProjection ? cpcvEfProjected : kpis.cpcvEf;

  return (
    <div className="space-y-6">
      {/* ─── 1. Título com a frente ──────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold text-fg leading-tight">Vídeo</h2>
        {availableTactics.length > 1 ? (
          <SegmentedControlV2
            label="Frente Vídeo"
            options={availableTactics}
            value={effectiveTactic}
            onChange={(t) => {
              trackCta("tactic_change_video");
              setTactic(t);
            }}
          />
        ) : (
          <span className="inline-flex items-center rounded-full border border-border px-2.5 py-0.5 text-[11px] font-semibold text-fg-muted">
            {availableTactics[0]?.label || effectiveTactic}
          </span>
        )}
      </div>

      {isEmpty ? (
        <div className="rounded-xl border border-border bg-surface p-8 text-center">
          <p className="text-sm text-fg-muted">
            Não há entrega Video {effectiveTactic} nesta campanha.
          </p>
        </div>
      ) : (
        <VideoContent
          camp={camp}
          tactic={effectiveTactic}
          aggregates={aggregates}
          detailAll={detailAll}
          detailFiltered={detailFiltered}
          detailNormalized={detailNormalized}
          kpis={kpis}
          daily={daily}
          bySize={bySize}
          byCreative={byCreative}
          byAudience={byAudience}
          contractedViews={contractedViews}
          bonusViews={bonusViews}
          cpcvNegBonus={cpcvNegBonus}
          cpcvEfDisplay={cpcvEfDisplay}
          useProjection={useProjection}
          notStarted={kpis.notStarted}
          isAdmin={isAdmin}
          aud={aud}
          fmtOv={fmtOv}
          clOv={clOv}
        />
      )}
    </div>
  );
}

// Conteúdo "pesado" do Video — extraído pra fora pra simplificar o
// fluxo de empty state e não duplicar o JSX do título.
function VideoContent({
  camp,
  tactic,
  aggregates,
  detailAll,
  detailFiltered,
  detailNormalized,
  kpis,
  daily,
  bySize,
  byCreative,
  byAudience,
  contractedViews,
  bonusViews,
  cpcvNegBonus,
  cpcvEfDisplay,
  useProjection,
  notStarted,
  isAdmin = false,
  aud,
  fmtOv,
  clOv,
}) {
  const campName = camp.campaign_name || "campanha";
  const isFiltered = aggregates.isFiltered;
  // Somas do detail do recorte (evita referenciar `totals`/`view` dentro de
  // props JSX — ver a nota do esbuild em computeVideoKpis).
  const imprSum = detailFiltered.reduce((s, r) => s + (r.impressions || 0), 0);
  const viewability = imprSum > 0 ? (kpis.vi / imprSum) * 100 : null;
  const completionRate = kpis.starts > 0 ? (kpis.views100 / kpis.starts) * 100 : null;
  const byLine = groupByLine(detailFiltered, "video_view_100", "viewable_impressions", "vtr");
  const contract = [
    { label: "Budget", value: fmtR(kpis.budget), hint: "Budget alocado à frente selecionada." },
    { label: "Views contratadas", value: fmt(contractedViews) },
    bonusViews > 0 ? { label: "Bônus", value: `${fmt(bonusViews)} views`, hint: "Bônus negociado além do contratado." } : null,
    bonusViews > 0 ? { label: "Total c/ bônus", value: `${fmt(contractedViews + bonusViews)} views`, hint: "Views contratadas + bonificadas." } : null,
    { label: "CPCV negociado", value: fmtCpcv(kpis.cpcvNeg) },
  ].filter(Boolean);

  const dims = [
    {
      key: "audience",
      label: "Audiência",
      rows: byAudience,
      groupKey: "audience",
      itemNoun: "audiência",
      extraRows: detailAll,
      getDetailGroupKey: (r) => applyAudienceOverride(extractAudience(r.line_name), aud?.overrideMap),
      rename: aud ? {
        busy: aud.busyAudience,
        isOverridden: (row) => aud.isOverridden?.(row._rawLabels),
        rename: (row, name, scope) => aud.renameAudience(row._rawLabels, name, row.audience, scope),
        reset: (row) => aud.resetAudience(row._rawLabels, row.audience),
      } : null,
    },
    {
      key: "size",
      label: "Formato",
      rows: bySize,
      groupKey: "size",
      itemNoun: "formato",
      extraRows: detailNormalized,
      getDetailGroupKey: (r) => applyLabelOverride(r.creative_size || "N/A", fmtOv?.overrideMap),
      rename: fmtOv ? {
        busy: fmtOv.busyLabel,
        isOverridden: (row) => fmtOv.isOverridden?.(row._rawLabels),
        rename: (row, name, scope) => fmtOv.renameLabel(row._rawLabels, name, row.size, scope),
        reset: (row) => fmtOv.resetLabel(row._rawLabels, row.size),
      } : null,
    },
    {
      key: "creative",
      label: "Linha criativa",
      rows: byCreative,
      groupKey: "creative_name",
      itemNoun: "linha criativa",
      itemNounPlural: "linhas criativas",
      extraRows: detailFiltered,
      getDetailGroupKey: (r) => applyLabelOverride(getCreativeLineKey(r), clOv?.overrideMap),
      rename: clOv ? {
        busy: clOv.busyLabel,
        isOverridden: (row) => clOv.isOverridden?.(row._rawLabels),
        rename: (row, name, scope) => clOv.renameLabel(row._rawLabels, name, row.creative_name, scope),
        reset: (row) => clOv.resetLabel(row._rawLabels, row.creative_name),
      } : null,
    },
    {
      key: "line",
      label: "Line",
      rows: byLine,
      groupKey: "line_name",
      itemNoun: "line",
      extraRows: detailFiltered,
      getDetailGroupKey: (r) => r.line_name || "N/A",
      rename: null,
    },
    { key: "day", label: "Dia" },
  ];

  return (
    <>
      {notStarted && (
        <div className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 flex items-start gap-3">
          <span className="size-2 rounded-full bg-warning mt-1.5 shrink-0" aria-hidden />
          <div className="text-sm">
            <div className="font-medium text-fg">Entrega {tactic} ainda não iniciada</div>
            <div className="text-fg-muted mt-0.5">
              Exibindo apenas os valores negociados. Verifique pendências com o cliente.
            </div>
          </div>
        </div>
      )}

      {/* ─── 2. Negociado × Efetivo + contrato ───────────────────────── */}
      <ComparisonCardV2
        title={`CPCV Vídeo · ${tactic}`}
        negociado={kpis.cpcvNeg}
        efetivo={cpcvEfDisplay}
        negociadoComBonus={cpcvNegBonus}
        efetivoIsProjection={useProjection}
        formatValue={(v) => `R$ ${(v || 0).toFixed(3).replace(".", ",")}`}
        unit="CPCV"
        contract={contract}
      />

      {/* ─── 3. KPIs ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCardV2 label="Imp. visíveis" value={fmt(kpis.vi)} hint="Impressões visíveis de vídeo no período." />
        <KpiCardV2 label="Views iniciadas" value={fmt(kpis.starts)} hint="Impressões em que o vídeo começou a tocar." />
        <KpiCardV2 label="Views 100%" value={fmt(kpis.views100)} hint="Vídeos vistos até o fim." />
        <KpiCardV2 label="VTR" value={fmtP2(kpis.vtr)} accent hint="Views 100% ÷ imp. visíveis." />
        <KpiCardV2
          label="Conclusão"
          value={completionRate == null ? "—" : `${fmt(completionRate, 1)}%`}
          hint="Views 100% ÷ views iniciadas: de quem deu play, quantos viram até o fim."
        />
        <KpiCardV2
          label="Viewability"
          value={viewability == null ? "—" : `${fmt(viewability, 1)}%`}
          hint="Imp. visíveis ÷ impressões medidas."
        />
      </div>

      {/* ─── 4. Pacing (ou custo do período) ─────────────────────────── */}
      {!isFiltered ? (
        <PacingBarV2
          label={`Pacing Vídeo ${tactic}`}
          pacing={kpis.pac}
          budget={kpis.budget}
          cost={kpis.cost}
          contracted={contractedViews}
          bonus={bonusViews}
          // kpis.completions (soma sobre totals): referência segura — o
          // esbuild miscompilava `totals`/`view` dentro deste prop quando
          // VideoV2/DisplayV2 caíam no mesmo chunk ("X is not defined").
          delivered={kpis.completions}
          showCost
        />
      ) : (
        <Card className="px-5 py-4 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">Custo efetivo no período</span>
          <span className="text-lg font-bold text-fg tabular-nums">{fmtR(kpis.cost)}</span>
          <span className="w-full text-[11px] text-fg-subtle">O pacing fica oculto com filtro de período: ele mede a campanha inteira.</span>
        </Card>
      )}

      {/* ─── 5. Tendência diária ─────────────────────────────────────── */}
      {daily.length > 0 && (
        <AlignedTrendCardV2
          data={daily}
          volumeKey="video_view_100"
          volumeLabel="Views 100%"
          rateKey="vtr"
          rateLabel="VTR"
          rateDecimals={1}
          subtitle="Views 100% e VTR alinhados, cada um na sua escala"
          downloadable={isAdmin}
          filename={`${campName} - Video ${tactic} - Tendencia diaria`}
        />
      )}

      {/* ─── 6. Retenção ─────────────────────────────────────────────── */}
      <RetentionCurveV2
        detail={detailFiltered}
        downloadable={isAdmin}
        filename={`${campName} - Video ${tactic} - Retencao`}
      />

      {/* ─── 7. Explorador de entrega ────────────────────────────────── */}
      {detailFiltered.length > 0 && (
        <DeliveryExplorerV2
          dims={dims}
          mediaType="VIDEO"
          numeratorKey="video_view_100"
          numeratorLabel="Views 100%"
          rateKey="vtr"
          rateLabel="VTR"
          rateFormatter={fmtP2}
          dailyDetail={detailFiltered}
          campaignName={campName}
          tactic={tactic}
          isAdmin={isAdmin}
        />
      )}
    </>
  );
}
