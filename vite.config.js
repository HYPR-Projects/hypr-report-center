import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// ── Vendor chunk splitting (Fase 4 · PR-21) ────────────────────────────
// Antes da PR-21 o build gerava um único arquivo de ~975 kB. O bundle
// foi quebrado em duas dimensões complementares:
//
//   1. Por rota (em App.jsx via React.lazy): cada page/dashboard vira
//      um chunk próprio. Cliente que só abre /report/X carrega só o
//      ClientDashboard (Legacy) OU ClientDashboardV2, nunca ambos.
//
//   2. Por vendor (este arquivo): separamos as 4 famílias de libs
//      pesadas em chunks dedicados. Esses chunks são cacheáveis a
//      longo prazo no browser (hash muda só quando a versão da lib
//      muda), enquanto chunks de aplicação invalidam a cada deploy.
//
// Famílias separadas:
//   - react        → react + react-dom + scheduler (fundamento, sempre necessário)
//   - recharts     → recharts + d3 transitivo (~200 kB, só V2 carrega)
//   - radix        → @radix-ui/* (Dialog, Popover, Tabs, Tooltip — só V2)
//   - dates        → date-fns + react-day-picker (DateRangeFilterV2)
//
// Por que NÃO criar um chunk pra Tailwind / cva / clsx / tailwind-merge
//   São pequenos e usados em todo lugar — splittar gera mais round-trips
//   sem ganho de cache real. Ficam no chunk da rota que primeiro precisar.
//
// Por que NÃO splittar @fontsource/urbanist
//   Vite já trata fonts como assets separados (cada .woff2 vira arquivo
//   próprio com hash). O JS do @fontsource é minúsculo (CSS injection).

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('react-dom') || id.match(/[/\\]react[/\\]/) || id.includes('scheduler')) return 'react';
          if (id.includes('recharts') || id.includes('d3-')) return 'recharts';
          if (id.includes('@radix-ui')) return 'radix';
          if (id.includes('date-fns') || id.includes('react-day-picker')) return 'dates';
        },
      },
    },
  },
  server: {
    headers: {
      "Content-Security-Policy": "img-src * data: blob:; default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;"
    }
  }
})
