import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { settingsFromRow } from "@/lib/pricing";

export async function GET() {
  try {
    await ensureDatabase();
    const row = await getD1().prepare("SELECT * FROM settings WHERE id = 1").first();
    if (!row) throw new Error("No se encontraron los ajustes.");
    return Response.json({ settings: settingsFromRow(row) });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const exchangeRateCrc = Number(body.exchangeRateCrc);
    const courierRateUsd = Number(body.courierRateUsd);
    const extraWeightLb = Number(body.extraWeightLb);
    const deliveryCrc = Number(body.deliveryCrc);
    const correosCrc = Number(body.correosCrc);
    const gamProfitCrc = Number(body.gamProfitCrc);
    const puertoProfitCrc = Number(body.puertoProfitCrc);
    const roundingCrc = Number(body.roundingCrc);
    const values = [exchangeRateCrc, courierRateUsd, extraWeightLb, deliveryCrc, correosCrc, gamProfitCrc, puertoProfitCrc, roundingCrc];
    if (values.some((value) => !Number.isFinite(value) || value < 0) || roundingCrc < 1) return Response.json({ error: "Revisá los valores ingresados." }, { status: 400 });
    await ensureDatabase();
    await getD1().prepare(`UPDATE settings SET exchange_rate_crc=?, courier_rate_usd_cents=?, extra_weight_milli_lb=?, delivery_crc=?, correos_crc=?, gam_profit_crc=?, puerto_profit_crc=?, rounding_crc=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`).bind(
      Math.round(exchangeRateCrc), Math.round(courierRateUsd * 100), Math.round(extraWeightLb * 1000), Math.round(deliveryCrc), Math.round(correosCrc), Math.round(gamProfitCrc), Math.round(puertoProfitCrc), Math.round(roundingCrc),
    ).run();
    const row = await getD1().prepare("SELECT * FROM settings WHERE id=1").first();
    if (!row) throw new Error("No se pudieron recuperar los ajustes.");
    return Response.json({ settings: settingsFromRow(row) });
  } catch (error) { return errorResponse(error); }
}
