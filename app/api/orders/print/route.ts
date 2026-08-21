import { ensureDatabase, getD1 } from "@/db";
import { orderErrorResponse } from "@/lib/orders";
import { buildOrdersPrintModel, createOrdersPrintPdf } from "@/lib/orders-print";

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const model = await buildOrdersPrintModel(getD1(), url.searchParams.get("date"));
    if (url.searchParams.get("format") === "json") return Response.json(model);
    const bytes = await createOrdersPrintPdf(model);
    return new Response(bytes as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="pedidos-${model.date}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) { return orderErrorResponse(error); }
}
