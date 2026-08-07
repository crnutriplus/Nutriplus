import { normalizeName } from "./pricing";

export function parseProductInput(payload: Record<string, unknown>) {
  const name = typeof payload.name === "string" ? payload.name.trim().replace(/\s+/g, " ") : "";
  const code = typeof payload.code === "string" ? payload.code.trim() || null : null;
  const purchasePriceUsd = Number(payload.purchasePriceUsd);
  const weightLb = Number(payload.weightLb);
  if (!name) throw new Error("El nombre del producto es obligatorio.");
  if (!Number.isFinite(purchasePriceUsd) || purchasePriceUsd < 0) throw new Error("Ingresá un precio de compra válido.");
  if (!Number.isFinite(weightLb) || weightLb <= 0) throw new Error("Ingresá un peso mayor que cero.");
  return { name, normalizedName: normalizeName(name), code, purchasePriceUsdCents: Math.round(purchasePriceUsd * 100), weightMilliLb: Math.round(weightLb * 1000) };
}

export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "No se pudo completar la operación.";
  const duplicate = message.includes("UNIQUE constraint failed");
  return Response.json({ error: duplicate ? "Ya existe un producto con ese nombre o código. Abrilo para actualizarlo." : message }, { status: duplicate ? 409 : 500 });
}
