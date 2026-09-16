import { ensureDatabase, getD1 } from "@/db";
import { CrmError } from "@/lib/crm";
import { getCrmPanelForCustomer, linkedCrmPanelCustomer, validateCrmPanelContext } from "@/lib/crm-panel";
import { ChatwootApiError, ChatwootClient } from "@/lib/chatwoot-client";
import { syncContact } from "@/lib/chatwoot-sync";
import {
  createCrmDashboardSession,
  crmDashboardSessionCookie,
  verifyCrmDashboardBootstrapToken,
} from "@/lib/crm-dashboard-session";

function errorResponse(error: unknown) {
  if (error instanceof CrmError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  }
  if (error instanceof ChatwootApiError) {
    const status = error.status >= 500 ? 503 : 401;
    return Response.json(
      { error: { code: "CRM_DASHBOARD_CHATWOOT_VALIDATION_FAILED", message: "No se pudo validar la conversación en Chatwoot." } },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json(
    { error: { code: "CRM_DASHBOARD_EXCHANGE_INTERNAL", message: "No se pudo iniciar la sesión del panel CRM." } },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

function configuredClient() {
  const base = globalThis.__NUTRIPLUS_CHATWOOT_BASE_URL__;
  const token = globalThis.__NUTRIPLUS_CHATWOOT_API_TOKEN__;
  if (!base || !token) {
    throw new CrmError(
      "Chatwoot no está configurado para validar el panel CRM.",
      503,
      "CRM_PANEL_CHATWOOT_NOT_CONFIGURED",
    );
  }
  return new ChatwootClient(base, token);
}

async function bootstrapToken(request: Request) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    throw new CrmError("Solicitud de inicio de sesión inválida.", 400, "CRM_DASHBOARD_BOOTSTRAP_INVALID");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CrmError("Solicitud de inicio de sesión inválida.", 400, "CRM_DASHBOARD_BOOTSTRAP_INVALID");
  }
  const token = (input as Record<string, unknown>).token;
  if (typeof token !== "string" || !token.trim() || token.length > 8192) {
    throw new CrmError("Token de Dashboard App requerido.", 400, "CRM_DASHBOARD_BOOTSTRAP_REQUIRED");
  }
  return token.trim();
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin) {
      throw new CrmError(
        "Origen de solicitud no permitido.",
        403,
        "CRM_DASHBOARD_ORIGIN_INVALID",
      );
    }
    await ensureDatabase();
    const token = await bootstrapToken(request);
    const claims = await verifyCrmDashboardBootstrapToken(token);
    const db = getD1();

    const context = {
      accountId: claims.accountId,
      contactId: claims.contactId,
      conversationId: claims.conversationId,
    };
    const chatwootClient = configuredClient();
    const recoverCustomer = async () => {
      const contact = await chatwootClient.getContact(context.accountId, context.contactId);
      if (Number(contact.id) !== context.contactId) {
        throw new CrmError(
          "La conversación no corresponde al contacto seleccionado.",
          404,
          "CRM_PANEL_CONTEXT_MISMATCH",
        );
      }
      await syncContact(db, chatwootClient, context.accountId, contact);
      return linkedCrmPanelCustomer(db, context);
    };
    const customer = await validateCrmPanelContext(
        db,
        context,
        {
          getConversation: (accountId, conversationId) =>
            chatwootClient.getConversation(accountId, conversationId),
        },
        recoverCustomer,
    );

    const [session, panel] = await Promise.all([
      createCrmDashboardSession(db, claims),
      getCrmPanelForCustomer(db, context, customer),
    ]);
    return Response.json(
      { ok: true, expiresAt: session.expiresAt, panel },
      {
        status: 201,
        headers: {
          "cache-control": "no-store",
          "set-cookie": crmDashboardSessionCookie(session.id),
        },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
