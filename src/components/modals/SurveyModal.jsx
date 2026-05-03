import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "../../shared/theme";
import {
  saveSurvey as saveSurveyApi,
  getSurvey as getSurveyApi,
  listTypeformForms,
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
          ? <>Escolha cada form direto da pasta <strong>Survey</strong> do Typeform (últimos 120 dias). Se o form estiver fora da pasta, use o modo <em>colar URL</em>.</>
          : <>Escolha cada form da sua conta Typeform (últimos 120 dias). Se não encontrar, use <em>colar URL</em>.</>}
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
              onChange={(patch) => updateBlock(idx, {
                expMode: patch.mode ?? block.expMode,
                expFormId: patch.formId ?? (patch.mode === "manual" ? "" : block.expFormId),
                expUrl: patch.url ?? block.expUrl,
              })}
              theme={{ text, muted, modalBdr, inputBg, cardBg }}
            />

            <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px dashed ${modalBdr}` }}>
              <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>
                Marca-foco para destaque <span style={{ opacity: 0.6 }}>(opcional)</span>
              </div>
              <input
                value={block.focusRow || ""}
                onChange={(e) => updateBlock(idx, { focusRow: e.target.value })}
                placeholder="Ex: Heineken — destaca essa linha visualmente"
                style={inputStyle(!!block.focusRow)}
              />
              <div
                style={{
                  fontSize: 11,
                  color: muted,
                  marginTop: 6,
                  lineHeight: 1.5,
                  opacity: 0.85,
                }}
              >
                Para forms tipo matrix, a marca digitada acima fica em destaque visual no relatório.
              </div>
            </div>
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

function FormPicker({ label, forms, formsById, mode, formId, url, onChange, theme, disabled }) {
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return forms;
    return forms.filter((f) => f.title?.toLowerCase().includes(q));
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
              filtered.map((f) => {
                const isSel = f.id === formId;
                return (
                  <button
                    key={f.id}
                    onClick={() => {
                      onChange({ formId: f.id });
                      setOpen(false);
                      setSearch("");
                    }}
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
                    <span style={{ color: muted, fontSize: 11, flexShrink: 0 }}>
                      {relativeTime(f.last_updated_at)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
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
