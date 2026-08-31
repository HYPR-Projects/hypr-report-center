// Abre o Chromium do Playwright. Em máquina de dev, `npx playwright install`
// deixa o binário onde a lib espera e nada disso é necessário; em ambientes
// que já vêm com um Chromium pré-instalado (CI, container do agente), o
// caminho não casa com a versão da lib — daí a detecção + CHROMIUM_PATH.
import fs from "node:fs";
import path from "node:path";
import pw from "playwright-core";

function detect() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().reverse();
  for (const d of dirs) {
    const bin = path.join(root, d, "chrome-linux", "chrome");
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

export async function launch() {
  const executablePath = detect();
  return pw.chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox"],
  });
}
