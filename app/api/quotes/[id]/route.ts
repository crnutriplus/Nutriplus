import { ensureDatabase, getD1 } from "@/db";
import { errorResponse, parseNonInventoryInput } from "@/lib/api-helpers";
import { runIdempotentMutation } from "@/lib/mutations";
import { nonInventoryFromRow } from "@/lib/pricing";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Producto inválido." }, { status: 400 });
    const payload = (await request.json()) as Record<string, unknown>;
    const quote = parseNonInventoryInput(payload);
    await ensureDatabase();
    const db = getD1();
    const mutation = await runIdempotentMutation(db, request, payload, async () => {
      const updated = await db.prepare(`UPDATE non_inventory_quotes SET
        name=?,code=?,purchase_price_usd_cents=?,weight_milli_lb=?,version=version+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? RETURNING *`)
        .bind(quote.name, quote.code, quote.purchasePriceUsdCents, quote.weightMilliLb, id)
        .first<Record<string, unknown>>();
      if (!updated) return { body: { deleted: true, quote: null } };
      return { body: { quote: nonInventoryFromRow(updated) } };
    });
    return Response.json(mutation.body, { status: mutation.status ?? 200 });
  } catch (error) { return errorResponse(error); }
}
