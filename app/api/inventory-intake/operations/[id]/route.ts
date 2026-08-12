import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { productFromRow } from "@/lib/pricing";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = (await context.params).id;
    await ensureDatabase();
    const db = getD1();
    const operation = await db.prepare("SELECT * FROM inventory_operations WHERE id=? LIMIT 1").bind(id).first<Record<string, unknown>>();
    if (!operation) return Response.json({ found: false, status: "not_found" }, { status: 404 });
    const movements = await db.prepare("SELECT * FROM inventory_movements WHERE operation_id=? ORDER BY id").bind(id).all<Record<string, unknown>>();
    const productIds = [...new Set(movements.results.map((movement) => Number(movement.product_id)))];
    const products = productIds.length
      ? await db.prepare("SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(productIds)).all<Record<string, unknown>>()
      : { results: [] as Record<string, unknown>[] };
    return Response.json({
      found: true,
      operation: {
        id: String(operation.id),
        documentId: operation.document_id ? String(operation.document_id) : "",
        status: String(operation.status),
        operationType: String(operation.operation_type),
        lineCount: Number(operation.line_count),
        totalUnits: Number(operation.total_units),
        confirmedAt: operation.confirmed_at ? String(operation.confirmed_at) : "",
        verificationStatus: String(operation.verification_status),
      },
      products: products.results.map(productFromRow),
      movements: movements.results.map((movement) => ({
        id: String(movement.id),
        documentLineId: movement.document_line_id ? String(movement.document_line_id) : "",
        productId: Number(movement.product_id),
        productName: String(movement.product_name),
        previousQuantity: Number(movement.previous_quantity),
        quantityAdded: Number(movement.quantity_change),
        resultingQuantity: Number(movement.resulting_quantity),
      })),
    }, { status: String(operation.status) === "completed" ? 200 : 202 });
  } catch (error) { return errorResponse(error); }
}
