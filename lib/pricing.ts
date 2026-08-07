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
  purchasePriceUsd: number;
  weightLb: number;
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
    purchasePriceUsd: Number(row.purchase_price_usd_cents) / 100,
    weightLb: Number(row.weight_milli_lb) / 1000,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
