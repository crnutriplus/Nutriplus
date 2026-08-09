import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { productFromRow } from "@/lib/pricing";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Producto inválido." }, { status: 400 });
    const payload = (await request.json()) as { purchased?: boolean };
    await ensureDatabase();
    const row = await getD1().prepare(`UPDATE products SET
      restock_purchased_at=CASE WHEN ?=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
      version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND ((minimum_stock_enabled=1 AND quantity_available<=minimum_stock) OR zero_stock_since IS NOT NULL)
      RETURNING *`).bind(payload.purchased === false ? 0 : 1, id).first();
    if (!row) {
      const current = await getD1().prepare("SELECT * FROM products WHERE id=? LIMIT 1").bind(id).first();
      if (!current) return Response.json({ error: "No se encontró el producto." }, { status: 404 });
      return Response.json({ product: productFromRow(current), noLongerNeeded: true });
    }
    return Response.json({ product: productFromRow(row) });
  } catch (error) { return errorResponse(error); }
}
