import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { documentStatusStatement } from "@/lib/inventory-line-progress";
import { productFromRow } from "@/lib/pricing";
import { requestUserLabel } from "@/lib/request-user";

async function resultFor(db: D1Database, operationId: string) {
  const operation = await db.prepare("SELECT * FROM inventory_operations WHERE id=?").bind(operationId).first<Record<string, unknown>>();
  if (!operation) return null;
  const movements = await db.prepare("SELECT * FROM inventory_movements WHERE operation_id=? ORDER BY id").bind(operationId).all<Record<string, unknown>>();
  const ids = [...new Set(movements.results.map((movement) => Number(movement.product_id)))];
  const products = ids.length
    ? await db.prepare("SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<Record<string, unknown>>()
    : { results: [] as Record<string, unknown>[] };
  return {
    operation: {
      id: String(operation.id),
      status: String(operation.status),
      reversalOf: operation.reversal_of ? String(operation.reversal_of) : "",
      lineCount: Number(operation.line_count),
      totalUnits: Number(operation.total_units),
      confirmedAt: operation.confirmed_at ? String(operation.confirmed_at) : "",
    },
    products: products.results.map(productFromRow),
    movements: movements.results.map((movement) => ({
      id: String(movement.id),
      productId: Number(movement.product_id),
      productName: String(movement.product_name),
      quantityChange: Number(movement.quantity_change),
      previousQuantity: Number(movement.previous_quantity),
      resultingQuantity: Number(movement.resulting_quantity),
    })),
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let reversalId = "";
  try {
    const originalId = (await context.params).id;
    const payload = await request.json() as Record<string, unknown>;
    reversalId = typeof payload.operationId === "string" ? payload.operationId.trim() : "";
    const reason = typeof payload.reason === "string" ? payload.reason.trim().replace(/\s+/g, " ").slice(0, 500) : "";
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(reversalId)) return Response.json({ error: "La reversión no tiene un identificador seguro." }, { status: 400 });
    if (reason.length < 3) return Response.json({ error: "Indicá la razón de la reversión." }, { status: 400 });
    await ensureDatabase();
    const db = getD1();
    const prior = await resultFor(db, reversalId);
    if (prior?.operation.status === "completed") return Response.json({ ...prior, idempotent: true });
    const original = await db.prepare("SELECT * FROM inventory_operations WHERE id=? AND status='completed' LIMIT 1").bind(originalId).first<Record<string, unknown>>();
    if (!original) return Response.json({ error: "No se encontró un ingreso completado para revertir." }, { status: 404 });
    if (String(original.operation_type) === "reversal") return Response.json({ error: "Una reversión no puede revertirse desde este botón." }, { status: 409 });
    const priorReversal = await db.prepare("SELECT id FROM inventory_operations WHERE reversal_of=? AND status='completed' LIMIT 1").bind(originalId).first();
    if (priorReversal) return Response.json({ error: "Este ingreso ya fue revertido." }, { status: 409 });
    const movements = await db.prepare("SELECT * FROM inventory_movements WHERE operation_id=? ORDER BY id").bind(originalId).all<Record<string, unknown>>();
    if (!movements.results.length) return Response.json({ error: "El ingreso no contiene movimientos para revertir." }, { status: 409 });
    const productIds = [...new Set(movements.results.map((movement) => Number(movement.product_id)))];
    const products = await db.prepare("SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(productIds)).all<Record<string, unknown>>();
    const insufficient = movements.results.flatMap((movement) => {
      const product = products.results.find((item) => Number(item.id) === Number(movement.product_id));
      const required = Math.max(0, Number(movement.quantity_change));
      return !product || Number(product.quantity_available) < required
        ? [{ productId: Number(movement.product_id), productName: String(movement.product_name), required, available: Number(product?.quantity_available ?? 0) }]
        : [];
    });
    if (insufficient.length) return Response.json({
      error: "No hay inventario suficiente para revertir completamente este ingreso. Revisá manualmente los productos que pudieron venderse.",
      insufficient,
    }, { status: 409 });

    const user = requestUserLabel(request);
    const now = new Date().toISOString();
    const totalUnits = movements.results.reduce((total, movement) => total + Math.max(0, Number(movement.quantity_change)), 0);
    const statements: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO inventory_operations (
        id,document_id,operation_type,status,reversal_of,reason,confirmed_by,line_count,total_units,created_at,confirmed_at,verification_status
      ) VALUES (?,?,'reversal','pending',?,?,?,?,?,?,?,'pending')`).bind(
        reversalId, original.document_id || null, originalId, reason, user, movements.results.length, -totalUnits, now, now,
      ),
    ];
    movements.results.forEach((movement) => {
      const productId = Number(movement.product_id);
      const amount = Math.max(0, Number(movement.quantity_change));
      const movementId = `mov-${crypto.randomUUID()}`;
      statements.push(db.prepare(`INSERT INTO inventory_movements (
        id,operation_id,original_movement_id,document_line_id,product_id,product_name,barcode,canonical_barcode,
        secondary_id,secondary_type,previous_quantity,quantity_change,conversion,resulting_quantity,
        barcode_method,barcode_source,confirmed_by,reason,created_at
      ) VALUES (?,?,?,?,
        (SELECT id FROM products WHERE id=?),(SELECT name FROM products WHERE id=?),?,?,?,?,
        (SELECT quantity_available FROM products WHERE id=?),?,?,
        (SELECT quantity_available-? FROM products WHERE id=?),?,?,?,?,?)`).bind(
        movementId, reversalId, String(movement.id), movement.document_line_id || null,
        productId, productId, movement.barcode || null, movement.canonical_barcode || null,
        movement.secondary_id || null, movement.secondary_type || null, productId, -amount,
        Number(movement.conversion || 1), amount, productId, movement.barcode_method || null,
        movement.barcode_source || null, user, reason, now,
      ));
      statements.push(db.prepare(`UPDATE products SET quantity_available=quantity_available-?,
        zero_stock_since=CASE WHEN quantity_available-?=0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
        restock_purchased_at=CASE WHEN quantity_available-?>minimum_stock THEN NULL ELSE restock_purchased_at END,
        version=version+1,updated_at=? WHERE id=? AND quantity_available>=?`).bind(amount, amount, amount, now, productId, amount));
      if (movement.document_line_id) {
        statements.push(db.prepare(`UPDATE inventory_document_lines SET
          status=CASE WHEN action='ignore' THEN 'ignored' ELSE 'confirmed' END,
          selected_for_ingress=CASE WHEN action='ignore' THEN 0 ELSE 1 END,updated_at=?
          WHERE id=?`).bind(now, String(movement.document_line_id)));
      }
    });
    if (original.document_id) statements.push(documentStatusStatement(db, String(original.document_id), now));
    statements.push(db.prepare("UPDATE inventory_operations SET status='completed',verification_status='verified',confirmed_at=? WHERE id=?").bind(now, reversalId));
    try { await db.batch(statements); }
    catch (error) {
      const raced = await resultFor(db, reversalId);
      if (raced?.operation.status === "completed") return Response.json({ ...raced, idempotent: true });
      throw error;
    }
    const result = await resultFor(db, reversalId);
    if (!result || result.movements.length !== movements.results.length) throw new Error("La reversión no pudo verificarse por completo.");
    return Response.json(result);
  } catch (error) {
    if (reversalId) {
      try {
        const recovered = await resultFor(getD1(), reversalId);
        if (recovered?.operation.status === "completed") return Response.json({ ...recovered, recoveredAfterConnectionCheck: true });
      } catch { /* Se conserva el error original. */ }
    }
    const message = error instanceof Error ? error.message : "";
    if (/INVENTORY_LINE_ACTIVE_NEGATIVE/i.test(message)) {
      return Response.json({
        error: "La reversión supera la cantidad actualmente activa de esta línea. Actualizá el historial antes de intentarlo nuevamente; el inventario no fue modificado.",
        title: "Cantidad de reversión inválida",
        code: "INVENTORY_REVERSAL_EXCEEDS_ACTIVE",
      }, { status: 409 });
    }
    return errorResponse(error);
  }
}
