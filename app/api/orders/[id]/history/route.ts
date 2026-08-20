import { ensureDatabase, getD1 } from "@/db";
import { orderErrorResponse } from "@/lib/orders";
import { orderHistory } from "@/lib/orders-service";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabase();
    return Response.json(await orderHistory(getD1(), (await context.params).id));
  } catch (error) { return orderErrorResponse(error); }
}
