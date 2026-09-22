import { ensureDatabase, getD1 } from "@/db";
import {
  loadMetaCapiStatus,
  parseMetaCapiOrderNumber,
} from "@/lib/meta-capi-status";

export async function GET(request: Request) {
  try {
    const orderNumber = parseMetaCapiOrderNumber(
      new URL(request.url).searchParams.get("orderNumber"),
    );

    await ensureDatabase();
    const jobs = await loadMetaCapiStatus(getD1(), orderNumber);

    return Response.json({
      orderNumber,
      count: jobs.length,
      jobs,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "No se pudo consultar Meta CAPI.";

    const invalid = message.startsWith("orderNumber debe");

    return Response.json(
      { error: message },
      { status: invalid ? 400 : 500 },
    );
  }
}
