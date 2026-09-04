import { ensureDatabase, getD1 } from "@/db";
import { CrmError } from "@/lib/crm";
import { searchCrmMobileProducts } from "@/lib/crm-mobile-orders";

function errorResponse(error: unknown) { const item = error instanceof CrmError ? error : new CrmError("No se pudo buscar productos.", 500, "CRM_PANEL_INTERNAL"); return Response.json({ error: { code: item.code, message: item.message } }, { status: item.status }); }
export async function GET(request: Request) { try { if (!request.headers.get("oai-authenticated-user-email")?.trim()) throw new CrmError("Se requiere iniciar sesión.", 401, "NUTRIPLUS_AUTH_REQUIRED"); await ensureDatabase(); return Response.json({ products: await searchCrmMobileProducts(getD1(), new URL(request.url).searchParams.get("q") ?? "") }); } catch (error) { return errorResponse(error); } }
