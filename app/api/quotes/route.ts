import { ensureDatabase, getD1 } from "@/db";
import { errorResponse, parseNonInventoryInput } from "@/lib/api-helpers";
import { runIdempotentMutation } from "@/lib/mutations";
import { nonInventoryFromRow } from "@/lib/pricing";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit")) || 1000));
    const result = await getD1().prepare("SELECT * FROM non_inventory_quotes ORDER BY updated_at DESC,id DESC LIMIT ?")
      .bind(limit).all();
    return Response.json({ quotes: result.results.map(nonInventoryFromRow) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const quote = parseNonInventoryInput(payload);
    await ensureDatabase();
    const db = getD1();
    const mutation = await runIdempotentMutation(db, request, payload, async () => {
      const row = await db.prepare(`INSERT INTO non_inventory_quotes (
        name,code,purchase_price_usd_cents,weight_milli_lb,version,created_at,updated_at
      ) VALUES (?,?,?,?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING *`)
        .bind(quote.name, quote.code, quote.purchasePriceUsdCents, quote.weightMilliLb).first();
      if (!row) throw new Error("No se pudo guardar la cotización.");
      return { body: { quote: nonInventoryFromRow(row) }, status: 201 };
    });
    return Response.json(mutation.body, { status: mutation.status ?? 200 });
  } catch (error) { return errorResponse(error); }
}
