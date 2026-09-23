// src/shared/timeout.js
//
// Deadline de fetch. Módulo próprio (sem dependências) pra ser usado tanto
// por lib/api.js quanto por shared/auth.js — auth não pode importar api,
// que depende dele.

export function timeoutSignal(ms) {
  // AbortSignal.timeout é Baseline desde 2022; o guard cobre WebView antigo,
  // onde simplesmente voltamos ao comportamento anterior (sem deadline).
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}
