// src/shared/googleOAuthCode.js
//
// OAuth authorization-code flow via Google Identity Services (GIS), em modo
// popup. Extraído do SheetsIntegrationCardV2 pra ser reusado por qualquer
// integração que precise de um refresh_token server-side (sheets de
// campanha, compplan sheet, ...).
//
// Gotchas (aprendidos na integração de Sheets):
// - `prompt: "consent"` força o re-consent screen, garantindo que o
//   refresh_token vem mesmo se o usuário já autorizou antes. Sem isso,
//   autorizações subsequentes só trazem access_token (1h TTL) e o sync
//   diário quebra.
// - `redirect_uri` no popup mode é literalmente "postmessage" (o backend
//   já assume esse default na troca do code).

import { GOOGLE_CLIENT_ID } from "./config";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export function loadGisScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    let s = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
    if (!s) {
      s = document.createElement("script");
      s.src   = "https://accounts.google.com/gsi/client";
      s.async = true;
      document.body.appendChild(s);
    }
    s.addEventListener("load",  () => resolve());
    s.addEventListener("error", () => reject(new Error("Falha ao carregar GIS")));
    // Already loaded?
    if (window.google?.accounts?.oauth2) resolve();
  });
}

/** Inicia o OAuth code flow, resolve com o `code` quando o usuário autoriza. */
export function requestOAuthCode({ scope = DRIVE_FILE_SCOPE } = {}) {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      return reject(new Error("Google Identity Services não disponível"));
    }
    const client = window.google.accounts.oauth2.initCodeClient({
      client_id: GOOGLE_CLIENT_ID,
      scope,
      ux_mode:   "popup",
      prompt:    "consent",
      access_type: "offline",
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        if (!resp.code) return reject(new Error("Code ausente na resposta"));
        resolve(resp.code);
      },
      error_callback: (err) => {
        // Usuário fechou popup, popup bloqueado, etc.
        reject(new Error(err?.message || err?.type || "Autorização cancelada"));
      },
    });
    client.requestCode();
  });
}
