import { ensureDatabase, getD1 } from "@/db";
import { ChatwootClient } from "@/lib/chatwoot-client";
import { CrmError } from "@/lib/crm";
import { requireCrmPanelAccess } from "@/lib/crm-panel-access";
import { getCrmPanel } from "@/lib/crm-panel";

function response(error: unknown) {
  const item = error instanceof CrmError ? error : new CrmError("No se pudo consultar el panel CRM.", 500, "CRM_PANEL_INTERNAL");
  return Response.json({ error: { code: item.code, message: item.message } }, { status: item.status });
}

function configuredClient() {
  const base = globalThis.__NUTRIPLUS_CHATWOOT_BASE_URL__;
  const token = globalThis.__NUTRIPLUS_CHATWOOT_API_TOKEN__;
  return base && token ? new ChatwootClient(base, token) : undefined;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const db = getD1();
    const access = await requireCrmPanelAccess(db, request);
    return Response.json(await getCrmPanel(db, access.context, configuredClient()));
  } catch (error) {
    return response(error);
  }
}
