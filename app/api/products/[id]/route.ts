import { ensureDatabase, getD1 } from "@/db";
import { errorResponse, parseProductInput } from "@/lib/api-helpers";
import { productFromRow } from "@/lib/pricing";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Producto inválido." }, { status: 400 });
    const product = parseProductInput((await request.json()) as Record<string, unknown>);
    await ensureDatabase();
    const row = await getD1().prepare("UPDATE products SET name=?,normalized_name=?,code=?,purchase_price_usd_cents=?,weight_milli_lb=?,updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING *").bind(product.name, product.normalizedName, product.code, product.purchasePriceUsdCents, product.weightMilliLb, id).first();
    if (!row) return Response.json({ error: "No se encontró el producto." }, { status: 404 });
    return Response.json({ product: productFromRow(row) });
  } catch (error) { return errorResponse(error); }
}
