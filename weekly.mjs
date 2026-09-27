import { spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const searches = JSON.parse(await readFile(new URL("./searches.json", import.meta.url), "utf8"));
const limit = Number(process.env.RADAR_SEARCH_LIMIT || searches.length);
const checkedAt = new Date().toISOString();
const checkedDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires",
  year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const coverage = [];
const verified = new Map();

for (const [index, search] of searches.slice(0, limit).entries()) {
  const output = `out/search-${index + 1}.json`;
  const run = spawnSync(process.execPath, ["collector.mjs"], {
    env: { ...process.env, RADAR_QUERY: search.query, RADAR_MARKET: search.market,
      RADAR_NICHE: search.niche, RADAR_PRODUCT_TYPE: search.productType, RADAR_OUTPUT: output },
    encoding: "utf8", timeout: 180000, maxBuffer: 1024 * 1024
  });
  let report;
  try { report = JSON.parse(await readFile(output, "utf8")); }
  catch { report = { status: "failed", error: run.error?.message || run.stderr?.slice(-300) || "sin resultado", scannedIds: 0, destinationIds: 0, reviewedSummaries: 0, qualifying: [] }; }
  coverage.push({ ...search, status: report.status, scannedIds: report.scannedIds,
    destinationIds: report.destinationIds, reviewedSummaries: report.reviewedSummaries,
    reviewedAdvertisers: report.reviewedAdvertisers, advertiserScans: report.advertiserScans,
    scope: report.scope, error: report.error });
  for (const offer of report.qualifying || []) {
    const key = [search.market, offer.pageId, offer.landingUrl].join("\u001f");
    const current = verified.get(key);
    const ids = new Set([...(current?.adIds || []), ...offer.adIds]);
    verified.set(key, { ...offer, market: search.market, niche: search.niche,
      productType: search.productType, search: search.query, adIds: [...ids], count: ids.size });
  }
  console.log(`${index + 1}/${Math.min(limit, searches.length)} ${search.market} ${search.niche} ${search.productType}: ${report.status}, ${report.scannedIds} IDs, ${(report.qualifying || []).length} ofertas`);
}

const offers = [...verified.values()].filter(o => o.count >= 21).sort((a, b) => b.count - a.count).slice(0, 20);
const completeSearches = coverage.filter(c => c.status === "completed_pilot").length;
const scannedSearches = coverage.filter(c => c.status === "completed_pilot" || c.status === "partial_pilot").length;
const report = { checkedAt, checkedDate, status: completeSearches === coverage.length ? "completed_bounded_scan" : "partial_bounded_scan",
  coverage, offers, count: offers.length, totalSearches: searches.length, executedSearches: coverage.length };
await mkdir("reports", { recursive: true });
await writeFile("reports/latest.json", JSON.stringify(report, null, 2) + "\n");
const lines = ["# Radar semanal de ebooks y apps", "", `Revisión: ${checkedDate} (Argentina). Estado: ${report.status}.`,
  `Ofertas verificadas: **${offers.length} de un máximo de 20**. Búsquedas revisadas: ${coverage.length}/${searches.length}.`,
  "", "El muestreo revisa el primer bloque de resultados, hasta tres resúmenes y tres bibliotecas de anunciantes por búsqueda. Un cero no prueba que no existan otras ofertas en Meta.",
  "Se cuentan IDs individuales activos del mismo anunciante y destino exacto: más de 20 para marcar actividad publicitaria sostenida. No implica ventas ni rentabilidad.",
  "Visitas a la página: no disponibles públicamente para esta URL; no se sustituyen por tráfico estimado del dominio. Se evalúan estructura, promesa, precio, CTA y pruebas visibles.", "", "## Ofertas", ""];
if (!offers.length) lines.push("Ninguna cumplió el umbral y la verificación de página en la cobertura revisada.", "");
for (const [index, o] of offers.entries()) {
  const library = new URL("https://www.facebook.com/ads/library/");
  library.search = new URLSearchParams({ active_status: "active", ad_type: "all", country: o.market, view_all_page_id: o.pageId }).toString();
  lines.push(`### ${index + 1}. ${o.advertiser} — ${o.market} · ${o.niche} · ${o.productType}`,
    `- **${o.count} IDs observados** con el mismo destino. Visitas de esta página: no verificables públicamente.`,
    `- Página: [${o.landing.headline || o.landingUrl}](${o.landingUrl}); precio visible: ${o.landing.price}; acción: ${o.landing.purchaseAction}.`,
    `- [Anunciante en Meta](${library}) · [Anuncio de muestra](https://www.facebook.com/ads/library/?id=${o.adIds[0]})`, "");
}
lines.push("## Cobertura", "", "| Mercado | Nicho | Formato | Búsqueda | IDs vistos | Destinos | Estado |", "|---|---|---|---|---:|---:|---|");
for (const c of coverage) lines.push(`| ${c.market} | ${c.niche} | ${c.productType} | ${c.query} | ${c.scannedIds || 0} | ${c.destinationIds || 0} | ${c.status} |`);
lines.push("", "Bibliotecas revisadas por búsqueda:", "");
for (const c of coverage) for (const a of c.advertiserScans || []) lines.push(`- ${c.market} · ${c.query}: [anunciante ${a.pageId}](${a.library}) — ${a.error ? "error parcial" : a.reachedBottom ? "recorrido completo" : "recorrido parcial"}.`);
lines.push("", "Los resultados están fechados; este informe semanal no actualiza automáticamente el Site privado.", "");
await writeFile("reports/latest.md", lines.join("\n"));
console.log(JSON.stringify({ status: report.status, count: report.count, completeSearches, executedSearches: coverage.length }));
if (scannedSearches === 0) process.exitCode = 2;
