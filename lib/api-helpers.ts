import { normalizeName } from "./pricing";

function optionalNumber(value: unknown) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function inventoryNumber(value: unknown, label: string) {
  if (value == null || (typeof value === "string" && !value.trim())) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} debe ser un número entero igual o mayor que cero.`);
  return parsed;
}

export function parseProductInput(payload: Record<string, unknown>, options: { allowPending?: boolean } = {}) {
  const name = typeof payload.name === "string" ? payload.name.trim().replace(/\s+/g, " ") : "";
  const code = typeof payload.code === "string" ? payload.code.trim() || null : null;
  const purchasePriceUsd = optionalNumber(payload.purchasePriceUsd);
  const weightLb = optionalNumber(payload.weightLb);
  const quantityAvailable = inventoryNumber(payload.quantityAvailable, "La cantidad disponible");
  const minimumStock = inventoryNumber(payload.minimumStock, "El stock mínimo");
  if (!name) throw new Error("El nombre del producto es obligatorio.");
  if (purchasePriceUsd !== null && (!Number.isFinite(purchasePriceUsd) || purchasePriceUsd < 0)) throw new Error("Ingresá un precio de compra válido.");
  if (weightLb !== null && (!Number.isFinite(weightLb) || weightLb < 0)) throw new Error("Ingresá un peso válido.");
  if (!options.allowPending && purchasePriceUsd === null) throw new Error("Ingresá el precio de compra.");
  if (!options.allowPending && weightLb === null) throw new Error("Ingresá el peso.");
  return {
    name,
    normalizedName: normalizeName(name),
    code,
    purchasePriceUsdCents: purchasePriceUsd === null ? null : Math.round(purchasePriceUsd * 100),
    weightMilliLb: weightLb === null ? null : Math.round(weightLb * 1000),
    quantityAvailable,
    minimumStock,
  };
}

export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "No se pudo completar la operación.";
  const duplicate = message.includes("UNIQUE constraint failed");
  return Response.json({ error: duplicate ? "Ya existe un producto con ese nombre o código. Abrilo para actualizarlo." : message }, { status: duplicate ? 409 : 500 });
}
