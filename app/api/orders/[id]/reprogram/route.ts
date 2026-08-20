import { ensureDatabase, getD1 } from "@/db";
import { orderErrorResponse, readOrderPayload } from "@/lib/orders";
import { reprogramOrder } from "@/lib/orders-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const payload = await readOrderPayload(request);
    await ensureDatabase();
    return Response.json(await reprogramOrder(getD1(), (await context.params).id, payload));
  } catch (error) { return orderErrorResponse(error); }
}
