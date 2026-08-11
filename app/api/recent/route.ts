import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { nonInventoryFromRow, productFromRow } from "@/lib/pricing";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const rows = await getD1().prepare(`SELECT * FROM (
      SELECT 'inventory' AS source,id,name,code,purchase_price_usd_cents,weight_milli_lb,
        quantity_available,minimum_stock,minimum_stock_enabled,restock_purchased_at,zero_stock_since,
        version,created_at,updated_at
      FROM products
      UNION ALL
      SELECT 'no_inventory' AS source,id,name,code,purchase_price_usd_cents,weight_milli_lb,
        NULL AS quantity_available,NULL AS minimum_stock,NULL AS minimum_stock_enabled,
        NULL AS restock_purchased_at,NULL AS zero_stock_since,version,created_at,updated_at
      FROM non_inventory_quotes
    ) ORDER BY updated_at DESC,id DESC LIMIT ?`).bind(limit).all<Record<string, unknown> & { source: string }>();
    return Response.json({
      items: rows.results.map((row) => row.source === "inventory"
        ? { source: "inventory", item: productFromRow(row) }
        : { source: "no_inventory", item: nonInventoryFromRow(row) }),
    });
  } catch (error) { return errorResponse(error); }
}
