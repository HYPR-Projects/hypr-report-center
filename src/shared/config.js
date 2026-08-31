export const GOOGLE_CLIENT_ID = "453955675457-p7bj0e8jt6s83da5teo2var5t97okqk7.apps.googleusercontent.com";

// `import.meta.env` só existe sob o Vite. Ler direto quebrava qualquer módulo
// desta árvore em `node --test` (que é como os testes de lógica rodam) — daí a
// guarda: no browser/bundle continua sendo o define do Vite; no Node vira {}.
const ENV = (typeof import.meta !== "undefined" && import.meta.env) || {};

export const API_URL = ENV.VITE_API_URL || "https://southamerica-east1-site-hypr.cloudfunctions.net/report_data";
