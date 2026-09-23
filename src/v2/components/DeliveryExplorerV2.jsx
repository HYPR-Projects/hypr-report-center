// src/v2/components/DeliveryExplorerV2.jsx
//
// Explorador de entrega das abas Display e Vídeo: uma dimensão por vez, no
// lugar das quatro tabelas empilhadas (tamanho, linha criativa, audiência,
// dia) e do gráfico de eixo duplo por audiência.
//
//   Dimensões: Audiência · Tamanho (Formato no Vídeo) · Linha criativa ·
//              Line · Dia
//   Visões:    Tabela (share, volume, taxa, viewability/CTR, custo; ordena
//              por coluna, CSV, PNG admin, renomear admin) · Gráfico (volume
//              e taxa lado a lado, cada um na sua escala)
//
// Dimensão com um valor só no recorte fica desligada (nada a comparar). O
// Dia usa a tabela diária completa (mesmas colunas e CSV de antes).

import { useRef, useState } from "react";
import { cn } from "../../ui/cn";
import { Card } from "../../ui/Card";
import { ChipGroupV2 } from "./ChipGroupV2";
import { SegmentedControlV2 } from "./SegmentedControlV2";
import { FormatBreakdownTableV2 } from "./FormatBreakdownTableV2";
import { DailyAggregateTableV2 } from "./DailyAggregateTableV2";
import { PairedBarsV2 } from "./PairedBarsV2";
import { DownloadPngButtonV2 } from "./DownloadPngButtonV2";

const VIEWS = [
  { value: "table", label: "Tabela" },
  { value: "chart", label: "Gráfico" },
];

/**
 * dims: [{ key, label, rows, groupKey, itemNoun, itemNounPlural, getDetailGroupKey,
 *          extraRows, editable, rename: { busy, isOverridden, rename, reset } }]
 *       (a dimensão "day" é tratada à parte: não precisa de rows)
 */
export function DeliveryExplorerV2({
  dims,
  mediaType,
  numeratorKey,
  numeratorLabel,
  rateKey,
  rateLabel,
  rateFormatter,
  dailyDetail,
  campaignName,
  tactic,
  isAdmin = false,
}) {
  const cardRef = useRef(null);
  const enabledOf = (d) => d.key === "day" ? (dailyDetail?.length || 0) > 0 : (d.rows?.length || 0) > 1;
  const firstEnabled = dims.find(enabledOf)?.key || dims[0]?.key;
  const [dimKey, setDimKey] = useState(firstEnabled);
  const [viewMode, setViewMode] = useState("table");
  const current = dims.find((d) => d.key === dimKey && enabledOf(d)) || dims.find((d) => d.key === firstEnabled);
  if (!current) return null;
  const isDay = current.key === "day";
  const media = mediaType === "VIDEO" ? "video" : "display";
  const fileBase = `${campaignName} - ${mediaType === "VIDEO" ? "Video" : "Display"} ${tactic} - Por ${current.label}`;

  return (
    <Card ref={cardRef} className="overflow-hidden">
      <div className="px-4 md:px-5 pt-4 pb-3 border-b border-border space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">Explorador de entrega</h3>
          <div className="flex items-center gap-2">
            {!isDay && (
              <SegmentedControlV2 label="Visão do explorador" options={VIEWS} value={viewMode} onChange={setViewMode} />
            )}
            {isAdmin && viewMode === "chart" && !isDay && (
              <DownloadPngButtonV2 targetRef={cardRef} filename={`${fileBase} - grafico`} exportMaxWidth={900} />
            )}
          </div>
        </div>
        <ChipGroupV2
          label="Dimensão"
          value={current.key}
          onChange={setDimKey}
          options={dims.map((d) => ({
            value: d.key,
            label: d.label,
            count: d.key === "day" ? null : d.rows?.length || 0,
            disabled: !enabledOf(d),
            title: enabledOf(d) ? undefined : "Só um valor neste recorte, nada a comparar",
          }))}
        />
      </div>

      {isDay ? (
        <DailyAggregateTableV2
          bare
          daily={dailyDetail}
          campaignName={`${campaignName}_${media}_${tactic}`}
          lockedMedia={mediaType}
          downloadable={isAdmin}
          initialRows={10}
        />
      ) : viewMode === "chart" ? (
        <PairedBarsV2
          rows={current.rows}
          groupKey={current.groupKey}
          volumeKey="viewable_impressions"
          volumeLabel="Imp. visíveis"
          rateKey={rateKey}
          rateLabel={rateLabel}
          rateDecimals={rateKey === "vtr" ? 1 : 2}
        />
      ) : (
        <FormatBreakdownTableV2
          key={current.key}
          bare
          rows={current.rows}
          groupKey={current.groupKey}
          groupLabel={current.label}
          itemNoun={current.itemNoun}
          itemNounPlural={current.itemNounPlural}
          denomKey="viewable_impressions"
          denomLabel="Imp. visíveis"
          numeratorKey={numeratorKey}
          numeratorLabel={numeratorLabel}
          rateKey={rateKey}
          rateLabel={rateLabel}
          rateFormatter={rateFormatter}
          extraRows={current.extraRows}
          getDetailGroupKey={current.getDetailGroupKey}
          mediaType={mediaType}
          downloadable={isAdmin}
          filename={fileBase}
          editable={isAdmin && !!current.rename}
          busyAudience={current.rename?.busy}
          isRowOverridden={current.rename?.isOverridden}
          onRenameGroup={current.rename?.rename}
          onResetGroup={current.rename?.reset}
          className={cn("border-0")}
        />
      )}
    </Card>
  );
}
