import { ensureDatabase, getD1 } from "@/db";
import { errorResponse, parseProductInput } from "@/lib/api-helpers";
import { productFromRow } from "@/lib/pricing";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Producto inválido." }, { status: 400 });
    const product = parseProductInput((await request.json()) as Record<string, unknown>, { allowPending: true });
    await ensureDatabase();
    const row = await getD1().prepare("UPDATE products SET name=?,normalized_name=?,code=?,purchase_price_usd_cents=?,weight_milli_lb=?,quantity_available=?,minimum_stock=?,minimum_stock_enabled=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? RETURNING *").bind(product.name, product.normalizedName, product.code, product.purchasePriceUsdCents, product.weightMilliLb, product.quantityAvailable, product.minimumStock, product.minimumStockEnabled ? 1 : 0, id).first();
    if (!row) return Response.json({ error: "No se encontró el producto." }, { status: 404 });
    return Response.json({ product: productFromRow(row) });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Producto inválido." }, { status: 400 });
    await ensureDatabase();
    const existing = await getD1().prepare("SELECT name FROM products WHERE id=? LIMIT 1").bind(id).first<{ name: string }>();
    if (!existing) return Response.json({ error: "No se encontró el producto." }, { status: 404 });
    await getD1().prepare("DELETE FROM products WHERE id=?").bind(id).run();
    return Response.json({ deleted: true, name: existing.name });
  } catch (error) { return errorResponse(error); }
}
