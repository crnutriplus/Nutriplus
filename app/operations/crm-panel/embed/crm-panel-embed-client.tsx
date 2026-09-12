"use client";

import { useEffect, useRef, useState } from "react";
import {
  isTrustedCrmDashboardMessage,
  parseCrmDashboardBootstrapMessage,
} from "@/lib/crm-dashboard-handshake";
import { CrmPanelClient } from "../crm-panel-client";

const EMPTY_CONTEXT = {
  accountId: "",
  contactId: "",
  conversationId: "",
};

type EmbedState = "waiting" | "exchanging" | "ready" | "error";

export function CrmPanelEmbedClient({
  parentOrigin,
}: {
  parentOrigin: string;
}) {
  const [state, setState] = useState<EmbedState>("waiting");
  const [error, setError] = useState<string | null>(null);
  const exchanging = useRef(false);

  useEffect(() => {
    const parentWindow = window.parent;

    async function handleMessage(event: MessageEvent) {
      if (
        !isTrustedCrmDashboardMessage(
          event,
          parentOrigin,
          parentWindow,
        )
      ) {
        return;
      }

      const token = parseCrmDashboardBootstrapMessage(event.data);
      if (!token || exchanging.current) return;

      exchanging.current = true;
      setError(null);
      setState("exchanging");

      try {
        const response = await fetch(
          "/api/operations/crm-panel/embed/session",
          {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token }),
          },
        );

        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;

        if (!response.ok) {
          throw new Error(
            body?.error?.message ||
              "No se pudo iniciar la sesión del CRM.",
          );
        }

        setState("ready");
      } catch (cause) {
        exchanging.current = false;
        setError(
          cause instanceof Error
            ? cause.message
            : "No se pudo iniciar la sesión del CRM.",
        );
        setState("error");
      }
    }

    window.addEventListener("message", handleMessage);
    parentWindow.postMessage(
      "nutriplus-dashboard-app:ready",
      parentOrigin,
    );

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [parentOrigin]);

  function retry() {
    exchanging.current = false;
    setError(null);
    setState("waiting");
    window.parent.postMessage(
      "nutriplus-dashboard-app:ready",
      parentOrigin,
    );
  }

  if (state === "ready") {
    return (
      <CrmPanelClient
        context={EMPTY_CONTEXT}
        userName="Chatwoot"
      />
    );
  }

  if (state === "error") {
    return (
      <main className="crm-panel-shell">
        <section className="crm-panel-error">
          <div>
            <h1>CRM NutriPlus</h1>
            <p>{error}</p>
            <button type="button" onClick={retry}>
              Reintentar
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="crm-panel-shell">
      <div className="crm-panel-loading">
        {state === "exchanging"
          ? "Validando sesión segura…"
          : "Conectando con Chatwoot…"}
      </div>
    </main>
  );
}
