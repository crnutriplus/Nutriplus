/**
 * Keeps invoice presentation useful as an identity hint instead of copying a
 * marketing sentence into the product record.  The source description remains
 * on the invoice line; this value is deliberately short and comparable.
 */
function numberText(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded).replace(/\.0+$/, "");
}

function numeric(value: string) {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const COUNT_UNITS: Array<[RegExp, string]> = [
  [/^(?:capsule|capsules|capsula|capsulas|cápsula|cápsulas)$/i, "cápsulas"],
  [/^softgels?$/i, "softgels"],
  [/^(?:tablet|tablets|tableta|tabletas)$/i, "tabletas"],
  [/^(?:gummy|gummies|gomita|gomitas)$/i, "gomitas"],
  [/^(?:serving|servings|porción|porciones)$/i, "porciones"],
  [/^(?:ct|count|unidad|unidades|unit|units|piece|pieces|pcs)$/i, "unidades"],
];

function normalizedCountUnit(value: string) {
  return COUNT_UNITS.find(([pattern]) => pattern.test(value))?.[1] || "";
}

/**
 * Returns the shortest canonical commercial presentation from a parsed
 * description. Metric text already present in the invoice always wins over an
 * imperial equivalent in parentheses.
 */
export function normalizePresentation(value: string | null | undefined) {
  const source = String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (!source) return "";

  const metricVolume = [...source.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(ml|mL|l|L)\b/g)]
    .map((match) => ({ amount: numeric(match[1]), unit: match[2].toLowerCase() }))
    .find((item) => item.amount != null);
  if (metricVolume?.amount != null) return `${numberText(metricVolume.amount)} ${metricVolume.unit === "l" ? "l" : "ml"}`;

  const metricWeight = [...source.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(kg|g)\b/gi)]
    .map((match) => ({ amount: numeric(match[1]), unit: match[2].toLowerCase() }))
    .find((item) => item.amount != null);
  if (metricWeight?.amount != null) return `${numberText(metricWeight.amount)} ${metricWeight.unit}`;

  const count = [...source.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(capsules?|capsulas?|cápsulas?|softgels?|tablets?|tabletas?|gummies|gomitas?|servings?|porciones?|ct|count|unidades?|units?|pieces?|pcs)\b/gi)]
    .map((match) => ({ amount: numeric(match[1]), unit: normalizedCountUnit(match[2]) }))
    .find((item) => item.amount != null && item.unit);
  if (count?.amount != null) return `${numberText(count.amount)} ${count.unit}`;

  const fluidOunces = source.match(/\b(\d+(?:[.,]\d+)?)\s*(?:fl\.?\s*oz|fluid\s*ounces?)\b/i);
  const fluidAmount = fluidOunces ? numeric(fluidOunces[1]) : null;
  if (fluidAmount != null) return `${Math.round(fluidAmount * 29.5735)} ml`;

  const pounds = source.match(/\b(\d+(?:[.,]\d+)?)\s*(?:lb|lbs|pounds?)\b/i);
  const poundAmount = pounds ? numeric(pounds[1]) : null;
  if (poundAmount != null) return `${Math.round(poundAmount * 453.592)} g`;

  return "";
}
