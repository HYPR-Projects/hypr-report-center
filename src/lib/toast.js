// src/lib/toast.js
//
// Singleton store dos toasts. Exposto como `toast.success/error/info/dismiss`.
// O <ToastContainer /> em components/Toast.jsx subscreve aqui via subscribe().
//
// Separado em arquivo próprio (não no Toast.jsx) por causa do react-refresh:
// fast-refresh só funciona em módulos que só exportam componentes — exportar
// função singleton no mesmo arquivo do componente quebraria HMR.

let nextId = 1;
let items = [];
const subscribers = new Set();

function notify() {
  for (const fn of subscribers) fn(items);
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

export function dismiss(id) {
  items = items.filter((t) => t.id !== id);
  notify();
}

function push(kind, message, opts = {}) {
  const id = nextId++;
  const duration = opts.duration ?? (kind === "error" ? 6000 : 3000);
  const item = { id, kind, message, createdAt: Date.now(), duration };
  items = [...items, item];
  notify();
  // Auto-dismiss agora vive no ToastItem (components/Toast.jsx) pra que
  // o timer dispare a animação de saída ANTES de chamar dismiss(). Antes
  // o setTimeout daqui removia o item da array direto, e o componente
  // sumia sem fade-out — visual hard-cut.
  return id;
}

export const toast = {
  success: (msg, opts) => push("success", msg, opts),
  error:   (msg, opts) => push("error", msg, opts),
  info:    (msg, opts) => push("info", msg, opts),
  dismiss,
};

export default toast;
