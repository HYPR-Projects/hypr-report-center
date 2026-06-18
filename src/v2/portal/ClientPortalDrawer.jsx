// src/v2/portal/ClientPortalDrawer.jsx
//
// Painel admin de gestão do Portal do Cliente — abre da página do cliente
// (/admin/client/:slug) via botão "Link compartilhado".
//
// Onde o admin: liga/desliga o portal, define a senha, faz o co-branding
// (logo + cor), copia o link /c/<share_id> e cura QUAIS campanhas aparecem
// pro cliente (toggle de publicação por campanha).
//
// Tudo client-safe: este painel só configura; os dados servidos ao cliente
// passam pelo serializer whitelist do backend (client_portal.py).

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerBody,
  DrawerFooter,
} from "../../ui/Drawer";
import { cn } from "../../ui/cn";
import {
  getClientPortalConfig,
  saveClientPortal,
  getClientPortalAudiences,
  setClientPublish,
} from "../../lib/api";
import { formatMonthLabel, getDateRangeParts } from "../admin/lib/format";

const DEFAULT_ACCENT = "#3397B9";
// Paleta de marca pré-selecionada (swatches). O azul default vem primeiro.
// O cliente pode sempre escolher qualquer cor pelo seletor livre ao lado.
const ACCENT_PRESETS = [
  "#3397B9", // azul HYPR (default)
  "#2E7D5B", // verde
  "#7C3AED", // roxo
  "#E11D48", // vermelho
  "#EC4899", // rosa
  "#F59E0B", // âmbar
  "#0EA5E9", // azul claro
  "#0F172A", // grafite
];
// Limite defensivo pro logo (data-URL base64). ~400KB de arquivo → ~540KB
// base64; mantém o payload do portal leve e cabe folgado numa célula STRING.
const MAX_LOGO_BYTES = 400 * 1024;

export function ClientPortalDrawer({ open, onOpenChange, slug, displayName, clientCampaigns = [] }) {
  const [syncing, setSyncing] = useState(true); // buscando config/flags (lista já aparece da página)
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [error, setError] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false); // falha ao carregar a config inteira
  const [copied, setCopied] = useState(false);

  // Campos editáveis (controlados).
  const [active, setActive] = useState(false);
  const [password, setPassword] = useState(""); // só envia se preenchido
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [logo, setLogo] = useState(null); // data-URL ou null
  const [logoTouched, setLogoTouched] = useState(false);
  const [pwCopied, setPwCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  // Unificação de audiências (Fase 2): regras {from, to} que vencem heurística+IA.
  const [audRules, setAudRules] = useState([]);
  const [detecting, setDetecting] = useState(false);
  const [detectedGroups, setDetectedGroups] = useState(null); // {canonical: [raw...]} | null
  const fileRef = useRef(null);

  // Constrói a lista exibida a partir das campanhas da página + flags.
  const buildList = useCallback(
    (pubMap) =>
      (clientCampaigns || [])
        .map((c) => ({
          short_token:   c.short_token,
          campaign_name: c.campaign_name,
          start_date:    c.start_date,
          end_date:      c.end_date,
          published:     !!pubMap[(c.short_token || "").toUpperCase()],
        }))
        .sort((a, b) => (b.start_date || "").localeCompare(a.start_date || "")),
    [clientCampaigns],
  );

  const load = useCallback(async () => {
    setError(null);
    setLoadFailed(false);
    setSyncing(true);
    // Lista aparece IMEDIATAMENTE (vem da página); flags chegam após o fetch.
    setCampaigns(buildList({}));
    try {
      const { config: cfg, publish_map: pubMap = {} } = await getClientPortalConfig(slug);
      setConfig(cfg);
      setCampaigns(buildList(pubMap));
      // Portal NOVO (sem config) nasce ativo — evita a armadilha de salvar e o
      // cliente não entrar porque o toggle ficou off. Existente respeita o salvo.
      setActive(cfg ? !!cfg.active : true);
      setAccent(cfg?.accent_color || DEFAULT_ACCENT);
      setLogo(cfg?.logo_base64 || null);
      setLogoTouched(false);
      setPassword(cfg?.password || "");
      const ov = cfg?.audience_overrides || {};
      setAudRules(Object.entries(ov).map(([from, to]) => ({ from, to })));
      setDetectedGroups(null);
    } catch (e) {
      setLoadFailed(true);
      setError(e?.message || "erro");
    } finally {
      setSyncing(false);
    }
  }, [slug, buildList]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const shareUrl = config?.share_id
    ? `${window.location.origin}/c/${config.share_id}`
    : null;

  const handleCopy = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLogoFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      setError("Logo muito grande (máx. 400KB). Use um PNG/SVG menor.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setLogo(reader.result);
      setLogoTouched(true);
      setError(null);
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const fields = { slug, active, accent_color: accent };
      if (password.trim()) fields.password = password.trim();
      if (logoTouched) fields.logo_base64 = logo || "";
      // Override de audiência: {from: to} só com pares preenchidos. Sempre
      // enviado (objeto vazio limpa) para refletir remoções de regra.
      fields.audience_overrides = audRules.reduce((acc, r) => {
        const from = (r.from || "").trim();
        const to = (r.to || "").trim();
        if (from && to) acc[from] = to;
        return acc;
      }, {});
      const { config: cfg } = await saveClientPortal(fields);
      setConfig(cfg);
      setLogoTouched(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2800);
    } catch (e) {
      setError(e?.message || "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  // Detecta o agrupamento atual de audiências (heurística+IA) via o endpoint
  // público do portal — mostra ao admin o que corrigir/fundir com regras.
  const detectGroups = async () => {
    if (!config?.share_id) return;
    setDetecting(true);
    setError(null);
    try {
      const data = await getClientPortalAudiences(config.share_id);
      setDetectedGroups(data?.groups || {});
    } catch (e) {
      setError(e?.message || "Não consegui detectar as audiências.");
    } finally {
      setDetecting(false);
    }
  };

  const addRule = () => setAudRules((r) => [...r, { from: "", to: "" }]);
  const updateRule = (i, key, val) =>
    setAudRules((r) => r.map((x, j) => (j === i ? { ...x, [key]: val } : x)));
  const removeRule = (i) => setAudRules((r) => r.filter((_, j) => j !== i));
  const mergeInto = (canonical) =>
    setAudRules((r) => [...r, { from: canonical, to: "" }]);

  // Toggle de publicação — otimista, persiste no backend em background.
  const togglePublish = async (token, next) => {
    setCampaigns((prev) =>
      prev.map((c) => (c.short_token === token ? { ...c, published: next } : c)),
    );
    try {
      await setClientPublish({ slug, short_token: token, published: next });
    } catch {
      // Reverte em falha.
      setCampaigns((prev) =>
        prev.map((c) => (c.short_token === token ? { ...c, published: !next } : c)),
      );
      setError("Não consegui salvar a publicação dessa campanha.");
    }
  };

  // Publica/despublica TODAS de uma vez — otimista, persiste em paralelo,
  // reverte só as que falharem.
  const setAllPublish = async (next) => {
    const targets = campaigns.filter((c) => c.published !== next);
    if (targets.length === 0) return;
    setCampaigns((prev) => prev.map((c) => ({ ...c, published: next })));
    const results = await Promise.allSettled(
      targets.map((c) =>
        setClientPublish({ slug, short_token: c.short_token, published: next }),
      ),
    );
    const failed = new Set(
      targets.filter((_, i) => results[i].status === "rejected").map((c) => c.short_token),
    );
    if (failed.size > 0) {
      setCampaigns((prev) =>
        prev.map((c) => (failed.has(c.short_token) ? { ...c, published: !next } : c)),
      );
      setError(`Não consegui salvar ${failed.size} campanha(s). Tente de novo.`);
    }
  };

  const publishedCount = campaigns.filter((c) => c.published).length;
  const allPublished = campaigns.length > 0 && publishedCount === campaigns.length;
  const canActivate = config?.has_password || password.trim();

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent widthClass="sm:w-[520px]">
        <DrawerHeader
          title="Link compartilhado"
          subtitle={`Portal do cliente · ${displayName || slug}`}
        />

        <DrawerBody className="space-y-6">
          {loadFailed ? (
            <div className="rounded-xl border border-danger/40 bg-danger/8 p-5 text-center">
              <p className="text-[13px] font-semibold text-fg">Não consegui carregar a config do portal</p>
              <p className="text-[12px] text-fg-muted mt-1.5 leading-snug">
                O backend pode ainda não ter os endpoints do portal{error ? ` (${error})` : ""}.
                Verifique se o deploy foi feito (<code className="font-mono">./backend/deploy.sh</code>).
              </p>
              <button
                type="button"
                onClick={load}
                className="mt-4 h-9 px-4 rounded-lg text-[13px] font-semibold text-on-signature bg-signature hover:bg-signature-hover transition-colors"
              >
                Tentar de novo
              </button>
            </div>
          ) : (
            <>
              {syncing && (
                <div className="flex items-center gap-2 text-[11px] text-fg-subtle -mt-1">
                  <span className="w-3 h-3 rounded-full border-2 border-border border-t-signature animate-spin" aria-hidden />
                  Carregando configuração…
                </div>
              )}
              {/* Status */}
              <Section
                title="Status do portal"
                hint="Quando ativo, o cliente acessa pelo link abaixo com a senha."
              >
                <ToggleRow
                  label={active ? "Portal ativo" : "Portal desativado"}
                  sub={
                    !canActivate
                      ? "Defina uma senha para poder ativar."
                      : !active
                        ? "Ligue para o cliente conseguir acessar o link."
                        : null
                  }
                  checked={active}
                  disabled={!canActivate}
                  accent={accent}
                  onChange={setActive}
                />
              </Section>

              {/* Link */}
              {shareUrl && (
                <Section title="Link do cliente">
                  <div className="flex items-center gap-2">
                    <code className="flex-1 min-w-0 truncate text-[12px] bg-surface border border-border rounded-lg px-3 h-9 flex items-center text-fg-muted">
                      {shareUrl}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="shrink-0 h-9 px-3 rounded-lg text-[12px] font-semibold text-on-signature transition-opacity hover:opacity-90"
                      style={{ background: accent }}
                    >
                      {copied ? "Copiado!" : "Copiar"}
                    </button>
                  </div>
                </Section>
              )}

              {/* Senha */}
              <Section
                title="Senha de acesso"
                hint="O cliente usa essa senha pra abrir o portal — ou o código (short_token) de qualquer campanha publicada. Edite e salve pra trocar."
              >
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Defina uma senha"
                    className="flex-1 min-w-0 h-10 px-3 rounded-lg bg-surface border border-border text-[13px] text-fg placeholder:text-fg-subtle focus:outline-none focus:border-signature focus:ring-2 focus:ring-signature/30 font-mono"
                  />
                  <button
                    type="button"
                    disabled={!password.trim()}
                    onClick={() => {
                      navigator.clipboard.writeText(password.trim());
                      setPwCopied(true);
                      setTimeout(() => setPwCopied(false), 2000);
                    }}
                    className="shrink-0 h-10 px-3 rounded-lg text-[12px] font-medium border border-border text-fg hover:bg-surface transition-colors disabled:opacity-40"
                  >
                    {pwCopied ? "Copiado!" : "Copiar"}
                  </button>
                </div>
              </Section>

              {/* Co-branding */}
              <Section title="Co-branding" hint="Logo e cor de marca do cliente — re-tematiza o portal.">
                <div className="flex items-center gap-4">
                  <LogoPreview logo={logo} accent={accent} name={displayName || slug} />
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="h-8 px-3 rounded-md text-[12px] font-medium border border-border text-fg hover:bg-surface transition-colors"
                    >
                      {logo ? "Trocar logo" : "Enviar logo"}
                    </button>
                    {logo && (
                      <button
                        type="button"
                        onClick={() => { setLogo(null); setLogoTouched(true); }}
                        className="h-8 px-3 rounded-md text-[12px] text-fg-muted hover:text-danger transition-colors"
                      >
                        Remover
                      </button>
                    )}
                    <input ref={fileRef} type="file" accept="image/*" onChange={handleLogoFile} className="hidden" />
                  </div>
                </div>
                {/* Cor de marca: paleta de presets + seletor livre */}
                <div className="mt-4">
                  <label className="text-[12px] text-fg-muted">Cor de marca</label>
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    {ACCENT_PRESETS.map((c) => {
                      const selected = accent.toLowerCase() === c.toLowerCase();
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setAccent(c)}
                          aria-label={`Cor ${c}`}
                          aria-pressed={selected}
                          title={c}
                          className="size-7 rounded-full transition-transform hover:scale-110"
                          style={{
                            background: c,
                            boxShadow: selected
                              ? `0 0 0 2px var(--color-canvas-elevated), 0 0 0 4px ${c}`
                              : "inset 0 0 0 1px rgba(0,0,0,0.12)",
                          }}
                        />
                      );
                    })}
                    {/* Seletor livre — qualquer cor. Realça quando a cor atual
                        não está na paleta. */}
                    <label
                      className="relative size-7 rounded-full cursor-pointer inline-flex items-center justify-center overflow-hidden"
                      title="Cor personalizada"
                      style={{
                        background: "conic-gradient(from 0deg, #ef4444, #f59e0b, #22c55e, #0ea5e9, #7c3aed, #ec4899, #ef4444)",
                        boxShadow: ACCENT_PRESETS.some((c) => c.toLowerCase() === accent.toLowerCase())
                          ? "inset 0 0 0 1px rgba(0,0,0,0.12)"
                          : `0 0 0 2px var(--color-canvas-elevated), 0 0 0 4px ${accent}`,
                      }}
                    >
                      <input
                        type="color"
                        value={accent}
                        onChange={(e) => setAccent(e.target.value)}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        aria-label="Cor personalizada"
                      />
                    </label>
                  </div>
                </div>
              </Section>

              {/* Unificação de audiências (Analytics) */}
              <Section
                title="Unificação de audiências"
                hint="Audiências parecidas já são unificadas automaticamente (heurística + IA). Use regras só para corrigir ou fundir grupos."
                action={
                  config?.share_id && (
                    <button
                      type="button"
                      onClick={detectGroups}
                      disabled={detecting}
                      className="text-[11px] font-semibold text-signature hover:opacity-80 transition-opacity disabled:opacity-50"
                    >
                      {detecting ? "Detectando…" : "Detectar agrupamento"}
                    </button>
                  )
                }
              >
                {detectedGroups && (
                  <div className="mb-3 rounded-lg border border-border bg-canvas-deeper p-2.5 space-y-1.5 max-h-44 overflow-y-auto">
                    {Object.keys(detectedGroups).length === 0 ? (
                      <p className="text-[11.5px] text-fg-subtle">Nenhuma audiência detectada (publique campanhas com line items).</p>
                    ) : (
                      Object.entries(detectedGroups)
                        .sort((a, b) => b[1].length - a[1].length)
                        .map(([canonical, members]) => (
                          <div key={canonical} className="flex items-start gap-2">
                            <button
                              type="button"
                              onClick={() => mergeInto(canonical)}
                              title="Criar regra a partir deste grupo"
                              className="mt-0.5 text-[10px] leading-none text-fg-subtle hover:text-signature transition-colors shrink-0"
                            >
                              ＋
                            </button>
                            <div className="min-w-0">
                              <span className="text-[12px] font-semibold text-fg">{canonical}</span>
                              {members.length > 1 && (
                                <span className="text-[11px] text-fg-subtle"> · {members.length} variações</span>
                              )}
                            </div>
                          </div>
                        ))
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  {audRules.length === 0 && (
                    <p className="text-[12px] text-fg-subtle">Sem regras manuais. A unificação automática cuida do resto.</p>
                  )}
                  {audRules.map((rule, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input
                        value={rule.from}
                        onChange={(e) => updateRule(i, "from", e.target.value)}
                        placeholder="Mercado"
                        className="flex-1 min-w-0 h-8 px-2.5 rounded-lg bg-canvas-deeper border border-border text-[12px] text-fg placeholder:text-fg-subtle focus:outline-none focus:border-signature"
                      />
                      <span className="text-fg-subtle text-[12px] shrink-0">→</span>
                      <input
                        value={rule.to}
                        onChange={(e) => updateRule(i, "to", e.target.value)}
                        placeholder="Supermercados"
                        className="flex-1 min-w-0 h-8 px-2.5 rounded-lg bg-canvas-deeper border border-border text-[12px] text-fg placeholder:text-fg-subtle focus:outline-none focus:border-signature"
                      />
                      <button
                        type="button"
                        onClick={() => removeRule(i)}
                        aria-label="Remover regra"
                        className="shrink-0 size-8 rounded-lg text-fg-subtle hover:text-danger hover:bg-danger/8 transition-colors text-[14px]"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addRule}
                    className="text-[12px] font-semibold text-signature hover:opacity-80 transition-opacity"
                  >
                    + Adicionar regra
                  </button>
                </div>
              </Section>

              {/* Curadoria de campanhas */}
              <Section
                title="Campanhas no portal"
                hint="Só as campanhas publicadas aparecem pro cliente."
                badge={`${publishedCount}/${campaigns.length}`}
                action={
                  campaigns.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setAllPublish(!allPublished)}
                      className="text-[11px] font-semibold text-signature hover:opacity-80 transition-opacity"
                    >
                      {allPublished ? "Limpar seleção" : "Selecionar todas"}
                    </button>
                  )
                }
              >
                <div className="space-y-1.5 -mx-1">
                  {campaigns.length === 0 ? (
                    <p className="text-[12px] text-fg-subtle px-1">Nenhuma campanha encontrada para este cliente.</p>
                  ) : (
                    campaigns.map((c) => {
                      const range = getDateRangeParts(c.start_date, c.end_date);
                      const month = c.start_date ? formatMonthLabel(c.start_date.slice(0, 7), "short") : "";
                      return (
                        <button
                          key={c.short_token}
                          type="button"
                          onClick={() => togglePublish(c.short_token, !c.published)}
                          className={cn(
                            "w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors",
                            c.published ? "border-signature/40 bg-signature-soft" : "border-border hover:bg-surface",
                          )}
                        >
                          <Check on={c.published} accent={accent} />
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-medium text-fg truncate">{c.campaign_name}</div>
                            <div className="text-[11px] text-fg-subtle tabular-nums">
                              {month}{range ? ` · ${range.startStr} → ${range.endStr}` : ""}
                            </div>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </Section>

              {error && <p className="text-[12px] text-danger">{error}</p>}
            </>
          )}
        </DrawerBody>

        <DrawerFooter>
          <span className="mr-auto inline-flex items-center gap-1.5 text-[11px]">
            {saved ? (
              <span className="inline-flex items-center gap-1.5 font-semibold animate-fade-in" style={{ color: accent }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                Salvo
              </span>
            ) : (
              <span className="text-fg-subtle">{active ? "Portal ativo" : "Portal desativado"}</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-9 px-4 rounded-lg text-[13px] text-fg-muted hover:text-fg border border-border hover:bg-surface transition-colors"
          >
            Fechar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || syncing}
            className="h-9 px-4 rounded-lg text-[13px] font-semibold text-on-signature transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ background: accent }}
          >
            {saving ? "Salvando…" : "Salvar"}
          </button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

// ── Subcomponentes ────────────────────────────────────────────────────────────
function Section({ title, hint, badge, action, children }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="text-[11px] uppercase tracking-widest font-bold text-fg-muted">{title}</h3>
        <div className="flex items-center gap-3">
          {action}
          {badge && <span className="text-[11px] text-fg-subtle tabular-nums">{badge}</span>}
        </div>
      </div>
      {children}
      {hint && <p className="text-[11px] text-fg-subtle mt-1.5 leading-snug">{hint}</p>}
    </div>
  );
}

function ToggleRow({ label, sub, checked, disabled, accent, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border bg-surface-2">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-fg">{label}</div>
        {sub && <div className="text-[11px] text-warning mt-0.5">{sub}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative shrink-0 w-10 h-6 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
          checked ? "" : "bg-surface-strong",
        )}
        style={checked ? { background: accent } : undefined}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform",
            checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
}

function Check({ on, accent }) {
  return (
    <span
      className={cn(
        "shrink-0 w-5 h-5 rounded-md border flex items-center justify-center transition-colors",
        on ? "border-transparent" : "border-border-strong",
      )}
      style={on ? { background: accent } : undefined}
      aria-hidden
    >
      {on && (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </span>
  );
}

function LogoPreview({ logo, accent, name }) {
  if (logo) {
    return <img src={logo} alt="" className="w-12 h-12 rounded-lg object-contain bg-surface border border-border" />;
  }
  const initials = (name || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div
      className="w-12 h-12 rounded-lg flex items-center justify-center font-bold text-white text-base shrink-0"
      style={{ background: accent }}
      aria-hidden
    >
      {initials}
    </div>
  );
}
