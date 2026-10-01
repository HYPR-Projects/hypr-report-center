// src/components/modals/RmndUploadModal.jsx
//
// Modal pra subir/configurar a base RMND (Amazon Ads). Substitui o fluxo
// antigo de "input file dentro da aba RMND" por um popup estilo SurveyModal:
//
//   1. Admin escolhe o arquivo (.csv ou .xlsx) gerado no Amazon Console
//   2. Frontend parseia tudo em memória (sem persistir ainda)
//   3. Modal mostra os grupos de anúncios encontrados (checkboxes) e o
//      período disponível (date range), com preview de totais ao vivo
//   4. Admin filtra → frontend salva o subset filtrado no backend
//      (saveUpload) e no localStorage do report.
//
// O JSON salvo segue o schema V2 (`format: "amazon-ads-2026"`) — o dashboard
// detecta esse formato e renderiza a nova view. Bases legadas continuam
// renderizando com o caminho antigo até o admin fazer um novo upload.

import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "../../shared/theme";
import { useXlsx } from "../../shared/useXlsx";
import { saveUpload } from "../../lib/api";
import ModalShell from "./ModalShell";
import { toast } from "../../lib/toast";
import {
  parseAmazonAdsFile,
  filterRows,
  summarize,
} from "../../shared/rmndParse";
import { fmt, fmtR } from "../../shared/format";

const RMND_FORMAT = "amazon-ads-2026";
const PAYLOAD_VERSION = 2;

const formatDateBR = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

const RmndUploadModal = ({
  shortToken,
  existing,        // payload já salvo (pra detectar "atualizar"), opcional
  adminJwt,
  onClose,
  onSaved,
  theme,
}) => {
  const XLSX = useXlsx();
  const fileRef = useRef();

  const [parsing, setParsing]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [parsed, setParsed]     = useState(null);   // { rows, adGroups, dateRange, totalRaw, fileName }
  const [error, setError]       = useState("");

  // Filtros — todos os grupos selecionados + range completo por default.
  const [selectedGroups, setSelectedGroups] = useState(new Set());
  const [range, setRange] = useState({ from: "", to: "" });
  const [groupSearch, setGroupSearch] = useState("");
  const [hoveredGroup, setHoveredGroup] = useState(null);

  // Hidrata estado a partir de payload existente (mostra resumo sem parser)
  const hasExisting = !!(existing && existing.format === RMND_FORMAT);

  const text     = theme?.text     || C.white;
  const muted    = theme?.muted    || C.muted;
  const modalBdr = theme?.modalBdr || C.dark3;
  const inputBg  = theme?.inputBg  || C.dark3;
  const cardBg   = theme?.modalBg  || C.dark2;

  // Quando termina parsing → seleciona tudo + range completo
  useEffect(() => {
    if (!parsed) return;
    setSelectedGroups(new Set(parsed.adGroups));
    setRange({ from: parsed.dateRange.from, to: parsed.dateRange.to });
  }, [parsed]);

  const handlePickFile = () => fileRef.current?.click();

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !XLSX) return;
    setParsing(true);
    setError("");
    try {
      const out = await parseAmazonAdsFile(file, XLSX);
      setParsed({ ...out, fileName: file.name });
    } catch (err) {
      setError(err.message || "Falha ao ler arquivo");
      setParsed(null);
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // Lista filtrada do search
  const visibleGroups = useMemo(() => {
    if (!parsed) return [];
    const q = groupSearch.trim().toLowerCase();
    if (!q) return parsed.adGroups;
    return parsed.adGroups.filter((g) => g.toLowerCase().includes(q));
  }, [parsed, groupSearch]);

  // Preview: rows que vão pro report, dado o filtro atual
  const filteredRows = useMemo(() => {
    if (!parsed) return [];
    return filterRows(parsed.rows, {
      adGroups: [...selectedGroups],
      dateRange: range.from && range.to ? range : null,
    });
  }, [parsed, selectedGroups, range]);

  const summary = useMemo(() => summarize(filteredRows), [filteredRows]);

  const toggleGroup = (g) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });
  };

  const selectOnly = (g) => setSelectedGroups(new Set([g]));

  const toggleAllVisible = () => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      const allOn = visibleGroups.every((g) => next.has(g));
      if (allOn) visibleGroups.forEach((g) => next.delete(g));
      else visibleGroups.forEach((g) => next.add(g));
      return next;
    });
  };

  const allVisibleSelected = visibleGroups.length > 0 &&
    visibleGroups.every((g) => selectedGroups.has(g));

  const canSave = !!parsed && filteredRows.length > 0 && !saving && !!range.from && !!range.to;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload = {
        version: PAYLOAD_VERSION,
        type: "RMND",
        format: RMND_FORMAT,
        uploadedAt: new Date().toISOString(),
        sourceFileName: parsed.fileName,
        filters: {
          adGroups: [...selectedGroups].sort(),
          dateRange: { from: range.from, to: range.to },
        },
        rows: filteredRows,
      };
      await saveUpload({
        short_token: shortToken,
        type: "RMND",
        data_json: JSON.stringify(payload),
        adminJwt,
      });
      // Espelha no localStorage do report (mesma chave do UploadTab)
      try {
        localStorage.setItem(`hypr_rmnd_${shortToken}`, JSON.stringify(payload));
      } catch { /* ignore quota */ }
      toast.success(`RMND de ${shortToken} salvo`);
      if (onSaved) onSaved(payload);
    } catch (err) {
      toast.error(`Erro ao salvar RMND: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = (filled = false) => ({
    background: inputBg,
    border: `1px solid ${filled ? C.blue + "60" : modalBdr}`,
    borderRadius: 7,
    padding: "9px 12px",
    color: text,
    fontSize: 13,
    outline: "none",
    fontFamily: "inherit",
  });

  return (
    <ModalShell onClose={onClose} theme={theme} maxWidth={620} padding={32} maxHeight="90vh">
      <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4, color: text }}>
        🛒 Subir base RMND · Amazon Ads
      </h2>
      <p style={{ color: muted, fontSize: 14, marginBottom: 6 }}>
        Configure a base RMND para <strong>{shortToken}</strong>.
      </p>
      <p style={{ color: muted, fontSize: 12, marginBottom: 20, lineHeight: 1.6 }}>
        Suba o relatório do <strong>Amazon Ads Console</strong> (.csv ou .xlsx) e
        escolha quais grupos de anúncios e qual período entram no report do cliente.
      </p>

      {hasExisting && !parsed && (
        <div
          style={{
            background: `${C.blue}15`,
            border: `1px solid ${C.blue}40`,
            color: text,
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 12,
            marginBottom: 12,
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 2 }}>Base atual</div>
          <div style={{ color: muted }}>
            {existing?.rows?.length || 0} linhas · {existing?.filters?.adGroups?.length || 0} grupo(s)
            {existing?.filters?.dateRange?.from && (
              <> · {formatDateBR(existing.filters.dateRange.from)} → {formatDateBR(existing.filters.dateRange.to)}</>
            )}
          </div>
          <div style={{ color: muted, fontSize: 11, marginTop: 4 }}>
            Subir um novo arquivo substitui a base atual.
          </div>
        </div>
      )}

      {/* Botão de upload */}
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        onChange={handleFile}
        style={{ display: "none" }}
      />

      {!parsed && (
        <button
          type="button"
          onClick={handlePickFile}
          disabled={!XLSX || parsing}
          style={{
            width: "100%",
            background: !XLSX ? inputBg : C.blue,
            color: !XLSX ? muted : "#fff",
            border: "none",
            padding: "14px 18px",
            borderRadius: 10,
            cursor: !XLSX || parsing ? "not-allowed" : "pointer",
            fontSize: 14,
            fontWeight: 700,
            opacity: !XLSX || parsing ? 0.6 : 1,
            marginBottom: 16,
          }}
        >
          {parsing
            ? "Lendo arquivo…"
            : !XLSX
              ? "Carregando biblioteca…"
              : hasExisting
                ? "📂 Trocar arquivo"
                : "📂 Selecionar arquivo (.csv / .xlsx)"}
        </button>
      )}

      {error && (
        <div
          style={{
            background: "#FFB95E20",
            border: "1px solid #FFB95E50",
            color: text,
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 12,
            marginBottom: 16,
          }}
        >
          ⚠ {error}
        </div>
      )}

      {parsed && (
        <>
          <div
            style={{
              border: `1px solid ${modalBdr}`,
              background: cardBg,
              borderRadius: 10,
              padding: 14,
              marginBottom: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: muted, marginBottom: 2 }}>Arquivo lido</div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={parsed.fileName}
              >
                {parsed.fileName}
              </div>
              <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>
                {fmt(parsed.totalRaw)} linhas · {parsed.adGroups.length} grupo(s) · {formatDateBR(parsed.dateRange.from)} → {formatDateBR(parsed.dateRange.to)}
              </div>
            </div>
            <button
              type="button"
              onClick={handlePickFile}
              style={{
                background: "none",
                border: `1px solid ${modalBdr}`,
                color: C.blue,
                padding: "7px 12px",
                borderRadius: 7,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              Trocar
            </button>
          </div>

          {/* Período */}
          <div
            style={{
              border: `1px solid ${modalBdr}`,
              background: cardBg,
              borderRadius: 10,
              padding: 14,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: C.blue,
                letterSpacing: 1,
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Período
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: muted, flex: "1 1 140px" }}>
                De
                <input
                  type="date"
                  value={range.from}
                  min={parsed.dateRange.from}
                  max={parsed.dateRange.to}
                  onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                  style={inputStyle(true)}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: muted, flex: "1 1 140px" }}>
                Até
                <input
                  type="date"
                  value={range.to}
                  min={parsed.dateRange.from}
                  max={parsed.dateRange.to}
                  onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                  style={inputStyle(true)}
                />
              </label>
              <button
                type="button"
                onClick={() => setRange({ from: parsed.dateRange.from, to: parsed.dateRange.to })}
                style={{
                  marginTop: 18,
                  background: "none",
                  border: "none",
                  color: C.blue,
                  fontSize: 11,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                tudo
              </button>
            </div>
          </div>

          {/* Grupos de anúncios */}
          <div
            style={{
              border: `1px solid ${modalBdr}`,
              background: cardBg,
              borderRadius: 10,
              padding: 14,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
                gap: 8,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: C.blue,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                }}
              >
                Grupos de anúncios
                <span style={{ fontSize: 11, color: muted, marginLeft: 8, textTransform: "none", letterSpacing: 0 }}>
                  ({selectedGroups.size}/{parsed.adGroups.length} selecionados)
                </span>
              </div>
            </div>

            <input
              type="text"
              placeholder="Buscar grupo…"
              value={groupSearch}
              onChange={(e) => setGroupSearch(e.target.value)}
              style={{ ...inputStyle(), width: "100%", marginBottom: 8 }}
            />

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                marginBottom: 4,
                fontSize: 12,
                color: muted,
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleAllVisible}
                style={{ accentColor: C.blue, cursor: "pointer" }}
              />
              Selecionar todos {groupSearch ? "filtrados" : ""}
            </label>

            <div
              style={{
                maxHeight: 220,
                overflowY: "auto",
                border: `1px solid ${modalBdr}`,
                borderRadius: 8,
                background: inputBg,
              }}
            >
              {visibleGroups.length === 0 ? (
                <div style={{ padding: 14, fontSize: 12, color: muted, textAlign: "center" }}>
                  Nenhum grupo encontrado.
                </div>
              ) : (
                visibleGroups.map((g) => {
                  const hovered = hoveredGroup === g;
                  const onlyThis = selectedGroups.size === 1 && selectedGroups.has(g);
                  return (
                  <label
                    key={g}
                    onMouseEnter={() => setHoveredGroup(g)}
                    onMouseLeave={() => setHoveredGroup((cur) => (cur === g ? null : cur))}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      fontSize: 12,
                      color: text,
                      cursor: "pointer",
                      borderBottom: `1px solid ${modalBdr}40`,
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedGroups.has(g)}
                      onChange={() => toggleGroup(g)}
                      style={{ accentColor: C.blue, cursor: "pointer", flexShrink: 0 }}
                    />
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                      }}
                      title={g}
                    >
                      {g}
                    </span>
                    {!onlyThis && (
                      <span
                        role="button"
                        tabIndex={hovered ? 0 : -1}
                        aria-label={`Selecionar apenas ${g}`}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); selectOnly(g); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault(); e.stopPropagation(); selectOnly(g);
                          }
                        }}
                        style={{
                          color: C.blue,
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "2px 6px",
                          marginLeft: 4,
                          opacity: hovered ? 1 : 0,
                          transition: "opacity 0.12s",
                          cursor: "pointer",
                          flexShrink: 0,
                        }}
                      >
                        apenas
                      </span>
                    )}
                  </label>
                  );
                })
              )}
            </div>
          </div>

          {/* Preview com totais */}
          <div
            style={{
              border: `1px solid ${C.blue}40`,
              background: `${C.blue}10`,
              borderRadius: 10,
              padding: 14,
              marginBottom: 16,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: C.blue,
                letterSpacing: 1,
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Preview do que vai pro report
            </div>
            {filteredRows.length === 0 ? (
              <div style={{ fontSize: 12, color: "#FFB95E", fontWeight: 600 }}>
                Nenhuma linha selecionada — ajuste o filtro acima.
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
                  gap: 10,
                  fontSize: 12,
                  color: text,
                }}
              >
                <PreviewStat label="Linhas"   value={fmt(summary.rowCount)} muted={muted} />
                <PreviewStat label="Dias"     value={fmt(summary.daysCount)} muted={muted} />
                <PreviewStat label="Vendas"   value={fmtR(summary.sales)} muted={muted} accent />
                <PreviewStat label="Compras"  value={fmt(summary.purchases)} muted={muted} />
                <PreviewStat label="Unidades" value={fmt(summary.units)} muted={muted} />
                <PreviewStat label="ATC"      value={fmt(summary.atc)} muted={muted} />
              </div>
            )}
          </div>
        </>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={onClose}
          style={{
            flex: 1,
            background: inputBg,
            color: muted,
            border: `1px solid ${modalBdr}`,
            padding: 12,
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={!canSave}
          onClick={handleSave}
          style={{
            flex: 2,
            background: C.blue,
            color: "#fff",
            border: "none",
            padding: 12,
            borderRadius: 8,
            cursor: !canSave ? "not-allowed" : "pointer",
            fontSize: 14,
            fontWeight: 700,
            opacity: !canSave ? 0.5 : 1,
          }}
        >
          {saving ? "Salvando…" : `✓ Salvar ${filteredRows.length ? `(${fmt(filteredRows.length)} linhas)` : ""}`}
        </button>
      </div>
    </ModalShell>
  );
};

function PreviewStat({ label, value, muted, accent }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: accent ? 16 : 14, fontWeight: 700, color: accent ? C.blue : "inherit", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
    </div>
  );
}

export default RmndUploadModal;
