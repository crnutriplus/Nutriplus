import { ensureDatabase, getD1 } from "@/db";
import { errorResponse, parseProductInput } from "@/lib/api-helpers";
import { normalizeName, productFromRow, searchTokens } from "@/lib/pricing";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const code = url.searchParams.get("code")?.trim();
    const query = url.searchParams.get("q")?.trim() ?? "";
    const lowStock = url.searchParams.get("lowStock") === "1";
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit")) || 1000));
    if (code) {
      const row = await getD1().prepare("SELECT * FROM products WHERE code=? LIMIT 1").bind(code).first();
      return Response.json({ product: row ? productFromRow(row) : null });
    }
    if (lowStock) {
      const result = await getD1().prepare("SELECT * FROM products WHERE minimum_stock_enabled=1 AND quantity_available<=minimum_stock ORDER BY quantity_available ASC,name COLLATE NOCASE LIMIT ?").bind(limit).all();
      return Response.json({ products: result.results.map(productFromRow) });
    }
    const normalized = normalizeName(query);
    const tokens = searchTokens(query);
    const nameClause = tokens.length ? `(${tokens.map(() => "normalized_name LIKE ?").join(" AND ")}) OR ` : "";
    const result = normalized
      ? await getD1().prepare(`SELECT * FROM products
          WHERE ${nameClause}code LIKE ?
          ORDER BY CASE
            WHEN normalized_name = ? THEN 0
            WHEN normalized_name LIKE ? THEN 1
            ELSE 2
          END, name COLLATE NOCASE
          LIMIT ?`)
        .bind(...tokens.map((token) => `%${token}%`), `%${query}%`, normalized, `${normalized}%`, limit)
        .all()
      : await getD1().prepare("SELECT * FROM products ORDER BY updated_at DESC, name COLLATE NOCASE LIMIT ?").bind(limit).all();
    return Response.json({ products: result.results.map(productFromRow) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const product = parseProductInput((await request.json()) as Record<string, unknown>, { allowPending: true });
    await ensureDatabase();
    const row = await getD1().prepare("INSERT INTO products (name,normalized_name,code,purchase_price_usd_cents,weight_milli_lb,quantity_available,minimum_stock,minimum_stock_enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING *").bind(product.name, product.normalizedName, product.code, product.purchasePriceUsdCents, product.weightMilliLb, product.quantityAvailable, product.minimumStock, product.minimumStockEnabled ? 1 : 0).first();
    if (!row) throw new Error("No se pudo guardar el producto.");
    return Response.json({ product: productFromRow(row) }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
