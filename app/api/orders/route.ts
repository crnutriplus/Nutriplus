import { ensureDatabase, getD1 } from "@/db";
import { orderErrorResponse, readOrderPayload } from "@/lib/orders";
import { createOrder, listOrders } from "@/lib/orders-service";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    return Response.json(await listOrders(getD1(), request));
  } catch (error) { return orderErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const payload = await readOrderPayload(request);
    await ensureDatabase();
    const result = await createOrder(getD1(), payload);
    return Response.json(result, { status: result.idempotent ? 200 : 201 });
  } catch (error) { return orderErrorResponse(error); }
}
