import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "../../shared/theme";
import {
  saveSurvey as saveSurveyApi,
  getSurvey as getSurveyApi,
  listTypeformForms,
  fetchTypeformFormMeta,
} from "../../lib/api";
import ModalShell from "./ModalShell";

/**
 * Modal pra configurar surveys (controle vs. exposto) via API do Typeform.
 *
 * Fluxo
 * -----
 * 1. Ao abrir, carrega em paralelo:
 *    - lista de forms da pasta Survey (últimos 120d) via `listTypeformForms`
 *    - config existente da campanha via `getSurvey` (pra entrar em modo edição)
 * 2. Cada bloco "Pergunta N" tem dois pickers (Controle, Exposto). O picker
 *    aceita selecionar da lista (combobox searchable) OU colar URL manual —
 *    fallback pra forms fora da pasta/janela. Toggle inline entre os modos.
 * 3. Ao salvar, gera payload `{nome, ctrlUrl, expUrl, focusRow?}` mantendo
 *    compat com o renderer (SurveyTab, SurveyV2). Adiciona `ctrlFormId/expFormId`
 *    pra persistir referência estável caso o título do form mude no Typeform.
 *
 * Backwards compat
 * ----------------
 * - Configs antigas (só URLs coladas) são lidas, e tentamos casar com forms
 *   da lista pelo form_id extraído. Se casar, vira modo "list"; senão, modo
 *   "manual" preservando a URL como estava.
 */
const EMPTY_BLOCK = (defaultMode = "list") => ({
  nome: "",
  ctrlMode: defaultMode,
  ctrlFormId: "",
  ctrlUrl: "",
  expMode: defaultMode,
  expFormId: "",
  expUrl: "",
  focusRow: "",
});

// Espelho frontend de _extract_typeform_form_id do backend.
function extractFormId(value) {
  if (!value) return "";
  const s = String(value).trim();
  const m = s.match(/typeform\.com\/to\/([A-Za-z0-9]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{4,32}$/.test(s)) return s;
  return "";
}

// Helper de label legível pra slot
const slotLabel = (s) => (s === "ctrl" ? "Controle" : "Exposto");

// Constrói mapa formId → [{blockIdx, slot}] varrendo todos os blocos.
// Usado pra detectar duplicatas no dropdown e na hora de salvar.
function buildUsageMap(blocks) {
  const m = new Map();
  blocks.forEach((b, i) => {
    if (b.ctrlMode === "list" && b.ctrlFormId) {
      const arr = m.get(b.ctrlFormId) || [];
      arr.push({ blockIdx: i, slot: "ctrl" });
      m.set(b.ctrlFormId, arr);
    }
    if (b.expMode === "list" && b.expFormId) {
      const arr = m.get(b.expFormId) || [];
      arr.push({ blockIdx: i, slot: "exp" });
      m.set(b.expFormId, arr);
    }
  });
  return m;
}

// Devolve usos do form em outros slots (excluindo o slot atual).
function conflictsFor(formId, currentBlockIdx, currentSlot, usageMap) {
  if (!formId) return [];
  const all = usageMap.get(formId) || [];
  return all.filter(
    (u) => !(u.blockIdx === currentBlockIdx && u.slot === currentSlot),
  );
}

function relativeTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const days = Math.floor(diff / 86_400_000);
  if (days < 1) return "hoje";
  if (days < 2) return "ontem";
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30);
  if (months < 12) return `há ${months} ${months === 1 ? "mês" : "meses"}`;
  return `há ${Math.floor(months / 12)}a`;
}

const SurveyModal = ({ shortToken, onClose, onSaved, theme }) => {
  const [blocks, setBlocks] = useState([EMPTY_BLOCK()]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forms, setForms] = useState([]);            // [{id,title,last_updated_at,display_url}]
  const [formsError, setFormsError] = useState("");
  const [scope, setScope] = useState("workspace");
  // Cache de meta por formId — popular sob demanda quando admin seleciona um form.
  // valor: { type: "matrix"|"choice"|"other", rows: [str], loading?: bool, error?: str }
  const [metaById, setMetaById] = useState(() => new Map());

  const text     = theme?.text     || C.white;
  const muted    = theme?.muted    || C.muted;
  const modalBdr = theme?.modalBdr || C.dark3;
  const inputBg  = theme?.inputBg  || C.dark3;
  const cardBg   = theme?.modalBg  || C.dark2;

  const formsById = useMemo(() => {
    const m = new Map();
    for (const f of forms) m.set(f.id, f);
    return m;
  }, [forms]);

  const usageMap = useMemo(() => buildUsageMap(blocks), [blocks]);

  // Lazy-fetch da meta de cada form selecionado em modo list. Precisamos
  // disso pra oferecer dropdown de linhas (marca-foco) só quando o form é
  // matrix. Usamos um Set ref pra rastrear ids já em fetch (in-flight) sem
  // precisar do metaById no array de deps — incluí-lo causa o cleanup do
  // effect rodar a cada setMetaById e cancelar o fetch antes dele resolver
  // (loop "loading eterno").
  const inflightIdsRef = useRef(new Set());
  useEffect(() => {
    const idsNeeded = new Set();
    for (const b of blocks) {
      if (b.ctrlMode === "list" && b.ctrlFormId) idsNeeded.add(b.ctrlFormId);
      if (b.expMode === "list" && b.expFormId) idsNeeded.add(b.expFormId);
    }
    // Filtra usando functional setState pra ler metaById atual sem dep.
    let missing = [];
    setMetaById((prev) => {
      missing = [...idsNeeded].filter(
        (id) => !prev.has(id) && !inflightIdsRef.current.has(id),
      );
      if (missing.length === 0) return prev;
      const next = new Map(prev);
      for (const id of missing) {
        next.set(id, { loading: true, type: null, rows: [] });
        inflightIdsRef.current.add(id);
      }
      return next;
    });

    if (missing.length === 0) return;

    (async () => {
      const results = await Promise.all(
        missing.map(async (id) => {
          try {
            const meta = await fetchTypeformFormMeta(id);
            return [id, { type: meta?.type || "other", rows: meta?.rows || [] }];
          } catch (e) {
            return [id, { type: "other", rows: [], error: e?.message || "fetch error" }];
          }
        }),
      );
      setMetaById((prev) => {
        const next = new Map(prev);
        for (const [id, val] of results) {
          next.set(id, val);
          inflightIdsRef.current.delete(id);
        }
        return next;
      });
    })();
  }, [blocks]);

  // ── Bootstrap: carrega config existente + lista de forms em paralelo ─────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [savedRaw, formsResp] = await Promise.allSettled([
        getSurveyApi({ short_token: shortToken }),
        listTypeformForms(),
      ]);
      if (cancelled) return;

      let formsList = [];
      let listFailed = false;
      if (formsResp.status === "fulfilled") {
        formsList = formsResp.value?.forms || [];
        setScope(formsResp.value?.scope || "workspace");
      } else {
        listFailed = true;
        setFormsError(formsResp.reason?.message || "Falha ao carregar forms");
      }
      setForms(formsList);

      // Default mode = "manual" se a listagem falhou (ou veio vazia) — assim
      // o admin nem vê o dropdown bloqueado, já cai direto em colar URL.
      const defaultMode = listFailed || formsList.length === 0 ? "manual" : "list";

      // Hidrata blocos com config existente, casando URLs → form_id da lista.
      if (savedRaw.status === "fulfilled" && savedRaw.value) {
        try {
          const parsed = JSON.parse(savedRaw.value);
          if (Array.isArray(parsed) && parsed.length) {
            const idsInList = new Set(formsList.map((f) => f.id));
            const hydrated = parsed.map((q) => {
              const ctrlId = q.ctrlFormId || extractFormId(q.ctrlUrl);
              const expId  = q.expFormId  || extractFormId(q.expUrl);
              const ctrlMatched = ctrlId && idsInList.has(ctrlId);
              const expMatched  = expId  && idsInList.has(expId);
              return {
                nome: q.nome || "",
                ctrlMode: ctrlMatched ? "list" : "manual",
                ctrlFormId: ctrlMatched ? ctrlId : "",
                ctrlUrl: q.ctrlUrl || "",
                expMode: expMatched ? "list" : "manual",
                expFormId: expMatched ? expId : "",
                expUrl: q.expUrl || "",
                focusRow: q.focusRow || "",
              };
            });
            setBlocks(hydrated);
          }
        } catch {
          // JSON corrompido — mantém bloco vazio
        }
      } else if (defaultMode === "manual") {
        // Sem config existente + lista indisponível → bloco inicial em manual
        setBlocks([EMPTY_BLOCK("manual")]);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [shortToken]);

  const handleClose = () => {
    if (onClose) onClose();
  };

  const updateBlock = (idx, patch) =>
    setBlocks((b) => b.map((bl, i) => (i === idx ? { ...bl, ...patch } : bl)));

  const removeBlock = (idx) =>
    setBlocks((b) => (b.length > 1 ? b.filter((_, i) => i !== idx) : b));

  const addBlock = () => setBlocks((b) => [...b, EMPTY_BLOCK()]);

  const handleSave = async () => {
    // Validação
    for (const [i, b] of blocks.entries()) {
      const ctrlOk = b.ctrlMode === "list" ? !!b.ctrlFormId : !!extractFormId(b.ctrlUrl);
      const expOk  = b.expMode  === "list" ? !!b.expFormId  : !!extractFormId(b.expUrl);
      if (!b.nome.trim()) {
        alert(`Pergunta ${i + 1}: preencha o nome.`);
        return;
      }
      if (!ctrlOk || !expOk) {
        alert(`Pergunta ${i + 1}: selecione (ou cole URL de) um form para Controle e Exposto.`);
        return;
      }
    }

    // Detecção de duplicatas (mesmo formId em 2+ slots) — modo list apenas.
    // Em modo manual, deixa passar: admin pode estar copiando URL crua e a
    // gente não tenta inferir conflito sem ID resolvido.
    const dupes = [];
    for (const [fid, uses] of usageMap.entries()) {
      if (uses.length > 1) {
        const f = formsById.get(fid);
        const title = f?.title || `form ${fid}`;
        dupes.push({ title, uses });
      }
    }
    if (dupes.length > 0) {
      const lines = dupes
        .map((d) => {
          const slots = d.uses
            .map((u) => `P${u.blockIdx + 1} ${slotLabel(u.slot)}`)
            .join(" e ");
          return `• ${d.title}\n   ${slots}`;
        })
        .join("\n\n");
      const ok = window.confirm(
        `Atenção: o mesmo form aparece em mais de um slot:\n\n${lines}\n\nSalvar mesmo assim?`,
      );
      if (!ok) return;
    }

    setSaving(true);
    try {
      const payload = blocks.map((b) => {
        const out = { nome: b.nome.trim() };
        if (b.ctrlMode === "list") {
          const f = formsById.get(b.ctrlFormId);
          out.ctrlFormId = b.ctrlFormId;
          out.ctrlUrl = f?.display_url || `https://form.typeform.com/to/${b.ctrlFormId}`;
        } else {
          out.ctrlUrl = b.ctrlUrl.trim();
          const id = extractFormId(out.ctrlUrl);
          if (id) out.ctrlFormId = id;
        }
        if (b.expMode === "list") {
          const f = formsById.get(b.expFormId);
          out.expFormId = b.expFormId;
          out.expUrl = f?.display_url || `https://form.typeform.com/to/${b.expFormId}`;
        } else {
          out.expUrl = b.expUrl.trim();
          const id = extractFormId(out.expUrl);
          if (id) out.expFormId = id;
        }
        if (b.focusRow && b.focusRow.trim()) out.focusRow = b.focusRow.trim();
        return out;
      });
      await saveSurveyApi({
        short_token: shortToken,
        survey_data: JSON.stringify(payload),
      });
      if (onSaved) onSaved();
    } catch {
      alert("Erro ao salvar survey.");
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = (highlighted = false) => ({
    width: "100%",
    background: inputBg,
    border: `1px solid ${highlighted ? C.blue + "60" : modalBdr}`,
    borderRadius: 7,
    padding: "9px 12px",
    color: text,
    fontSize: 13,
    outline: "none",
  });

  const totalCount = blocks.length;
  const emptyForms = !loading && forms.length === 0;

  return (
    <ModalShell onClose={handleClose} theme={theme} maxWidth={620} padding={32} maxHeight="90vh">
      <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4, color: text }}>
        📋 Configurar Survey
      </h2>
      <p style={{ color: muted, fontSize: 14, marginBottom: 6 }}>
        Brand Lift Survey para <strong>{shortToken}</strong>.
      </p>
      <p style={{ color: muted, fontSize: 12, marginBottom: 20, lineHeight: 1.6 }}>
        {scope === "workspace"
          ? <>Escolha cada form direto da pasta <strong>Survey</strong> do Typeform{forms.length ? <> ({forms.length} forms disponíveis)</> : null}. Se o form estiver fora da pasta, use <em>colar URL</em>.</>
          : <>Escolha cada form da sua conta Typeform{forms.length ? <> ({forms.length} disponíveis)</> : null}. Se não encontrar, use <em>colar URL</em>.</>}
      </p>

      {formsError && (
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
          ⚠ Não consegui listar os forms do Typeform ({formsError}). Use o modo <em>colar URL</em> para continuar.
        </div>
      )}

      {loading ? (
        <SkeletonBlock theme={{ inputBg, modalBdr }} />
      ) : (
        blocks.map((block, idx) => (
          <div
            key={idx}
            style={{
              border: `1px solid ${modalBdr}`,
              borderRadius: 10,
              padding: 16,
              marginBottom: 12,
              background: cardBg,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: C.blue,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                }}
              >
                Pergunta {idx + 1}
              </div>
              {blocks.length > 1 && (
                <button
                  onClick={() => removeBlock(idx)}
                  title="Remover pergunta"
                  style={{
                    background: "none",
                    border: "none",
                    color: muted,
                    cursor: "pointer",
                    fontSize: 18,
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  ×
                </button>
              )}
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>Nome da pergunta</div>
              <input
                value={block.nome}
                onChange={(e) => updateBlock(idx, { nome: e.target.value })}
                placeholder="Ex: Ad Recall, Awareness — SP..."
                style={inputStyle(!!block.nome)}
              />
            </div>

            <FormPicker
              label="Form do Grupo Controle"
              forms={forms}
              formsById={formsById}
              mode={block.ctrlMode}
              formId={block.ctrlFormId}
              url={block.ctrlUrl}
              disabled={emptyForms && block.ctrlMode === "list"}
              usageMap={usageMap}
              currentBlockIdx={idx}
              currentSlot="ctrl"
              onChange={(patch) => updateBlock(idx, {
                ctrlMode: patch.mode ?? block.ctrlMode,
                ctrlFormId: patch.formId ?? (patch.mode === "manual" ? "" : block.ctrlFormId),
                ctrlUrl: patch.url ?? block.ctrlUrl,
              })}
              theme={{ text, muted, modalBdr, inputBg, cardBg }}
            />

            <div style={{ height: 10 }} />

            <FormPicker
              label="Form do Grupo Exposto"
              forms={forms}
              formsById={formsById}
              mode={block.expMode}
              formId={block.expFormId}
              url={block.expUrl}
              disabled={emptyForms && block.expMode === "list"}
              usageMap={usageMap}
              currentBlockIdx={idx}
              currentSlot="exp"
              onChange={(patch) => updateBlock(idx, {
                expMode: patch.mode ?? block.expMode,
                expFormId: patch.formId ?? (patch.mode === "manual" ? "" : block.expFormId),
                expUrl: patch.url ?? block.expUrl,
              })}
              theme={{ text, muted, modalBdr, inputBg, cardBg }}
            />

            <FocusRowField
              block={block}
              metaById={metaById}
              onChange={(value) => updateBlock(idx, { focusRow: value })}
              theme={{ text, muted, modalBdr, inputBg }}
              inputStyle={inputStyle}
            />
          </div>
        ))
      )}

      {!loading && (
        <button
          onClick={addBlock}
          style={{
            width: "100%",
            background: "none",
            border: `1px dashed ${modalBdr}`,
            color: C.blue,
            borderRadius: 8,
            padding: "10px 0",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 16,
          }}
        >
          + Adicionar pergunta
        </button>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={handleClose}
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
          disabled={saving || loading}
          onClick={handleSave}
          style={{
            flex: 2,
            background: C.blue,
            color: C.white,
            border: "none",
            padding: 12,
            borderRadius: 8,
            cursor: saving || loading ? "not-allowed" : "pointer",
            fontSize: 14,
            fontWeight: 700,
            opacity: saving || loading ? 0.5 : 1,
          }}
        >
          {saving
            ? "Salvando..."
            : `✓ Salvar ${totalCount > 1 ? totalCount + " perguntas" : "Survey"}`}
        </button>
      </div>
    </ModalShell>
  );
};

// ─── FormPicker ─────────────────────────────────────────────────────────────
// Combobox searchable + toggle pra modo manual (URL crua). Mantém estado
// interno apenas do termo de busca e do open/close — tudo que importa pro
// caller volta via onChange({mode?, formId?, url?}).

function FormPicker({
  label,
  forms,
  formsById,
  mode,
  formId,
  url,
  onChange,
  theme,
  disabled,
  usageMap,
  currentBlockIdx,
  currentSlot,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef(null);

  // Click-outside fecha o dropdown
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selected = formId ? formsById.get(formId) : null;
  const ownConflicts = mode === "list"
    ? conflictsFor(formId, currentBlockIdx, currentSlot, usageMap)
    : [];

  // Limite de render: sem busca, mostra só os 100 mais recentes (a lista vem
  // ordenada por last_updated_at desc do backend). Com 1900 forms no workspace,
  // montar todos no DOM trava o scroll. Quando o admin digita algo, busca em
  // toda a base — string match em 1900 itens é <5ms.
  const RENDER_CAP = 100;
  const { filtered, hiddenCount } = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      return {
        filtered: forms.slice(0, RENDER_CAP),
        hiddenCount: Math.max(0, forms.length - RENDER_CAP),
      };
    }
    const matches = forms.filter((f) => f.title?.toLowerCase().includes(q));
    return { filtered: matches.slice(0, RENDER_CAP), hiddenCount: Math.max(0, matches.length - RENDER_CAP) };
  }, [forms, search]);

  const { text, muted, modalBdr, inputBg, cardBg } = theme;

  const labelRow = (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        marginBottom: 4,
      }}
    >
      <div style={{ fontSize: 12, color: muted }}>{label}</div>
      <button
        onClick={() =>
          onChange({
            mode: mode === "list" ? "manual" : "list",
            url: mode === "list" ? url : "",
            formId: mode === "manual" ? "" : formId,
          })
        }
        style={{
          background: "none",
          border: "none",
          color: C.blue,
          fontSize: 11,
          cursor: "pointer",
          padding: 0,
          fontWeight: 600,
        }}
      >
        {mode === "list" ? "colar URL manual" : "selecionar da pasta"}
      </button>
    </div>
  );

  if (mode === "manual") {
    return (
      <div>
        {labelRow}
        <input
          value={url}
          onChange={(e) => onChange({ url: e.target.value })}
          placeholder="https://hypr-mobi.typeform.com/to/..."
          style={{
            width: "100%",
            background: inputBg,
            border: `1px solid ${url ? C.blue + "60" : modalBdr}`,
            borderRadius: 7,
            padding: "9px 12px",
            color: text,
            fontSize: 12,
            outline: "none",
            fontFamily: "monospace",
          }}
        />
      </div>
    );
  }

  // mode === "list"
  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      {labelRow}

      {/* Botão / chip de seleção */}
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        style={{
          width: "100%",
          background: inputBg,
          border: `1px solid ${selected ? C.blue + "60" : modalBdr}`,
          borderRadius: 7,
          padding: "9px 12px",
          color: text,
          fontSize: 13,
          textAlign: "left",
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          outline: "none",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? (
            selected.title
          ) : (
            <span style={{ color: muted }}>
              {disabled ? "Nenhum form disponível" : "Selecionar form…"}
            </span>
          )}
        </span>
        <span style={{ color: muted, fontSize: 10, flexShrink: 0 }}>
          {selected ? relativeTime(selected.last_updated_at) : "▾"}
        </span>
      </button>

      {ownConflicts.length > 0 && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "#FFB95E",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>⚠</span>
          <span>
            mesmo form em{" "}
            {ownConflicts
              .map((u) => `P${u.blockIdx + 1} ${slotLabel(u.slot)}`)
              .join(", ")}
          </span>
        </div>
      )}

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            background: cardBg,
            border: `1px solid ${modalBdr}`,
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
            zIndex: 10,
            overflow: "hidden",
          }}
        >
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar pelo nome do form…"
            style={{
              width: "100%",
              background: inputBg,
              border: "none",
              borderBottom: `1px solid ${modalBdr}`,
              padding: "9px 12px",
              color: text,
              fontSize: 13,
              outline: "none",
            }}
          />
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {filtered.length === 0 ? (
              <div style={{ padding: "12px 14px", color: muted, fontSize: 12 }}>
                Nenhum form encontrado.
              </div>
            ) : (
              <>
              {filtered.map((f) => {
                const isSel = f.id === formId;
                const conflicts = conflictsFor(f.id, currentBlockIdx, currentSlot, usageMap);
                const hasConflict = conflicts.length > 0;
                const conflictLabel = hasConflict
                  ? (conflicts.length === 1
                      ? `já em P${conflicts[0].blockIdx + 1} · ${slotLabel(conflicts[0].slot)}`
                      : `em uso em ${conflicts.length} slots`)
                  : null;
                return (
                  <button
                    key={f.id}
                    onClick={() => {
                      onChange({ formId: f.id });
                      setOpen(false);
                      setSearch("");
                    }}
                    title={hasConflict
                      ? `Este form já foi usado em: ${conflicts.map((u) => `P${u.blockIdx + 1} ${slotLabel(u.slot)}`).join(", ")}`
                      : ""}
                    style={{
                      width: "100%",
                      background: isSel ? C.blue + "20" : "none",
                      border: "none",
                      padding: "9px 12px",
                      textAlign: "left",
                      cursor: "pointer",
                      color: text,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      borderBottom: `1px solid ${modalBdr}40`,
                      opacity: hasConflict ? 0.55 : 1,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                      }}
                    >
                      {f.title}
                    </span>
                    {hasConflict ? (
                      <span
                        style={{
                          fontSize: 10,
                          flexShrink: 0,
                          color: "#FFB95E",
                          background: "#FFB95E18",
                          border: "1px solid #FFB95E40",
                          borderRadius: 999,
                          padding: "2px 8px",
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {conflictLabel}
                      </span>
                    ) : (
                      <span style={{ color: muted, fontSize: 11, flexShrink: 0 }}>
                        {relativeTime(f.last_updated_at)}
                      </span>
                    )}
                  </button>
                );
              })}
              {hiddenCount > 0 && (
                <div
                  style={{
                    padding: "10px 14px",
                    color: muted,
                    fontSize: 11,
                    textAlign: "center",
                    background: inputBg + "80",
                    fontStyle: "italic",
                  }}
                >
                  + {hiddenCount} {hiddenCount === 1 ? "form" : "forms"} — refine a busca pra ver mais
                </div>
              )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FocusRowField ──────────────────────────────────────────────────────────
// Campo "marca-foco" com fallback inteligente:
// - Se ambos forms (ctrl + exp) são matrix: <select> com união das linhas.
// - Se algum dos dois ainda está carregando: skeleton.
// - Se nenhum dos dois é matrix: campo escondido (não faz sentido em choice).
// - Se a meta falhou ou estamos em modo manual: input livre como fallback.

function FocusRowField({ block, metaById, onChange, theme, inputStyle }) {
  const { text, muted, modalBdr, inputBg } = theme;

  const ctrlMeta = block.ctrlMode === "list" && block.ctrlFormId
    ? metaById.get(block.ctrlFormId) : null;
  const expMeta  = block.expMode  === "list" && block.expFormId
    ? metaById.get(block.expFormId)  : null;

  const anyLoading = (ctrlMeta?.loading) || (expMeta?.loading);
  const eitherMatrix =
    (ctrlMeta && ctrlMeta.type === "matrix") ||
    (expMeta  && expMeta.type  === "matrix");
  const anyManualOrError =
    block.ctrlMode === "manual" || block.expMode === "manual" ||
    (ctrlMeta?.error) || (expMeta?.error);

  // União de linhas, preservando ordem (ctrl primeiro). Trim + de-dup case-sens.
  const rows = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const m of [ctrlMeta, expMeta]) {
      for (const r of (m?.rows || [])) {
        const t = String(r).trim();
        if (t && !seen.has(t)) { seen.add(t); out.push(t); }
      }
    }
    return out;
  }, [ctrlMeta, expMeta]);

  // Detecta se o focusRow salvo não bate com nenhuma linha conhecida — comum
  // após troca de form. Adiciona como opção de "valor antigo" pro admin
  // perceber e re-escolher.
  const focusInRows = !block.focusRow || rows.includes(block.focusRow);

  // Caso 1: matrix detectado em pelo menos um lado, lista carregada
  if (eitherMatrix && !anyLoading && rows.length > 0) {
    return (
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px dashed ${modalBdr}` }}>
        <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>
          Marca-foco para destaque <span style={{ opacity: 0.6 }}>(opcional)</span>
        </div>
        <select
          value={block.focusRow || ""}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: "100%",
            background: inputBg,
            border: `1px solid ${block.focusRow ? C.blue + "60" : modalBdr}`,
            borderRadius: 7,
            padding: "9px 12px",
            color: text,
            fontSize: 13,
            outline: "none",
            cursor: "pointer",
          }}
        >
          <option value="">— sem destaque —</option>
          {!focusInRows && (
            <option value={block.focusRow}>
              {block.focusRow} (não encontrada nas linhas atuais)
            </option>
          )}
          {rows.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <div style={{ fontSize: 11, color: muted, marginTop: 6, lineHeight: 1.5, opacity: 0.85 }}>
          Linhas detectadas a partir do form {ctrlMeta?.type === "matrix" ? "Controle" : "Exposto"}.
          A marca selecionada fica em destaque no relatório.
        </div>
      </div>
    );
  }

  // Caso 2: ainda carregando meta dos forms — skeleton compacto
  if (anyLoading && !anyManualOrError) {
    return (
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px dashed ${modalBdr}` }}>
        <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>
          Marca-foco <span style={{ opacity: 0.6 }}>(carregando linhas do form…)</span>
        </div>
        <div
          style={{
            height: 36, background: inputBg, borderRadius: 7, opacity: 0.5,
            border: `1px solid ${modalBdr}`,
          }}
        />
      </div>
    );
  }

  // Caso 3: modo manual em algum slot OU meta falhou — input livre como fallback
  if (anyManualOrError) {
    return (
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px dashed ${modalBdr}` }}>
        <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>
          Marca-foco para destaque <span style={{ opacity: 0.6 }}>(opcional)</span>
        </div>
        <input
          value={block.focusRow || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Ex: Heineken — destaca essa linha visualmente"
          style={inputStyle(!!block.focusRow)}
        />
        <div style={{ fontSize: 11, color: muted, marginTop: 6, lineHeight: 1.5, opacity: 0.85 }}>
          Pra ver linhas em dropdown, selecione os forms da pasta Survey nos dois grupos. Se for matrix, listamos as marcas automaticamente.
        </div>
      </div>
    );
  }

  // Caso 4: meta carregada mas nenhum dos forms é matrix (choice/other) — esconde
  // o campo. Marca-foco só faz sentido em matrix. Se há focusRow legado salvo,
  // mantém input livre pra não perder o valor silenciosamente.
  if (block.focusRow) {
    return (
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px dashed ${modalBdr}` }}>
        <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>
          Marca-foco <span style={{ opacity: 0.6 }}>(form não é matrix — pode limpar)</span>
        </div>
        <input
          value={block.focusRow}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle(true)}
        />
      </div>
    );
  }

  return null; // nenhum dos forms é matrix e sem focusRow → some o campo
}

// ─── Skeleton ───────────────────────────────────────────────────────────────
function SkeletonBlock({ theme }) {
  const bar = (h, w = "100%") => (
    <div
      style={{
        height: h,
        width: w,
        background: theme.inputBg,
        borderRadius: 6,
        marginBottom: 8,
        opacity: 0.6,
      }}
    />
  );
  return (
    <div
      style={{
        border: `1px solid ${theme.modalBdr}`,
        borderRadius: 10,
        padding: 16,
        marginBottom: 12,
      }}
    >
      {bar(12, "30%")}
      {bar(36)}
      {bar(12, "40%")}
      {bar(36)}
      {bar(12, "40%")}
      {bar(36)}
    </div>
  );
}

export default SurveyModal;
