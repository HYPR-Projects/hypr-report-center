// src/v2/components/AlcanceFrequenciaV2.jsx
//
// Bloco "Alcance & Frequência" — admin edita, cliente vê read-only.
//
// Escopo (target_type/target_id):
//   Cada report-membro de um grupo merge tem seu próprio par
//   (alcance, frequencia), e a visão agregada do grupo tem outro par
//   independente (não é soma — alcance único entre meses se sobrepõe).
//   O componente recebe `targetType` ("token" ou "merge") e `targetId`
//   (short_token ou merge_id) do parent, e usa esse escopo tanto pra
//   identificar qual valor mostrar (via key remount) quanto pra
//   persistir via saveAlcanceFrequencia.
//
// Frequência auto-calculada (modo padrão):
//   Quando o admin preenche apenas `alcance`, o valor de frequência é
//   derivado em runtime como `totalImpressions / alcance`. O front mostra
//   esse valor sem persistir — sai do estado "calculado" só se o admin
//   sobrescrever manualmente no input.
//
// Alcance auto-calculado (modo invertido, `autoAlcance=true`):
//   Quando o admin liga o toggle "calcular alcance automaticamente baseado
//   na frequência", ele preenche só a frequência e o alcance vira derivado:
//   `alcance = totalImpressions / frequencia`. O alcance manual é apagado
//   no save. Cliente continua vendo os dois valores normalmente — a flag
//   é só pra UX do admin.

import { useEffect, useRef, useState } from "react";
import { saveAlcanceFrequencia } from "../../lib/api";
import { fmt } from "../../shared/format";
import { Card } from "../../ui/Card";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { cn } from "../../ui/cn";

// Parser tolerante a formato BR ("1.250.000", "1250000", "1.250.000,5").
// Retorna número positivo ou null.
function parseAlcanceNumber(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/\./g, "").replace(",", ".").trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Frequência aceita vírgula ou ponto decimal ("3,5" ou "3.5"). Pessoas/Mês,
// número positivo qualquer.
function parseFrequenciaNumber(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/\./g, "").replace(",", ".").trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Formata o input de alcance enquanto o admin digita: só dígitos no input
// viram pontuação BR (617800 → "617.800"). Alcance é contagem de pessoas,
// sempre inteiro — não há decimal.
function formatAlcanceInput(s) {
  const digits = String(s ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("pt-BR");
}

// Calcula frequência derivada (impressões / alcance) formatada em pt-BR.
// Retorna string ou null se não dá pra calcular.
function deriveFrequencia(alcanceStr, totalImpressions) {
  const a = parseAlcanceNumber(alcanceStr);
  if (!a || !totalImpressions || totalImpressions <= 0) return null;
  return fmt(totalImpressions / a, 2);
}

// Calcula alcance derivado (impressões / frequência) formatado em pt-BR.
// Retorna string ou null se não dá pra calcular. Inteiro — alcance é
// contagem de pessoas.
function deriveAlcance(frequenciaStr, totalImpressions) {
  const f = parseFrequenciaNumber(frequenciaStr);
  if (!f || !totalImpressions || totalImpressions <= 0) return null;
  return fmt(Math.round(totalImpressions / f), 0);
}

// "2026-05-12T14:32:00+00:00" → "12/05/2026 às 11:32 (BRT)". Fixa horário de
// Brasília (independe do fuso do viewer — pode ser cliente fora do BR).
// Retorna null pra timestamps vazios/inválidos — componente esconde a linha.
function formatUpdatedAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric",
  });
  const time = d.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit",
  });
  return `${date} às ${time} (BRT)`;
}

export function AlcanceFrequenciaV2({
  targetType,
  targetId,
  isAdmin,
  adminJwt,
  initialAlcance = "",
  initialFrequencia = "",
  initialAutoAlcance = false,
  initialUpdatedAt = "",
  totalImpressions = 0,
}) {
  const [alcance, setAlcance] = useState(initialAlcance || "");
  const [frequencia, setFrequencia] = useState(initialFrequencia || "");
  const [autoAlcance, setAutoAlcance] = useState(!!initialAutoAlcance);
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt || "");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const lastSavedRef = useRef({
    alcance: initialAlcance || "",
    frequencia: initialFrequencia || "",
    autoAlcance: !!initialAutoAlcance,
  });

  // Reset interno quando o escopo (target) ou os valores iniciais mudam —
  // troca de view dentro de um grupo merge não remonta o componente, então
  // sem isso os campos digitados num mês vazariam pro outro.
  useEffect(() => {
    setAlcance(initialAlcance || "");
    setFrequencia(initialFrequencia || "");
    setAutoAlcance(!!initialAutoAlcance);
    setUpdatedAt(initialUpdatedAt || "");
    lastSavedRef.current = {
      alcance: initialAlcance || "",
      frequencia: initialFrequencia || "",
      autoAlcance: !!initialAutoAlcance,
    };
    setEditing(false);
    setError(null);
  }, [targetType, targetId, initialAlcance, initialFrequencia, initialAutoAlcance, initialUpdatedAt]);

  // Os dois modos são simétricos: num lado o admin digita, no outro o
  // valor é derivado. `displayAlcance`/`displayFrequencia` é o que vai pra
  // tela — manual primeiro, derivado como fallback.
  const derivedFreq    = deriveFrequencia(alcance, totalImpressions);
  const derivedAlcance = deriveAlcance(frequencia, totalImpressions);
  const displayFrequencia = autoAlcance
    ? frequencia
    : (frequencia || derivedFreq || "");
  const displayAlcance = autoAlcance
    ? (derivedAlcance || "")
    : alcance;
  const isEmpty = !displayAlcance && !displayFrequencia;

  const startEdit = () => {
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setAlcance(lastSavedRef.current.alcance);
    setFrequencia(lastSavedRef.current.frequencia);
    setAutoAlcance(lastSavedRef.current.autoAlcance);
    setError(null);
    setEditing(false);
  };

  // Ao ligar o toggle "calcular alcance automaticamente", limpa o alcance
  // manual — o backend também ignora esse campo no modo auto, mas zerar
  // localmente evita confusão visual durante a edição.
  const toggleAutoAlcance = (next) => {
    setAutoAlcance(next);
    if (next) setAlcance("");
  };

  const save = async () => {
    if (!targetType || !targetId) {
      setError("Escopo não definido — recarregue a página");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const trimmedAlcance = autoAlcance ? "" : alcance.trim();
      const trimmedFrequencia = frequencia.trim();
      await saveAlcanceFrequencia({
        target_type: targetType,
        target_id: targetId,
        alcance: trimmedAlcance,
        frequencia: trimmedFrequencia,
        auto_alcance: autoAlcance,
        adminJwt,
      });
      lastSavedRef.current = {
        alcance: trimmedAlcance,
        frequencia: trimmedFrequencia,
        autoAlcance,
      };
      setAlcance(trimmedAlcance);
      setFrequencia(trimmedFrequencia);
      // Optimistic: o backend grava CURRENT_TIMESTAMP() no MERGE. Em vez de
      // refetch, usamos o relógio local — diferença de poucos segundos não
      // muda nada na UI (mostramos só DD/MM/AAAA HH:MM).
      setUpdatedAt(new Date().toISOString());
      setEditing(false);
    } catch (e) {
      setError(e?.message || "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin && isEmpty) {
    // Cliente sem dado: mostra placeholder amigável dentro de card simples.
    return (
      <Card className="p-6">
        <div className="text-[11px] font-bold uppercase tracking-widest text-fg-muted mb-2">
          Alcance & Frequência
        </div>
        <p className="text-sm text-fg-subtle">
          Dados de alcance e frequência serão disponibilizados em breve.
        </p>
      </Card>
    );
  }

  // Hint "calculada" só faz sentido pro lado que de fato está sendo derivado.
  // Em modo padrão: aparece na frequência quando admin não preencheu.
  // Em modo auto_alcance: aparece no alcance (sempre que houver valor derivado).
  const freqIsAuto    = !autoAlcance && !frequencia && !!derivedFreq;
  const alcanceIsAuto = autoAlcance && !!derivedAlcance;
  const updatedAtLabel = !isEmpty ? formatUpdatedAt(updatedAt) : null;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-3">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">
            Alcance & Frequência
          </div>
          {updatedAtLabel && (
            <div className="text-[10px] text-fg-subtle mt-0.5 tabular-nums">
              Atualizado em {updatedAtLabel}
            </div>
          )}
        </div>
        {isAdmin && !editing && (
          <Button variant="ghost" size="sm" onClick={startEdit} iconLeft={<PencilIcon />}>
            Editar
          </Button>
        )}
        {isAdmin && editing && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              loading={saving}
            >
              {saving ? "Salvando..." : "Salvar"}
            </Button>
          </div>
        )}
      </div>

      {isAdmin && editing && (
        <label className="flex items-center gap-2 px-6 pb-3 text-xs text-fg-subtle cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoAlcance}
            onChange={(e) => toggleAutoAlcance(e.target.checked)}
            className="size-3.5 accent-signature cursor-pointer"
          />
          <span>
            Calcular alcance automaticamente baseado na frequência
            <span className="text-fg-muted ml-1">
              (impressões ÷ frequência)
            </span>
          </span>
        </label>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-border">
        <Stat
          icon={<PeopleIcon />}
          label="Alcance único"
          value={displayAlcance}
          editValue={alcance}
          onChange={(v) => setAlcance(formatAlcanceInput(v))}
          placeholder={
            autoAlcance
              ? (derivedAlcance ? `Auto: ${derivedAlcance}` : "Calculado automaticamente")
              : "Ex: 1.250.000"
          }
          editing={isAdmin && editing && !autoAlcance}
          // Quando admin liga auto_alcance, esconde o input — mostra o valor
          // derivado no formato read-only com badge "calculada" pra dar
          // contexto, igual frequência derivada.
          forceReadOnly={editing && autoAlcance}
          // Badge "calculada" é admin-only — cliente vê só o número final,
          // sem distinção entre manual e derivado.
          hint={
            isAdmin && alcanceIsAuto && (!editing || autoAlcance) ? "calculada" : null
          }
        />
        <Stat
          icon={<RefreshIcon />}
          label="Frequência média"
          value={displayFrequencia}
          editValue={frequencia}
          onChange={setFrequencia}
          placeholder={
            autoAlcance
              ? "Ex: 3,2"
              : (derivedFreq ? `Auto: ${derivedFreq}` : "Ex: 3,2")
          }
          editing={isAdmin && editing}
          hint={isAdmin && !editing && freqIsAuto ? "calculada" : null}
        />
      </div>

      {error && (
        <p className="px-6 py-3 text-xs text-danger border-t border-border">
          {error}
        </p>
      )}
    </Card>
  );
}

function Stat({ icon, label, value, editValue, onChange, placeholder, editing, hint, forceReadOnly }) {
  // forceReadOnly: estamos no modo edit do card, mas esse Stat específico
  // exibe um valor derivado e não deve aceitar input (ex: alcance quando
  // auto_alcance=true). Mostra placeholder se sem valor, em vez de "—".
  const showReadOnly = forceReadOnly || !editing;
  return (
    <div className="flex items-center gap-4 px-6 py-5 bg-surface">
      <div className="shrink-0 size-12 rounded-xl bg-signature-soft border border-signature/30 inline-flex items-center justify-center text-signature">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-1 flex items-center gap-2">
          <span>{label}</span>
          {hint && (
            <span className="text-[9px] font-semibold uppercase tracking-wider text-fg-subtle bg-canvas border border-border rounded px-1.5 py-0.5">
              {hint}
            </span>
          )}
        </div>
        {showReadOnly ? (
          <div className={cn(
            "text-3xl font-extrabold leading-none tabular-nums",
            value ? "text-fg" : "text-fg-subtle",
          )}>
            {value || (forceReadOnly && placeholder ? (
              <span className="text-base font-medium italic text-fg-subtle">
                {placeholder}
              </span>
            ) : "—")}
          </div>
        ) : (
          <Input
            value={editValue ?? value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            size="md"
            className="font-bold text-lg"
          />
        )}
      </div>
    </div>
  );
}

function PencilIcon() {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg
      className="size-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      className="size-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
