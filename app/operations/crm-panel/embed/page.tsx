import { crmDashboardParentOrigin } from "@/lib/crm-dashboard-handshake";
import { CrmPanelEmbedClient } from "./crm-panel-embed-client";

export default function CrmPanelEmbedPage() {
  const parentOrigin = crmDashboardParentOrigin(
    globalThis.__NUTRIPLUS_CHATWOOT_BASE_URL__,
  );

  if (!parentOrigin) {
    return (
      <main className="crm-panel-shell">
        <section className="crm-panel-error">
          <div>
            <h1>CRM NutriPlus</h1>
            <p>Chatwoot no está configurado para abrir el panel embebido.</p>
          </div>
        </section>
      </main>
    );
  }

  return <CrmPanelEmbedClient parentOrigin={parentOrigin} />;
}
