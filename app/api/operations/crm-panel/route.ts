import { ensureDatabase, getD1 } from "@/db";
import { CrmError } from "@/lib/crm";
import { getCrmPanel, parseCrmPanelContext } from "@/lib/crm-panel";

function response(error: unknown) { const item = error instanceof CrmError ? error : new CrmError("No se pudo consultar el panel CRM.", 500, "CRM_PANEL_INTERNAL"); return Response.json({ error: { code: item.code, message: item.message } }, { status: item.status }); }
function requireUser(request: Request) { if (!request.headers.get("oai-authenticated-user-email")?.trim()) throw new CrmError("Se requiere iniciar sesión.", 401, "NUTRIPLUS_AUTH_REQUIRED"); }
export async function GET(request: Request) { try { requireUser(request); await ensureDatabase(); return Response.json(await getCrmPanel(getD1(), parseCrmPanelContext(new URL(request.url)))); } catch (error) { return response(error); } }
