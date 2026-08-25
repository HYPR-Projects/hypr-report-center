/**
 * Wrapper centralizado em volta da Google Identity Services (GIS).
 *
 * Existe por dois motivos:
 *
 *  1) Carregar o script `accounts.google.com/gsi/client` uma única vez
 *     entre LoginScreen (login inicial) e App.jsx (refresh silencioso),
 *     evitando duplicação e race conditions na inicialização.
 *
 *  2) Habilitar refresh silencioso do `id_token` do Google: o token
 *     dura ~1h, mas a sessão admin é de 8h. Sem refresh, ações admin
 *     param de funcionar depois de 1h. Com `auto_select: true` +
 *     `use_fedcm_for_prompt: true`, o `prompt()` chamado em background
 *     retorna um `credential` novo sem UI (em browsers modernos com
 *     FedCM) ou via One Tap quase invisível.
 *
 * O `callback` passado em `initGoogleAuth` é o handler global — tanto
 * o login inicial (sem sessão) quanto cada refresh silencioso passam
 * por ele. Quem chama é responsável por discriminar via `loadSession`.
 *
 * `initGoogleAuth` pode ser chamado múltiplas vezes (idempotente do
 * lado do GIS); o último callback registrado vence. Isso permite que
 * LoginScreen e App.jsx convivam sem coordenação extra.
 */

import { GOOGLE_CLIENT_ID } from "./config";

let _scriptPromise = null;

function loadScript() {
  if (_scriptPromise) return _scriptPromise;
  _scriptPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = (e) => {
      _scriptPromise = null;
      reject(e);
    };
    document.body.appendChild(s);
  });
  return _scriptPromise;
}

/**
 * Inicializa GIS com o callback de credencial. Deve ser chamado antes
 * de `renderSignInButton` ou `requestSilentSignIn`. `auto_select` permite
 * que o `prompt()` reaproveite a conta previamente escolhida sem UI;
 * `use_fedcm_for_prompt` ativa o fluxo nativo do Chrome (silencioso).
 */
export async function initGoogleAuth(callback) {
  await loadScript();
  window.google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback,
    auto_select: true,
    use_fedcm_for_prompt: true,
  });
}

/**
 * Renderiza o botão "Sign in with Google" no elemento dado. Requer
 * `initGoogleAuth` ter sido chamado antes (mesma sessão do GIS).
 */
export async function renderSignInButton(elementId, opts = {}) {
  await loadScript();
  const el = document.getElementById(elementId);
  if (!el) return;
  window.google.accounts.id.renderButton(el, {
    theme: "filled_black",
    size: "large",
    width: 280,
    ...opts,
  });
}

/**
 * Desarma o `auto_select`. Depois disso o GIS volta a PERGUNTAR qual conta
 * usar em vez de repescar a última.
 *
 * Existe por um motivo específico: `auto_select: true` faz o One Tap
 * silencioso reeleger sozinho a última conta Google usada no browser. Se
 * essa conta não for @hypr.mobi, a tela de login recusa, e o `prompt()` da
 * carga seguinte reelege a MESMA conta — o operador fica preso num laço sem
 * nunca ver o seletor de contas. Chamar isto ao recusar devolve a escolha
 * pra ele.
 */
export async function disableAutoSelect() {
  await loadScript();
  try {
    window.google.accounts.id.disableAutoSelect();
  } catch {
    /* GIS ausente/bloqueado — nada a desarmar */
  }
}

/**
 * Dispara One Tap silencioso. Em browsers com FedCM e sessão Google
 * ativa, o `callback` registrado em `initGoogleAuth` é invocado com
 * um `credential` novo sem qualquer UI. Em browsers sem FedCM, pode
 * exibir o One Tap brevemente; se o usuário não estiver logado no
 * Google, é no-op silencioso.
 */
export async function requestSilentSignIn() {
  await loadScript();
  try {
    window.google.accounts.id.prompt();
  } catch {
    /* ignore — vai tentar de novo no próximo timer */
  }
}
