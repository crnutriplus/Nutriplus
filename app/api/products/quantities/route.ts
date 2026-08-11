import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { runIdempotentMutation } from "@/lib/mutations";
import { productFromRow } from "@/lib/pricing";

type QuantityEntry = { code?: unknown; quantityAvailable?: unknown };

function normalizedCode(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, "") : "";
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown> & { entries?: QuantityEntry[] };
    const source = Array.isArray(payload.entries) ? payload.entries.slice(0, 2000) : [];
    const entries = new Map<string, number>();
    const invalid: number[] = [];
    source.forEach((entry, index) => {
      const code = normalizedCode(entry.code);
      const quantity = Number(entry.quantityAvailable);
      if (!code || !Number.isInteger(quantity) || quantity < 0) invalid.push(index + 1);
      else entries.set(code, quantity);
    });
    if (!entries.size) return Response.json({ error: "No se encontró ninguna cantidad válida." }, { status: 400 });

    await ensureDatabase();
    const db = getD1();
    const mutation = await runIdempotentMutation(db, request, payload, async () => {
      const requestedCodes = [...entries.keys()];
      const existing = await db.prepare(`SELECT * FROM products
        WHERE lower(replace(code,' ','')) IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(requestedCodes)).all<Record<string, unknown>>();
      const byCode = new Map(existing.results.map((row) => [normalizedCode(row.code), row]));
      const statements: D1PreparedStatement[] = [];
      for (const [code, quantity] of entries) {
        const row = byCode.get(code);
        if (!row) continue;
        statements.push(db.prepare(`UPDATE products SET
          quantity_available=?,
          zero_stock_since=CASE WHEN ?=0 THEN COALESCE(zero_stock_since,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END,
          restock_purchased_at=CASE WHEN ?>0 AND (minimum_stock_enabled=0 OR ?>minimum_stock) THEN NULL ELSE restock_purchased_at END,
          version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? RETURNING *`).bind(quantity, quantity, quantity, quantity, Number(row.id)));
      }
      const results = statements.length ? await db.batch<Record<string, unknown>>(statements) : [];
      const products = results.flatMap((result) => result.results || []).map(productFromRow);
      const foundCodes = new Set(products.map((product) => normalizedCode(product.code)));
      const notFound = requestedCodes.filter((code) => !foundCodes.has(code));
      return { body: { products, updated: products.length, notFound, invalid } };
    });
    return Response.json(mutation.body, { status: mutation.status ?? 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
