import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { CrmPanelClient } from "./crm-panel-client";

function value(input: string | string[] | undefined) { return typeof input === "string" ? input : ""; }

export default async function CrmPanelPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const accountId = value(params.account_id), contactId = value(params.contact_id), conversationId = value(params.conversation_id);
  const query = new URLSearchParams();
  if (accountId) query.set("account_id", accountId);
  if (contactId) query.set("contact_id", contactId);
  if (conversationId) query.set("conversation_id", conversationId);
  const currentPath = `/operations/crm-panel${query.size ? `?${query}` : ""}`;
  const user = await requireChatGPTUser(currentPath);
  return <CrmPanelClient context={{ accountId, contactId, conversationId }} userName={user.displayName} />;
}
