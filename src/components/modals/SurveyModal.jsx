import { useEffect, useMemo, useRef, useState } from "react";
import { C } from "../../shared/theme";
import {
  saveSurvey as saveSurveyApi,
  getSurvey as getSurveyApi,
  listTypeformForms,
  fetchTypeformFormMeta,
  fetchTypeformViaProxy,
} from "../../lib/api";
import ModalShell from "./ModalShell";
import { toast } from "../../lib/toast";
import { parseSurveyConfig, serializeSurveyConfig, sumCounts } from "../../shared/surveyConfig";
import { parseVideoaskFile } from "../../lib/videoaskParser";

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
// Estado de um upload VideoAsk parseado. Persiste no bloco mesmo quando
// tipo=typeform, pra não perder dados se admin alternar.
const EMPTY_VIDEOASK_SIDE = () => ({
  fileName: "",
  question: "",   // header "Q1. ..." extraído do XLSX
  counts: {},     // {resposta: n}
  total: 0,
  firstAt: null,  // ISO string da 1ª resposta (informativo)
  lastAt: null,
});

const EMPTY_BLOCK = (defaultMode = "list") => ({
  nome: "",
  tipo: "typeform", // "typeform" | "videoask"
  forms: [
    { mode: defaultMode, formId: "", url: "", groupOverride: null },
    { mode: defaultMode, formId: "", url: "", groupOverride: null },
  ],
  videoask: {
    ctrl: EMPTY_VIDEOASK_SIDE(),
    exp: EMPTY_VIDEOASK_SIDE(),
  },
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

// Detecta o grupo (controle/exposto) tokenizando o nome do form e casando
// cada token contra aliases conhecidos + Levenshtein. Robusto contra:
//  - posição (sufixo, prefixo, meio): "..._Controle_Abr26" funciona
//  - typos: "Cotrole", "Expsto", "Controlle"
//  - variantes: "Control", "Exposed", "Expuesto"
//  - acentos e caixa
const GROUP_ALIASES = {
  controle: ["controle", "control", "ctrl", "kontrol", "controlado"],
  exposto: ["exposto", "exposed", "exposta", "expuesto", "expose", "expostos"],
};

// Tokeniza: NFD pra tirar acento, lowercase, separa por _ - espaço.
function normalizeAndTokenize(title) {
  return String(title || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter(Boolean);
}

// Distância de Levenshtein. Strings curtas (< 32 chars) — barato.
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  let prev = new Array(bl + 1);
  let cur = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[bl];
}

// Classifica 1 token. Retorna "controle" / "exposto" / null.
// Igualdade exata + Levenshtein. Tolerância proporcional ao tamanho do
// alias, no máximo 2. Tokens curtos (< 4 chars) só casam por igualdade
// exata pra evitar falso positivo (ex: "ctrl" contra qualquer 4-letras).
function classifyToken(token) {
  if (!token) return null;
  let best = null;
  let bestScore = Infinity;
  for (const group of Object.keys(GROUP_ALIASES)) {
    for (const alias of GROUP_ALIASES[group]) {
      if (token === alias) return group;
      if (token.length < 4 || alias.length < 4) continue;
      // Tolerância apertada: só aceita 2 edits em aliases longos (>= 9 chars,
      // ex: "controlado"). Pra aliases de 7-8 chars (controle, exposto,
      // control, exposed) só 1 edit — evita casar "centro" ou "contrato".
      const tol = alias.length >= 9 ? 2 : 1;
      const d = levenshtein(token, alias);
      if (d <= tol && d < bestScore) { best = group; bestScore = d; }
    }
  }
  return best;
}

// Casa o nome inteiro: percorre tokens e devolve o primeiro match com
// o índice do token (pra reconstruir o par trocando só esse token).
function matchGroupInTitle(title) {
  const tokens = normalizeAndTokenize(title);
  for (let i = 0; i < tokens.length; i++) {
    const g = classifyToken(tokens[i]);
    if (g) return { group: g, tokenIdx: i, tokens };
  }
  return null;
}

function parseGroupFromName(title) {
  return matchGroupInTitle(title)?.group || null;
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

// Acha o "irmão" do form: procura outro form com os MESMOS tokens (exceto
// o token de grupo) e grupo oposto. Tolera diferença de 1 token nos demais
// pra absorver typo no sufixo de data, etc.
function findPartnerForm(formId, formsById, forms) {
  if (!formId) return null;
  const f = formsById.get(formId);
  if (!f) return null;
  const myMatch = matchGroupInTitle(f.title || "");
  if (!myMatch) return null;
  const targetGroup = myMatch.group === "controle" ? "exposto" : "controle";
  const myRest = myMatch.tokens.filter((_, i) => i !== myMatch.tokenIdx);

  let best = null;
  let bestMismatches = Infinity;
  for (const cand of forms) {
    if (cand.id === formId) continue;
    const cm = matchGroupInTitle(cand.title || "");
    if (!cm || cm.group !== targetGroup) continue;
    const candRest = cm.tokens.filter((_, i) => i !== cm.tokenIdx);
    if (Math.abs(candRest.length - myRest.length) > 1) continue;

    const len = Math.max(myRest.length, candRest.length);
    let mismatches = 0;
    for (let i = 0; i < len; i++) {
      if (myRest[i] !== candRest[i]) mismatches++;
    }
    if (mismatches < bestMismatches) {
      best = cand;
      bestMismatches = mismatches;
      if (mismatches === 0) break;
    }
  }
  return bestMismatches <= 1 ? best : null;
}

// Constrói mapa formId → [{blockIdx, formIdx, group}] varrendo blocos.
// O `group` (efetivo) é incluído pra rotular conflitos de forma legível.
function buildUsageMap(blocks, formsById) {
  const m = new Map();
  blocks.forEach((b, blockIdx) => {
    if (b.tipo === "videoask") return; // duplicatas só fazem sentido em Typeform
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
  // Período salvo — exibido na visão do cliente. null = cliente vê tudo (default).
  // Strings YYYY-MM-DD pra evitar problemas de timezone com Date.
  const [clientRange, setClientRange] = useState({ from: "", to: "" });
  // Cache de first/last response_at por formId — alimenta o hint "primeira
  // resposta em DD/MM" próximo aos inputs de data. Carregado sob demanda
  // (quando admin seleciona forms) via typeform_proxy.
  const [responseSpanByForm, setResponseSpanByForm] = useState(() => new Map());

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
      if (b.tipo === "videoask") continue;
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

  // ── Lazy-fetch de first/last response_at por formId pra hint do clientRange.
  // Cada form vai precisar 1 chamada ao typeform_proxy (sem range) — pesado
  // se o form tem milhares de respostas, mas roda só na 1ª seleção e o
  // resultado é cached pelo backend (quase de graça em hits subsequentes).
  const responseSpanRef = useRef(responseSpanByForm);
  useEffect(() => { responseSpanRef.current = responseSpanByForm; });
  const responseSpanInflightRef = useRef(new Set());
  useEffect(() => {
    const idsNeeded = new Set();
    for (const b of blocks) {
      if (b.tipo === "videoask") continue;
      for (const f of b.forms) {
        const id = f.mode === "list" ? f.formId : extractFormId(f.url);
        if (id) idsNeeded.add(id);
      }
    }
    const current = responseSpanRef.current;
    const missing = [...idsNeeded].filter(
      (id) => !current.has(id) && !responseSpanInflightRef.current.has(id),
    );
    if (missing.length === 0) return;
    for (const id of missing) responseSpanInflightRef.current.add(id);
    (async () => {
      const results = await Promise.all(
        missing.map(async (id) => {
          try {
            const url = `https://form.typeform.com/to/${id}`;
            const data = await fetchTypeformViaProxy(url, null);
            return [id, {
              first: data?.first_response_at || null,
              last: data?.last_response_at || null,
              total: typeof data?.total === "number" ? data.total : null,
            }];
          } catch {
            return [id, { first: null, last: null, total: null, error: true }];
          }
        }),
      );
      setResponseSpanByForm((prev) => {
        const next = new Map(prev);
        for (const [id, val] of results) {
          next.set(id, val);
          responseSpanInflightRef.current.delete(id);
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

      // Hidrata blocos com config existente. O formato salvo aceita v1
      // (array puro), v2 ({version:2, questions, clientRange}) e v3
      // (questions com tipo="videoask"); todos normalizados via parseSurveyConfig.
      if (savedRaw.status === "fulfilled" && savedRaw.value) {
        const cfg = parseSurveyConfig(savedRaw.value);
        if (cfg && Array.isArray(cfg.questions) && cfg.questions.length) {
          const idsInList = new Set(formsList.map((f) => f.id));
          const hydrated = cfg.questions.map((q) => {
            const isVideoask = q.tipo === "videoask";
            const ctrlId = q.ctrlFormId || extractFormId(q.ctrlUrl);
            const expId  = q.expFormId  || extractFormId(q.expUrl);
            const ctrlMatched = ctrlId && idsInList.has(ctrlId);
            const expMatched  = expId  && idsInList.has(expId);
            return {
              nome: q.nome || "",
              tipo: isVideoask ? "videoask" : "typeform",
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
              videoask: {
                ctrl: isVideoask
                  ? {
                      fileName: q.ctrlFileName || "",
                      question: q.ctrlQuestion || "",
                      counts: q.ctrlCounts || {},
                      total: sumCounts(q.ctrlCounts),
                      firstAt: q.ctrlFirstAt || null,
                      lastAt: q.ctrlLastAt || null,
                    }
                  : EMPTY_VIDEOASK_SIDE(),
                exp: isVideoask
                  ? {
                      fileName: q.expFileName || "",
                      question: q.expQuestion || "",
                      counts: q.expCounts || {},
                      total: sumCounts(q.expCounts),
                      firstAt: q.expFirstAt || null,
                      lastAt: q.expLastAt || null,
                    }
                  : EMPTY_VIDEOASK_SIDE(),
              },
              focusRow: q.focusRow || "",
            };
          });
          setBlocks(hydrated);
          if (cfg.clientRange) {
            setClientRange({ from: cfg.clientRange.from, to: cfg.clientRange.to });
          }
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
      if (b.tipo === "videoask") {
        const ctrlOk = b.videoask?.ctrl?.fileName && sumCounts(b.videoask.ctrl.counts) > 0;
        const expOk  = b.videoask?.exp?.fileName  && sumCounts(b.videoask.exp.counts)  > 0;
        if (!ctrlOk || !expOk) {
          toast.error(`Pergunta ${i + 1}: envie os 2 arquivos do VideoAsk (Controle e Exposto) com respostas válidas.`);
          return;
        }
        continue;
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

    // Validação do clientRange — aceita totalmente vazio (cliente vê tudo)
    // ou totalmente preenchido com from <= to. Preenchido parcial é erro.
    const cr = { from: clientRange.from?.trim() || "", to: clientRange.to?.trim() || "" };
    if ((cr.from && !cr.to) || (!cr.from && cr.to)) {
      toast.error("Período exibido ao cliente: preencha as duas datas ou deixe ambas vazias.");
      return;
    }
    if (cr.from && cr.to && cr.from > cr.to) {
      toast.error("Período exibido ao cliente: a data inicial não pode ser maior que a final.");
      return;
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
        if (b.tipo === "videoask") {
          out.tipo = "videoask";
          out.ctrlCounts = b.videoask.ctrl.counts || {};
          out.expCounts = b.videoask.exp.counts || {};
          // Metadata informativa — usada na UI admin e no badge do report.
          // Não afeta o cálculo de lift (só counts importa).
          if (b.videoask.ctrl.fileName) out.ctrlFileName = b.videoask.ctrl.fileName;
          if (b.videoask.exp.fileName)  out.expFileName  = b.videoask.exp.fileName;
          if (b.videoask.ctrl.question) out.ctrlQuestion = b.videoask.ctrl.question;
          if (b.videoask.exp.question)  out.expQuestion  = b.videoask.exp.question;
          if (b.videoask.ctrl.firstAt)  out.ctrlFirstAt  = b.videoask.ctrl.firstAt;
          if (b.videoask.ctrl.lastAt)   out.ctrlLastAt   = b.videoask.ctrl.lastAt;
          if (b.videoask.exp.firstAt)   out.expFirstAt   = b.videoask.exp.firstAt;
          if (b.videoask.exp.lastAt)    out.expLastAt    = b.videoask.exp.lastAt;
          if (b.focusRow && b.focusRow.trim()) out.focusRow = b.focusRow.trim();
          return out;
        }
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
      const rangeOut = cr.from && cr.to ? cr : null;
      await saveSurveyApi({
        short_token: shortToken,
        survey_data: serializeSurveyConfig(payload, rangeOut),
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
                  gap: 10,
                  flexWrap: "wrap",
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
                <TipoToggle
                  value={block.tipo}
                  onChange={(t) => updateBlock(idx, { tipo: t })}
                  theme={{ text, muted, modalBdr, inputBg }}
                />
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

              {block.tipo === "videoask" ? (
                <VideoaskUploads
                  videoask={block.videoask}
                  onChange={(side, patch) =>
                    setBlocks((bs) =>
                      bs.map((bl, i) => {
                        if (i !== idx) return bl;
                        return {
                          ...bl,
                          videoask: {
                            ...bl.videoask,
                            [side]: { ...bl.videoask[side], ...patch },
                          },
                        };
                      }),
                    )
                  }
                  theme={{ text, muted, modalBdr, inputBg, cardBg }}
                />
              ) : (
                <>
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
                </>
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

      {!loading && (
        <ClientRangeField
          value={clientRange}
          onChange={setClientRange}
          spanHint={getCombinedResponseSpan(blocks, formsById, responseSpanByForm)}
          theme={{ text, muted, modalBdr, inputBg, cardBg }}
        />
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

// Combina spans de respostas de todos os forms/arquivos do bloco em um único
// intervalo (min de firsts, max de lasts) — pra mostrar ao admin "tem dados
// de A a B" como hint pra escolher o clientRange.
function getCombinedResponseSpan(blocks, formsById, spanByForm) {
  let firstISO = null;
  let lastISO = null;
  let totalForms = 0;
  let formsWithData = 0;
  for (const b of blocks) {
    if (b.tipo === "videoask") {
      // VideoAsk: timestamps já vieram do XLSX parser, embutidos no bloco
      for (const side of ["ctrl", "exp"]) {
        const s = b.videoask?.[side];
        if (!s?.fileName) continue;
        totalForms++;
        if (!s.firstAt && !s.lastAt) continue;
        formsWithData++;
        if (s.firstAt && (!firstISO || s.firstAt < firstISO)) firstISO = s.firstAt;
        if (s.lastAt && (!lastISO || s.lastAt > lastISO)) lastISO = s.lastAt;
      }
      continue;
    }
    for (const f of b.forms) {
      const id = f.mode === "list" ? f.formId : extractFormId(f.url);
      if (!id) continue;
      totalForms++;
      const span = spanByForm.get(id);
      if (!span || (!span.first && !span.last)) continue;
      formsWithData++;
      if (span.first && (!firstISO || span.first < firstISO)) firstISO = span.first;
      if (span.last && (!lastISO || span.last > lastISO)) lastISO = span.last;
    }
  }
  return { firstISO, lastISO, totalForms, formsWithData };
}

// "2026-04-15T13:45:00Z" → "15/04/2026" (em BRT — soma offset de -3h pra
// não passar pro dia anterior). Retorna "" se inválido.
function fmtIsoToBRDate(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  // Converte UTC pra BRT (-03:00) somando -3h aos millis e formatando como UTC
  const brt = new Date(t - 3 * 3600 * 1000);
  const dd = String(brt.getUTCDate()).padStart(2, "0");
  const mm = String(brt.getUTCMonth() + 1).padStart(2, "0");
  const yy = brt.getUTCFullYear();
  return `${dd}/${mm}/${yy}`;
}

// ─── ClientRangeField ──────────────────────────────────────────────────────
// Bloco de configuração do período exibido ao cliente. Usa <input type="date">
// nativo (YYYY-MM-DD direto, sem dependência de timezone). Mostra hint de
// primeira/última resposta dos forms selecionados quando disponível.

function ClientRangeField({ value, onChange, spanHint, theme }) {
  const { text, muted, modalBdr, inputBg, cardBg } = theme;
  const hasSpan = !!(spanHint?.firstISO || spanHint?.lastISO);
  const hint = hasSpan
    ? `Primeira resposta em ${fmtIsoToBRDate(spanHint.firstISO) || "—"}, última em ${fmtIsoToBRDate(spanHint.lastISO) || "—"}.`
    : spanHint?.totalForms > 0
      ? "Sem respostas registradas ainda — você ainda pode escolher um período pra exibir."
      : "Selecione os forms acima pra ver as datas disponíveis de resposta.";
  const isSet = !!(value.from && value.to);

  return (
    <div
      style={{
        background: cardBg,
        border: `1px solid ${modalBdr}`,
        borderRadius: 10,
        padding: 14,
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, letterSpacing: 1, textTransform: "uppercase" }}>
          Período exibido ao cliente
        </div>
        <span style={{ fontSize: 11, color: muted }}>(opcional)</span>
        {isSet && (
          <button
            type="button"
            onClick={() => onChange({ from: "", to: "" })}
            style={{
              marginLeft: "auto",
              background: "none",
              border: "none",
              color: C.blue,
              fontSize: 11,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            limpar
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: muted, marginBottom: 10, lineHeight: 1.5 }}>
        Restringe o que o cliente vê na aba Survey àquele intervalo. Não afeta sua visão de admin (você continua vendo todas as respostas, com filtros próprios).
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: muted, flex: "1 1 140px" }}>
          De
          <input
            type="date"
            value={value.from || ""}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
            style={{
              background: inputBg,
              color: text,
              border: `1px solid ${modalBdr}`,
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 13,
              fontFamily: "inherit",
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: muted, flex: "1 1 140px" }}>
          Até
          <input
            type="date"
            value={value.to || ""}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
            style={{
              background: inputBg,
              color: text,
              border: `1px solid ${modalBdr}`,
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 13,
              fontFamily: "inherit",
            }}
          />
        </label>
      </div>
      <div style={{ fontSize: 11, color: muted, marginTop: 8, fontStyle: "italic" }}>
        {hint}
      </div>
    </div>
  );
}

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

// ─── TipoToggle ─────────────────────────────────────────────────────────────
// Segmented control no header do bloco — alterna entre Typeform (forms da
// pasta Survey via API) e VideoAsk (upload de XLSX exportado da plataforma).
// Estado do tipo inativo é preservado no bloco — alternar não destrói dados.

function TipoToggle({ value, onChange, theme }) {
  const { muted, modalBdr, inputBg } = theme;
  const base = {
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    border: "none",
    background: "transparent",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  };
  return (
    <div
      style={{
        display: "inline-flex",
        background: inputBg,
        border: `1px solid ${modalBdr}`,
        borderRadius: 999,
        padding: 2,
      }}
    >
      <button
        type="button"
        onClick={() => onChange("typeform")}
        style={{
          ...base,
          borderRadius: 999,
          background: value === "typeform" ? C.blue : "transparent",
          color: value === "typeform" ? "#fff" : muted,
        }}
      >
        Typeform
      </button>
      <button
        type="button"
        onClick={() => onChange("videoask")}
        style={{
          ...base,
          borderRadius: 999,
          background: value === "videoask" ? "#8E44AD" : "transparent",
          color: value === "videoask" ? "#fff" : muted,
        }}
      >
        VideoAsk
      </button>
    </div>
  );
}

// ─── VideoaskUploads ────────────────────────────────────────────────────────
// 2 uploads (Controle + Exposto) que aceitam o XLSX exportado pela VideoAsk.
// Parser local (read-excel-file) extrai a 1ª coluna de pergunta (header
// /^Q\d+\./) e conta valores categóricos. Preview mostra contagens parseadas.

function VideoaskUploads({ videoask, onChange, theme }) {
  const { text, muted, modalBdr, inputBg, cardBg } = theme;

  // Union de keys ctrl + exp pra preview alinhado (mesma ordem nos 2 lados)
  const allLabels = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const k of Object.keys(videoask?.ctrl?.counts || {})) {
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
    for (const k of Object.keys(videoask?.exp?.counts || {})) {
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out;
  }, [videoask]);

  const ctrlTotal = videoask?.ctrl?.total || 0;
  const expTotal  = videoask?.exp?.total  || 0;
  const hasBoth = ctrlTotal > 0 && expTotal > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <UploadSlot
        side="ctrl"
        label="Arquivo Controle"
        accentColor="#27AE60"
        state={videoask?.ctrl}
        onParsed={(parsed) => onChange("ctrl", parsed)}
        onClear={() => onChange("ctrl", { fileName: "", question: "", counts: {}, total: 0, firstAt: null, lastAt: null })}
        theme={{ text, muted, modalBdr, inputBg }}
      />
      <UploadSlot
        side="exp"
        label="Arquivo Exposto"
        accentColor={C.blue}
        state={videoask?.exp}
        onParsed={(parsed) => onChange("exp", parsed)}
        onClear={() => onChange("exp", { fileName: "", question: "", counts: {}, total: 0, firstAt: null, lastAt: null })}
        theme={{ text, muted, modalBdr, inputBg }}
      />

      {hasBoth && (
        <div
          style={{
            marginTop: 4,
            background: cardBg,
            border: `1px solid ${modalBdr}`,
            borderRadius: 8,
            padding: "10px 12px",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: muted,
              letterSpacing: 1,
              textTransform: "uppercase",
              marginBottom: 8,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>Preview das contagens</span>
            <span>
              {ctrlTotal.toLocaleString("pt-BR")} ctrl ·{" "}
              {expTotal.toLocaleString("pt-BR")} exp
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", rowGap: 4, columnGap: 14, fontSize: 12 }}>
            <div style={{ fontWeight: 700, color: muted, fontSize: 10, textTransform: "uppercase" }}>Resposta</div>
            <div style={{ fontWeight: 700, color: muted, fontSize: 10, textTransform: "uppercase", textAlign: "right" }}>Ctrl</div>
            <div style={{ fontWeight: 700, color: muted, fontSize: 10, textTransform: "uppercase", textAlign: "right" }}>Exp</div>
            {allLabels.map((label) => {
              const c = Number(videoask?.ctrl?.counts?.[label] || 0);
              const e = Number(videoask?.exp?.counts?.[label]  || 0);
              const cPct = ctrlTotal > 0 ? Math.round((c / ctrlTotal) * 100) : 0;
              const ePct = expTotal  > 0 ? Math.round((e / expTotal)  * 100) : 0;
              return (
                <div key={`row-${label}`} style={{ display: "contents" }}>
                  <div style={{ color: text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
                  <div style={{ color: text, textAlign: "right" }}>{c} <span style={{ color: muted, fontSize: 10 }}>({cPct}%)</span></div>
                  <div style={{ color: text, textAlign: "right" }}>{e} <span style={{ color: muted, fontSize: 10 }}>({ePct}%)</span></div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function UploadSlot({ label, accentColor, state, onParsed, onClear, theme }) {
  const { text, muted, modalBdr, inputBg } = theme;
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    setError("");
    setParsing(true);
    try {
      const parsed = await parseVideoaskFile(file);
      onParsed({
        fileName: file.name,
        question: parsed.question,
        counts: parsed.counts,
        total: parsed.total,
        firstAt: parsed.firstAt,
        lastAt: parsed.lastAt,
      });
    } catch (e) {
      setError(e?.message || "Erro ao processar arquivo");
    } finally {
      setParsing(false);
      // Reseta o input pra permitir re-upload do mesmo arquivo (browser
      // não dispara onChange se o nome do arquivo for o mesmo).
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const hasFile = !!state?.fileName;

  return (
    <div>
      <div style={{ fontSize: 12, color: muted, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: 2,
            background: accentColor,
          }}
          aria-hidden
        />
        {label}
      </div>
      <div
        style={{
          background: inputBg,
          border: `1px solid ${hasFile ? `${accentColor}80` : modalBdr}`,
          borderRadius: 7,
          padding: "9px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        {hasFile ? (
          <>
            <span style={{ fontSize: 13, color: text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
              {state.fileName}
            </span>
            <span style={{ fontSize: 11, color: muted }}>
              {state.total || 0} respostas
            </span>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              style={{ background: "none", border: "none", color: C.blue, fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0 }}
            >
              trocar
            </button>
            <button
              type="button"
              onClick={onClear}
              title="Remover arquivo"
              style={{ background: "none", border: "none", color: muted, fontSize: 14, lineHeight: 1, cursor: "pointer", padding: 0 }}
            >
              ×
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={parsing}
            style={{
              background: "none",
              border: "none",
              color: parsing ? muted : C.blue,
              fontSize: 13,
              fontWeight: 600,
              cursor: parsing ? "wait" : "pointer",
              padding: 0,
              textAlign: "left",
              flex: 1,
            }}
          >
            {parsing ? "Processando…" : "📎 Selecionar .xlsx do VideoAsk"}
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => handleFile(e.target.files?.[0])}
          style={{ display: "none" }}
        />
      </div>
      {error && (
        <div style={{ fontSize: 11, color: "#E74C3C", marginTop: 4 }}>
          ⚠ {error}
        </div>
      )}
      {hasFile && state.question && (
        <div style={{ fontSize: 11, color: muted, marginTop: 4, lineHeight: 1.4 }}>
          Pergunta detectada: <span style={{ color: text }}>{state.question.length > 60 ? state.question.slice(0, 60) + "…" : state.question}</span>
        </div>
      )}
    </div>
  );
}

// ─── FocusRowField ──────────────────────────────────────────────────────────
// Resposta-foco para destaque visual no relatório. Sempre visível.
//   - Loading da meta (sem rows ainda) → skeleton
//   - Rows conhecidos → <select>
//   - Sem rows (manual em ambos OU tipos sem opções fixas) → input livre

function FocusRowField({ block, metaById, onChange, onRefreshMeta, theme, inputStyle }) {
  const { text, muted, modalBdr, inputBg } = theme;
  const isVideoask = block.tipo === "videoask";

  // Pra videoask, ignoramos metaById (que é Typeform) e usamos as keys das
  // contagens do XLSX direto.
  const rows = useMemo(() => {
    const seen = new Set();
    const out = [];
    if (isVideoask) {
      const ctrlKeys = Object.keys(block.videoask?.ctrl?.counts || {});
      const expKeys  = Object.keys(block.videoask?.exp?.counts  || {});
      for (const k of [...ctrlKeys, ...expKeys]) {
        const t = String(k).trim();
        if (t && !seen.has(t)) { seen.add(t); out.push(t); }
      }
      return out;
    }
    for (const f of block.forms) {
      const m = f.mode === "list" && f.formId ? metaById.get(f.formId) : null;
      for (const r of (m?.rows || [])) {
        const t = String(r).trim();
        if (t && !seen.has(t)) { seen.add(t); out.push(t); }
      }
    }
    return out;
  }, [isVideoask, block.videoask, block.forms, metaById]);

  const anyLoading = !isVideoask && block.forms.some((f) => {
    if (f.mode !== "list" || !f.formId) return false;
    return metaById.get(f.formId)?.loading;
  });
  const noListSlot = isVideoask
    ? !(block.videoask?.ctrl?.fileName || block.videoask?.exp?.fileName)
    : block.forms.every((f) => f.mode !== "list");

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
    const hasMatrix = !isVideoask && block.forms.some((f) => {
      if (f.mode !== "list" || !f.formId) return false;
      return metaById.get(f.formId)?.type === "matrix";
    });
    const sourceLabel = isVideoask
      ? "opções de resposta detectadas no arquivo do VideoAsk"
      : hasMatrix
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
            ? (isVideoask
                ? "Envie os arquivos do VideoAsk acima pra ver as opções em dropdown."
                : "Selecione os forms da pasta Survey pra ver as opções em dropdown.")
            : "Não consegui detectar opções — digite manualmente ou tente recarregar."}
        </span>
        {!noListSlot && !isVideoask && onRefreshMeta && (
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
