import { ensureDatabase, getD1 } from "@/db";
import { orderErrorResponse, readOrderPayload } from "@/lib/orders";
import { createDeliveryRoute, listDeliveryRoutes } from "@/lib/orders-service";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    return Response.json(await listDeliveryRoutes(getD1(), request));
  } catch (error) { return orderErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const payload = await readOrderPayload(request);
    await ensureDatabase();
    return Response.json(await createDeliveryRoute(getD1(), payload), { status: 201 });
  } catch (error) { return orderErrorResponse(error); }
}
