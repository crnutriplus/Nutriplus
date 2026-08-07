import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  exchangeRateCrc: integer("exchange_rate_crc").notNull().default(520),
  courierRateUsdCents: integer("courier_rate_usd_cents").notNull().default(550),
  extraWeightMilliLb: integer("extra_weight_milli_lb").notNull().default(100),
  deliveryCrc: integer("delivery_crc").notNull().default(1000),
  correosCrc: integer("correos_crc").notNull().default(500),
  gamProfitCrc: integer("gam_profit_crc").notNull().default(5000),
  puertoProfitCrc: integer("puerto_profit_crc").notNull().default(4000),
  roundingCrc: integer("rounding_crc").notNull().default(100),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const products = sqliteTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  code: text("code"),
  purchasePriceUsdCents: integer("purchase_price_usd_cents"),
  weightMilliLb: integer("weight_milli_lb"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("products_normalized_name_unique").on(table.normalizedName),
  uniqueIndex("products_code_unique").on(table.code),
]);
