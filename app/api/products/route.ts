import { ensureDatabase, getD1 } from "@/db";
import { errorResponse, parseProductInput } from "@/lib/api-helpers";
import { runIdempotentMutation } from "@/lib/mutations";
import { normalizeName, productFromRow, searchTokens } from "@/lib/pricing";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const code = url.searchParams.get("code")?.trim();
    const query = url.searchParams.get("q")?.trim() ?? "";
    const lowStock = url.searchParams.get("lowStock") === "1";
    const recent = url.searchParams.get("recent") === "1";
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit")) || 1000));
    if (code) {
      const normalizedCode = code.toLowerCase().replace(/\s+/g, "");
      const row = await getD1().prepare("SELECT * FROM products WHERE lower(replace(code,' ',''))=? LIMIT 1").bind(normalizedCode).first();
      return Response.json({ product: row ? productFromRow(row) : null });
    }
    if (lowStock) {
      const result = await getD1().prepare(`SELECT * FROM products
        WHERE (minimum_stock_enabled=1 AND quantity_available<=minimum_stock) OR zero_stock_since IS NOT NULL
        ORDER BY CASE WHEN restock_purchased_at IS NULL THEN 0 ELSE 1 END,
          CASE WHEN quantity_available=0 THEN 0 ELSE 1 END,quantity_available ASC,name COLLATE NOCASE LIMIT ?`)
        .bind(limit).all();
      return Response.json({ products: result.results.map(productFromRow) });
    }
    if (recent) {
      const result = await getD1().prepare("SELECT * FROM products ORDER BY updated_at DESC,id DESC LIMIT ?").bind(limit).all();
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
    const payload = (await request.json()) as Record<string, unknown>;
    const product = parseProductInput(payload, { allowPending: true });
    const brand = typeof payload.brand === "string" ? payload.brand.trim().slice(0, 200) || null : null;
    const presentation = typeof payload.presentation === "string" ? payload.presentation.trim().slice(0, 250) || null : null;
    await ensureDatabase();
    const db = getD1();
    const result = await runIdempotentMutation(db, request, payload, async () => {
      const row = await db.prepare(`INSERT OR IGNORE INTO products (
        name,normalized_name,code,brand,presentation,purchase_price_usd_cents,weight_milli_lb,quantity_available,
        minimum_stock,minimum_stock_enabled,zero_stock_since,version,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,CASE WHEN ?=0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,1,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING *`)
        .bind(product.name, product.normalizedName, product.code, brand, presentation, product.purchasePriceUsdCents, product.weightMilliLb,
          product.quantityAvailable, product.minimumStock, product.minimumStockEnabled ? 1 : 0, product.quantityAvailable).first();
      if (!row) {
        const existing = await db.prepare(`SELECT * FROM products
          WHERE normalized_name=? OR (? IS NOT NULL AND lower(replace(code,' ',''))=lower(replace(?,' ','')))
          ORDER BY CASE WHEN normalized_name=? THEN 0 ELSE 1 END LIMIT 1`)
          .bind(product.normalizedName, product.code, product.code, product.normalizedName).first();
        if (existing) return { body: { product: productFromRow(existing), deduplicated: true } };
        throw new Error("No se pudo guardar el producto.");
      }
      return { body: { product: productFromRow(row) }, status: 201 };
    });
    return Response.json(result.body, { status: result.status ?? 200 });
  } catch (error) { return errorResponse(error); }
}
