import { ensureDatabase, getD1 } from "@/db";
import { errorResponse, parseProductInput } from "@/lib/api-helpers";
import { normalizeName, productFromRow, searchTokens } from "@/lib/pricing";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const code = url.searchParams.get("code")?.trim();
    const query = url.searchParams.get("q")?.trim() ?? "";
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 1000));
    if (code) {
      const row = await getD1().prepare("SELECT * FROM products WHERE code=? LIMIT 1").bind(code).first();
      return Response.json({ product: row ? productFromRow(row) : null });
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
    const row = await getD1().prepare("INSERT INTO products (name,normalized_name,code,purchase_price_usd_cents,weight_milli_lb) VALUES (?,?,?,?,?) RETURNING *").bind(product.name, product.normalizedName, product.code, product.purchasePriceUsdCents, product.weightMilliLb).first();
    if (!row) throw new Error("No se pudo guardar el producto.");
    return Response.json({ product: productFromRow(row) }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
