// src/components/modals/MergeModal.jsx
//
// Modal de Merge Reports — admin unifica múltiplos PIs (short_tokens) do
// mesmo cliente em um único link público. Mesmo padrão dos demais modais
// admin (ModalShell + tema legacy), mas estilizado com tokens V2 (Tailwind)
// pra ficar consistente com o CampaignDrawer.
//
// Fluxo
// -----
// 1. Abre via CampaignDrawer ("Gerenciar Merge"). Recebe a campanha base.
// 2. Carrega lista de tokens elegíveis (mesmo cliente, não em outro grupo)
//    via listMergeableTokens. Tokens já no MESMO grupo do base já vêm
//    marcados (already_in_group=true).
// 3. Se base tem merge_id, carrega config atual do grupo (rmnd/pdooh mode)
//    via getMergeGroup pra pré-popular os toggles.
// 4. Usuário marca/desmarca tokens e ajusta modes. Ao salvar:
//      - tokens novos selecionados → mergeTokens
//      - tokens existentes desmarcados → unmergeToken individual
//      - settings mudaram (e grupo persistiu) → updateMergeSettings
// 5. "Desfazer grupo" (só visível se base já está em grupo) → dissolve o
//    grupo inteiro, todos os tokens voltam a ser reports independentes.
//
// Decisões de UX
// --------------
// • Token BASE não é desmarcável na UI — pra desfazer o agrupamento usa
//   o botão destacado "Desfazer grupo". Reduz o risco de admin dissolver
//   o grupo sem intenção e mantém a ação destrutiva separada do save.
// • Settings ficam num bloco recolhível ("Avançado"); default 'merge'
//   para ambos cobre o caso comum.
// • Lista vazia (sem tokens elegíveis) mostra estado vazio amigável em
//   vez de modal vazio confuso.

import { useState, useEffect, useMemo } from "react";
import {
  listMergeableTokens,
  getMergeGroup,
  mergeTokens,
  unmergeToken,
  updateMergeSettings,
} from "../../lib/api";
import ModalShell from "./ModalShell";
import { formatDateRange } from "../../v2/admin/lib/format";

const MergeModal = ({ campaign, onClose, onSaved, theme }) => {
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [candidates, setCandidates] = useState([]);  // [{short_token, campaign_name, ...}]
  const [selected, setSelected]     = useState(new Set()); // tokens marcados (excl. base)
  const [initial, setInitial]       = useState(new Set()); // o que estava marcado quando abriu
  const [rmndMode, setRmndMode]     = useState("merge");
  const [pdoohMode, setPdoohMode]   = useState("merge");
  const [initialModes, setInitialModes] = useState({ rmnd: "merge", pdooh: "merge" });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving]         = useState(false);

  const baseToken = campaign?.short_token;
  const baseInGroup = !!campaign?.merge_id;

  // ── Carregamento inicial ───────────────────────────────────────────────
  useEffect(() => {
    if (!baseToken) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const candidatesPromise = listMergeableTokens(baseToken);
        const groupPromise = baseInGroup
          ? getMergeGroup(campaign.merge_id).catch(() => null)
          : Promise.resolve(null);
        const [cands, group] = await Promise.all([candidatesPromise, groupPromise]);
        if (cancelled) return;
        setCandidates(cands || []);
        const preChecked = new Set(
          (cands || [])
            .filter((c) => c.already_in_group)
            .map((c) => c.short_token)
        );
        setSelected(preChecked);
        setInitial(new Set(preChecked));
        if (group) {
          setRmndMode(group.rmnd_mode  || "merge");
          setPdoohMode(group.pdooh_mode || "merge");
          setInitialModes({
            rmnd:  group.rmnd_mode  || "merge",
            pdooh: group.pdooh_mode || "merge",
          });
        }
      } catch (e) {
        if (!cancelled) setError(e.message || "Erro ao carregar candidatos");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [baseToken, baseInGroup, campaign?.merge_id]);

  // ── Diff entre estado inicial e atual ──────────────────────────────────
  const diff = useMemo(() => {
    const toAdd = [];
    const toRemove = [];
    for (const t of selected) if (!initial.has(t)) toAdd.push(t);
    for (const t of initial) if (!selected.has(t)) toRemove.push(t);
    const settingsChanged =
      baseInGroup &&
      (rmndMode !== initialModes.rmnd || pdoohMode !== initialModes.pdooh);
    return { toAdd, toRemove, settingsChanged };
  }, [selected, initial, rmndMode, pdoohMode, baseInGroup, initialModes]);

  const hasChanges =
    diff.toAdd.length > 0 ||
    diff.toRemove.length > 0 ||
    diff.settingsChanged;

  // ── Save: aplica diff em sequência (cada chamada invalida cache) ───────
  const handleSave = async () => {
    setSaving(true);
    try {
      // 1) Adiciona novos: 1 chamada com base + adicionados
      if (diff.toAdd.length > 0) {
        await mergeTokens({
          tokens: [baseToken, ...diff.toAdd],
          rmnd_mode:  baseInGroup ? undefined : rmndMode,
          pdooh_mode: baseInGroup ? undefined : pdoohMode,
        });
      }
      // 2) Remove: 1 chamada por token a remover
      for (const t of diff.toRemove) {
        await unmergeToken(t);
      }
      // 3) Settings: só faz sentido se grupo existe (merge_id pode ter mudado)
      if (diff.settingsChanged) {
        // O merge_id pode ter sido criado em (1) — buscamos do servidor pra
        // ter certeza. Se base não está mais em grupo (ex: removeu todos
        // exceto base e dissolveu), pula.
        const fresh = baseInGroup
          ? campaign.merge_id
          : null; // novo grupo já foi criado com modes corretos em (1)
        if (fresh) {
          await updateMergeSettings({
            merge_id:   fresh,
            rmnd_mode:  rmndMode,
            pdooh_mode: pdoohMode,
          });
        }
      }
      onSaved?.();
    } catch (e) {
      alert("Erro ao salvar merge: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  // ── Desfazer grupo (botão destacado) ────────────────────────────────────
  // Itera todos os membros e remove cada um — dissolve o grupo INTEIRO.
  // Backend unmergeToken é idempotente (no-op se o token já não está em
  // grupo), então mesmo após a auto-dissolução do grupo de 2 tokens as
  // chamadas restantes são seguras.
  const handleDissolveGroup = async () => {
    if (!confirm(
      "Tem certeza que deseja desfazer o grupo? " +
      "Todos os tokens voltam a ser reports independentes."
    )) return;
    setSaving(true);
    try {
      // Calcula a lista de membros a partir dos candidates já carregados
      // (todos com already_in_group=true) + o próprio token base.
      const memberTokens = [
        baseToken,
        ...candidates.filter((c) => c.already_in_group).map((c) => c.short_token),
      ];
      await Promise.all(memberTokens.map((t) => unmergeToken(t).catch(() => null)));
      onSaved?.();
    } catch (e) {
      alert("Erro ao desfazer grupo: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  if (!campaign) return null;

  // Tokens elegíveis pra mostrar (exclui os em outro grupo, que não dá pra
  // mexer mesmo). Mantemos eles na lista com badge "em outro grupo" pra
  // dar contexto.
  const sortedCandidates = candidates.slice().sort((a, b) => {
    // Já-no-grupo primeiro, depois por start_date desc
    if (a.already_in_group !== b.already_in_group) {
      return a.already_in_group ? -1 : 1;
    }
    return (b.start_date || "").localeCompare(a.start_date || "");
  });

  return (
    <ModalShell
      onClose={onClose}
      maxWidth={620}
      maxHeight="min(90vh, 720px)"
      padding={0}
      theme={theme}
    >
      {/* Container interno com tokens V2 — independente do tema legacy do shell.
          As classes Tailwind respeitam light/dark via data-theme do <html>. */}
      <div className="bg-canvas-elevated text-fg rounded-2xl flex flex-col" style={{ maxHeight: "inherit" }}>
        {/* ── Header ──────────────────────────────────────────────── */}
        <header className="px-7 pt-7 pb-4 border-b border-border">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-fg-subtle">
                Agrupar Reports
              </div>
              <h2 className="text-xl font-bold tracking-tight mt-1 truncate">
                {campaign.client_name}
              </h2>
              <p className="text-xs text-fg-muted mt-1 truncate">
                <span className="text-fg-subtle">Base:</span>{" "}
                <span className="font-mono">{baseToken}</span>{" "}
                <span className="mx-1.5 text-fg-subtle">·</span>
                {campaign.campaign_name}
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Fechar"
              className="shrink-0 w-8 h-8 -mr-2 -mt-1 rounded-md text-fg-subtle hover:text-fg hover:bg-surface flex items-center justify-center transition-colors cursor-pointer"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p className="text-xs text-fg-muted mt-3 leading-relaxed">
            Unifica PIs do mesmo cliente em um único link de report.{" "}
            <span className="text-fg">Investimentos e entregas somam</span>;{" "}
            pacing reflete sempre o token do mês ativo.
          </p>
        </header>

        {/* ── Body scrollável ─────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-7 py-5">
          {loading && (
            <div className="py-12 text-center text-sm text-fg-muted">
              Carregando candidatos…
            </div>
          )}

          {!loading && error && (
            <div className="py-8 text-center">
              <p className="text-sm text-danger">{error}</p>
            </div>
          )}

          {!loading && !error && candidates.length === 0 && (
            <div className="py-12 text-center">
              <div className="text-3xl mb-2 opacity-50">∅</div>
              <p className="text-sm text-fg">Sem campanhas elegíveis</p>
              <p className="text-xs text-fg-muted mt-1 max-w-[360px] mx-auto leading-relaxed">
                Não encontrei outros tokens deste cliente para agrupar.
                Para agrupar, é preciso ter ao menos 2 reports do mesmo
                cliente registrados.
              </p>
            </div>
          )}

          {!loading && !error && candidates.length > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-[0.16em] font-bold text-fg-subtle mb-3">
                Tokens do cliente
              </div>
              <ul className="space-y-1.5">
                {/* Token base (sempre presente, fixo) */}
                <li>
                  <CandidateRow
                    token={baseToken}
                    campaignName={campaign.campaign_name}
                    startDate={campaign.start_date}
                    endDate={campaign.end_date}
                    isBase
                    checked
                    disabled
                  />
                </li>
                {sortedCandidates.map((c) => {
                  const inOther = c.in_other_group;
                  return (
                    <li key={c.short_token}>
                      <CandidateRow
                        token={c.short_token}
                        campaignName={c.campaign_name}
                        startDate={c.start_date}
                        endDate={c.end_date}
                        checked={selected.has(c.short_token)}
                        disabled={inOther}
                        disabledReason={inOther ? "em outro grupo" : null}
                        alreadyMerged={c.already_in_group}
                        onChange={(next) => {
                          setSelected((prev) => {
                            const ns = new Set(prev);
                            if (next) ns.add(c.short_token);
                            else      ns.delete(c.short_token);
                            return ns;
                          });
                        }}
                      />
                    </li>
                  );
                })}
              </ul>

              {/* ── Settings (avançado) ─────────────────────────── */}
              <div className="mt-6">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] font-bold text-fg-subtle hover:text-fg-muted transition-colors cursor-pointer"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    style={{ transform: showAdvanced ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms" }}
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                  Avançado · RMND e PDOOH
                </button>
                {showAdvanced && (
                  <div className="mt-3 space-y-4 rounded-lg border border-border bg-surface px-4 py-4">
                    <ModeRadioGroup
                      label="RMND (retail media)"
                      value={rmndMode}
                      onChange={setRmndMode}
                    />
                    <ModeRadioGroup
                      label="PDOOH (out-of-home)"
                      value={pdoohMode}
                      onChange={setPdoohMode}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────────── */}
        <footer className="px-7 py-4 border-t border-border flex items-center gap-2 flex-wrap">
          {baseInGroup && (
            <button
              type="button"
              onClick={handleDissolveGroup}
              disabled={saving || loading}
              className="text-xs font-semibold px-3 h-9 rounded-md text-danger border border-danger/30 hover:bg-danger-soft hover:border-danger/50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Desfazer grupo
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="text-xs font-semibold px-4 h-9 rounded-md text-fg-muted border border-border hover:text-fg hover:bg-surface transition-colors cursor-pointer disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !hasChanges || loading}
              className="text-xs font-bold px-4 h-9 rounded-md bg-signature text-white hover:bg-signature-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving
                ? "Salvando…"
                : baseInGroup
                  ? "Salvar mudanças"
                  : `Agrupar ${diff.toAdd.length || ""}`.trim()}
            </button>
          </div>
        </footer>
      </div>
    </ModalShell>
  );
};

export default MergeModal;

// ─────────────────────────────────────────────────────────────────────────────
// Sub-componentes
// ─────────────────────────────────────────────────────────────────────────────

function CandidateRow({
  token,
  campaignName,
  startDate,
  endDate,
  checked,
  disabled,
  disabledReason,
  alreadyMerged,
  isBase,
  onChange,
}) {
  const period = formatDateRange(startDate, endDate);
  return (
    <label
      className={[
        "flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors",
        disabled
          ? "border-border bg-surface/40 opacity-60 cursor-not-allowed"
          : checked
            ? "border-signature/50 bg-signature/5 cursor-pointer"
            : "border-border bg-surface hover:border-signature/30 hover:bg-surface-strong cursor-pointer",
      ].join(" ")}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        className="w-4 h-4 accent-signature shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-semibold text-fg truncate leading-snug">
            {campaignName || "—"}
          </span>
          <span className="font-mono text-[10px] text-fg-subtle tracking-wider px-1.5 py-0.5 rounded bg-surface border border-border">
            {token}
          </span>
          {isBase && (
            <span className="text-[9px] uppercase tracking-widest font-bold text-signature">
              base
            </span>
          )}
          {alreadyMerged && !isBase && (
            <span className="text-[9px] uppercase tracking-widest font-bold text-success">
              agrupado
            </span>
          )}
          {disabledReason && (
            <span className="text-[9px] uppercase tracking-widest font-bold text-fg-subtle">
              {disabledReason}
            </span>
          )}
        </div>
        {period && (
          <div className="text-[10.5px] text-fg-subtle mt-0.5 tabular-nums">
            {period}
          </div>
        )}
      </div>
    </label>
  );
}

function ModeRadioGroup({ label, value, onChange }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.16em] font-bold text-fg-subtle mb-2">
        {label}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <ModeRadio
          checked={value === "merge"}
          onChange={() => onChange("merge")}
          title="Agrupar"
          subtitle="Une dados de todos os meses"
        />
        <ModeRadio
          checked={value === "latest"}
          onChange={() => onChange("latest")}
          title="Mais recente"
          subtitle="Apenas o último mês"
        />
      </div>
    </div>
  );
}

function ModeRadio({ checked, onChange, title, subtitle }) {
  return (
    <label
      className={[
        "flex flex-col gap-0.5 px-3 py-2 rounded-md border cursor-pointer transition-colors",
        checked
          ? "border-signature/50 bg-signature/5"
          : "border-border bg-canvas-elevated hover:border-signature/25",
      ].join(" ")}
    >
      <div className="flex items-center gap-2">
        <input
          type="radio"
          checked={checked}
          onChange={onChange}
          className="w-3.5 h-3.5 accent-signature"
        />
        <span className="text-xs font-semibold text-fg">{title}</span>
      </div>
      <span className="text-[10.5px] text-fg-muted ml-5.5 leading-snug">
        {subtitle}
      </span>
    </label>
  );
}
