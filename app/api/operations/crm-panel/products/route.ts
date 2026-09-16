import { ensureDatabase, getD1 } from "@/db";
import { CrmError } from "@/lib/crm";
import { requireCrmPanelAccess } from "@/lib/crm-panel-access";
import { searchCrmMobileProducts } from "@/lib/crm-mobile-orders";

function errorResponse(error: unknown) {
  const item = error instanceof CrmError ? error : new CrmError("No se pudo buscar productos.", 500, "CRM_PANEL_INTERNAL");
  return Response.json({ error: { code: item.code, message: item.message } }, { status: item.status });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const db = getD1();
    await requireCrmPanelAccess(db, request);
    return Response.json({
      products: await searchCrmMobileProducts(db, new URL(request.url).searchParams.get("q") ?? ""),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
