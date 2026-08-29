import { ensureDatabase, getD1 } from "@/db";
import { financeErrorResponse, financeRange, loadFinanceSnapshot } from "@/lib/finance";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    return Response.json(await loadFinanceSnapshot(getD1(), financeRange(new URL(request.url))));
  } catch (error) { return financeErrorResponse(error); }
}
