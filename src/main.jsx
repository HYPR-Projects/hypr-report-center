import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Carrega Urbanist self-hosted (pesos 400-800) em todas as rotas. Antes
// vivia só no ClientDashboardV2; LoginScreen e ClientPasswordScreen
// dependiam de um @import url(Google Fonts) síncrono dentro do
// GlobalStyle, que era render-blocking no path crítico.
import './ui/typography'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import GlobalProgressBar from './components/GlobalProgressBar.jsx'
import { ToastContainer } from './components/Toast.jsx'

// Recuperação de chunk stale pós-deploy: todas as rotas são lazy() (App.jsx),
// então uma aba aberta antes de um deploy da Vercel referencia chunks JS que
// não existem mais — o import dinâmico falha e a tela fica presa no fallback
// do Suspense ("report em branco até dar refresh"). O Vite emite
// `vite:preloadError` nesse cenário; recarregar busca o index.html novo com
// os hashes atuais. O timestamp em sessionStorage limita a 1 reload por
// minuto: se o reload não resolver (ex.: rede fora), deixa o erro propagar
// pro ErrorBoundary em vez de entrar em loop de refresh.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'hypr.chunkReloadAt'
  const last = Number(sessionStorage.getItem(KEY) || 0)
  if (Date.now() - last < 60_000) return
  sessionStorage.setItem(KEY, String(Date.now()))
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      {/* Barra fininha de loading global — fica fixa no topo, aparece só
        * em fetches > 200ms. Mantida fora do <App /> pra sobreviver a
        * trocas de rota sem desmontar. */}
      <GlobalProgressBar />
      <App />
      {/* Toast container — captura toast.success()/error() de qualquer
        * lugar do app via singleton. Fica fora do <App /> pelo mesmo
        * motivo da progress bar (sobrevive a trocas de rota). */}
      <ToastContainer />
    </ErrorBoundary>
  </StrictMode>,
)
