import { ensureDatabase, getD1 } from "@/db";
import { errorResponse, parseProductInput } from "@/lib/api-helpers";
import { runIdempotentMutation } from "@/lib/mutations";
import { productFromRow, type ProductRecord } from "@/lib/pricing";

type EditableProduct = {
  name: string;
  code: string;
  purchasePriceUsd: number | null;
  weightLb: number | null;
  quantityAvailable: number;
  minimumStock: number;
  minimumStockEnabled: boolean;
};

function editable(product: ProductRecord): EditableProduct {
  return {
    name: product.name,
    code: product.code || "",
    purchasePriceUsd: product.purchasePriceUsd,
    weightLb: product.weightLb,
    quantityAvailable: product.quantityAvailable,
    minimumStock: product.minimumStock,
    minimumStockEnabled: product.minimumStockEnabled,
  };
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function productHistoryProtectionResponse() {
  return Response.json({
    error: "Este producto se conserva porque está vinculado a un recibo histórico de encargo. El pedido y su trazabilidad no se modificaron.",
  }, { status: 409 });
}

function isForeignKeyConstraint(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /FOREIGN KEY constraint failed|SQLITE_CONSTRAINT_FOREIGNKEY/i.test(message);
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Producto inválido." }, { status: 400 });
    const payload = (await request.json()) as Record<string, unknown>;
    const desiredParsed = parseProductInput(payload, { allowPending: true });
    await ensureDatabase();
    const db = getD1();
    const mutation = await runIdempotentMutation(db, request, payload, async () => {
      const requestedVersion = Number(payload.version ?? 0);
      const desiredInput: EditableProduct = {
        name: desiredParsed.name,
        code: desiredParsed.code || "",
        purchasePriceUsd: desiredParsed.purchasePriceUsdCents === null ? null : desiredParsed.purchasePriceUsdCents / 100,
        weightLb: desiredParsed.weightMilliLb === null ? null : desiredParsed.weightMilliLb / 1000,
        quantityAvailable: desiredParsed.quantityAvailable,
        minimumStock: desiredParsed.minimumStock,
        minimumStockEnabled: desiredParsed.minimumStockEnabled,
      };
      const base = payload.base && typeof payload.base === "object" ? payload.base as Partial<EditableProduct> : null;

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const currentRow = await db.prepare("SELECT * FROM products WHERE id=? LIMIT 1").bind(id).first<Record<string, unknown>>();
        if (!currentRow) return { body: { deleted: true, product: null, skippedFields: ["deleted"] } };
        const current = productFromRow(currentRow);
        let nextInput = { ...desiredInput };
        const skippedFields: string[] = [];
        let merged = false;

        if (requestedVersion !== current.version) {
          merged = true;
          if (base) {
            const currentInput = editable(current);
            nextInput = { ...currentInput };
            const fields = Object.keys(currentInput) as Array<keyof EditableProduct>;
            for (const field of fields) {
              if (same(desiredInput[field], base[field])) continue;
              if (!same(currentInput[field], base[field])) {
                if (field === "quantityAvailable") {
                  const delta = Number(desiredInput.quantityAvailable) - Number(base.quantityAvailable ?? 0);
                  nextInput.quantityAvailable = Math.max(0, currentInput.quantityAvailable + delta);
                } else {
                  skippedFields.push(field);
                }
              } else {
                (nextInput as Record<string, unknown>)[field] = desiredInput[field];
              }
            }
          }
        }

        const next = parseProductInput(nextInput as unknown as Record<string, unknown>, { allowPending: true });
        const stillNeedsRestock = (next.minimumStockEnabled && next.quantityAvailable <= next.minimumStock) || next.quantityAvailable === 0;
        const zeroStockSince = next.quantityAvailable === 0
          ? current.zeroStockSince || new Date().toISOString()
          : null;
        const restockPurchasedAt = stillNeedsRestock ? current.restockPurchasedAt : null;
        const update = await db.prepare(`UPDATE products SET
          name=?,normalized_name=?,code=?,purchase_price_usd_cents=?,weight_milli_lb=?,quantity_available=?,
          minimum_stock=?,minimum_stock_enabled=?,restock_purchased_at=?,zero_stock_since=?,version=version+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=? RETURNING *`)
          .bind(next.name, next.normalizedName, next.code, next.purchasePriceUsdCents, next.weightMilliLb,
            next.quantityAvailable, next.minimumStock, next.minimumStockEnabled ? 1 : 0, restockPurchasedAt,
            zeroStockSince, id, current.version).first<Record<string, unknown>>();
        if (update) return { body: { product: productFromRow(update), merged, skippedFields } };
      }

      const latest = await db.prepare("SELECT * FROM products WHERE id=? LIMIT 1").bind(id).first<Record<string, unknown>>();
      return latest
        ? { body: { product: productFromRow(latest), merged: true, skippedFields: ["concurrentUpdate"] } }
        : { body: { deleted: true, product: null, skippedFields: ["deleted"] } };
    });
    return Response.json(mutation.body, { status: mutation.status ?? 200 });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Producto inválido." }, { status: 400 });
    await ensureDatabase();
    const db = getD1();
    const receiptReference = await db.prepare("SELECT 1 FROM special_order_receipt_lines WHERE product_id=? LIMIT 1")
      .bind(id).first();
    if (receiptReference) return productHistoryProtectionResponse();
    const payload = { mutationId: request.headers.get("x-mutation-id") || "" };
    const mutation = await runIdempotentMutation(db, request, payload, async () => {
      const existing = await db.prepare("DELETE FROM products WHERE id=? RETURNING name").bind(id).first<{ name: string }>();
      return { body: { deleted: true, alreadyDeleted: !existing, name: existing?.name || null } };
    });
    return Response.json(mutation.body, { status: mutation.status ?? 200 });
  } catch (error) {
    return isForeignKeyConstraint(error) ? productHistoryProtectionResponse() : errorResponse(error);
  }
}
