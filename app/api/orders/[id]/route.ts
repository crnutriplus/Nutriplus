import { ensureDatabase, getD1 } from "@/db";
import { OrderError, orderErrorResponse, readOrderPayload } from "@/lib/orders";
import { deleteDraftOrder, loadOrder, updateOrder } from "@/lib/orders-service";

async function orderId(context: { params: Promise<{ id: string }> }) {
  const id = (await context.params).id.trim();
  if (!/^order-[0-9a-f-]{36}$/i.test(id)) throw new OrderError("El identificador del pedido no es válido. Actualizá la lista.", 400, "ORDER_ID_INVALID", "Pedido inválido");
  return id;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = await orderId(context);
    await ensureDatabase();
    const order = await loadOrder(getD1(), id);
    if (!order) throw new OrderError("No encontramos el pedido. Actualizá la lista.", 404, "ORDER_NOT_FOUND", "Pedido no encontrado");
    return Response.json({ order });
  } catch (error) { return orderErrorResponse(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = await orderId(context);
    const payload = await readOrderPayload(request);
    await ensureDatabase();
    return Response.json(await updateOrder(getD1(), id, payload));
  } catch (error) { return orderErrorResponse(error); }
}

export const PUT = PATCH;

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = await orderId(context);
    const payload = await readOrderPayload(request);
    await ensureDatabase();
    return Response.json(await deleteDraftOrder(getD1(), id, payload));
  } catch (error) { return orderErrorResponse(error); }
}
