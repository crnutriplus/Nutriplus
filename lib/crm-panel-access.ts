import { CrmError } from "./crm";
import {
  CRM_DASHBOARD_SESSION_COOKIE,
  getCrmDashboardSession,
} from "./crm-dashboard-session";
import { parseCrmPanelContext } from "./crm-panel";

function hasDashboardSessionCookie(request: Request): boolean {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .some((item) => item.trim().startsWith(`${CRM_DASHBOARD_SESSION_COOKIE}=`));
}

export async function requireCrmPanelAccess(db: D1Database, request: Request) {
  if (hasDashboardSessionCookie(request)) {
    const session = await getCrmDashboardSession(db, request);
    if (!session) {
      throw new CrmError("Se requiere iniciar sesión.", 401, "NUTRIPLUS_AUTH_REQUIRED");
    }

    return {
      mode: "embedded" as const,
      context: {
        accountId: session.accountId,
        contactId: session.contactId,
        conversationId: session.conversationId,
      },
      agentId: session.agentId,
      sessionId: session.id,
    };
  }

  const email = request.headers.get("oai-authenticated-user-email")?.trim();
  if (email) {
    return {
      mode: "chatgpt" as const,
      context: parseCrmPanelContext(new URL(request.url)),
      agentId: null,
      sessionId: null,
    };
  }

  throw new CrmError("Se requiere iniciar sesión.", 401, "NUTRIPLUS_AUTH_REQUIRED");
}
