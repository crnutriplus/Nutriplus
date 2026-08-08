export type PricingSettings = {
  exchangeRateCrc: number;
  courierRateUsd: number;
  extraWeightLb: number;
  deliveryCrc: number;
  correosCrc: number;
  gamProfitCrc: number;
  puertoProfitCrc: number;
  roundingCrc: number;
};

export type ProductRecord = {
  id: number;
  name: string;
  code: string | null;
  purchasePriceUsd: number | null;
  weightLb: number | null;
  createdAt: string;
  updatedAt: string;
};

export const DEFAULT_SETTINGS: PricingSettings = {
  exchangeRateCrc: 520,
  courierRateUsd: 5.5,
  extraWeightLb: 0.1,
  deliveryCrc: 1000,
  correosCrc: 500,
  gamProfitCrc: 5000,
  puertoProfitCrc: 4000,
  roundingCrc: 100,
};

export function normalizeName(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function searchTokens(value: string) {
  return normalizeName(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 8);
}

export function searchProducts<T extends Pick<ProductRecord, "name" | "code">>(products: T[], query: string) {
  const normalizedQuery = normalizeName(query);
  const tokens = searchTokens(query);
  const codeQuery = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!normalizedQuery) return products;

  return products
    .map((product, order) => {
      const name = normalizeName(product.name);
      const code = (product.code || "").toLowerCase().replace(/\s+/g, "");
      const nameMatches = tokens.length > 0 && tokens.every((token) => name.includes(token));
      const codeMatches = Boolean(codeQuery) && code.includes(codeQuery);
      if (!nameMatches && !codeMatches) return null;

      let score = 50;
      if (code === codeQuery) score = 0;
      else if (name === normalizedQuery) score = 1;
      else if (name.startsWith(`${normalizedQuery} `) || name.startsWith(normalizedQuery)) score = 3;
      else if (tokens.every((token) => name.split(/[^a-z0-9]+/).some((word) => word.startsWith(token)))) score = 8;
      else if (codeMatches) score = 12;
      else score = 20 + name.indexOf(tokens[0] || normalizedQuery);

      return { product, score, order };
    })
    .filter((match): match is { product: T; score: number; order: number } => match !== null)
    .sort((a, b) => a.score - b.score || a.product.name.localeCompare(b.product.name, "es") || a.order - b.order)
    .map((match) => match.product);
}

export function calculatePrices(priceUsd: number, weightLb: number, settings: PricingSettings) {
  const purchasePriceUsd = Number.isFinite(priceUsd) ? Math.max(0, priceUsd) : 0;
  const productWeightLb = Number.isFinite(weightLb) ? Math.max(0, weightLb) : 0;
  const chargedWeightLb = productWeightLb + settings.extraWeightLb;
  const courierUsd = chargedWeightLb * settings.courierRateUsd;
  const merchandiseAndCourierUsd = purchasePriceUsd + courierUsd;
  const costCrc = merchandiseAndCourierUsd * settings.exchangeRateCrc + settings.deliveryCrc + settings.correosCrc;
  const roundUp = (value: number) => Math.ceil(value / Math.max(1, settings.roundingCrc)) * Math.max(1, settings.roundingCrc);
  return {
    chargedWeightLb,
    courierUsd,
    merchandiseAndCourierUsd,
    costCrc,
    gamPriceCrc: roundUp(costCrc + settings.gamProfitCrc),
    puertoPriceCrc: roundUp(costCrc + settings.puertoProfitCrc),
  };
}

export function hasCompletePricing<T extends Pick<ProductRecord, "purchasePriceUsd" | "weightLb">>(
  product: T,
): product is T & { purchasePriceUsd: number; weightLb: number } {
  return product.purchasePriceUsd !== null
    && Number.isFinite(product.purchasePriceUsd)
    && product.purchasePriceUsd >= 0
    && product.weightLb !== null
    && Number.isFinite(product.weightLb)
    && product.weightLb >= 0;
}

export const crc = (value: number) => new Intl.NumberFormat("es-CR", { style: "currency", currency: "CRC", maximumFractionDigits: 0 }).format(Math.round(value));
export const usd = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

export function settingsFromRow(row: Record<string, unknown>): PricingSettings {
  return {
    exchangeRateCrc: Number(row.exchange_rate_crc),
    courierRateUsd: Number(row.courier_rate_usd_cents) / 100,
    extraWeightLb: Number(row.extra_weight_milli_lb) / 1000,
    deliveryCrc: Number(row.delivery_crc),
    correosCrc: Number(row.correos_crc),
    gamProfitCrc: Number(row.gam_profit_crc),
    puertoProfitCrc: Number(row.puerto_profit_crc),
    roundingCrc: Number(row.rounding_crc),
  };
}

export function productFromRow(row: Record<string, unknown>): ProductRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    code: row.code ? String(row.code) : null,
    purchasePriceUsd: row.purchase_price_usd_cents == null ? null : Number(row.purchase_price_usd_cents) / 100,
    weightLb: row.weight_milli_lb == null ? null : Number(row.weight_milli_lb) / 1000,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
