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

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Producto inválido." }, { status: 400 });
    const payload = (await request.json()) as Record<string, unknown>;
    const desiredParsed = parseProductInput(payload, { allowPending: true });
    await ensureDatabase();
    const db = getD1();
    const mutation = await runIdempotentMutation(db, request, payload, async () => {
      const currentRow = await db.prepare("SELECT * FROM products WHERE id=? LIMIT 1").bind(id).first<Record<string, unknown>>();
      if (!currentRow) return { body: { error: "No se encontró el producto." }, status: 404 };
      const current = productFromRow(currentRow);
      const requestedVersion = Number(payload.version ?? 0);
      let nextInput: EditableProduct = {
        name: desiredParsed.name,
        code: desiredParsed.code || "",
        purchasePriceUsd: desiredParsed.purchasePriceUsdCents === null ? null : desiredParsed.purchasePriceUsdCents / 100,
        weightLb: desiredParsed.weightMilliLb === null ? null : desiredParsed.weightMilliLb / 1000,
        quantityAvailable: desiredParsed.quantityAvailable,
        minimumStock: desiredParsed.minimumStock,
        minimumStockEnabled: desiredParsed.minimumStockEnabled,
      };
      const skippedFields: string[] = [];
      let merged = false;

      if (requestedVersion !== current.version) {
        const base = payload.base && typeof payload.base === "object" ? payload.base as Partial<EditableProduct> : null;
        if (!base) return { body: { error: "Este producto cambió en otro dispositivo. Se cargó la versión más reciente.", current }, status: 409 };
        const currentInput = editable(current);
        const desiredInput = { ...nextInput };
        nextInput = { ...currentInput };
        const fields = Object.keys(currentInput) as Array<keyof EditableProduct>;
        for (const field of fields) {
          if (same(desiredInput[field], base[field])) continue;
          if (!same(currentInput[field], base[field])) {
            if (field === "quantityAvailable") {
              const delta = Number(desiredInput.quantityAvailable) - Number(base.quantityAvailable ?? 0);
              nextInput.quantityAvailable = Math.max(0, currentInput.quantityAvailable + delta);
              merged = true;
            } else {
              skippedFields.push(field);
            }
          } else {
            (nextInput as Record<string, unknown>)[field] = desiredInput[field];
            merged = true;
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
      if (!update) {
        const latest = await db.prepare("SELECT * FROM products WHERE id=? LIMIT 1").bind(id).first<Record<string, unknown>>();
        return { body: { error: "Otro cambio llegó al mismo tiempo. Se conservó la información más reciente.", current: latest ? productFromRow(latest) : null }, status: 409 };
      }
      return { body: { product: productFromRow(update), merged, skippedFields } };
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
    const payload = { mutationId: request.headers.get("x-mutation-id") || "" };
    const mutation = await runIdempotentMutation(db, request, payload, async () => {
      const existing = await db.prepare("SELECT * FROM products WHERE id=? LIMIT 1").bind(id).first<Record<string, unknown>>();
      if (!existing) return { body: { deleted: true, alreadyDeleted: true } };
      const expectedVersion = Number(request.headers.get("if-match") || 0);
      if (expectedVersion && Number(existing.version ?? 1) !== expectedVersion) {
        return { body: { error: "El producto cambió en otro dispositivo y no se eliminó.", current: productFromRow(existing) }, status: 409 };
      }
      const result = await db.prepare("DELETE FROM products WHERE id=? AND version=?").bind(id, Number(existing.version ?? 1)).run();
      const deleted = Number(result.meta?.changes ?? 0) > 0;
      if (!deleted) return { body: { error: "El producto cambió mientras se eliminaba y se conservó.", current: productFromRow(existing) }, status: 409 };
      return { body: { deleted: true, name: String(existing.name) } };
    });
    return Response.json(mutation.body, { status: mutation.status ?? 200 });
  } catch (error) { return errorResponse(error); }
}
