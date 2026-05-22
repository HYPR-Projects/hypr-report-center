// src/components/modals/PdoohUploadModal.jsx
//
// Modal "rico" pra subir/configurar a base PDOOH. Mesmo padrão do
// RmndUploadModal:
//
//   1. Admin escolhe o arquivo (.csv ou .xlsx) do HYPR_PDOOH_REPORT.
//   2. Frontend parseia tudo em memória (sem persistir ainda).
//   3. Modal mostra:
//        - Período (date range) com defaults = range completo
//        - Line items / Media owners / Cidades (colapsáveis, listas com busca)
//      Filtros são CRUZADOS: marcar uma line item reduz a lista de owners,
//      cidades e o range de dias ao que efetivamente tem entrega pra ela.
//      Preview de totais atualiza ao vivo.
//   4. Admin filtra → frontend salva o subset filtrado no backend
//      (saveUpload) e no localStorage do report.
//
// Payload salvo segue schema V2 (`format: "pdooh-v2"`) — o dashboard
// continua lendo r["DATE"]/r["CITY"]/etc. exatamente como antes.

import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "../../shared/theme";
import { useXlsx } from "../../shared/useXlsx";
import { saveUpload } from "../../lib/api";
import ModalShell from "./ModalShell";
import { toast } from "../../lib/toast";
import {
  parsePdoohFile,
  filterPdoohRows,
  summarizePdooh,
} from "../../shared/pdoohParse";
import { fmt } from "../../shared/format";

const PDOOH_FORMAT = "pdooh-v2";
const PAYLOAD_VERSION = 2;

const formatDateBR = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

// Aplica os filtros EXCETO o passado em `skip`. Usado pra computar o que está
// disponível em cada dimensão dado as seleções das outras (cross-filtering).
function applyFiltersExcept(rows, parsed, state, skip) {
  const { selectedLineItems, selectedMediaOwners, selectedCities, range } = state;
  const liActive = skip !== "li" && selectedLineItems.size > 0 && selectedLineItems.size < parsed.lineItems.length;
  const moActive = skip !== "mo" && selectedMediaOwners.size > 0 && selectedMediaOwners.size < parsed.mediaOwners.length;
  const ciActive = skip !== "ci" && selectedCities.size > 0 && selectedCities.size < parsed.cities.length;
  const dActive  = skip !== "date" && range.from && range.to;
  return rows.filter((r) => {
    if (dActive && (r.DATE < range.from || r.DATE > range.to)) return false;
    if (liActive && !selectedLineItems.has(r.LINE_ITEM)) return false;
    if (moActive && !selectedMediaOwners.has(r.MEDIA_OWNER)) return false;
    if (ciActive && !selectedCities.has(r.CITY)) return false;
    return true;
  });
}

const PdoohUploadModal = ({
  shortToken,
  existing,
  adminJwt,
  onClose,
  onSaved,
  theme,
}) => {
  const XLSX = useXlsx();
  const fileRef = useRef();

  const [parsing, setParsing] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [parsed, setParsed]   = useState(null);
  const [error, setError]     = useState("");

  const [selectedLineItems,   setSelectedLineItems]   = useState(new Set());
  const [selectedMediaOwners, setSelectedMediaOwners] = useState(new Set());
  const [selectedCities,      setSelectedCities]      = useState(new Set());
  const [range, setRange] = useState({ from: "", to: "" });

  const [liSearch, setLiSearch] = useState("");
  const [moSearch, setMoSearch] = useState("");
  const [cSearch,  setCSearch]  = useState("");

  const [liOpen, setLiOpen] = useState(true);
  const [moOpen, setMoOpen] = useState(false);
  const [ciOpen, setCiOpen] = useState(false);

  const hasExisting = !!(existing && existing.format === PDOOH_FORMAT);

  const text     = theme?.text     || C.white;
  const muted    = theme?.muted    || C.muted;
  const modalBdr = theme?.modalBdr || C.dark3;
  const inputBg  = theme?.inputBg  || C.dark3;
  const cardBg   = theme?.modalBg  || C.dark2;

  // Default: tudo selecionado + range completo (e reseta UI auxiliar)
  useEffect(() => {
    if (!parsed) return;
    setSelectedLineItems(new Set(parsed.lineItems));
    setSelectedMediaOwners(new Set(parsed.mediaOwners));
    setSelectedCities(new Set(parsed.cities));
    setRange({ from: parsed.dateRange.from, to: parsed.dateRange.to });
    setLiSearch(""); setMoSearch(""); setCSearch("");
    setLiOpen(true); setMoOpen(false); setCiOpen(false);
  }, [parsed]);

  const handlePickFile = () => fileRef.current?.click();

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !XLSX) return;
    setParsing(true);
    setError("");
    try {
      const out = await parsePdoohFile(file, XLSX);
      setParsed({ ...out, fileName: file.name });
    } catch (err) {
      setError(err.message || "Falha ao ler arquivo");
      setParsed(null);
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const filterState = { selectedLineItems, selectedMediaOwners, selectedCities, range };

  // Cross-filtering: o que cada dimensão tem disponível DADO as outras.
  const available = useMemo(() => {
    if (!parsed) return { lineItems: [], mediaOwners: [], cities: [], dateMin: "", dateMax: "" };
    const rowsForLi = applyFiltersExcept(parsed.rows, parsed, filterState, "li");
    const rowsForMo = applyFiltersExcept(parsed.rows, parsed, filterState, "mo");
    const rowsForCi = applyFiltersExcept(parsed.rows, parsed, filterState, "ci");
    const rowsForDt = applyFiltersExcept(parsed.rows, parsed, filterState, "date");

    const uniq = (rows, key) => {
      const s = new Set();
      for (const r of rows) {
        const v = String(r[key] ?? "").trim();
        if (v) s.add(v);
      }
      return [...s].sort();
    };
    let dateMin = "", dateMax = "";
    if (rowsForDt.length) {
      dateMin = rowsForDt[0].DATE; dateMax = rowsForDt[0].DATE;
      for (const r of rowsForDt) {
        if (r.DATE < dateMin) dateMin = r.DATE;
        if (r.DATE > dateMax) dateMax = r.DATE;
      }
    }
    return {
      lineItems:   uniq(rowsForLi, "LINE_ITEM"),
      mediaOwners: uniq(rowsForMo, "MEDIA_OWNER"),
      cities:      uniq(rowsForCi, "CITY"),
      dateMin,
      dateMax,
    };
  }, [parsed, selectedLineItems, selectedMediaOwners, selectedCities, range.from, range.to]);

  // Clamp range pros dias disponíveis.
  //
  // Deps incluem range.from/to pra cobrir o caso "user digitou manualmente
  // uma data fora dos limites". Sem isso, se o cross-filter não mudou o
  // dateMin/dateMax (ex: o filter já estava fixado num único line item), o
  // useEffect não disparava e o input ficava com valor inválido visível.
  // O retorno `r` cedo (sem mudar referência) impede loop infinito.
  useEffect(() => {
    if (!parsed || !available.dateMin) return;
    setRange((r) => {
      let { from, to } = r;
      if (from && from < available.dateMin) from = available.dateMin;
      if (from && from > available.dateMax) from = available.dateMax;
      if (to && to < available.dateMin) to = available.dateMin;
      if (to && to > available.dateMax) to = available.dateMax;
      if (from && to && from > to) from = to;
      if (from === r.from && to === r.to) return r;
      return { from, to };
    });
  }, [parsed, available.dateMin, available.dateMax, range.from, range.to]);

  // (lista filtrada por busca é calculada dentro do FilterSection — o input
  // de busca não pode depender do tamanho da lista pós-busca, senão ele some
  // quando a busca encontra poucos itens e o user fica sem como apagar a query)

  const filteredRows = useMemo(() => {
    if (!parsed) return [];
    // Selecionados clamped ao "disponível dado os outros filtros". Se um valor
    // já marcado pelo user saiu do available, ele é simplesmente ignorado no
    // resultado (não conta como filtro literal vazio).
    const liSet = intersect(selectedLineItems,   available.lineItems);
    const moSet = intersect(selectedMediaOwners, available.mediaOwners);
    const cSet  = intersect(selectedCities,      available.cities);
    // null = "sem filtro" (tudo disponível passa). Caso contrário, array com a
    // seleção exata. Quando user tem TUDO disponível selecionado, passar null
    // evita re-filtrar com o set inteiro (otimização + semântica idêntica).
    const liArg = liSet.size === available.lineItems.length   && available.lineItems.length   > 0 ? null : [...liSet];
    const moArg = moSet.size === available.mediaOwners.length && available.mediaOwners.length > 0 ? null : [...moSet];
    const cArg  = cSet.size  === available.cities.length      && available.cities.length      > 0 ? null : [...cSet];
    return filterPdoohRows(parsed.rows, {
      lineItems:   liArg,
      mediaOwners: moArg,
      cities:      cArg,
      dateRange:   range.from && range.to ? range : null,
    });
  }, [parsed, selectedLineItems, selectedMediaOwners, selectedCities, range, available]);

  const summary = useMemo(() => summarizePdooh(filteredRows), [filteredRows]);

  const canSave = !!parsed && filteredRows.length > 0 && !saving && !!range.from && !!range.to;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const liFinal = [...intersect(selectedLineItems,   available.lineItems)].sort();
      const moFinal = [...intersect(selectedMediaOwners, available.mediaOwners)].sort();
      const cFinal  = [...intersect(selectedCities,      available.cities)].sort();
      const payload = {
        version: PAYLOAD_VERSION,
        type: "PDOOH",
        format: PDOOH_FORMAT,
        uploadedAt: new Date().toISOString(),
        sourceFileName: parsed.fileName,
        headers: parsed.headers,
        filters: {
          lineItems:   liFinal,
          mediaOwners: moFinal,
          cities:      cFinal,
          dateRange:   { from: range.from, to: range.to },
        },
        rows: filteredRows,
      };
      await saveUpload({
        short_token: shortToken,
        type: "PDOOH",
        data_json: JSON.stringify(payload),
        adminJwt,
      });
      try {
        localStorage.setItem(`hypr_pdooh_${shortToken}`, JSON.stringify(payload));
      } catch { /* quota */ }
      toast.success(`PDOOH de ${shortToken} salvo`);
      if (onSaved) onSaved(payload);
    } catch (err) {
      toast.error(`Erro ao salvar PDOOH: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = (filled = false) => ({
    background: inputBg,
    border: `1px solid ${filled ? C.blue + "60" : modalBdr}`,
    borderRadius: 6,
    padding: "8px 11px",
    color: text,
    fontSize: 13,
    outline: "none",
    fontFamily: "inherit",
  });

  return (
    <ModalShell onClose={onClose} theme={theme} maxWidth={560} padding={28} maxHeight="92vh">
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4, color: text }}>
        Subir base PDOOH
      </h2>
      <p style={{ color: muted, fontSize: 12, marginBottom: 18, lineHeight: 1.5 }}>
        Token <strong style={{ color: text }}>{shortToken}</strong> · suba o HYPR_PDOOH_REPORT (.csv/.xlsx) e escolha o que entra no report.
      </p>

      {hasExisting && !parsed && (
        <div
          style={{
            background: `${C.blue}12`,
            border: `1px solid ${C.blue}33`,
            color: text,
            borderRadius: 8,
            padding: "9px 11px",
            fontSize: 12,
            marginBottom: 12,
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 600 }}>Base atual</div>
          <div style={{ color: muted, marginTop: 1 }}>
            {fmt(existing?.rows?.length || 0)} linhas
            {existing?.filters?.lineItems?.length != null && <> · {existing.filters.lineItems.length} line item(s)</>}
            {existing?.filters?.dateRange?.from && (
              <> · {formatDateBR(existing.filters.dateRange.from)} → {formatDateBR(existing.filters.dateRange.to)}</>
            )}
          </div>
        </div>
      )}

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
            padding: "13px 18px",
            borderRadius: 9,
            cursor: !XLSX || parsing ? "not-allowed" : "pointer",
            fontSize: 14,
            fontWeight: 600,
            opacity: !XLSX || parsing ? 0.6 : 1,
            marginBottom: 14,
          }}
        >
          {parsing
            ? "Lendo arquivo…"
            : !XLSX
              ? "Carregando biblioteca…"
              : hasExisting
                ? "Trocar arquivo"
                : "Selecionar arquivo"}
        </button>
      )}

      {error && (
        <div
          style={{
            background: "#FFB95E18",
            border: "1px solid #FFB95E40",
            color: text,
            borderRadius: 7,
            padding: "9px 11px",
            fontSize: 12,
            marginBottom: 14,
          }}
        >
          ⚠ {error}
        </div>
      )}

      {parsed && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "10px 12px",
              marginBottom: 10,
              borderRadius: 8,
              background: inputBg,
              border: `1px solid ${modalBdr}`,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={parsed.fileName}
              >
                {parsed.fileName}
              </div>
              <div style={{ fontSize: 11, color: muted, marginTop: 1 }}>
                {fmt(parsed.totalRaw)} linhas · {formatDateBR(parsed.dateRange.from)} → {formatDateBR(parsed.dateRange.to)}
              </div>
            </div>
            <button
              type="button"
              onClick={handlePickFile}
              style={{
                background: "none",
                border: "none",
                color: C.blue,
                padding: 0,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Trocar
            </button>
          </div>

          {/* Período — sempre visível, compacto */}
          <div
            style={{
              border: `1px solid ${modalBdr}`,
              borderRadius: 8,
              padding: "10px 12px",
              marginBottom: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: text }}>Período</span>
              <button
                type="button"
                onClick={() => setRange({ from: available.dateMin, to: available.dateMax })}
                style={{ background: "none", border: "none", color: C.blue, fontSize: 11, cursor: "pointer", fontWeight: 600, padding: 0 }}
              >
                tudo
              </button>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="date"
                value={range.from}
                min={available.dateMin || parsed.dateRange.from}
                max={available.dateMax || parsed.dateRange.to}
                onChange={(e) => setRange((r) => {
                  const from = e.target.value;
                  const to = from && r.to && from > r.to ? from : r.to;
                  return { from, to };
                })}
                style={{ ...inputStyle(true), flex: 1 }}
              />
              <span style={{ color: muted, fontSize: 11 }}>→</span>
              <input
                type="date"
                value={range.to}
                min={available.dateMin || parsed.dateRange.from}
                max={available.dateMax || parsed.dateRange.to}
                onChange={(e) => setRange((r) => {
                  const to = e.target.value;
                  const from = to && r.from && to < r.from ? to : r.from;
                  return { from, to };
                })}
                style={{ ...inputStyle(true), flex: 1 }}
              />
            </div>
          </div>

          <FilterSection
            title="Line items"
            availableInDim={available.lineItems}
            selected={selectedLineItems}
            onToggle={(g) => toggleInSet(setSelectedLineItems, g)}
            onToggleAllVisible={(visibleArr, allOn) => toggleAllVisible(setSelectedLineItems, visibleArr, allOn)}
            onOnly={(g) => setSelectedLineItems(new Set([g]))}
            open={liOpen}
            onToggleOpen={() => setLiOpen((v) => !v)}
            placeholder="Buscar line item…"
            search={liSearch}
            onSearch={setLiSearch}
            muted={muted}
            text={text}
            inputBg={inputBg}
            modalBdr={modalBdr}
            inputStyle={inputStyle}
          />

          <FilterSection
            title="Media owners"
            availableInDim={available.mediaOwners}
            selected={selectedMediaOwners}
            onToggle={(g) => toggleInSet(setSelectedMediaOwners, g)}
            onToggleAllVisible={(visibleArr, allOn) => toggleAllVisible(setSelectedMediaOwners, visibleArr, allOn)}
            onOnly={(g) => setSelectedMediaOwners(new Set([g]))}
            open={moOpen}
            onToggleOpen={() => setMoOpen((v) => !v)}
            placeholder="Buscar painel…"
            search={moSearch}
            onSearch={setMoSearch}
            muted={muted}
            text={text}
            inputBg={inputBg}
            modalBdr={modalBdr}
            inputStyle={inputStyle}
          />

          <FilterSection
            title="Cidades"
            availableInDim={available.cities}
            selected={selectedCities}
            onToggle={(g) => toggleInSet(setSelectedCities, g)}
            onToggleAllVisible={(visibleArr, allOn) => toggleAllVisible(setSelectedCities, visibleArr, allOn)}
            onOnly={(g) => setSelectedCities(new Set([g]))}
            open={ciOpen}
            onToggleOpen={() => setCiOpen((v) => !v)}
            placeholder="Buscar cidade…"
            search={cSearch}
            onSearch={setCSearch}
            muted={muted}
            text={text}
            inputBg={inputBg}
            modalBdr={modalBdr}
            inputStyle={inputStyle}
          />

          {/* Preview — sutil, sem chamar atenção */}
          <div
            style={{
              borderTop: `1px solid ${modalBdr}`,
              padding: "12px 4px 4px",
              marginTop: 4,
              marginBottom: 14,
            }}
          >
            {filteredRows.length === 0 ? (
              <div style={{ fontSize: 12, color: "#FFB95E", fontWeight: 600 }}>
                Nenhuma linha selecionada — ajuste os filtros acima.
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  gap: 10,
                  fontSize: 12,
                  color: text,
                }}
              >
                <PreviewStat label="Linhas"     value={fmt(summary.rowCount)}                  muted={muted} />
                <PreviewStat label="Dias"       value={fmt(summary.daysCount)}                 muted={muted} />
                <PreviewStat label="Impressões" value={fmt(Math.round(summary.impressions))}   muted={muted} accent />
                <PreviewStat label="Plays"      value={fmt(Math.round(summary.plays))}         muted={muted} />
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
            background: "none",
            color: muted,
            border: `1px solid ${modalBdr}`,
            padding: "10px 14px",
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 500,
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
            padding: "10px 14px",
            borderRadius: 8,
            cursor: !canSave ? "not-allowed" : "pointer",
            fontSize: 13,
            fontWeight: 700,
            opacity: !canSave ? 0.5 : 1,
          }}
        >
          {saving ? "Salvando…" : `Salvar${filteredRows.length ? ` · ${fmt(filteredRows.length)} linhas` : ""}`}
        </button>
      </div>
    </ModalShell>
  );
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function filterList(list, q) {
  if (!list) return [];
  const s = q.trim().toLowerCase();
  if (!s) return list;
  return list.filter((g) => g.toLowerCase().includes(s));
}

function toggleInSet(setter, value) {
  setter((prev) => {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  });
}

function toggleAllVisible(setter, visible, allOn) {
  setter((prev) => {
    const next = new Set(prev);
    if (allOn) visible.forEach((g) => next.delete(g));
    else visible.forEach((g) => next.add(g));
    return next;
  });
}

function intersect(set, arr) {
  const out = new Set();
  for (const v of arr) if (set.has(v)) out.add(v);
  return out;
}

const SEARCH_THRESHOLD = 8;

function FilterSection({
  title,
  availableInDim,
  selected,
  onToggle,
  onToggleAllVisible,
  onOnly,
  open,
  onToggleOpen,
  placeholder,
  search,
  onSearch,
  muted,
  text,
  inputBg,
  modalBdr,
  inputStyle,
}) {
  const [hoveredKey, setHoveredKey] = useState(null);

  // Lista visível = available ∩ matches(search). Filtragem por busca acontece
  // AQUI dentro, não no parent — assim o input não some quando a query reduz
  // a visible a poucos itens (esse era o bug que prendia o user com query
  // ativa sem como apagar).
  const visible = useMemo(
    () => filterList(availableInDim, search),
    [availableInDim, search]
  );
  const searchActive = search.trim().length > 0;
  const showSearchInput = availableInDim.length > SEARCH_THRESHOLD || searchActive;

  const selectedCount = useMemo(() => {
    let n = 0;
    for (const v of availableInDim) if (selected.has(v)) n++;
    return n;
  }, [availableInDim, selected]);
  const total = availableInDim.length;

  const allVisibleSelected = visible.length > 0 && visible.every((g) => selected.has(g));

  return (
    <div
      style={{
        border: `1px solid ${modalBdr}`,
        borderRadius: 8,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={onToggleOpen}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          padding: "10px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer",
          color: text,
          fontSize: 12,
          fontWeight: 600,
          fontFamily: "inherit",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontSize: 9,
              color: muted,
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.15s",
              display: "inline-block",
              width: 8,
            }}
          >
            ▶
          </span>
          {title}
          <span style={{ color: muted, fontWeight: 500 }}>
            {total === 0
              ? "0"
              : selectedCount === total
                ? `${total}`
                : `${selectedCount} de ${total}`}
          </span>
        </span>
        {open && visible.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onToggleAllVisible(visible, allVisibleSelected); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onToggleAllVisible(visible, allVisibleSelected); } }}
            style={{ color: C.blue, fontSize: 11, fontWeight: 600, cursor: "pointer", padding: "2px 4px" }}
          >
            {allVisibleSelected ? "limpar" : "todos"}
            {searchActive ? " (filtrados)" : ""}
          </span>
        )}
      </button>

      {open && (
        <div style={{ padding: "0 12px 10px" }}>
          {showSearchInput && (
            <div style={{ position: "relative", marginBottom: 6 }}>
              <input
                type="text"
                placeholder={placeholder}
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                style={{ ...inputStyle(), width: "100%", paddingRight: searchActive ? 28 : undefined, boxSizing: "border-box" }}
              />
              {searchActive && (
                <button
                  type="button"
                  onClick={() => onSearch("")}
                  aria-label="Limpar busca"
                  style={{
                    position: "absolute",
                    right: 6,
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "none",
                    border: "none",
                    color: muted,
                    cursor: "pointer",
                    fontSize: 14,
                    lineHeight: 1,
                    padding: "4px 6px",
                  }}
                >
                  ×
                </button>
              )}
            </div>
          )}
          <div
            style={{
              maxHeight: 170,
              overflowY: "auto",
              border: `1px solid ${modalBdr}`,
              borderRadius: 7,
              background: inputBg,
            }}
          >
            {visible.length === 0 ? (
              <div style={{ padding: 12, fontSize: 12, color: muted, textAlign: "center" }}>
                {searchActive ? (
                  <>
                    Nada encontrado para “{search}”.{" "}
                    <button
                      type="button"
                      onClick={() => onSearch("")}
                      style={{ background: "none", border: "none", color: C.blue, cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}
                    >
                      limpar busca
                    </button>
                  </>
                ) : (
                  "Nenhum item disponível com os filtros atuais."
                )}
              </div>
            ) : (
              visible.map((g) => {
                const hovered = hoveredKey === g;
                const onlyThis = selected.size === 1 && selected.has(g);
                return (
                  <label
                    key={g}
                    onMouseEnter={() => setHoveredKey(g)}
                    onMouseLeave={() => setHoveredKey((cur) => (cur === g ? null : cur))}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 10px",
                      fontSize: 12,
                      color: text,
                      cursor: "pointer",
                      borderBottom: `1px solid ${modalBdr}30`,
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(g)}
                      onChange={() => onToggle(g)}
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
                    {onOnly && !onlyThis && (
                      <span
                        role="button"
                        tabIndex={hovered ? 0 : -1}
                        aria-label={`Selecionar apenas ${g}`}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOnly(g); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault(); e.stopPropagation(); onOnly(g);
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
      )}
    </div>
  );
}

function PreviewStat({ label, value, muted, accent }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: accent ? 15 : 13, fontWeight: 700, color: accent ? C.blue : "inherit", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
    </div>
  );
}

export default PdoohUploadModal;
