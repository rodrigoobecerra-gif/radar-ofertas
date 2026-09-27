import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const QUERY = process.env.RADAR_QUERY || "ebook emagrecimento";
const MARKET = process.env.RADAR_MARKET || "BR";
const NICHE = process.env.RADAR_NICHE || "salud";
const PRODUCT_TYPE = process.env.RADAR_PRODUCT_TYPE || "ebook";
const OUTPUT = process.env.RADAR_OUTPUT || "out/pilot.json";

function libraryUrl() {
  const url = new URL("https://www.facebook.com/ads/library/");
  url.search = new URLSearchParams({ active_status: "active", ad_type: "all", country: MARKET, q: QUERY }).toString();
  return url.toString();
}

function extractVisibleAds(dialog, config) {
  const ids = [...dialog.querySelectorAll("span,div")].filter(element => {
    const value = element.textContent?.trim() || "";
    return /^(?:Identificador de la biblioteca|Library ID|ID da Biblioteca):\s*\d+$/i.test(value) &&
      ![...element.children].some(child => /^(?:Identificador de la biblioteca|Library ID|ID da Biblioteca):\s*\d+$/i.test(child.textContent?.trim() || ""));
  });
  return ids.map(element => {
    const adId = element.textContent.match(/\d+/)?.[0];
    let card = element;
    let profile;
    while (card !== dialog && card.parentElement) {
      card = card.parentElement;
      profile = [...card.querySelectorAll("a[href]")].find(a => /^https?:\/\/(?:www\.)?facebook\.com\/\d+\/?(?:\?.*)?$/.test(a.href));
      if (profile) break;
    }
    if (!adId || !profile || (card.innerText.match(/Identificador de la biblioteca|Library ID|ID da Biblioteca/gi) || []).length !== 1) return null;
    if (!/\b(?:Activo|Active|Ativo)\b/i.test(card.innerText)) return null;
    const wrapper = [...card.querySelectorAll("a[href]")].find(a => {
      try { const u = new URL(a.href); return u.hostname === "l.facebook.com" && u.pathname === "/l.php"; } catch { return false; }
    });
    const landingUrl = wrapper && new URL(wrapper.href).searchParams.get("u");
    let landing;
    try { landing = new URL(landingUrl); } catch { return null; }
    if (landing.protocol !== "https:" || landing.username || landing.password || !landing.hostname.includes(".")) return null;
    const pageId = new URL(profile.href).pathname.match(/^\/(\d+)\/?$/)?.[1];
    if (!pageId) return null;
    landing.hash = "";
    return {
      adId, pageId, advertiser: profile.innerText.trim().slice(0, 160), market: config.market, niche: config.niche,
      adUrl: `https://www.facebook.com/ads/library/?id=${adId}`,
      landingUrl: landing.toString(), active: true, observedAt: new Date().toISOString()
    };
  }).filter(Boolean);
}

function groupExactDestinations(ads) {
  const groups = new Map();
  for (const ad of ads) {
    const key = [ad.market, ad.niche, ad.pageId, ad.landingUrl].join("\u001f");
    const g = groups.get(key) || { advertiser: ad.advertiser, pageId: ad.pageId, landingUrl: ad.landingUrl, adIds: [] };
    g.adIds.push(ad.adId);
    groups.set(key, g);
  }
  return [...groups.values()].map(g => ({ ...g, count: g.adIds.length }))
    .sort((a, b) => b.count - a.count);
}

async function checkSalesPage(browser, group) {
  const page = await browser.newPage({ locale: MARKET === "BR" ? "pt-BR" : "es-AR" });
  try {
    const response = await page.goto(group.landingUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    if (!response?.ok()) return { status: "inaccessible", httpStatus: response?.status() ?? null };
    const detail = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const actions = [...document.querySelectorAll("a,button")].map(e => e.innerText.trim()).filter(Boolean);
      return { headline: document.querySelector("h1")?.innerText.trim().slice(0, 220) || "",
        price: text.match(/(?:R\$|ARS\s*|US\$|\$)\s*[\d.,]+/i)?.[0] || "",
        purchaseAction: actions.find(a => /\b(?:comprar?|adquirir|assinar|inscrev(?:er|a)|garantir|finalizar pedido|ir para (?:o )?checkout)\b/i.test(a)) || "",
        productType: /\b(?:ebook|e-book|livro digital|libro digital|recetario digital)\b/i.test(text) ? "ebook" :
          /\b(?:app|aplicativo|aplicación|software|plataforma digital)\b/i.test(text) ? "app" : "unknown" };
    });
    return { status: detail.headline && detail.price && detail.purchaseAction && detail.productType === PRODUCT_TYPE ? "sales_page" : "unverified",
      finalUrl: page.url(), ...detail };
  } catch (error) { return { status: "inaccessible", error: String(error).slice(0, 240) }; }
  finally { await page.close(); }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const observations = new Map();
  const report = { observedAt: new Date().toISOString(), market: MARKET, niche: NICHE, query: QUERY,
    productType: PRODUCT_TYPE, searchUrl: libraryUrl(), status: "incomplete", scannedIds: 0, destinationIds: 0,
    reachedBottom: false, reviewedSummaries: 0, scope: "primer bloque visible y hasta tres resúmenes", groups: [], qualifying: [], error: null };
  try {
    const page = await browser.newPage({ locale: "es-ES", viewport: { width: 1365, height: 900 } });
    await page.goto(report.searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.getByText(/Identificador de la biblioteca|Library ID|ID da Biblioteca/i).first().waitFor({ timeout: 30000 });
    const seenIds = new Set();
    const visible = await page.locator("body").evaluate(extractVisibleAds, { market: MARKET, niche: NICHE });
    for (const ad of visible) observations.set(`${ad.pageId}:${ad.adId}`, ad);
    for (const id of await page.evaluate(() => [...document.querySelectorAll("span")]
      .map(e => e.textContent?.trim().match(/^(?:Identificador de la biblioteca|Library ID|ID da Biblioteca):\s*(\d+)$/i)?.[1]).filter(Boolean))) seenIds.add(id);
    const summaries = page.getByRole("button", { name: /Ver detalles del resumen|See summary details|Ver detalhes do resumo/i });
    const candidates = [];
    for (let i = 0; i < Math.min(await summaries.count(), 20); i++) {
      const count = await summaries.nth(i).evaluate(button => {
        let card = button; for (let j = 0; j < 3; j++) card = card.parentElement;
        return Number(card.innerText.match(/(\d+) (?:anuncios|ads|anúncios) (?:usan|use|usam)/i)?.[1] || 0);
      });
      candidates.push({ index: i, claimedCount: count });
    }
    candidates.sort((a, b) => b.claimedCount - a.claimedCount);
    report.reachedBottom = true;
    for (const candidate of candidates.slice(0, 3)) {
      await summaries.nth(candidate.index).click();
      const dialog = page.locator('[role="dialog"]').filter({ hasText: /Datos resumidos|Summary data|Dados resumidos/i }).last();
      await dialog.getByText(/Identificador de la biblioteca|Library ID|ID da Biblioteca/i).first().waitFor({ timeout: 30000 });
      let unchanged = 0, reachedBottom = false;
      for (let i = 0; i < 45; i++) {
        const batch = await dialog.evaluate(extractVisibleAds, { market: MARKET, niche: NICHE });
        const ids = await dialog.evaluate(element => [...element.querySelectorAll("span")]
          .map(e => e.textContent?.trim().match(/^(?:Identificador de la biblioteca|Library ID|ID da Biblioteca):\s*(\d+)$/i)?.[1])
          .filter(Boolean));
        for (const id of ids) seenIds.add(id);
        const previous = observations.size;
        for (const ad of batch) observations.set(`${ad.pageId}:${ad.adId}`, ad);
        const movement = await dialog.evaluate(element => {
          const scroll = [...element.querySelectorAll("*")].find(e => e.scrollHeight > e.clientHeight + 100 && getComputedStyle(e).overflowY === "auto");
          if (!scroll) return null;
          const before = scroll.scrollTop;
          scroll.scrollTop = Math.min(scroll.scrollHeight, before + Math.max(450, scroll.clientHeight * 0.85));
          return { bottom: scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 5 };
        });
        if (!movement) break;
        if (movement.bottom && observations.size === previous) unchanged++;
        else unchanged = 0;
        if (unchanged >= 2) { reachedBottom = true; break; }
        await page.waitForTimeout(400);
      }
      report.reviewedSummaries++;
      report.reachedBottom &&= reachedBottom;
      await dialog.getByRole("button", { name: /Cerrar|Close|Fechar/i }).last().click();
    }
    const ads = [...observations.values()];
    report.scannedIds = seenIds.size;
    report.destinationIds = ads.length;
    report.groups = groupExactDestinations(ads);
    for (const group of report.groups.filter(g => g.count >= 31).slice(0, 4)) {
      const landing = await checkSalesPage(browser, group);
      if (landing.status === "sales_page") report.qualifying.push({ ...group, landing });
      else group.rejection = landing;
    }
    report.status = report.reachedBottom ? "completed_pilot" : "partial_pilot";
  } catch (error) { report.error = String(error).slice(0, 500); }
  finally {
    await browser.close();
    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, scannedIds: report.scannedIds, destinationIds: report.destinationIds, reachedBottom: report.reachedBottom,
      groups: report.groups.map(({ pageId, landingUrl, count, rejection }) => ({ pageId, landingUrl, count, rejection })),
      qualifying: report.qualifying.length, error: report.error }, null, 2));
  }
  if (report.error) process.exitCode = 1;
}

main();
