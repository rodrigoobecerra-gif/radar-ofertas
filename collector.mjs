import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const QUERY = process.env.RADAR_QUERY || "inlead.digital";
const MARKET = process.env.RADAR_MARKET || "BR";
const NICHE = process.env.RADAR_NICHE || "unknown";
const PRODUCT_TYPE = process.env.RADAR_PRODUCT_TYPE || "any";
const OUTPUT = process.env.RADAR_OUTPUT || "out/pilot.json";

function libraryUrl() {
  const url = new URL("https://www.facebook.com/ads/library/");
  url.search = new URLSearchParams({ active_status: "active", ad_type: "all", country: MARKET, q: QUERY }).toString();
  return url.toString();
}

function advertiserLibraryUrl(pageId) {
  const url = new URL("https://www.facebook.com/ads/library/");
  url.search = new URLSearchParams({ active_status: "active", ad_type: "all", country: MARKET, media_type: "all", search_type: "page", view_all_page_id: pageId }).toString();
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

function nicheFromPage(text) {
  const signals = {
    salud: /\b(?:emagrec\w*|adelgaz\w*|pilates|trein\w*|entren\w*|recet\w*|receit\w*|menopaus\w*|saúde|salud|dieta|nutri\w*|aliment\w*|dormir|sono|yoga)\b/gi,
    dinero: /\b(?:renda|ingresos?|dinheiro|dinero|finan\w*|deudas?|dívidas?|invest\w*|empreend\w*|emprend\w*|negocio|negócio|ahorro|economiz\w*)\b/gi,
    amor: /\b(?:pareja|casal|relaciona\w*|reconquist\w*|namorad\w*|ruptura|término|termino|apego|amor|separación|separação)\b/gi,
    hogar: /\b(?:hogar|casa|lar|limpieza|limpeza|organiza\w*|rotina|rutina|tareas|tarefas|família|familia)\b/gi,
    educacion: /\b(?:aprender|aprendiz\w*|estudi\w*|idioma|inglês|ingles|escola|escuela|alumno|estudante)\b/gi,
    belleza: /\b(?:belleza|beleza|piel|pele|maquill\w*|maquiag\w*|cosmétic\w*|cabelo|cabello)\b/gi,
    mascotas: /\b(?:mascota|perro|cachorro|gato|pet|adiestra\w*|adestra\w*|veterin\w*)\b/gi
  };
  const scores = Object.entries(signals).map(([niche, pattern]) => [niche, [...text.matchAll(pattern)].length]);
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] >= 2 && scores[0][1] > scores[1][1] ? scores[0][0] : "otros";
}

async function checkSalesPage(browser, group) {
  const page = await browser.newPage({ locale: MARKET === "BR" ? "pt-BR" : "es-AR" });
  try {
    const response = await page.goto(group.landingUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    if (!response?.ok()) return { status: "inaccessible", httpStatus: response?.status() ?? null };
    const detail = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const actions = [...document.querySelectorAll("a,button")].map(e => ({ text: e.innerText.trim(), href: e instanceof HTMLAnchorElement ? e.href : "" })).filter(e => e.text);
      const purchase = actions.find(a => /\b(?:comprar?|adquirir|assinar|inscrev(?:er|a)|garantir|finalizar pedido|ir para (?:o )?checkout)\b/i.test(a.text));
      return { headline: document.querySelector("h1")?.innerText.trim().slice(0, 220) || "",
        nicheText: [document.title, document.querySelector("h1")?.innerText || "", text.slice(0, 8000)].join(" "),
        price: text.match(/(?:R\$|ARS\s*|US\$|\$)\s*[\d.,]+/i)?.[0] || "",
        purchaseAction: purchase?.text.slice(0, 120) || "",
        checkoutUrl: purchase?.href.startsWith("https://") ? purchase.href : "",
        productType: /\b(?:ebook|e-book|livro digital|libro digital|recetario digital|biblioteca digital|pdf|tomos?|manual(?:es)?|guías?|guias?)\b/i.test(text) ? "ebook" :
          /\b(?:app|aplicativo|aplicación|software|plataforma digital)\b/i.test(text) ? "app" :
          /\b(?:plantilla|template|planificador|planner|planificateur|guía digital|guia digital)\b/i.test(text) ? "plantilla" : "unknown" };
    });
    const positivePrice = /[1-9]/.test(detail.price.replace(/^(?:R\$|ARS\s*|US\$|\$)\s*/i, ""));
    const niche = nicheFromPage(detail.nicheText);
    const { nicheText, ...publicDetail } = detail;
    return { status: detail.headline && positivePrice && detail.purchaseAction &&
      (PRODUCT_TYPE === "any" ? detail.productType !== "unknown" : detail.productType === PRODUCT_TYPE) ? "sales_page" : "unverified",
      finalUrl: page.url(), niche, ...publicDetail };
  } catch (error) { return { status: "inaccessible", error: String(error).slice(0, 240) }; }
  finally { await page.close(); }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const observations = new Map();
  const advertiserObservations = new Map();
  const report = { observedAt: new Date().toISOString(), market: MARKET, niche: NICHE, query: QUERY,
    productType: PRODUCT_TYPE, searchUrl: libraryUrl(), status: "incomplete", scannedIds: 0, destinationIds: 0,
    reachedBottom: false, reviewedSummaries: 0, reviewedAdvertisers: 0, searchDestinationIds: 0,
    advertiserScans: [], scope: "primer bloque visible, hasta tres resúmenes y tres bibliotecas de anunciantes", groups: [], qualifying: [], candidates: [], error: null };
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
    const pageCounts = new Map();
    for (const ad of observations.values()) pageCounts.set(ad.pageId, (pageCounts.get(ad.pageId) || 0) + 1);
    const candidatePages = [...pageCounts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([pageId]) => pageId);
    report.reachedBottom &&= candidatePages.length > 0;
    for (const pageId of candidatePages) {
      const library = advertiserLibraryUrl(pageId);
      let reachedBottom = false, error = null, unchanged = 0;
      try {
        await page.goto(library, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.getByText(/Identificador de la biblioteca|Library ID|ID da Biblioteca/i).first().waitFor({ timeout: 12000 });
        for (let i = 0; i < 45; i++) {
          const batch = await page.locator("body").evaluate(extractVisibleAds, { market: MARKET, niche: NICHE });
          const ids = await page.evaluate(() => [...document.querySelectorAll("span")]
            .map(e => e.textContent?.trim().match(/^(?:Identificador de la biblioteca|Library ID|ID da Biblioteca):\s*(\d+)$/i)?.[1]).filter(Boolean));
          for (const id of ids) seenIds.add(id);
          const previous = observations.size;
          for (const ad of batch) if (ad.pageId === pageId) {
            observations.set(`${ad.pageId}:${ad.adId}`, ad);
            advertiserObservations.set(`${ad.pageId}:${ad.adId}`, ad);
          }
          const movement = await page.evaluate(() => {
            const before = window.scrollY;
            window.scrollBy(0, Math.max(600, window.innerHeight * 0.85));
            return { bottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 5,
              moved: window.scrollY > before };
          });
          if (movement.bottom && observations.size === previous) unchanged++;
          else unchanged = 0;
          if (unchanged >= 2) { reachedBottom = true; break; }
          if (!movement.moved && !movement.bottom) break;
          await page.waitForTimeout(400);
        }
      } catch (cause) {
        const diagnostic = await page.evaluate(() => document.body?.innerText.slice(-1300) || "").catch(() => "");
        error = `${String(cause).slice(0, 130)}; url=${page.url()}; page-tail=${diagnostic.replace(/\s+/g, " ")}`.slice(0, 1700);
      }
      report.reviewedAdvertisers++;
      report.advertiserScans.push({ pageId, library, reachedBottom, error });
      report.reachedBottom &&= reachedBottom && !error;
    }
    // Search and creative-summary ads only nominate an advertiser. The actual
    // offer threshold is counted from IDs observed inside its own library.
    report.searchDestinationIds = observations.size;
    const ads = [...advertiserObservations.values()];
    report.scannedIds = seenIds.size;
    report.destinationIds = ads.length;
    report.groups = groupExactDestinations(ads);
    for (const group of report.groups.filter(g => g.count >= 21).slice(0, 4)) {
      const landing = await checkSalesPage(browser, group);
      if (landing.status === "sales_page") report.qualifying.push({ ...group, niche: landing.niche, landing });
      else group.rejection = landing;
    }
    // Candidate evidence remains separate: search-result IDs do not satisfy
    // the advertiser-library threshold, even when the sales page opens.
    const searchGroups = groupExactDestinations([...observations.values()]);
    for (const group of searchGroups.filter(g => g.count >= 2).slice(0, 3)) {
      const landing = await checkSalesPage(browser, group);
      if (landing.status === "sales_page" && !report.qualifying.some(o => o.pageId === group.pageId && o.landingUrl === group.landingUrl))
        report.candidates.push({ ...group, market: MARKET, niche: landing.niche, productType: landing.productType,
          status: "pending_advertiser_library", evidenceSource: "search_results", landing });
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
