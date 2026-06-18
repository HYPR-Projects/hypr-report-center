// src/v2/components/GlobalDataFilterBarV2.jsx
//
// Barra unificada de filtros que vive abaixo da tab bar do ClientDashboardV2
// e fica VISÍVEL nas abas que consomem dados de detail/daily/totals da
// campanha — Visão Geral, Display e Video. Escondida em Base de Dados (que
// tem seus próprios filtros internos no DataTableV2) e nas tabs auxiliares
// RMND/PDOOH/Loom/Survey (data sources diferentes, não compartilham este
// pipeline).
//
// Filtros (todos opcionais, combinam como AND, empty = "todos"):
//   1. Audiência     → extractAudience(line_name)  — penúltimo segmento
//   2. Line          → line_name completo
//   3. Linha Criativa→ getCreativeLineKey(row)     — creative_name - size
//   4. Tamanho       → creative_size               — "300x250", "970x250"
//   5. Formato       → media_type                  — DISPLAY/VIDEO
//      Renderizado SÓ quando a campanha tem ambos (showBothFormats=true).
//      Campanha mono-mídia: filtro de formato é ruído visual sem ganho.
//
// State e options vivem no ClientDashboardV2 (lifted). Aqui é apenas
// apresentação — recebe tudo via props.

import { TableMultiSelectFilter } from "./TableMultiSelectFilter";
import { applyAudienceOverride } from "../../shared/aggregations";

export function GlobalDataFilterBarV2({
  // Options
  audienceOptions,
  lineOptions,
  creativeLineOptions,
  sizeOptions,
  formatOptions,
  // Override de nome de audiência (Report Center) — relabela SÓ o texto
  // exibido no filtro; o valor (rótulo cru) e o predicado (extractAudience)
  // ficam intactos, então a filtragem não muda. Mantém o filtro coerente
  // com a tabela "Por Audiência", que mostra os nomes corrigidos.
  audienceOverrideMap = null,
  // State + setters
  audiences,
  setAudiences,
  lineNames,
  setLineNames,
  creativeLines,
  setCreativeLines,
  sizes,
  setSizes,
  formats,
  setFormats,
  // Visibilidade do filtro Formato — true só quando campanha tem
  // Display E Video. Mono-mídia esconde.
  showFormatFilter = false,
}) {
  // Se NENHUMA option tem entrada, a barra inteira fica vazia — não
  // renderiza. Acontece em campanhas que ainda não começaram a entregar
  // (sem detail) — filtros não fariam sentido.
  const totalOptions =
    audienceOptions.length + lineOptions.length + sizeOptions.length;
  if (totalOptions === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap pt-3 pb-1">
      {audienceOptions.length > 0 && (
        <TableMultiSelectFilter
          label="Audiência"
          pluralLabel="audiências"
          options={audienceOptions}
          selected={audiences}
          onChange={setAudiences}
          formatLabel={
            audienceOverrideMap
              ? (a) => applyAudienceOverride(a, audienceOverrideMap)
              : undefined
          }
          icon={
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          }
        />
      )}
      {lineOptions.length > 0 && (
        <TableMultiSelectFilter
          label="Line"
          pluralLabel="lines"
          options={lineOptions}
          selected={lineNames}
          onChange={setLineNames}
          popoverWidth={420}
          triggerMaxWidth={360}
          wrapItems={true}
          searchable={true}
          formatLabel={(ln) => {
            const parts = ln.split("_");
            return parts.length > 4 ? "…_" + parts.slice(-4).join("_") : ln;
          }}
          icon={
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2 4h12M2 8h12M2 12h8" />
            </svg>
          }
        />
      )}
      {creativeLineOptions.length > 0 && (
        <TableMultiSelectFilter
          label="Linha Criativa"
          pluralLabel="linhas criativas"
          options={creativeLineOptions}
          selected={creativeLines}
          onChange={setCreativeLines}
          popoverWidth={340}
          triggerMaxWidth={300}
          searchable={creativeLineOptions.length > 10}
          icon={
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2" y="2" width="5" height="5" rx="0.5" />
              <rect x="9" y="2" width="5" height="5" rx="0.5" />
              <rect x="2" y="9" width="12" height="5" rx="0.5" />
            </svg>
          }
        />
      )}
      {sizeOptions.length > 0 && (
        <TableMultiSelectFilter
          label="Tamanho"
          pluralLabel="tamanhos"
          options={sizeOptions}
          selected={sizes}
          onChange={setSizes}
          icon={
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2" y="3" width="12" height="10" rx="1" />
              <path d="M2 7h12M6 3v10" />
            </svg>
          }
        />
      )}
      {showFormatFilter && formatOptions.length > 1 && (
        <TableMultiSelectFilter
          label="Formato"
          pluralLabel="formatos"
          options={formatOptions}
          selected={formats}
          onChange={setFormats}
          formatLabel={(v) => v.charAt(0) + v.slice(1).toLowerCase()}
          icon={
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2" y="2.5" width="12" height="9" rx="1" />
              <path d="M5 14h6" />
            </svg>
          }
        />
      )}
    </div>
  );
}
