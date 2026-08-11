import { ensureDatabase, getD1 } from "@/db";
import { errorResponse, parseProductInput } from "@/lib/api-helpers";
import { runIdempotentMutation } from "@/lib/mutations";
import { nonInventoryFromRow, productFromRow } from "@/lib/pricing";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const quoteId = Number((await context.params).id);
    if (!Number.isInteger(quoteId) || quoteId < 1) {
      return Response.json({ error: "Producto inválido." }, { status: 400 });
    }

    const payload = (await request.json()) as Record<string, unknown>;
    const product = parseProductInput(payload, { allowPending: true });
    await ensureDatabase();
    const db = getD1();
    const mutation = await runIdempotentMutation(db, request, payload, async () => {
      const currentRow = await db.prepare("SELECT * FROM non_inventory_quotes WHERE id=? LIMIT 1")
        .bind(quoteId).first<Record<string, unknown>>();
      if (!currentRow) {
        const moved = await db.prepare(`SELECT * FROM products
          WHERE normalized_name=? OR (? IS NOT NULL AND lower(replace(code,' ',''))=lower(replace(?,' ','')))
          ORDER BY CASE WHEN normalized_name=? THEN 0 ELSE 1 END LIMIT 1`)
          .bind(product.normalizedName, product.code, product.code, product.normalizedName).first<Record<string, unknown>>();
        return moved
          ? { body: { product: productFromRow(moved), removedQuoteId: quoteId, alreadyMoved: true } }
          : { body: { product: null, removedQuoteId: quoteId, deleted: true } };
      }

      const current = nonInventoryFromRow(currentRow);
      const duplicate = await db.prepare(`SELECT * FROM products
        WHERE normalized_name=? OR (? IS NOT NULL AND lower(replace(code,' ',''))=lower(replace(?,' ',''))) LIMIT 1`)
        .bind(product.normalizedName, product.code, product.code).first<Record<string, unknown>>();
      if (duplicate) {
        return { body: { error: "Ya existe un producto con ese nombre o código. El registro se conservó en No inventario.", current }, status: 409 };
      }

      const [insertResult, deleteResult] = await db.batch([
        db.prepare(`INSERT INTO products (
          name,normalized_name,code,purchase_price_usd_cents,weight_milli_lb,quantity_available,
          minimum_stock,minimum_stock_enabled,restock_purchased_at,zero_stock_since,version,created_at,updated_at
        ) SELECT ?,?,?,?,?,?,?,?,NULL,
          CASE WHEN ?=0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
          1,created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')
          FROM non_inventory_quotes WHERE id=? RETURNING *`)
          .bind(
            product.name,
            product.normalizedName,
            product.code,
            product.purchasePriceUsdCents,
            product.weightMilliLb,
            product.quantityAvailable,
            product.minimumStock,
            product.minimumStockEnabled ? 1 : 0,
            product.quantityAvailable,
            quoteId,
          ),
        db.prepare("DELETE FROM non_inventory_quotes WHERE id=?")
          .bind(quoteId),
      ]);

      const row = insertResult.results?.[0] as Record<string, unknown> | undefined;
      const deleted = Number(deleteResult.meta?.changes ?? 0) > 0;
      if (!row || !deleted) {
        const moved = await db.prepare(`SELECT * FROM products
          WHERE normalized_name=? OR (? IS NOT NULL AND lower(replace(code,' ',''))=lower(replace(?,' ','')))
          ORDER BY CASE WHEN normalized_name=? THEN 0 ELSE 1 END LIMIT 1`)
          .bind(product.normalizedName, product.code, product.code, product.normalizedName).first<Record<string, unknown>>();
        if (moved) return { body: { product: productFromRow(moved), removedQuoteId: quoteId, alreadyMoved: true } };
        return { body: { product: null, removedQuoteId: quoteId, deleted: true } };
      }

      return {
        body: { product: productFromRow(row), removedQuoteId: quoteId },
        status: 201,
      };
    });
    return Response.json(mutation.body, { status: mutation.status ?? 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
