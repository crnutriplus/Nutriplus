import { ensureDatabase, getD1 } from "@/db";
import { CrmError } from "@/lib/crm";
import { getCrmPanelOrder, parseCrmPanelContext } from "@/lib/crm-panel";
import { ChatwootClient } from "@/lib/chatwoot-client";
function response(error: unknown) { const item = error instanceof CrmError ? error : new CrmError("No se pudo consultar el pedido.", 500, "CRM_PANEL_INTERNAL"); return Response.json({ error: { code: item.code, message: item.message } }, { status: item.status }); }
function configuredClient() { const base = globalThis.__NUTRIPLUS_CHATWOOT_BASE_URL__, token = globalThis.__NUTRIPLUS_CHATWOOT_API_TOKEN__; return base && token ? new ChatwootClient(base, token) : undefined; }
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { if (!request.headers.get("oai-authenticated-user-email")?.trim()) throw new CrmError("Se requiere iniciar sesión.", 401, "NUTRIPLUS_AUTH_REQUIRED"); await ensureDatabase(); return Response.json(await getCrmPanelOrder(getD1(), parseCrmPanelContext(new URL(request.url)), (await context.params).id, configuredClient())); } catch (error) { return response(error); } }
