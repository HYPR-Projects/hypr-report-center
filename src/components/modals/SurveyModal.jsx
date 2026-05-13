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
import { parseSurveyConfig, serializeSurveyConfig, sumCounts, getSideSource } from "../../shared/surveyConfig";
import { parseVideoaskFile } from "../../lib/videoaskParser";

/**
 * Modal pra configurar surveys com slots independentes pra Controle e Exposto.
 *
 * Modelo interno (state) — bloco:
 *   {
 *     nome,
 *     ctrl: SideState,    // lados independentes do par
 *     exp:  SideState,
 *     focusRow,
 *   }
 *
 * SideState = {
 *   source: "typeform" | "videoask",   // fonte daquele lado
 *   // Typeform:
 *   mode: "list" | "manual",            // list = pasta Survey, manual = URL colada
 *   formId, url,
 *   // VideoAsk (XLSX exportado da plataforma):
 *   fileName, question, counts, total, firstAt, lastAt,
 * }
 *
 * Cada lado é opcional (admin pode configurar só Controle ou só Exposto).
 * Pelo menos UM precisa estar preenchido — sem ambos, o render do report
 * mostra distribuição sem cálculo de lift. Pareamento misto também é
 * suportado (ex: Typeform Controle × VideoAsk Exposto).
 *
 * Persistência (BigQuery): JSON serializado por `serializeSurveyConfig`.
 * Schema novo escreve `ctrlSource`/`expSource` por pergunta. Hydration
 * aceita schemas legados (v2 typeform sem source; v3 com `tipo:"videoask"`).
 */
const EMPTY_SIDE = (defaultMode = "list") => ({
  source: "typeform",
  mode: defaultMode,
  formId: "",
  url: "",
  fileName: "",
  question: "",
  counts: {},
  total: 0,
  firstAt: null,
  lastAt: null,
});

const EMPTY_BLOCK = (defaultMode = "list") => ({
  nome: "",
  ctrl: EMPTY_SIDE(defaultMode),
  exp:  EMPTY_SIDE(defaultMode),
  focusRow: "",
});

// Diz se um SideState tem dado utilizável (URL/form ID pra typeform OU
// counts pra videoask). Usado em validação e na decisão de habilitar
// botões de save/preview.
function sideHasData(side) {
  if (!side) return false;
  if (side.source === "videoask") return sumCounts(side.counts) > 0;
  return !!(side.formId || extractFormId(side.url));
}

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

// Detecta o grupo (controle/exposto) de um form da pasta Survey pelo nome —
// usado APENAS pra exibir badge "C"/"E" inline no dropdown da listagem.
// Slots são explícitos no novo modelo (admin escolhe diretamente o lado),
// então nenhuma decisão depende disso.
function detectFormGroup(formId, formsById) {
  if (!formId) return null;
  const f = formsById.get(formId);
  return f?.title ? parseGroupFromName(f.title) : null;
}

// Verifica se o nome do form/arquivo de um lado bate com o slot onde ele
// está. Devolve:
//   - null  → sem info suficiente (manual sem título, ou nome neutro)
//   - "ok"  → nome bate com o slot atual
//   - "controle" | "exposto" → nome sugere o OUTRO grupo (slot trocado)
// Usado pra exibir aviso "↔ trocar lados" quando admin põe Controle no
// slot Exposto (ou vice-versa) por engano.
function detectSideMismatch(side, sideKey, formsById) {
  if (!side || !sideHasData(side)) return null;
  let title = "";
  if (side.source === "videoask") {
    title = side.fileName || "";
  } else if (side.mode === "list" && side.formId) {
    title = formsById.get(side.formId)?.title || "";
  } else {
    return null;
  }
  const detected = parseGroupFromName(title);
  if (!detected) return null;
  const expected = sideKey === "ctrl" ? "controle" : "exposto";
  return detected === expected ? "ok" : detected;
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

// Constrói mapa formId → [{blockIdx, side, slotGroup}] varrendo blocos.
// `slotGroup` é o slot lógico ("controle"/"exposto") onde o form foi posto,
// usado pra rotular conflitos ("já usado em P2 Controle"). Só inspeciona
// lados com source=typeform — videoask não conflita por formId.
function buildUsageMap(blocks) {
  const m = new Map();
  blocks.forEach((b, blockIdx) => {
    for (const side of ["ctrl", "exp"]) {
      const s = b[side];
      if (!s || s.source !== "typeform") continue;
      if (s.mode !== "list" || !s.formId) continue;
      const arr = m.get(s.formId) || [];
      arr.push({ blockIdx, side, slotGroup: side === "ctrl" ? "controle" : "exposto" });
      m.set(s.formId, arr);
    }
  });
  return m;
}

// Conflitos do form atual (excluindo o slot atual deste bloco).
function conflictsFor(formId, currentBlockIdx, currentSide, usageMap) {
  if (!formId) return [];
  const all = usageMap.get(formId) || [];
  return all.filter(
    (u) => !(u.blockIdx === currentBlockIdx && u.side === currentSide),
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

  const usageMap = useMemo(() => buildUsageMap(blocks), [blocks]);

  // ── Lazy-fetch da meta (rows) por formId selecionado em modo list ─────────
  const metaByIdRef = useRef(metaById);
  useEffect(() => { metaByIdRef.current = metaById; });
  const inflightIdsRef = useRef(new Set());

  useEffect(() => {
    const idsNeeded = new Set();
    for (const b of blocks) {
      for (const side of ["ctrl", "exp"]) {
        const s = b[side];
        if (s?.source !== "typeform") continue;
        if (s.mode === "list" && s.formId) idsNeeded.add(s.formId);
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
      for (const side of ["ctrl", "exp"]) {
        const s = b[side];
        if (s?.source !== "typeform") continue;
        const id = s.mode === "list" ? s.formId : extractFormId(s.url);
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

      // Hidrata blocos com config existente. parseSurveyConfig normaliza
      // todos os formatos legados (v1 array, v2 objeto com clientRange, v3
      // com `tipo:"videoask"`) num único shape. Aqui derivamos o source
      // POR LADO usando getSideSource — schema novo (v3.1) tem ctrlSource/
      // expSource explícitos; legados caem nos defaults via fallback.
      if (savedRaw.status === "fulfilled" && savedRaw.value) {
        const cfg = parseSurveyConfig(savedRaw.value);
        if (cfg && Array.isArray(cfg.questions) && cfg.questions.length) {
          const idsInList = new Set(formsList.map((f) => f.id));
          const hydrateSide = (q, side) => {
            const source = getSideSource(q, side);
            const base = EMPTY_SIDE(defaultMode);
            if (source === "videoask") {
              const counts = side === "ctrl" ? q.ctrlCounts : q.expCounts;
              return {
                ...base,
                source: "videoask",
                fileName: (side === "ctrl" ? q.ctrlFileName : q.expFileName) || "",
                question: (side === "ctrl" ? q.ctrlQuestion : q.expQuestion) || "",
                counts: counts || {},
                total: sumCounts(counts),
                firstAt: (side === "ctrl" ? q.ctrlFirstAt : q.expFirstAt) || null,
                lastAt:  (side === "ctrl" ? q.ctrlLastAt  : q.expLastAt)  || null,
              };
            }
            const fid = side === "ctrl" ? (q.ctrlFormId || extractFormId(q.ctrlUrl)) : (q.expFormId || extractFormId(q.expUrl));
            const url = (side === "ctrl" ? q.ctrlUrl : q.expUrl) || "";
            const matched = fid && idsInList.has(fid);
            return {
              ...base,
              source: "typeform",
              mode: matched ? "list" : (fid || url ? "manual" : defaultMode),
              formId: matched ? fid : "",
              url,
            };
          };
          const hydrated = cfg.questions.map((q) => ({
            nome: q.nome || "",
            ctrl: hydrateSide(q, "ctrl"),
            exp:  hydrateSide(q, "exp"),
            focusRow: q.focusRow || "",
          }));
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

  const updateSide = (blockIdx, side, patch) =>
    setBlocks((b) => b.map((bl, i) => {
      if (i !== blockIdx) return bl;
      return { ...bl, [side]: { ...bl[side], ...patch } };
    }));

  const clearSide = (blockIdx, side) =>
    setBlocks((b) => b.map((bl, i) => {
      if (i !== blockIdx) return bl;
      const prevSource = bl[side]?.source || "typeform";
      const fresh = EMPTY_SIDE(prevSource === "typeform" ? (forms.length ? "list" : "manual") : "list");
      return { ...bl, [side]: { ...fresh, source: prevSource } };
    }));

  // Troca os 2 lados do bloco atomicamente — atalho pra resolver mismatch
  // (ex: arquivo "Controle.xlsx" caiu no slot Exposto).
  const swapSides = (blockIdx) =>
    setBlocks((b) => b.map((bl, i) => (i === blockIdx ? { ...bl, ctrl: bl.exp, exp: bl.ctrl } : bl)));

  const removeBlock = (idx) =>
    setBlocks((b) => (b.length > 1 ? b.filter((_, i) => i !== idx) : b));

  const addBlock = () => setBlocks((b) => [...b, EMPTY_BLOCK()]);

  const handleSave = async () => {
    // Validação: nome e pelo menos um lado preenchido por pergunta.
    for (const [i, b] of blocks.entries()) {
      if (!b.nome.trim()) {
        toast.error(`Pergunta ${i + 1}: preencha o nome.`);
        return;
      }
      const hasCtrl = sideHasData(b.ctrl);
      const hasExp  = sideHasData(b.exp);
      if (!hasCtrl && !hasExp) {
        toast.error(`Pergunta ${i + 1}: preencha pelo menos um lado (Controle ou Exposto).`);
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
      // Serializa cada lado independentemente. Lados vazios omitem TODOS
      // os campos daquele lado (incluindo *Source) — leitor antigo lê como
      // "sem dado" e renderer single-side cuida do resto.
      const writeSide = (out, side, sideKey /* "ctrl" | "exp" */) => {
        if (!sideHasData(side)) return;
        const prefix = sideKey;
        out[`${prefix}Source`] = side.source;
        if (side.source === "videoask") {
          out[`${prefix}Counts`] = side.counts || {};
          if (side.fileName) out[`${prefix}FileName`] = side.fileName;
          if (side.question) out[`${prefix}Question`] = side.question;
          if (side.firstAt)  out[`${prefix}FirstAt`]  = side.firstAt;
          if (side.lastAt)   out[`${prefix}LastAt`]   = side.lastAt;
          return;
        }
        // typeform
        if (side.mode === "list" && side.formId) {
          const f = formsById.get(side.formId);
          out[`${prefix}FormId`] = side.formId;
          out[`${prefix}Url`] = f?.display_url || `https://form.typeform.com/to/${side.formId}`;
        } else {
          out[`${prefix}Url`] = side.url.trim();
          const id = extractFormId(out[`${prefix}Url`]);
          if (id) out[`${prefix}FormId`] = id;
        }
      };
      const payload = blocks.map((b) => {
        const out = { nome: b.nome.trim() };
        writeSide(out, b.ctrl, "ctrl");
        writeSide(out, b.exp,  "exp");
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
    const ids = [];
    for (const side of ["ctrl", "exp"]) {
      const s = block[side];
      if (s?.source === "typeform" && s.mode === "list" && s.formId) ids.push(s.formId);
    }
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
        Cada pergunta tem 2 slots independentes — <strong>Controle</strong> e <strong>Exposto</strong>. Em cada slot você escolhe a fonte: form do <strong>Typeform</strong>{forms.length ? <> ({forms.length} forms na pasta Survey)</> : null} ou arquivo do <strong>VideoAsk</strong> (.xlsx). Pode misturar fontes nos lados, e pode deixar um lado vazio — sem comparativo de lift nesse caso.
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
          const sidePartnerSuggestion = (side) => {
            // Sugestão: se o LADO OPOSTO está com typeform/list/formId definido,
            // tenta achar o "par" pelo nome (Eudora_Controle → Eudora_Exposto)
            // e oferecer pro slot vazio atual.
            const me = block[side];
            const other = side === "ctrl" ? block.exp : block.ctrl;
            if (!me || me.source !== "typeform" || me.mode !== "list" || me.formId) return null;
            if (!other || other.source !== "typeform" || other.mode !== "list" || !other.formId) return null;
            const partner = findPartnerForm(other.formId, formsById, forms);
            if (!partner) return null;
            const used = usageMap.get(partner.id) || [];
            if (used.length > 0) return null;
            return partner;
          };

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

              <SideCard
                sideKey="ctrl"
                label="Controle"
                accentColor="#27AE60"
                side={block.ctrl}
                forms={forms}
                formsById={formsById}
                emptyForms={emptyForms}
                usageMap={usageMap}
                blockIdx={idx}
                suggestion={sidePartnerSuggestion("ctrl")}
                mismatch={detectSideMismatch(block.ctrl, "ctrl", formsById)}
                onSwap={() => swapSides(idx)}
                onChange={(patch) => updateSide(idx, "ctrl", patch)}
                onClear={() => clearSide(idx, "ctrl")}
                theme={{ text, muted, modalBdr, inputBg, cardBg }}
              />
              <div style={{ height: 10 }} />
              <SideCard
                sideKey="exp"
                label="Exposto"
                accentColor={C.blue}
                side={block.exp}
                forms={forms}
                formsById={formsById}
                emptyForms={emptyForms}
                usageMap={usageMap}
                blockIdx={idx}
                suggestion={sidePartnerSuggestion("exp")}
                mismatch={detectSideMismatch(block.exp, "exp", formsById)}
                onSwap={() => swapSides(idx)}
                onChange={(patch) => updateSide(idx, "exp", patch)}
                onClear={() => clearSide(idx, "exp")}
                theme={{ text, muted, modalBdr, inputBg, cardBg }}
              />

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

// Combina spans de respostas de todos os lados preenchidos em um único
// intervalo (min de firsts, max de lasts) — pra mostrar ao admin "tem dados
// de A a B" como hint pra escolher o clientRange. Mistura typeform (lookup
// no spanByForm) com videoask (timestamps embutidos no próprio side).
function getCombinedResponseSpan(blocks, formsById, spanByForm) {
  let firstISO = null;
  let lastISO = null;
  let totalSides = 0;
  let sidesWithData = 0;
  for (const b of blocks) {
    for (const sideKey of ["ctrl", "exp"]) {
      const s = b[sideKey];
      if (!s) continue;
      if (s.source === "videoask") {
        if (!s.fileName) continue;
        totalSides++;
        if (!s.firstAt && !s.lastAt) continue;
        sidesWithData++;
        if (s.firstAt && (!firstISO || s.firstAt < firstISO)) firstISO = s.firstAt;
        if (s.lastAt  && (!lastISO  || s.lastAt  > lastISO))  lastISO  = s.lastAt;
        continue;
      }
      // typeform
      const id = s.mode === "list" ? s.formId : extractFormId(s.url);
      if (!id) continue;
      totalSides++;
      const span = spanByForm.get(id);
      if (!span || (!span.first && !span.last)) continue;
      sidesWithData++;
      if (span.first && (!firstISO || span.first < firstISO)) firstISO = span.first;
      if (span.last  && (!lastISO  || span.last  > lastISO))  lastISO  = span.last;
    }
  }
  // Mantém nome legado nos campos pra não quebrar ClientRangeField
  return { firstISO, lastISO, totalForms: totalSides, formsWithData: sidesWithData };
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
  currentSide,        // "ctrl" | "exp" — pra detectar conflitos em outros slots
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
    ? conflictsFor(formId, currentBlockIdx, currentSide, usageMap)
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

  // Toggle "selecionar da pasta / colar URL manual" — fica inline com o input.
  const modeToggle = (
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
  );

  if (mode === "manual") {
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>{modeToggle}</div>
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
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>{modeToggle}</div>

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
              .map((u) => `P${u.blockIdx + 1} ${groupLabel(u.slotGroup)}`)
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
                  const conflicts = conflictsFor(f.id, currentBlockIdx, currentSide, usageMap);
                  const hasConflict = conflicts.length > 0;
                  const conflictLabel = hasConflict
                    ? (conflicts.length === 1
                        ? `já em P${conflicts[0].blockIdx + 1} · ${groupLabel(conflicts[0].slotGroup)}`
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
                        ? `Este form já foi usado em: ${conflicts.map((u) => `P${u.blockIdx + 1} ${groupLabel(u.slotGroup)}`).join(", ")}`
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

// ─── SideCard ───────────────────────────────────────────────────────────────
// Card de UM lado da pergunta (Controle ou Exposto). Contém:
//   - Header: rótulo do lado + segmented Typeform/VideoAsk + botão limpar
//   - Body: input correspondente à fonte ativa (FormPicker ou UploadSlot)
//
// Estado da fonte inativa é preservado no bloco — alternar source não destrói
// dados (você pode voltar e o form/URL/arquivo anterior segue lá).

function SideCard({
  sideKey,           // "ctrl" | "exp"
  label,             // "Controle" | "Exposto"
  accentColor,
  side,
  forms,
  formsById,
  emptyForms,
  usageMap,
  blockIdx,
  suggestion,
  mismatch,          // null | "ok" | "controle" | "exposto"
  onSwap,
  onChange,
  onClear,
  theme,
}) {
  const { text, muted, modalBdr, inputBg, cardBg } = theme;
  const filled = sideHasData(side);
  const toggleBtn = (target) => ({
    padding: "3px 9px",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    border: "none",
    borderRadius: 999,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    background: side.source === target
      ? (target === "videoask" ? "#8E44AD" : C.blue)
      : "transparent",
    color: side.source === target ? "#fff" : muted,
  });

  return (
    <div
      style={{
        background: inputBg,
        border: `1px solid ${filled ? accentColor + "55" : modalBdr}`,
        borderLeft: `3px solid ${filled ? accentColor : modalBdr}`,
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: accentColor,
            textTransform: "uppercase",
            letterSpacing: 1,
            flex: "0 0 auto",
          }}
        >
          {label}
        </span>
        <div
          style={{
            display: "inline-flex",
            background: cardBg,
            border: `1px solid ${modalBdr}`,
            borderRadius: 999,
            padding: 2,
            marginLeft: 4,
          }}
        >
          <button type="button" onClick={() => onChange({ source: "typeform" })} style={toggleBtn("typeform")}>
            Typeform
          </button>
          <button type="button" onClick={() => onChange({ source: "videoask" })} style={toggleBtn("videoask")}>
            VideoAsk
          </button>
        </div>
        <div style={{ flex: 1 }} />
        {filled && (
          <button
            type="button"
            onClick={onClear}
            title={`Limpar ${label}`}
            style={{
              background: "none",
              border: "none",
              color: muted,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              padding: 0,
            }}
          >
            × limpar
          </button>
        )}
      </div>

      {side.source === "typeform" ? (
        <FormPicker
          forms={forms}
          formsById={formsById}
          mode={side.mode}
          formId={side.formId}
          url={side.url}
          disabled={emptyForms && side.mode === "list"}
          usageMap={usageMap}
          currentBlockIdx={blockIdx}
          currentSide={sideKey}
          suggestion={suggestion}
          onChange={(patch) =>
            onChange({
              mode: patch.mode ?? side.mode,
              formId: patch.formId ?? (patch.mode === "manual" ? "" : side.formId),
              url: patch.url ?? side.url,
            })
          }
          theme={{ text, muted, modalBdr, inputBg, cardBg }}
        />
      ) : (
        <UploadSlot
          state={{
            fileName: side.fileName,
            counts: side.counts,
            total: side.total,
            question: side.question,
          }}
          onParsed={(parsed) =>
            onChange({
              fileName: parsed.fileName,
              question: parsed.question,
              counts: parsed.counts,
              total: parsed.total,
              firstAt: parsed.firstAt,
              lastAt: parsed.lastAt,
            })
          }
          onClear={() =>
            onChange({
              fileName: "",
              question: "",
              counts: {},
              total: 0,
              firstAt: null,
              lastAt: null,
            })
          }
          theme={{ text, muted, modalBdr, inputBg }}
        />
      )}

      {mismatch && mismatch !== "ok" && (
        <div
          style={{
            marginTop: 8,
            padding: "8px 10px",
            background: "#FFB95E14",
            border: "1px solid #FFB95E50",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            fontSize: 11,
            color: text,
            lineHeight: 1.5,
          }}
        >
          <span style={{ color: "#FFB95E" }}>⚠</span>
          <span style={{ flex: "1 1 200px" }}>
            O nome sugere <strong>{groupLabel(mismatch)}</strong>, mas está no slot <strong>{label}</strong>.
          </span>
          {onSwap && (
            <button
              type="button"
              onClick={onSwap}
              style={{
                background: "#FFB95E",
                border: "none",
                color: "#1a1a1a",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                padding: "4px 10px",
                borderRadius: 6,
              }}
            >
              ↔ trocar lados
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function UploadSlot({ state, onParsed, onClear, theme }) {
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
      <div
        style={{
          background: inputBg,
          border: `1px solid ${hasFile ? `${C.blue}60` : modalBdr}`,
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
      {hasFile && state.counts && Object.keys(state.counts).length > 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: muted, lineHeight: 1.5 }}>
          {Object.entries(state.counts).map(([k, v], i, arr) => (
            <span key={k}>
              <span style={{ color: text, fontWeight: 600 }}>{k}</span>: {v}
              {i < arr.length - 1 ? "  ·  " : ""}
            </span>
          ))}
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

  // Rows vêm de qualquer lado preenchido: pra typeform pega `rows` da meta
  // do form; pra videoask pega keys das contagens parseadas do XLSX.
  const rows = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const sideKey of ["ctrl", "exp"]) {
      const s = block[sideKey];
      if (!s) continue;
      if (s.source === "videoask") {
        for (const k of Object.keys(s.counts || {})) {
          const t = String(k).trim();
          if (t && !seen.has(t)) { seen.add(t); out.push(t); }
        }
        continue;
      }
      const m = s.mode === "list" && s.formId ? metaById.get(s.formId) : null;
      for (const r of (m?.rows || [])) {
        const t = String(r).trim();
        if (t && !seen.has(t)) { seen.add(t); out.push(t); }
      }
    }
    return out;
  }, [block.ctrl, block.exp, metaById]);

  const anyLoading = ["ctrl", "exp"].some((sideKey) => {
    const s = block[sideKey];
    if (!s || s.source !== "typeform") return false;
    if (s.mode !== "list" || !s.formId) return false;
    return metaById.get(s.formId)?.loading;
  });
  const isVideoask = block.ctrl?.source === "videoask" && block.exp?.source === "videoask";
  // "Sem opção em dropdown" quando NENHUM lado tem fonte que provê opções
  // — typeform manual sem meta carregada, ou videoask sem arquivo.
  const noListSlot = ["ctrl", "exp"].every((sideKey) => {
    const s = block[sideKey];
    if (!s) return true;
    if (s.source === "videoask") return !sumCounts(s.counts);
    return s.mode !== "list";
  });

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
    const hasMatrix = ["ctrl", "exp"].some((sideKey) => {
      const s = block[sideKey];
      if (!s || s.source !== "typeform" || s.mode !== "list" || !s.formId) return false;
      return metaById.get(s.formId)?.type === "matrix";
    });
    const anyVideoask = block.ctrl?.source === "videoask" || block.exp?.source === "videoask";
    const sourceLabel = hasMatrix
      ? "linhas detectadas no form (matrix)"
      : anyVideoask
        ? "opções de resposta detectadas no arquivo do VideoAsk"
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
