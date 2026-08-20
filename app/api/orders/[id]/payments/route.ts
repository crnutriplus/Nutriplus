import { ensureDatabase, getD1 } from "@/db";
import { orderErrorResponse, readOrderPayload } from "@/lib/orders";
import { listPayments, recordPayment } from "@/lib/orders-service";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabase();
    return Response.json(await listPayments(getD1(), (await context.params).id));
  } catch (error) { return orderErrorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const payload = await readOrderPayload(request);
    await ensureDatabase();
    return Response.json(await recordPayment(getD1(), (await context.params).id, payload));
  } catch (error) { return orderErrorResponse(error); }
}
