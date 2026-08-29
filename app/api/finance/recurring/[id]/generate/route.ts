import { ensureDatabase, getD1 } from "@/db";
import { financeErrorResponse, generateRecurringExpense } from "@/lib/finance";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabase();
    return Response.json(await generateRecurringExpense(getD1(), (await context.params).id, await request.json() as Record<string, unknown>));
  } catch (error) { return financeErrorResponse(error); }
}
