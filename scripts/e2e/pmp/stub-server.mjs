// Backend de mentira pro E2E: responde os actions que a página PMP chama.
import http from "node:http";
import { buildFixture } from "./fixtures.mjs";

const { lines, rows } = buildFixture();
const PORT = Number(process.env.STUB_PORT || 8788);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const action = url.searchParams.get("action") || "";
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  let body;
  switch (action) {
    case "pmp_lines_list":
      body = {
        lines,
        sync_runs: [
          { source: "xandr",    last_run_at: "2026-08-31T04:05:00Z", last_run_status: "ok", api_last_day: "2026-08-30", lag_days: 1 },
          { source: "pubmatic", last_run_at: "2026-08-31T04:07:00Z", last_run_status: "ok", api_last_day: "2026-08-30", lag_days: 1 },
        ],
        sync_runs_recent: [],
      };
      break;
    case "pmp_lines_timeseries": {
      const from = url.searchParams.get("date_from");
      const to = url.searchParams.get("date_to");
      body = { rows: rows.filter((r) => (!from || r.day >= from) && (!to || r.day <= to)) };
      break;
    }
    case "pmp_lines_window":
      body = { metrics: {} };
      break;
    case "ping":
      body = { ok: true };
      break;
    default:
      // Qualquer outra chamada do shell (alertas, contagens…) responde vazio.
      body = { ok: true, items: [], rows: [], campaigns: [], clients: [], alerts: [] };
  }
  res.end(JSON.stringify(body));
});

server.listen(PORT, () => console.log(`[stub] http://localhost:${PORT}`));
