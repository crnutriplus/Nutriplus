import { errorResponse } from "@/lib/api-helpers";
import { presentationSignature } from "@/lib/inventory-intake";
import { validateBarcode } from "@/lib/barcodes";
import { normalizeName } from "@/lib/pricing";

type Candidate = {
  code: string;
  type: string;
  source: string;
  sourceUrl: string;
  title: string;
  presentation: string;
  confidence: number;
  differences: string[];
};

function safeProductUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || /^\d+(?:\.\d+){3}$/.test(host) || host === "[::1]") return null;
    return url;
  } catch { return null; }
}

function tokens(value: string) {
  return new Set(normalizeName(value).split(/[^a-z0-9]+/).filter((word) => word.length > 1));
}

function score(description: string, title: string, expectedPresentation: string, foundPresentation: string) {
  const left = tokens(description);
  const right = tokens(title);
  const shared = [...left].filter((word) => right.has(word)).length;
  const nameScore = left.size && right.size ? shared / Math.max(left.size, right.size) : 0;
  const expected = presentationSignature(description, expectedPresentation);
  const found = presentationSignature(title, foundPresentation);
  const differences: string[] = [];
  if (expected && found && expected !== found) differences.push(`La presentación encontrada (${foundPresentation || found}) no coincide con la esperada (${expectedPresentation || expected}).`);
  if (nameScore < 0.35) differences.push("El nombre encontrado tiene poca similitud con el producto de la factura.");
  const confidence = Math.round(Math.max(0, Math.min(100, nameScore * 75 + (expected && found && expected === found ? 25 : expected || found ? 5 : 15) - differences.length * 25)));
  return { confidence, differences };
}

function walkJson(value: unknown, results: Array<{ code: string; title: string; presentation: string }>, inheritedTitle = "") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach((item) => walkJson(item, results, inheritedTitle));
  const object = value as Record<string, unknown>;
  const title = String(object.name || object.headline || inheritedTitle || "");
  const presentation = String(object.size || object.weight || object.description || "");
  ["gtin", "gtin8", "gtin12", "gtin13", "gtin14", "upc", "ean", "barcode"].forEach((key) => {
    const raw = object[key];
    if (typeof raw === "string" || typeof raw === "number") results.push({ code: String(raw), title, presentation });
  });
  Object.values(object).forEach((child) => { if (child && typeof child === "object") walkJson(child, results, title); });
}

async function fromProductPage(url: URL, description: string, presentation: string) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "NutriPlusInventory/2.0 (+private inventory verification)" },
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error(`La página respondió ${response.status}.`);
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html") && !type.includes("application/xhtml")) throw new Error("La página no devolvió información de producto legible.");
  const html = (await response.text()).slice(0, 2_000_000);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Producto de la página";
  const found: Array<{ code: string; title: string; presentation: string }> = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walkJson(JSON.parse(match[1]), found, title); } catch { /* Un bloque JSON-LD inválido no invalida los demás. */ }
  }
  for (const match of html.matchAll(/<(?:meta|span)[^>]+itemprop=["'](?:gtin|gtin8|gtin12|gtin13|gtin14|sku|productID)["'][^>]+(?:content=["']([^"']+)["']|>([^<]+))/gi)) {
    found.push({ code: match[1] || match[2] || "", title, presentation: "" });
  }
  return found.map((item) => {
    const validated = validateBarcode(item.code);
    if (!validated.valid || !validated.normalized) return null;
    const evaluated = score(description, item.title || title, presentation, item.presentation);
    return { code: validated.normalized, type: validated.type || "", source: url.hostname, sourceUrl: url.toString(), title: item.title || title, presentation: item.presentation, ...evaluated } satisfies Candidate;
  }).filter((item): item is Candidate => item !== null);
}

async function fromOpenFacts(base: string, description: string, presentation: string) {
  const url = new URL("/cgi/search.pl", base);
  url.searchParams.set("search_terms", description.slice(0, 180));
  url.searchParams.set("search_simple", "1");
  url.searchParams.set("action", "process");
  url.searchParams.set("json", "1");
  url.searchParams.set("page_size", "8");
  url.searchParams.set("fields", "code,product_name,brands,quantity");
  const response = await fetch(url, { signal: AbortSignal.timeout(9000), headers: { "User-Agent": "NutriPlusInventory/2.0" } });
  if (!response.ok) return [];
  const body = await response.json() as { products?: Array<Record<string, unknown>> };
  return (body.products || []).map((product) => {
    const validated = validateBarcode(product.code);
    if (!validated.valid || !validated.normalized) return null;
    const title = [product.brands, product.product_name].filter(Boolean).map(String).join(" ");
    const foundPresentation = String(product.quantity || "");
    const evaluated = score(description, title, presentation, foundPresentation);
    return { code: validated.normalized, type: validated.type || "", source: new URL(base).hostname, sourceUrl: url.toString(), title, presentation: foundPresentation, ...evaluated } satisfies Candidate;
  }).filter((item): item is Candidate => item !== null);
}

async function fromUpcItemDb(description: string, presentation: string) {
  const url = new URL("https://api.upcitemdb.com/prod/trial/search");
  url.searchParams.set("s", description.slice(0, 180));
  url.searchParams.set("type", "product");
  const response = await fetch(url, { signal: AbortSignal.timeout(9000), headers: { "User-Agent": "NutriPlusInventory/2.0" } });
  if (!response.ok) return [];
  const body = await response.json() as { items?: Array<Record<string, unknown>> };
  return (body.items || []).slice(0, 8).map((item) => {
    const validated = validateBarcode(item.upc || item.ean);
    if (!validated.valid || !validated.normalized) return null;
    const title = [item.brand, item.title].filter(Boolean).map(String).join(" ");
    const foundPresentation = String(item.size || item.description || "");
    const evaluated = score(description, title, presentation, foundPresentation);
    return { code: validated.normalized, type: validated.type || "", source: "UPCitemdb", sourceUrl: url.toString(), title, presentation: foundPresentation, ...evaluated } satisfies Candidate;
  }).filter((item): item is Candidate => item !== null);
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const description = typeof payload.description === "string" ? payload.description.trim().slice(0, 500) : "";
    const presentation = typeof payload.presentation === "string" ? payload.presentation.trim().slice(0, 200) : "";
    const provider = typeof payload.provider === "string" ? payload.provider : "other";
    const secondaryId = typeof payload.secondaryId === "string" ? payload.secondaryId.trim() : "";
    let productUrl = safeProductUrl(payload.productUrl);
    if (!productUrl && provider === "amazon" && /^B[0-9A-Z]{9}$/i.test(secondaryId)) productUrl = new URL(`https://www.amazon.com/dp/${secondaryId.toUpperCase()}`);
    if (!description) return Response.json({ error: "Ingresá el nombre y la presentación exacta del producto." }, { status: 400 });

    const results: Candidate[] = [];
    const failures: string[] = [];
    if (productUrl) {
      try { results.push(...await fromProductPage(productUrl, description, presentation)); }
      catch (error) { failures.push(error instanceof Error ? `No se pudo consultar la página exacta: ${error.message}` : "No se pudo consultar la página exacta."); }
    }
    const searches = await Promise.allSettled([
      fromOpenFacts("https://world.openfoodfacts.org", description, presentation),
      fromOpenFacts("https://world.openbeautyfacts.org", description, presentation),
      fromUpcItemDb(description, presentation),
    ]);
    searches.forEach((result) => { if (result.status === "fulfilled") results.push(...result.value); });
    const unique = new Map<string, Candidate>();
    results.forEach((candidate) => {
      const previous = unique.get(candidate.code);
      if (!previous || candidate.confidence > previous.confidence) unique.set(candidate.code, candidate);
    });
    const candidates = [...unique.values()].sort((left, right) => right.confidence - left.confidence).slice(0, 12);
    return Response.json({
      candidates,
      failures,
      message: candidates.length ? "Revisá la presentación y confirmá el código antes de usarlo." : "No fue posible confirmar el código de barras de este producto. Selecciona una opción para continuar.",
    });
  } catch (error) { return errorResponse(error); }
}
