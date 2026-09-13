import { ensureDatabase, getD1 } from "@/db";
import { ChatwootClient } from "@/lib/chatwoot-client";
import { CrmError } from "@/lib/crm";
import { requireCrmPanelAccess } from "@/lib/crm-panel-access";
import { createCrmMobileOrder } from "@/lib/crm-mobile-orders";
import { OrderError } from "@/lib/orders";

function response(error: unknown) {
  const item = error instanceof CrmError || error instanceof OrderError ? error : new CrmError("No se pudo crear el borrador.", 500, "CRM_PANEL_INTERNAL");
  return Response.json({ error: { code: item.code, message: item.message } }, { status: item.status });
}

function configuredClient() {
  const base = globalThis.__NUTRIPLUS_CHATWOOT_BASE_URL__;
  const token = globalThis.__NUTRIPLUS_CHATWOOT_API_TOKEN__;
  return base && token ? new ChatwootClient(base, token) : undefined;
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const db = getD1();
    const access = await requireCrmPanelAccess(db, request);
    const input = await request.json() as Record<string, unknown>;
    const client = configuredClient();

    if (access.context.conversationId != null && !client) {
      throw new CrmError("La sincronización con Chatwoot no está disponible. El pedido no fue creado.", 503, "CRM_PANEL_CHATWOOT_NOT_CONFIGURED");
    }

    const result = await createCrmMobileOrder(db, access.context, input, client);
    return Response.json(result, { status: result.idempotent ? 200 : 201 });
  } catch (error) {
    return response(error);
  }
}
