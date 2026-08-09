import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { nonInventoryFromRow, productFromRow } from "@/lib/pricing";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const rows = await getD1().prepare(`SELECT source,source_id,sort_date FROM (
      SELECT 'inventory' AS source,id AS source_id,updated_at AS sort_date FROM products
      UNION ALL
      SELECT 'no_inventory' AS source,id AS source_id,updated_at AS sort_date FROM non_inventory_quotes
    ) ORDER BY sort_date DESC,source_id DESC LIMIT ?`).bind(limit).all<{ source: string; source_id: number }>();
    const inventoryIds = rows.results.filter((row) => row.source === "inventory").map((row) => Number(row.source_id));
    const quoteIds = rows.results.filter((row) => row.source === "no_inventory").map((row) => Number(row.source_id));
    const inventory = inventoryIds.length
      ? await getD1().prepare(`SELECT * FROM products WHERE id IN (${inventoryIds.map(() => "?").join(",")})`).bind(...inventoryIds).all()
      : { results: [] as Record<string, unknown>[] };
    const quotes = quoteIds.length
      ? await getD1().prepare(`SELECT * FROM non_inventory_quotes WHERE id IN (${quoteIds.map(() => "?").join(",")})`).bind(...quoteIds).all()
      : { results: [] as Record<string, unknown>[] };
    const productMap = new Map(inventory.results.map((row) => [Number(row.id), productFromRow(row)]));
    const quoteMap = new Map(quotes.results.map((row) => [Number(row.id), nonInventoryFromRow(row)]));
    return Response.json({ items: rows.results.flatMap((row) => {
      if (row.source === "inventory") {
        const product = productMap.get(Number(row.source_id));
        return product ? [{ source: "inventory", item: product }] : [];
      }
      const quote = quoteMap.get(Number(row.source_id));
      return quote ? [{ source: "no_inventory", item: quote }] : [];
    }) });
  } catch (error) { return errorResponse(error); }
}
