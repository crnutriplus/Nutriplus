import { ensureDatabase, getD1 } from "@/db";
import { financeErrorResponse, saveBudget } from "@/lib/finance";

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    return Response.json(await saveBudget(getD1(), await request.json() as Record<string, unknown>));
  } catch (error) { return financeErrorResponse(error); }
}
