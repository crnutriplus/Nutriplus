import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { runIdempotentMutation } from "@/lib/mutations";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown> & { ids?: unknown[] };
    const ids = [...new Set((Array.isArray(payload.ids) ? payload.ids : [])
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0))].slice(0, 5000);
    if (!ids.length) return Response.json({ error: "Seleccioná al menos un producto para eliminar." }, { status: 400 });

    await ensureDatabase();
    const db = getD1();
    const mutation = await runIdempotentMutation(db, request, payload, async () => {
      const serializedIds = JSON.stringify(ids);
      const deleted = await db.prepare(`DELETE FROM products
        WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
        AND NOT EXISTS (
          SELECT 1 FROM special_order_receipt_lines receipt_line
          WHERE receipt_line.product_id=products.id
        ) RETURNING id,name`)
        .bind(serializedIds).all<{ id: number; name: string }>();
      const deletedIds = deleted.results.map((row) => Number(row.id));
      const protectedRows = await db.prepare(`SELECT DISTINCT product_id FROM special_order_receipt_lines
        WHERE product_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`)
        .bind(serializedIds).all<{ product_id: number }>();
      const protectedIds = protectedRows.results.map((row) => Number(row.product_id));
      return {
        body: {
          deleted: deletedIds.length,
          deletedIds,
          protectedIds,
          alreadyDeleted: ids.filter((id) => !deletedIds.includes(id) && !protectedIds.includes(id)),
        },
      };
    });
    return Response.json(mutation.body, { status: mutation.status ?? 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
