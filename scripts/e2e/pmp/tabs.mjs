// Os filtros da página são compartilhados pelas cinco views. Este roteiro
// confere que o recorte continua valendo em Lista, No ar, Carteira e
// Histórico (inclusive os recortes de data exclusivos do Histórico) — é a
// rede de segurança do refactor que tirou `applyFilters` do componente.
import { launch } from "./browser.mjs";
import fs from "node:fs";
import { buildFixture, daysAgo } from "./fixtures.mjs";

// Entrega do fixture vai de D-30 a D-1: se D-30 cai no mês anterior, o recorte
// "Mês passado" do Histórico acha as 6 lines; senão, nenhuma.
const { rows } = buildFixture();
const firstDay = rows[0].day;
const thisMonthStart = `${daysAgo(0).slice(0, 7)}-01`;
const lastMonthHits = firstDay < thisMonthStart ? 6 : 0;

const BASE = process.env.BASE || "http://127.0.0.1:5173";
const OUT = process.env.OUT || "/tmp/e2e-pmp/tabs";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 }, locale: "pt-BR" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));

const until = Date.now() + 8 * 60 * 60 * 1000;
await ctx.addInitScript(([until]) => {
  localStorage.setItem("hypr.session", JSON.stringify({
    user: { email: "joao.buzolin@hypr.mobi", name: "E2E", picture: "" },
    idToken: null, adminJwt: "e2e.fake.jwt", adminJwtUntil: until, expiresAt: until,
  }));
  localStorage.removeItem("hypr.pmp.filters");
}, [until]);

async function pageChip(name) {
  await page.locator("button", { hasText: new RegExp(`^${name}`) }).first().click();
  await page.waitForTimeout(250);
}
async function pickOption(label) {
  await page.locator("[data-radix-popper-content-wrapper]")
    .locator("button", { hasText: new RegExp(`^${label}$`) }).first().click();
  await page.waitForTimeout(400);
}
const esc = async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(200); };
async function clearAll() {
  const link = page.locator("button", { hasText: /^Limpar tudo$/ });
  if (await link.count()) { await link.first().click(); await page.waitForTimeout(500); }
  for (let i = 0; i < 8; i++) {
    const x = page.locator('button[aria-label^="Remover filtro"]');
    if (!(await x.count())) break;
    await x.first().click(); await page.waitForTimeout(350);
  }
}
async function resultLabel() {
  const el = page.locator("text=/\\d+ de \\d+ (lines|lines no ar|clientes|campanhas)/").first();
  return (await el.count()) ? (await el.innerText()).trim() : null;
}
// Abre um pill de filtro e espera o popover de fato aparecer (o clique pode
// cair no meio de um re-render depois de limpar filtros).
async function openPill(re) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await page.locator("button", { hasText: re }).first().click({ force: true });
    await page.waitForTimeout(400);
    if (await page.locator("[data-radix-popper-content-wrapper]").count()) return true;
  }
  return false;
}

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });

// ── Lista ───────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/admin/pmp/lista`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('input[placeholder*="Buscar cliente"]', { timeout: 30000 });
await page.waitForTimeout(1200);

// Lista mostra ativas + indefinidas (Finalizado vai pro Histórico): das 3
// lines PubMatic do fixture, uma é Finalizado → 2 aqui, 3 no Histórico.
await pageChip("Fonte"); await pickOption("PubMatic");
ok("Lista · Fonte PubMatic", (await resultLabel()) === "2 de 6 lines", `label=${await resultLabel()}`);
await shot("lista-pubmatic");
await clearAll();

await pageChip("Cliente"); await pickOption("Ambev"); await esc();
ok("Lista · Cliente Ambev", (await resultLabel()) === "2 de 6 lines", `label=${await resultLabel()}`);
await clearAll();

// Finalizado só vive no Histórico — a Lista fica vazia por PARTIÇÃO, não por
// filtro quebrado (o Histórico logo abaixo mostra as duas).
await pageChip("Status"); await pickOption("Finalizado"); await esc();
ok("Lista · Status Finalizado (partição manda pro Histórico)",
   (await resultLabel()) === "0 de 6 lines", `label=${await resultLabel()}`);
await clearAll();

await pageChip("Bid"); await pickOption("Fixed");
ok("Lista · Bid Fixed", (await resultLabel()) === "2 de 6 lines", `label=${await resultLabel()}`);
await clearAll();

await page.locator('input[placeholder*="Buscar cliente"]').fill("TK101");
await page.waitForTimeout(800);
ok("Lista · busca por token", (await resultLabel()) === "1 de 6 lines", `label=${await resultLabel()}`);
await shot("lista-busca");
await page.locator('input[placeholder*="Buscar cliente"]').fill("");
await page.waitForTimeout(600);

// Combinação: Fonte + Cliente (AND)
await pageChip("Fonte"); await pickOption("Xandr Curate");
await pageChip("Cliente"); await pickOption("Ambev"); await esc();
ok("Lista · Fonte + Cliente combinam em AND", (await resultLabel()) === "1 de 6 lines",
   `label=${await resultLabel()}`);
await clearAll();

// ── No ar ───────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/admin/pmp/no-ar`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await pageChip("Fonte"); await pickOption("PubMatic");
const liveLabel = await resultLabel();
ok("No ar · Fonte PubMatic recorta", /^2 de \d+ lines no ar$/.test(liveLabel || ""), `label=${liveLabel}`);
await shot("no-ar-pubmatic");
await clearAll();

// ── Carteira ────────────────────────────────────────────────────────────────
await page.goto(`${BASE}/admin/pmp/carteira`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await pageChip("Fonte"); await pickOption("PubMatic");
const cart = await resultLabel();
ok("Carteira · Fonte PubMatic recorta", /^3 de 3 clientes$/.test(cart || ""), `label=${cart}`);
await shot("carteira-pubmatic");
await clearAll();

// ── Histórico ───────────────────────────────────────────────────────────────
await page.goto(`${BASE}/admin/pmp/historico`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await pageChip("Fonte"); await pickOption("PubMatic");
ok("Histórico · Fonte PubMatic", (await resultLabel()) === "3 de 6 lines", `label=${await resultLabel()}`);
await clearAll();

await pageChip("Status"); await pickOption("Finalizado"); await esc();
ok("Histórico · Status Finalizado acha as duas", (await resultLabel()) === "2 de 6 lines",
   `label=${await resultLabel()}`);
await clearAll();

await page.locator('input[placeholder*="Buscar cliente"]').fill("TK203");
await page.waitForTimeout(800);
ok("Histórico · busca por token da line encerrada", (await resultLabel()) === "1 de 6 lines",
   `label=${await resultLabel()}`);
await page.locator('input[placeholder*="Buscar cliente"]').fill("");
await page.waitForTimeout(600);

// Recorte de período do Histórico: entrega é toda de agosto/26.
await openPill(/^Período/);
const mesPassado = page.locator("[data-radix-popper-content-wrapper] button", { hasText: /^Mês passado$/ }).first();
if (await mesPassado.count()) {
  await mesPassado.click(); await page.waitForTimeout(800); await esc();
  ok(`Histórico · Período 'mês passado' → ${lastMonthHits} lines (entrega começa em ${firstDay})`,
     (await resultLabel()) === `${lastMonthHits} de 6 lines`, `label=${await resultLabel()}`);
  await shot("historico-mes-passado");
  await clearAll();
} else {
  ok("Histórico · preset de período encontrado", false, "popover não abriu");
}

// "Últimos 30 dias" sempre cruza a entrega (a série vive em D-30..D-1).
if (!(await openPill(/^Período/))) {
  ok("Histórico · Período abriu de novo", false, "popover não abriu");
} else {
  const p30 = page.locator("[data-radix-popper-content-wrapper] button", { hasText: /^Últimos 30 dias$/ }).first();
  if (await p30.count()) {
    await p30.click(); await page.waitForTimeout(800); await esc();
    ok("Histórico · Período 'últimos 30 dias' acha as 6",
       (await resultLabel()) === "6 de 6 lines", `label=${await resultLabel()}`);
    await shot("historico-30d");
    await clearAll();
  } else {
    ok("Histórico · preset 'Últimos 30 dias' encontrado", false, "opção ausente");
  }
}

const MES_ABBR = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const lastMes = MES_ABBR[Number(rows.at(-1).day.slice(5, 7)) - 1];
await openPill(/^Mês$/);
const mesOpt = page.locator("[data-radix-popper-content-wrapper] button", { hasText: new RegExp(`^${lastMes}$`) }).first();
if (await mesOpt.count()) {
  await mesOpt.click(); await page.waitForTimeout(700); await esc();
  ok(`Histórico · recorte por mês (${lastMes}) mantém as 6`, (await resultLabel()) === "6 de 6 lines",
     `label=${await resultLabel()}`);
  await shot("historico-mes");
  await clearAll();
} else {
  ok("Histórico · seletor de mês encontrado", false, "popover não abriu");
}

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks OK`);
await browser.close();
process.exit(failed.length ? 1 : 0);
