import { ensureDatabase, getD1 } from "@/db";
import { financeErrorResponse, reverseExpense } from "@/lib/finance";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabase();
    return Response.json(await reverseExpense(getD1(), (await context.params).id, await request.json() as Record<string, unknown>));
  } catch (error) { return financeErrorResponse(error); }
}
