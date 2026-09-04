import { ensureDatabase, getD1 } from "@/db";
import { CrmError } from "@/lib/crm";
import { ChatwootClient } from "@/lib/chatwoot-client";
import { createCrmMobileOrder } from "@/lib/crm-mobile-orders";
import { parseCrmPanelContext } from "@/lib/crm-panel";
import { OrderError } from "@/lib/orders";

function response(error: unknown) { const item = error instanceof CrmError || error instanceof OrderError ? error : new CrmError("No se pudo crear el borrador.", 500, "CRM_PANEL_INTERNAL"); return Response.json({ error: { code: item.code, message: item.message } }, { status: item.status }); }
function configuredClient() { const base = globalThis.__NUTRIPLUS_CHATWOOT_BASE_URL__, token = globalThis.__NUTRIPLUS_CHATWOOT_API_TOKEN__; return base && token ? new ChatwootClient(base, token) : undefined; }
export async function POST(request: Request) { try { if (!request.headers.get("oai-authenticated-user-email")?.trim()) throw new CrmError("Se requiere iniciar sesión.", 401, "NUTRIPLUS_AUTH_REQUIRED"); const input = await request.json() as Record<string, unknown>; await ensureDatabase(); const context = parseCrmPanelContext(new URL(request.url)); if (context.conversationId != null && !configuredClient()) throw new CrmError("La sincronización con Chatwoot no está disponible. El pedido no fue creado.", 503, "CRM_PANEL_CHATWOOT_NOT_CONFIGURED"); const result = await createCrmMobileOrder(getD1(), context, input, configuredClient()); return Response.json(result, { status: result.idempotent ? 200 : 201 }); } catch (error) { return response(error); } }
