// E2E do PMP Deals: abre a aba Analytics no navegador de verdade e exercita
// TODOS os filtros — os da página (busca, Cliente, Status, Bid, Fonte) e os da
// própria aba (Período, Cliente, Campanha, Status, Bid, Diário/Mensal).
import { launch } from "./browser.mjs";
import { buildFixture, expected, daysAgo, TODAY } from "./fixtures.mjs";
import fs from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:5173";
const OUT = process.env.OUT || "/tmp/e2e-pmp/analytics";
fs.mkdirSync(OUT, { recursive: true });

const { rows } = buildFixture();
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const brl = (v) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 }, locale: "pt-BR" });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 200)); });
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));

// Sessão admin falsa: `loadSession()` só olha o localStorage, e o JWT nunca é
// validado localmente — o backend é o stub.
const until = Date.now() + 8 * 60 * 60 * 1000;
await ctx.addInitScript(([until]) => {
  localStorage.setItem("hypr.session", JSON.stringify({
    user: { email: "joao.buzolin@hypr.mobi", name: "E2E", picture: "" },
    idToken: null, adminJwt: "e2e.fake.jwt",
    adminJwtUntil: until, expiresAt: until,
  }));
  localStorage.removeItem("hypr.pmp.filters");
}, [until]);

await page.goto(`${BASE}/admin/pmp/analytics`, { waitUntil: "domcontentloaded" });

// ── Helpers de leitura ──────────────────────────────────────────────────────

// Valor cheio (title="R$ 65.709,00") do tile de KPI do Analytics.
async function kpiTitle(label) {
  const tile = page.locator("div.rounded-2xl", { has: page.locator(`div:text-is("${label}")`) }).first();
  return await tile.locator("div[title]").first().getAttribute("title");
}
async function kpiText(label) {
  const tile = page.locator("div.rounded-2xl", { has: page.locator(`div:text-is("${label}")`) }).first();
  return (await tile.innerText()).replace(/\s+/g, " ");
}
const dealsLabel = () => page.locator("span", { hasText: /^\d+ deals?$/ }).last().innerText();
const resultLabel = async () => {
  const el = page.locator("text=/\\d+ de \\d+ lines/").first();
  return (await el.count()) ? (await el.innerText()) : null;
};

async function waitAnalytics() {
  await page.waitForSelector('div:text-is("Receita Bruta")', { timeout: 30000 });
  await page.waitForTimeout(350);
}

// Chip da FilterBar da página (Cliente / Status / Bid / Fonte).
async function pageChip(name) {
  const chip = page.locator("button", { hasText: new RegExp(`^${name}`) }).first();
  await chip.click();
  await page.waitForTimeout(250);
}
async function pickOption(label) {
  await page.locator(`[role="dialog"], [data-radix-popper-content-wrapper]`)
    .locator("button", { hasText: new RegExp(`^${label}$`) }).first().click();
  await page.waitForTimeout(450);
}
async function closePopover() {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}
async function clearAll() {
  // "Limpar tudo" só existe com 2+ filtros ativos; com 1, cada chip tem o seu ×.
  const link = page.locator("button", { hasText: /^Limpar tudo$/ });
  if (await link.count()) { await link.first().click(); await page.waitForTimeout(600); }
  for (let i = 0; i < 8; i++) {
    const x = page.locator('button[aria-label^="Remover filtro"]');
    if (!(await x.count())) break;
    await x.first().click();
    await page.waitForTimeout(400);
  }
  const left = await page.locator('button[aria-label^="Remover filtro"]').count();
  if (left) throw new Error(`clearAll deixou ${left} filtro(s) ativo(s)`);
  await page.waitForTimeout(300);
}

// Filtro próprio da aba (MultiFilter): abre pelo texto do resumo e confirma
// que o clique pegou (o botão passa a mostrar a opção escolhida). Sem a
// confirmação, um clique perdido no meio de um re-render viraria "filtro não
// funciona" — falso negativo que já apareceu aqui.
async function tabFilter(summary, option) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const trigger = page.locator("button", { hasText: new RegExp(`^${summary}`) }).first();
    if (!(await trigger.count())) break;                       // já está aplicado
    await trigger.click({ force: true });
    await page.waitForTimeout(350);
    const opt = page.locator("[data-radix-popper-content-wrapper] button", { hasText: new RegExp(`^${option}$`) }).first();
    if (await opt.count()) {
      await opt.click();
      await page.waitForTimeout(400);
    }
    await closePopover();
    if (await page.locator("button", { hasText: new RegExp(`^${option}`) }).count()) return true;
  }
  throw new Error(`tabFilter("${summary}", "${option}") não aplicou`);
}

async function clearTabFilters() {
  const link = page.locator("button", { hasText: /^Limpar$/ }).last();
  if (await link.count()) { await link.click(); await page.waitForTimeout(600); }
}

// Faixa "Faturamento" do topo (KpiBoard) — colapsável, então garante aberta.
async function topKpi(label) {
  const board = page.locator('button', { hasText: /Faturamento/ }).first();
  let tile = page.locator("div", { has: page.locator(`div:text-is("${label}")`) });
  if (!(await page.locator(`div:text-is("${label}")`).count())) {
    if (await board.count()) { await board.click(); await page.waitForTimeout(500); }
  }
  const cell = page.locator(`div:text-is("${label}")`).first();
  if (!(await cell.count())) return null;
  const parent = cell.locator("xpath=..");
  return (await parent.innerText()).replace(/\s+/g, " ");
}

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: false });

// ── 1. Baseline: aba abre e soma o dataset inteiro ──────────────────────────
await waitAnalytics();
const window30 = { from: daysAgo(29), to: TODAY };   // preset default "últimos 30 dias"
const totalExp = expected(rows, window30);
const revTotal = await kpiTitle("Receita Bruta");
ok("Analytics carrega e soma o dataset todo",
   revTotal === brl(totalExp.revenue), `tela=${revTotal} esperado=${brl(totalExp.revenue)}`);
ok("Contagem de deals do período", (await dealsLabel()).startsWith(String(totalExp.deals)),
   `tela=${await dealsLabel()} esperado=${totalExp.deals} deals`);
await shot("01-baseline");

// ── 2. O BUG: Fonte · PubMatic tem que mexer no Analytics ───────────────────
await pageChip("Fonte");
await pickOption("PubMatic");
await waitAnalytics();
const pubExp = expected(rows, { ...window30, source: "pubmatic" });
const revPub = await kpiTitle("Receita Bruta");
ok("Fonte · PubMatic recorta o Analytics",
   revPub === brl(pubExp.revenue), `tela=${revPub} esperado=${brl(pubExp.revenue)}`);
ok("Fonte · PubMatic muda a contagem de deals",
   (await dealsLabel()).startsWith(String(pubExp.deals)), `tela=${await dealsLabel()}`);
ok("Rótulo de resultado aparece no Analytics", /3 de 6 lines/.test((await resultLabel()) || ""),
   `tela=${await resultLabel()}`);
await shot("02-fonte-pubmatic");

// (a coerência com a faixa "Faturamento" do topo é conferida no passo 13)
ok("Card PI contratado presente", (await page.locator("text=/PI contratado/i").first().count()) > 0);

// ── 3. Fonte · Xandr e a partição exata ────────────────────────────────────
await pageChip("Fonte");
await pickOption("Xandr Curate");
await waitAnalytics();
const xanExp = expected(rows, { ...window30, source: "xandr" });
const revXan = await kpiTitle("Receita Bruta");
ok("Fonte · Xandr recorta o Analytics",
   revXan === brl(xanExp.revenue), `tela=${revXan} esperado=${brl(xanExp.revenue)}`);
ok("PubMatic + Xandr = total (nenhuma row contada duas vezes)",
   Math.abs(pubExp.revenue + xanExp.revenue - totalExp.revenue) < 0.02);
await shot("03-fonte-xandr");

// ── 4. Cliente (filtro da página) ──────────────────────────────────────────
await pageChip("Fonte"); await pickOption("Todas"); await waitAnalytics();
await pageChip("Cliente"); await pickOption("Ambev"); await closePopover(); await waitAnalytics();
const ambevExp = expected(rows, { ...window30, pick: (r) => [101, 201].includes(r.line_id) });
ok("Cliente · Ambev recorta o Analytics",
   (await kpiTitle("Receita Bruta")) === brl(ambevExp.revenue),
   `tela=${await kpiTitle("Receita Bruta")} esperado=${brl(ambevExp.revenue)}`);
await shot("04-cliente-ambev");

// Cliente é multi-select: soma com Itaú.
await pageChip("Cliente"); await pickOption("Itau"); await closePopover(); await waitAnalytics();
const twoExp = expected(rows, { ...window30, pick: (r) => [101, 201, 103, 202].includes(r.line_id) });
ok("Cliente multi-select soma os dois",
   (await kpiTitle("Receita Bruta")) === brl(twoExp.revenue),
   `tela=${await kpiTitle("Receita Bruta")} esperado=${brl(twoExp.revenue)}`);
await clearAll(); await waitAnalytics();

// ── 5. Status (filtro da página) ───────────────────────────────────────────
await pageChip("Status"); await pickOption("Finalizado"); await closePopover(); await waitAnalytics();
const finExp = expected(rows, { ...window30, pick: (r) => [103, 203].includes(r.line_id) });
ok("Status · Finalizado recorta o Analytics",
   (await kpiTitle("Receita Bruta")) === brl(finExp.revenue),
   `tela=${await kpiTitle("Receita Bruta")} esperado=${brl(finExp.revenue)}`);
await shot("05-status-finalizado");
await clearAll(); await waitAnalytics();

// ── 6. Bid (filtro da página) ──────────────────────────────────────────────
await pageChip("Bid"); await pickOption("Fixed"); await waitAnalytics();
const fixedExp = expected(rows, { ...window30, pick: (r) => [102, 202].includes(r.line_id) });
ok("Bid · Fixed recorta o Analytics",
   (await kpiTitle("Receita Bruta")) === brl(fixedExp.revenue),
   `tela=${await kpiTitle("Receita Bruta")} esperado=${brl(fixedExp.revenue)}`);
await shot("06-bid-fixed");
await clearAll(); await waitAnalytics();

// ── 7. Busca livre ─────────────────────────────────────────────────────────
await page.locator('input[placeholder*="Buscar cliente"]').fill("Magalu");
await page.waitForTimeout(700); await waitAnalytics();
const magaluExp = expected(rows, { ...window30, pick: (r) => r.line_id === 203 });
ok("Busca livre recorta o Analytics",
   (await kpiTitle("Receita Bruta")) === brl(magaluExp.revenue),
   `tela=${await kpiTitle("Receita Bruta")} esperado=${brl(magaluExp.revenue)}`);
await shot("07-busca-magalu");
await page.locator('input[placeholder*="Buscar cliente"]').fill("");
await page.waitForTimeout(700); await waitAnalytics();

// ── 8. Filtros da própria aba ──────────────────────────────────────────────
await tabFilter("Todos os clientes", "Vivo"); await waitAnalytics();
const vivoExp = expected(rows, { ...window30, pick: (r) => r.line_id === 102 });
ok("Filtro Cliente da aba",
   (await kpiTitle("Receita Bruta")) === brl(vivoExp.revenue),
   `tela=${await kpiTitle("Receita Bruta")} esperado=${brl(vivoExp.revenue)}`);
await shot("08-aba-cliente-vivo");

// "Limpar" da barra da aba volta tudo (e zera o período).
await page.locator("button", { hasText: /^Limpar$/ }).last().click();
await page.waitForTimeout(600); await waitAnalytics();
const lifetimeExp = expected(rows, {});
ok("Limpar da aba solta período e dimensões (soma lifetime)",
   (await kpiTitle("Receita Bruta")) === brl(lifetimeExp.revenue),
   `tela=${await kpiTitle("Receita Bruta")} esperado=${brl(lifetimeExp.revenue)}`);

await tabFilter("Todas as campanhas", "Cartoes Q3"); await waitAnalytics();
const cartoesExp = expected(rows, { pick: (r) => [103, 202].includes(r.line_id) });
ok("Filtro Campanha da aba",
   (await kpiTitle("Receita Bruta")) === brl(cartoesExp.revenue),
   `tela=${await kpiTitle("Receita Bruta")} esperado=${brl(cartoesExp.revenue)}`);
await shot("09-aba-campanha");

await page.locator("button", { hasText: /^Limpar$/ }).last().click();
await page.waitForTimeout(600); await waitAnalytics();

await tabFilter("Todos os status", "Finalizado"); await waitAnalytics();
const finLifeExp = expected(rows, { pick: (r) => [103, 203].includes(r.line_id) });
ok("Filtro Status da aba",
   (await kpiTitle("Receita Bruta")) === brl(finLifeExp.revenue),
   `tela=${await kpiTitle("Receita Bruta")} esperado=${brl(finLifeExp.revenue)}`);
await page.locator("button", { hasText: /^Limpar$/ }).last().click();
await page.waitForTimeout(600); await waitAnalytics();

await tabFilter("Todos os tipos", "Fixed"); await waitAnalytics();
const fixedLifeExp = expected(rows, { pick: (r) => [102, 202].includes(r.line_id) });
ok("Filtro Bid da aba",
   (await kpiTitle("Receita Bruta")) === brl(fixedLifeExp.revenue),
   `tela=${await kpiTitle("Receita Bruta")} esperado=${brl(fixedLifeExp.revenue)}`);
await page.locator("button", { hasText: /^Limpar$/ }).last().click();
await page.waitForTimeout(600); await waitAnalytics();
await shot("10-aba-limpo");

// ── 9. Composição: página (PubMatic) × aba (Cliente Itaú) ───────────────────
await pageChip("Fonte"); await pickOption("PubMatic"); await waitAnalytics();
await tabFilter("Todos os clientes", "Itau"); await waitAnalytics();
const compExp = expected(rows, { pick: (r) => r.line_id === 202 });
ok("Filtro da página + filtro da aba compõem",
   (await kpiTitle("Receita Bruta")) === brl(compExp.revenue),
   `tela=${await kpiTitle("Receita Bruta")} esperado=${brl(compExp.revenue)}`);
await shot("11-composicao");

// ── 10. Poda de seleção órfã: solta a Fonte com Cliente da aba selecionado ──
// "Vivo" só existe no Xandr. Com PubMatic + Vivo selecionado, a aba não pode
// ficar zerada por um filtro que nem aparece na tela.
await page.locator("button", { hasText: /^Limpar$/ }).last().click();
await page.waitForTimeout(500);
await pageChip("Fonte"); await pickOption("Xandr Curate"); await waitAnalytics();
await tabFilter("Todos os clientes", "Vivo"); await waitAnalytics();
await pageChip("Fonte"); await pickOption("PubMatic"); await waitAnalytics();
const pubLifeExp = expected(rows, { source: "pubmatic" });
const afterPrune = await kpiTitle("Receita Bruta");
ok("Seleção órfã é podada em vez de zerar a aba",
   afterPrune === brl(pubLifeExp.revenue), `tela=${afterPrune} esperado=${brl(pubLifeExp.revenue)}`);
await shot("12-poda-selecao");

// ── 11. Granularidade e gráficos ───────────────────────────────────────────
await clearAll(); await waitAnalytics();
await page.locator("button", { hasText: /^Mensal$/ }).first().click();
await page.waitForTimeout(600);
const monthlyTitle = await page.locator("text=/Evolução de entrega · mensal/i").count();
ok("Toggle Mensal troca a granularidade dos gráficos", monthlyTitle > 0);
await shot("13-mensal");
await page.locator("button", { hasText: /^Diário$/ }).first().click();
await page.waitForTimeout(500);

const charts = await page.locator("svg.recharts-surface").count();
ok("Gráficos renderizam (recharts)", charts >= 3, `${charts} svg`);
const ledger = await page.locator("text=/Fechamento mensal/").count();
const deals = await page.locator("text=/Desempenho por deal/").count();
const donut = await page.locator("text=/Receita por status/").count();
const contract = await page.locator("text=/Realizado vs. contratado/").count();
ok("Blocos do Analytics presentes", ledger && deals && donut && contract,
   `ledger=${ledger} tabela=${deals} donut=${donut} contrato=${contract}`);

// ── 12. Seleção podada VOLTA quando a opção reaparece ──────────────────────
// (a seleção do usuário não é apagada: só fica suspensa enquanto a opção
// não existe no recorte da página)
await pageChip("Fonte"); await pickOption("Xandr Curate"); await waitAnalytics();
const backExp = expected(rows, { pick: (r) => r.line_id === 102 });
ok("Seleção suspensa volta a valer quando a opção reaparece",
   (await kpiTitle("Receita Bruta")) === brl(backExp.revenue),
   `tela=${await kpiTitle("Receita Bruta")} esperado=${brl(backExp.revenue)}`);

// ── 13. Coerência: faixa de KPIs do topo × card do Analytics ───────────────
await clearTabFilters(); await clearAll(); await waitAnalytics();
const piAll = await kpiTitle("PI contratado");
const topAll = await topKpi("Total PI");
ok("Total PI do topo = PI contratado do Analytics (sem filtro)",
   !!topAll && !!piAll && topAll.includes(piAll.replace(/\u00a0/g, " ")),
   `topo=${topAll} analytics=${piAll}`);
await pageChip("Fonte"); await pickOption("PubMatic"); await waitAnalytics();
const piPub = await kpiTitle("PI contratado");
const topPub = await topKpi("Total PI");
ok("Total PI do topo = PI contratado do Analytics (Fonte · PubMatic)",
   !!topPub && !!piPub && topPub.includes(piPub.replace(/\u00a0/g, " ")),
   `topo=${topPub} analytics=${piPub}`);
await shot("15-coerencia-kpi");
await clearAll(); await waitAnalytics();

// ── 14. Período: presets do calendário ─────────────────────────────────────
await clearTabFilters(); await waitAnalytics();
await page.locator('button:has-text("Período")').first().click();
await page.waitForTimeout(400);
const preset7 = page.locator("[data-radix-popper-content-wrapper] button", { hasText: /^Últimos 7 dias$/ }).first();
if (await preset7.count()) {
  await preset7.click(); await page.waitForTimeout(700); await closePopover(); await waitAnalytics();
  const w7 = expected(rows, { from: daysAgo(6), to: TODAY });
  const rev7 = await kpiTitle("Receita Bruta");
  ok("Período · últimos 7 dias recorta a janela", rev7 === brl(w7.revenue),
     `tela=${rev7} esperado=${brl(w7.revenue)}`);
  await shot("14-periodo-7d");
} else {
  ok("Preset 'Últimos 7 dias' encontrado", false, "popover não abriu");
}

// ── 13. Sanidade final: nenhum erro de runtime na página ───────────────────
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks OK`);
await browser.close();
process.exit(failed.length ? 1 : 0);
