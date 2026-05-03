import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "../../shared/theme";
import {
  saveSurvey as saveSurveyApi,
  getSurvey as getSurveyApi,
  listTypeformForms,
  fetchTypeformFormMeta,
} from "../../lib/api";
import ModalShell from "./ModalShell";
import { toast } from "../../lib/toast";

/**
 * Modal pra configurar surveys (controle vs. exposto) via API do Typeform.
 *
 * Modelo interno (state): cada bloco tem um array `forms` com 2 itens.
 * Posição no array é só ordem visual; o GRUPO (controle/exposto) é
 * deduzido do sufixo do nome do form (auto-detect) ou definido pelo
 * admin via toggle. Isso elimina a categoria de erro "form do grupo
 * errado no slot errado" porque slot e grupo deixam de ser acoplados.
 *
 * Persistência (BigQuery): continua igual ao formato anterior —
 * { nome, ctrlUrl, expUrl, ctrlFormId, expFormId, focusRow? }. Na hora
 * de salvar, identificamos qual form é controle e qual é exposto pelo
 * groupOverride (ou pelo nome detectado) e mapeamos pra esse formato.
 * Renderer (SurveyTab) não muda.
 */
const EMPTY_BLOCK = (defaultMode = "list") => ({
  nome: "",
  forms: [
    { mode: defaultMode, formId: "", url: "", groupOverride: null },
    { mode: defaultMode, formId: "", url: "", groupOverride: null },
  ],
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

// Heurística leve: identifica grupo (controle/exposto) pelo sufixo do nome.
// Convenção HYPR: forms terminam em "_Controle" ou "_Exposto" (case-insens).
// Forms fora dessa convenção devolvem null e exigem definição manual.
const GROUP_SUFFIX_RE = /_(controle|exposto)\s*$/i;
function parseGroupFromName(title) {
  if (!title) return null;
  const m = String(title).match(GROUP_SUFFIX_RE);
  return m ? m[1].toLowerCase() : null;
}

// Devolve o grupo "efetivo" de um form do bloco. Prioriza override explícito
// (admin clicou em "trocar"), senão tenta detectar pelo nome (lookup em
// formsById se for list-mode, ou via extractFormId+lookup se for manual).
// Retorna null se não há override e não dá pra detectar.
function getFormGroup(form, formsById) {
  if (!form) return null;
  if (form.groupOverride) return form.groupOverride;
  let title = "";
  if (form.formId) {
    const f = formsById.get(form.formId);
    if (f) title = f.title || "";
  } else if (form.url) {
    const id = extractFormId(form.url);
    if (id) {
      const f = formsById.get(id);
      if (f) title = f.title || "";
    }
  }
  return title ? parseGroupFromName(title) : null;
}

const groupLabel = (g) => (g === "controle" ? "Controle" : g === "exposto" ? "Exposto" : "");

// Acha o "irmão" de um form trocando _Controle ↔ _Exposto no nome,
// preservando a capitalização. Devolve o form encontrado ou null.
function findPartnerForm(formId, formsById, forms) {
  if (!formId) return null;
  const f = formsById.get(formId);
  if (!f) return null;
  const m = (f.title || "").match(GROUP_SUFFIX_RE);
  if (!m) return null;
  const isUpper = m[1] === m[1].toUpperCase();
  const isCap = m[1][0] === m[1][0].toUpperCase();
  const swap = m[1].toLowerCase() === "controle" ? "Exposto" : "Controle";
  const swapped = isUpper ? swap.toUpperCase() : isCap ? swap : swap.toLowerCase();
  const partnerTitle = f.title.replace(GROUP_SUFFIX_RE, `_${swapped}`);
  return (
    forms.find((x) => x.id !== formId && x.title === partnerTitle) ||
    forms.find(
      (x) => x.id !== formId && (x.title || "").toLowerCase() === partnerTitle.toLowerCase(),
    ) ||
    null
  );
}

// Constrói mapa formId → [{blockIdx, formIdx, group}] varrendo blocos.
// O `group` (efetivo) é incluído pra rotular conflitos de forma legível.
function buildUsageMap(blocks, formsById) {
  const m = new Map();
  blocks.forEach((b, blockIdx) => {
    b.forms.forEach((form, formIdx) => {
      if (form.mode === "list" && form.formId) {
        const arr = m.get(form.formId) || [];
        const group = getFormGroup(form, formsById);
        arr.push({ blockIdx, formIdx, group });
        m.set(form.formId, arr);
      }
    });
  });
  return m;
}

// Conflitos do form atual (excluindo o slot atual deste bloco).
function conflictsFor(formId, currentBlockIdx, currentFormIdx, usageMap) {
  if (!formId) return [];
  const all = usageMap.get(formId) || [];
  return all.filter(
    (u) => !(u.blockIdx === currentBlockIdx && u.formIdx === currentFormIdx),
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
  // Cache de meta por formId — populado sob demanda quando admin seleciona um form.
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

  const usageMap = useMemo(() => buildUsageMap(blocks, formsById), [blocks, formsById]);

  // ── Lazy-fetch da meta (rows) por formId selecionado em modo list ─────────
  const metaByIdRef = useRef(metaById);
  useEffect(() => { metaByIdRef.current = metaById; });
  const inflightIdsRef = useRef(new Set());

  useEffect(() => {
    const idsNeeded = new Set();
    for (const b of blocks) {
      for (const f of b.forms) {
        if (f.mode === "list" && f.formId) idsNeeded.add(f.formId);
      }
    }
    const current = metaByIdRef.current;
    const missing = [...idsNeeded].filter(
      (id) => !current.has(id) && !inflightIdsRef.current.has(id),
    );
    if (missing.length === 0) return;

    for (const id of missing) inflightIdsRef.current.add(id);
    setMetaById((prev) => {
      const next = new Map(prev);
      for (const id of missing) next.set(id, { loading: true, type: null, rows: [] });
      return next;
    });

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

      const defaultMode = listFailed || formsList.length === 0 ? "manual" : "list";

      // Hidrata blocos com config existente. O formato salvo continua
      // ctrlFormId/expFormId; mapeamos pra forms[0]=controle, forms[1]=exposto
      // e setamos groupOverride explicitamente (assim a classificação salva
      // sobrevive mesmo se o nome do form mudar no Typeform).
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
                forms: [
                  {
                    mode: ctrlMatched ? "list" : "manual",
                    formId: ctrlMatched ? ctrlId : "",
                    url: q.ctrlUrl || "",
                    groupOverride: "controle",
                  },
                  {
                    mode: expMatched ? "list" : "manual",
                    formId: expMatched ? expId : "",
                    url: q.expUrl || "",
                    groupOverride: "exposto",
                  },
                ],
                focusRow: q.focusRow || "",
              };
            });
            setBlocks(hydrated);
          }
        } catch {
          // JSON corrompido — mantém bloco vazio
        }
      } else if (defaultMode === "manual") {
        setBlocks([EMPTY_BLOCK("manual")]);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [shortToken]);

  const handleClose = () => { if (onClose) onClose(); };

  const updateBlock = (idx, patch) =>
    setBlocks((b) => b.map((bl, i) => (i === idx ? { ...bl, ...patch } : bl)));

  const updateForm = (blockIdx, formIdx, patch) =>
    setBlocks((b) => b.map((bl, i) => {
      if (i !== blockIdx) return bl;
      return {
        ...bl,
        forms: bl.forms.map((f, j) => (j === formIdx ? { ...f, ...patch } : f)),
      };
    }));

  const removeBlock = (idx) =>
    setBlocks((b) => (b.length > 1 ? b.filter((_, i) => i !== idx) : b));

  const addBlock = () => setBlocks((b) => [...b, EMPTY_BLOCK()]);

  const handleSave = async () => {
    // Validação
    for (const [i, b] of blocks.entries()) {
      if (!b.nome.trim()) {
        toast.error(`Pergunta ${i + 1}: preencha o nome.`);
        return;
      }
      // Cada form deve ter conteúdo (formId em list, URL válida em manual)
      const formsOk = b.forms.every((f) =>
        f.mode === "list" ? !!f.formId : !!extractFormId(f.url),
      );
      if (!formsOk) {
        toast.error(`Pergunta ${i + 1}: selecione (ou cole URL de) os 2 forms do par.`);
        return;
      }
      // Cada form precisa ter grupo definido (auto ou override)
      const groups = b.forms.map((f) => getFormGroup(f, formsById));
      if (groups.some((g) => g == null)) {
        toast.error(`Pergunta ${i + 1}: defina o grupo (Controle/Exposto) dos forms sem padrão de nome.`);
        return;
      }
      // Os 2 forms devem ter grupos diferentes (1 ctrl + 1 exp)
      const ctrl = b.forms.find((f) => getFormGroup(f, formsById) === "controle");
      const exp  = b.forms.find((f) => getFormGroup(f, formsById) === "exposto");
      if (!ctrl || !exp) {
        toast.error(`Pergunta ${i + 1}: o par precisa ter 1 form Controle e 1 Exposto. Ajuste via "trocar".`);
        return;
      }
    }

    // Detecção de duplicatas (mesmo formId em 2+ slots) — modo list apenas.
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
            .map((u) => `P${u.blockIdx + 1} ${groupLabel(u.group) || `Form ${u.formIdx + 1}`}`)
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
        const ctrl = b.forms.find((f) => getFormGroup(f, formsById) === "controle");
        const exp  = b.forms.find((f) => getFormGroup(f, formsById) === "exposto");
        // Controle
        if (ctrl.mode === "list") {
          const f = formsById.get(ctrl.formId);
          out.ctrlFormId = ctrl.formId;
          out.ctrlUrl = f?.display_url || `https://form.typeform.com/to/${ctrl.formId}`;
        } else {
          out.ctrlUrl = ctrl.url.trim();
          const id = extractFormId(out.ctrlUrl);
          if (id) out.ctrlFormId = id;
        }
        // Exposto
        if (exp.mode === "list") {
          const f = formsById.get(exp.formId);
          out.expFormId = exp.formId;
          out.expUrl = f?.display_url || `https://form.typeform.com/to/${exp.formId}`;
        } else {
          out.expUrl = exp.url.trim();
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
      toast.success(`Survey de ${shortToken} salvo`);
      if (onSaved) onSaved();
    } catch {
      toast.error("Erro ao salvar survey.");
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

  // refresh handler pra usar dentro do FocusRowField via closure
  const buildRefreshMeta = (block) => () => {
    const ids = block.forms
      .filter((f) => f.mode === "list" && f.formId)
      .map((f) => f.formId);
    if (ids.length === 0) return;
    setMetaById((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        next.set(id, { loading: true, type: null, rows: [] });
        inflightIdsRef.current.add(id);
      }
      return next;
    });
    (async () => {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            const meta = await fetchTypeformFormMeta(id, { refresh: true });
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
  };

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
          ? <>Escolha 2 forms do par direto da pasta <strong>Survey</strong> do Typeform{forms.length ? <> ({forms.length} forms disponíveis)</> : null}. O grupo (Controle/Exposto) é detectado automaticamente pelo sufixo do nome — você pode trocar manualmente se precisar.</>
          : <>Escolha 2 forms do par da sua conta Typeform{forms.length ? <> ({forms.length} disponíveis)</> : null}. O grupo é detectado pelo sufixo do nome.</>}
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
        blocks.map((block, idx) => {
          // Validação visual em tempo real do par
          const groups = block.forms.map((f) => getFormGroup(f, formsById));
          const sameGroup = groups[0] && groups[1] && groups[0] === groups[1];

          return (
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

              {block.forms.map((form, fIdx) => {
                // Sugestão: o outro slot tem form, este está vazio, e existe irmão na lista
                const otherFilledIdx = block.forms.findIndex((x, j) => j !== fIdx && x.mode === "list" && x.formId);
                const otherForm = otherFilledIdx >= 0 ? block.forms[otherFilledIdx] : null;
                let suggestion = null;
                if (form.mode === "list" && !form.formId && otherForm) {
                  const partner = findPartnerForm(otherForm.formId, formsById, forms);
                  if (partner) {
                    const used = usageMap.get(partner.id) || [];
                    if (used.length === 0) suggestion = partner;
                  }
                }

                return (
                  <div key={fIdx} style={{ marginBottom: fIdx === 0 ? 10 : 0 }}>
                    <FormPicker
                      label={`Form ${fIdx + 1} do par`}
                      forms={forms}
                      formsById={formsById}
                      mode={form.mode}
                      formId={form.formId}
                      url={form.url}
                      groupOverride={form.groupOverride}
                      effectiveGroup={getFormGroup(form, formsById)}
                      disabled={emptyForms && form.mode === "list"}
                      usageMap={usageMap}
                      currentBlockIdx={idx}
                      currentFormIdx={fIdx}
                      suggestion={suggestion}
                      onChange={(patch) =>
                        updateForm(idx, fIdx, {
                          mode: patch.mode ?? form.mode,
                          formId: patch.formId ?? (patch.mode === "manual" ? "" : form.formId),
                          url: patch.url ?? form.url,
                          // Quando o admin troca o form por outro pela lista,
                          // limpa override pra deixar a auto-detecção valer.
                          ...(patch.formId !== undefined && patch.formId !== form.formId
                            ? { groupOverride: null }
                            : {}),
                          ...(patch.groupOverride !== undefined
                            ? { groupOverride: patch.groupOverride }
                            : {}),
                        })
                      }
                      theme={{ text, muted, modalBdr, inputBg, cardBg }}
                    />
                  </div>
                );
              })}

              {sameGroup && (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 11,
                    color: "#FFB95E",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span>⚠</span>
                  <span>
                    os 2 forms estão como <strong>{groupLabel(groups[0])}</strong>. Use o botão <em>trocar</em> em um deles pra formar o par Controle/Exposto.
                  </span>
                </div>
              )}

              <FocusRowField
                block={block}
                metaById={metaById}
                onChange={(value) => updateBlock(idx, { focusRow: value })}
                onRefreshMeta={buildRefreshMeta(block)}
                theme={{ text, muted, modalBdr, inputBg }}
                inputStyle={inputStyle}
              />
            </div>
          );
        })
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
// Picker neutro (sem rótulo fixo de Controle/Exposto). Mostra chip do grupo
// efetivo (auto-detectado pelo nome ou override manual) com botão "trocar".

function FormPicker({
  label,
  forms,
  formsById,
  mode,
  formId,
  url,
  groupOverride,
  effectiveGroup,        // grupo computado pelo parent (controle/exposto/null)
  onChange,
  theme,
  disabled,
  usageMap,
  currentBlockIdx,
  currentFormIdx,
  suggestion,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef(null);

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
    ? conflictsFor(formId, currentBlockIdx, currentFormIdx, usageMap)
    : [];

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

  // Chip de grupo: aparece DEPOIS do form ser selecionado (list) ou da URL
  // ser preenchida (manual). Mostra:
  //   - "Controle" / "Exposto" quando há grupo efetivo
  //   - "definir grupo" + dropdown quando não há (sem sufixo no nome)
  // Botão "trocar" inverte o override (controle ↔ exposto).
  const hasContent = mode === "list" ? !!formId : !!extractFormId(url);
  const groupChip = hasContent ? (
    <div
      style={{
        marginTop: 6,
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      {effectiveGroup ? (
        <>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: "3px 9px",
              borderRadius: 999,
              background: effectiveGroup === "controle" ? "#27AE6020" : `${C.blue}20`,
              color: effectiveGroup === "controle" ? "#27AE60" : C.blue,
              border: `1px solid ${effectiveGroup === "controle" ? "#27AE60" : C.blue}40`,
            }}
          >
            {groupLabel(effectiveGroup)}
            {groupOverride ? "" : " (auto)"}
          </span>
          <button
            type="button"
            onClick={() =>
              onChange({
                groupOverride: effectiveGroup === "controle" ? "exposto" : "controle",
              })
            }
            style={{
              background: "none",
              border: "none",
              color: C.blue,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              padding: 0,
            }}
          >
            ↔ trocar para {effectiveGroup === "controle" ? "Exposto" : "Controle"}
          </button>
        </>
      ) : (
        <>
          <span style={{ fontSize: 11, color: "#FFB95E" }}>
            ⚠ grupo não detectado
          </span>
          <button
            type="button"
            onClick={() => onChange({ groupOverride: "controle" })}
            style={chipBtn("#27AE60")}
          >
            Controle
          </button>
          <button
            type="button"
            onClick={() => onChange({ groupOverride: "exposto" })}
            style={chipBtn(C.blue)}
          >
            Exposto
          </button>
        </>
      )}
    </div>
  ) : null;

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
        {groupChip}
      </div>
    );
  }

  // mode === "list"
  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      {labelRow}

      {!selected && suggestion && (
        <button
          type="button"
          onClick={() => onChange({ formId: suggestion.id })}
          title={`Usar ${suggestion.title}`}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 10px",
            marginBottom: 6,
            background: `${C.blue}10`,
            border: `1px dashed ${C.blue}60`,
            borderRadius: 7,
            color: C.blue,
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span aria-hidden style={{ fontSize: 12 }}>💡</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            par detectado: <span style={{ fontWeight: 700 }}>{suggestion.title}</span>
          </span>
          <span style={{ fontWeight: 700, flexShrink: 0 }}>usar →</span>
        </button>
      )}

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

      {groupChip}

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
              .map((u) => `P${u.blockIdx + 1} ${groupLabel(u.group) || `Form ${u.formIdx + 1}`}`)
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
                  const conflicts = conflictsFor(f.id, currentBlockIdx, currentFormIdx, usageMap);
                  const hasConflict = conflicts.length > 0;
                  const conflictLabel = hasConflict
                    ? (conflicts.length === 1
                        ? `já em P${conflicts[0].blockIdx + 1} · ${groupLabel(conflicts[0].group) || `Form ${conflicts[0].formIdx + 1}`}`
                        : `em uso em ${conflicts.length} slots`)
                    : null;
                  const itemGroup = parseGroupFromName(f.title);
                  return (
                    <button
                      key={f.id}
                      onClick={() => {
                        onChange({ formId: f.id });
                        setOpen(false);
                        setSearch("");
                      }}
                      title={hasConflict
                        ? `Este form já foi usado em: ${conflicts.map((u) => `P${u.blockIdx + 1} ${groupLabel(u.group) || `Form ${u.formIdx + 1}`}`).join(", ")}`
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
                        gap: 10,
                        borderBottom: `1px solid ${modalBdr}40`,
                        opacity: hasConflict ? 0.55 : 1,
                      }}
                    >
                      {itemGroup ? (
                        <span
                          style={{
                            flexShrink: 0,
                            width: 18,
                            height: 18,
                            borderRadius: 4,
                            fontSize: 10,
                            fontWeight: 700,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            background: itemGroup === "controle" ? "#27AE6020" : `${C.blue}20`,
                            color: itemGroup === "controle" ? "#27AE60" : C.blue,
                            border: `1px solid ${itemGroup === "controle" ? "#27AE60" : C.blue}40`,
                          }}
                          aria-label={groupLabel(itemGroup)}
                          title={groupLabel(itemGroup)}
                        >
                          {itemGroup === "controle" ? "C" : "E"}
                        </span>
                      ) : (
                        <span style={{ flexShrink: 0, width: 18 }} aria-hidden />
                      )}
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

// Estilo dos botões "Controle"/"Exposto" no chip de "definir grupo"
function chipBtn(color) {
  return {
    background: `${color}15`,
    border: `1px solid ${color}50`,
    color,
    fontSize: 11,
    fontWeight: 700,
    padding: "3px 9px",
    borderRadius: 999,
    cursor: "pointer",
  };
}

// ─── FocusRowField ──────────────────────────────────────────────────────────
// Resposta-foco para destaque visual no relatório. Sempre visível.
//   - Loading da meta (sem rows ainda) → skeleton
//   - Rows conhecidos → <select>
//   - Sem rows (manual em ambos OU tipos sem opções fixas) → input livre

function FocusRowField({ block, metaById, onChange, onRefreshMeta, theme, inputStyle }) {
  const { text, muted, modalBdr, inputBg } = theme;

  // Iterando forms[] genericamente — não importa qual é controle/exposto.
  const metas = block.forms.map((f) =>
    f.mode === "list" && f.formId ? metaById.get(f.formId) : null,
  );

  const rows = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const m of metas) {
      for (const r of (m?.rows || [])) {
        const t = String(r).trim();
        if (t && !seen.has(t)) { seen.add(t); out.push(t); }
      }
    }
    return out;
  }, [metas]);

  const anyLoading = metas.some((m) => m?.loading);
  const noListSlot = block.forms.every((f) => f.mode !== "list");

  const wrapperStyle = {
    marginTop: 12,
    paddingTop: 10,
    borderTop: `1px dashed ${modalBdr}`,
  };

  if (anyLoading && rows.length === 0) {
    return (
      <div style={wrapperStyle}>
        <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>
          Resposta-foco <span style={{ opacity: 0.6 }}>(carregando opções do form…)</span>
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

  if (rows.length > 0) {
    const focusInRows = !block.focusRow || rows.includes(block.focusRow);
    const sourceLabel = metas.some((m) => m?.type === "matrix")
      ? "linhas detectadas no form (matrix)"
      : "opções de resposta detectadas no form";
    return (
      <div style={wrapperStyle}>
        <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>
          Resposta-foco para destaque <span style={{ opacity: 0.6 }}>(opcional)</span>
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
              {block.focusRow} (não encontrada nas opções atuais)
            </option>
          )}
          {rows.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <div style={{ fontSize: 11, color: muted, marginTop: 6, lineHeight: 1.5, opacity: 0.85 }}>
          {sourceLabel}. A opção selecionada fica em destaque visual no relatório.
        </div>
      </div>
    );
  }

  return (
    <div style={wrapperStyle}>
      <div style={{ fontSize: 12, color: muted, marginBottom: 4 }}>
        Resposta-foco para destaque <span style={{ opacity: 0.6 }}>(opcional)</span>
      </div>
      <input
        value={block.focusRow || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Ex: Sim — destaca essa resposta visualmente"
        style={inputStyle(!!block.focusRow)}
      />
      <div
        style={{
          fontSize: 11,
          marginTop: 6,
          lineHeight: 1.5,
          color: muted,
          opacity: 0.85,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span>
          {noListSlot
            ? "Selecione os forms da pasta Survey pra ver as opções em dropdown."
            : "Não consegui detectar opções deste form — digite manualmente ou tente recarregar."}
        </span>
        {!noListSlot && onRefreshMeta && (
          <button
            type="button"
            onClick={onRefreshMeta}
            style={{
              background: "none",
              border: "none",
              color: C.blue,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              padding: 0,
              whiteSpace: "nowrap",
            }}
          >
            ↻ recarregar opções
          </button>
        )}
      </div>
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
