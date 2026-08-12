import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { invoiceAiConfig, invoiceAiUsageSummary } from "@/lib/invoice-ai";

export async function GET() {
  try {
    await ensureDatabase();
    const config = invoiceAiConfig();
    const usage = await invoiceAiUsageSummary(getD1());
    const limitMicrousd = Math.round(config.monthlyLimitUsd * 1_000_000);
    return Response.json({
      aiEnabled: config.enabled,
      aiAvailable: config.enabled && config.keyConfigured && usage.currentMonthMicrousd < limitMicrousd,
      keyConfigured: config.keyConfigured,
      model: config.model,
      monthlyLimitUsd: config.monthlyLimitUsd,
      currentMonthCostUsd: usage.currentMonthMicrousd / 1_000_000,
      cumulativeCostUsd: usage.cumulativeMicrousd / 1_000_000,
      billedAnalyses: usage.billedAnalyses,
      month: usage.month,
      limitReached: usage.currentMonthMicrousd >= limitMicrousd,
    });
  } catch (error) { return errorResponse(error); }
}
