import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Carrega Urbanist self-hosted (pesos 400-800) em todas as rotas. Antes
// vivia só no ClientDashboardV2; LoginScreen e ClientPasswordScreen
// dependiam de um @import url(Google Fonts) síncrono dentro do
// GlobalStyle, que era render-blocking no path crítico.
import './ui/typography'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
