import { ensureDatabase, getD1 } from "@/db";
import { errorResponse, parseProductInput } from "@/lib/api-helpers";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { rows?: Array<Record<string, unknown> & { rowNumber?: number }>; strategy?: "skip" | "update" };
    const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 5000) : [];
    const strategy = payload.strategy === "skip" ? "skip" : "update";
    if (!rows.length) return Response.json({ error: "No hay filas para importar." }, { status: 400 });
    await ensureDatabase();
    const db = getD1();
    let imported = 0, updated = 0, skipped = 0;
    const errors: Array<{ row: number; message: string }> = [];
    for (let index = 0; index < rows.length; index += 1) {
      const source = rows[index];
      try {
        const product = parseProductInput(source, { allowPending: true });
        const existing = await db.prepare("SELECT id FROM products WHERE normalized_name=? OR (? IS NOT NULL AND code=?) LIMIT 1").bind(product.normalizedName, product.code, product.code).first<{ id: number }>();
        if (existing && strategy === "skip") { skipped += 1; continue; }
        if (existing) {
          await db.prepare("UPDATE products SET name=?,normalized_name=?,code=?,purchase_price_usd_cents=?,weight_milli_lb=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(product.name, product.normalizedName, product.code, product.purchasePriceUsdCents, product.weightMilliLb, existing.id).run();
          updated += 1;
        } else {
          await db.prepare("INSERT INTO products (name,normalized_name,code,purchase_price_usd_cents,weight_milli_lb) VALUES (?,?,?,?,?)").bind(product.name, product.normalizedName, product.code, product.purchasePriceUsdCents, product.weightMilliLb).run();
          imported += 1;
        }
      } catch (error) { errors.push({ row: Number(source.rowNumber) || index + 2, message: error instanceof Error ? error.message : "Fila inválida." }); }
    }
    return Response.json({ imported, updated, skipped, errors });
  } catch (error) { return errorResponse(error); }
}
