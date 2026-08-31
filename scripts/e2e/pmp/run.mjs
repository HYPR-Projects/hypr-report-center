#!/usr/bin/env node
//
// Sobe um backend de mentira + o dev server e roda os dois roteiros de E2E do
// PMP Deals (aba Analytics e as outras quatro views). Uso:
//
//   npm i --no-save playwright-core     # uma vez (não é dependência do app)
//   node scripts/e2e/pmp/run.mjs        # tudo
//   node scripts/e2e/pmp/run.mjs tabs   # só um roteiro
//
// Prints e resultados vão pra $OUT_DIR (default /tmp/e2e-pmp).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_PORT = process.env.STUB_PORT || "8788";
const VITE_PORT = process.env.VITE_PORT || "5199";
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const OUT_DIR = process.env.OUT_DIR || "/tmp/e2e-pmp";
const only = process.argv[2] || null;

const children = [];
const spawnBg = (cmd, args, env) => {
  const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: "inherit" });
  children.push(c);
  return c;
};
const kill = () => children.forEach((c) => { try { c.kill("SIGTERM"); } catch { /* já morreu */ } });
process.on("exit", kill);
process.on("SIGINT", () => { kill(); process.exit(130); });

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout esperando ${url}`);
}

spawnBg("node", [path.join(HERE, "stub-server.mjs")], { STUB_PORT });
spawnBg("npx", ["vite", "--port", VITE_PORT, "--host", "127.0.0.1", "--clearScreen", "false"],
        { VITE_API_URL: `http://localhost:${STUB_PORT}` });

await waitFor(`http://localhost:${STUB_PORT}/?action=ping`);
await waitFor(`${BASE}/admin/pmp/analytics`);

const suites = [
  ["analytics", path.join(HERE, "analytics.mjs")],
  ["tabs", path.join(HERE, "tabs.mjs")],
].filter(([name]) => !only || only === name);

let failed = 0;
for (const [name, file] of suites) {
  console.log(`\n─── ${name} ───────────────────────────────────────────────`);
  const code = await new Promise((resolve) => {
    const c = spawn("node", [file], {
      env: { ...process.env, BASE, OUT: path.join(OUT_DIR, name) },
      stdio: "inherit",
    });
    c.on("exit", resolve);
  });
  if (code !== 0) failed++;
}

kill();
console.log(`\n${failed ? `${failed} roteiro(s) com falha` : "todos os roteiros OK"} · prints em ${OUT_DIR}`);
process.exit(failed ? 1 : 0);
