// src/v2/components/AlcanceFrequenciaV2.jsx
//
// Bloco "Alcance & Frequência" — admin pode editar e persistir, cliente
// vê read-only. Quando ambos estão vazios e usuário não é admin, mostra
// mensagem "será disponibilizado em breve" (mesma regra do Legacy).
//
// Redesenhado em PR-13 pra bater com o mockup:
//   - Layout horizontal com ícones grandes (people, refresh)
//   - Valores grandes (text-3xl) à direita do ícone
//   - Botão Editar com ícone de pencil
//   - Card sem border-bottom no header (header e body como uma peça só)
//
// Self-contained: gerencia próprio state local + chama a API direto.

import { useRef, useState } from "react";
import { saveAlcanceFrequencia } from "../../lib/api";
import { Card } from "../../ui/Card";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { cn } from "../../ui/cn";

export function AlcanceFrequenciaV2({
  token,
  isAdmin,
  adminJwt,
  initialAlcance = "",
  initialFrequencia = "",
}) {
  const [alcance, setAlcance] = useState(initialAlcance || "");
  const [frequencia, setFrequencia] = useState(initialFrequencia || "");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const lastSavedRef = useRef({
    alcance: initialAlcance || "",
    frequencia: initialFrequencia || "",
  });

  const isEmpty = !alcance && !frequencia;

  const startEdit = () => {
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setAlcance(lastSavedRef.current.alcance);
    setFrequencia(lastSavedRef.current.frequencia);
    setError(null);
    setEditing(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const trimmedAlcance = alcance.trim();
      const trimmedFrequencia = frequencia.trim();
      await saveAlcanceFrequencia({
        short_token: token,
        alcance: trimmedAlcance,
        frequencia: trimmedFrequencia,
        adminJwt,
      });
      lastSavedRef.current = {
        alcance: trimmedAlcance,
        frequencia: trimmedFrequencia,
      };
      setAlcance(trimmedAlcance);
      setFrequencia(trimmedFrequencia);
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

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-3">
        <div className="text-[11px] font-bold uppercase tracking-widest text-fg-muted">
          Alcance & Frequência
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-border">
        <Stat
          icon={<PeopleIcon />}
          label="Alcance único"
          value={alcance}
          onChange={setAlcance}
          placeholder="Ex: 1.250.000"
          editing={isAdmin && editing}
        />
        <Stat
          icon={<RefreshIcon />}
          label="Frequência média"
          value={frequencia}
          onChange={setFrequencia}
          placeholder="Ex: 3.2x"
          editing={isAdmin && editing}
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

function Stat({ icon, label, value, onChange, placeholder, editing }) {
  return (
    <div className="flex items-center gap-4 px-6 py-5 bg-surface">
      <div className="shrink-0 size-12 rounded-xl bg-signature-soft border border-signature/30 inline-flex items-center justify-center text-signature">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-1">
          {label}
        </div>
        {editing ? (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            size="md"
            className="font-bold text-lg"
          />
        ) : (
          <div className={cn(
            "text-3xl font-extrabold leading-none tabular-nums",
            value ? "text-fg" : "text-fg-subtle",
          )}>
            {value || "—"}
          </div>
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
