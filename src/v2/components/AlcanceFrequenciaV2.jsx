// src/v2/components/AlcanceFrequenciaV2.jsx
//
// Bloco "Alcance & Frequência" — admin pode editar e persistir, cliente
// vê read-only. Quando ambos estão vazios e usuário não é admin, mostra
// mensagem "será disponibilizado em breve" (mesma regra do Legacy).
//
// Self-contained: gerencia próprio state local + chama a API direto.
// Diferente do Legacy que recebia state controlado do pai
// (alcance/frequencia/setAlcance/setFrequencia/editingAfReach/saveAf
// como 7 props) — fica mais simples assim.

import { useState } from "react";
import { saveAlcanceFrequencia } from "../../lib/api";
import { Card, CardBody } from "../../ui/Card";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";

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

  const isEmpty = !alcance && !frequencia;

  const startEdit = () => { setError(null); setEditing(true); };

  const cancel = () => {
    setAlcance(initialAlcance || "");
    setFrequencia(initialFrequencia || "");
    setError(null);
    setEditing(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveAlcanceFrequencia({
        short_token: token,
        alcance: alcance.trim(),
        frequencia: frequencia.trim(),
        adminJwt,
      });
      setEditing(false);
    } catch (e) {
      setError(e?.message || "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardBody className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-bold uppercase tracking-widest text-signature">
            Alcance &amp; Frequência
          </span>

          {isAdmin && !editing && (
            <Button variant="ghost" size="sm" onClick={startEdit}>
              Editar
            </Button>
          )}

          {isAdmin && editing && (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>
                Cancelar
              </Button>
              <Button variant="primary" size="sm" onClick={save} loading={saving}>
                {saving ? "Salvando..." : "Salvar"}
              </Button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            label="Alcance"
            value={alcance}
            onChange={setAlcance}
            placeholder="Ex: 1.250.000"
            editing={isAdmin && editing}
          />
          <Field
            label="Frequência"
            value={frequencia}
            onChange={setFrequencia}
            placeholder="Ex: 3.2x"
            editing={isAdmin && editing}
          />
        </div>

        {error && (
          <p className="text-xs text-danger">
            {error}
          </p>
        )}

        {!isAdmin && isEmpty && (
          <p className="text-xs text-fg-subtle">
            Dados de alcance e frequência serão disponibilizados em breve.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function Field({ label, value, onChange, placeholder, editing }) {
  return (
    <div className="rounded-lg bg-canvas-deeper border border-border px-4 py-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-fg-muted mb-1.5">
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
        <div className="text-2xl font-bold text-fg leading-tight tabular-nums">
          {value || "—"}
        </div>
      )}
    </div>
  );
}
