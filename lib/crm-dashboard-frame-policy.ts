import { crmDashboardParentOrigin } from "./crm-dashboard-handshake";

export function withCrmDashboardFramePolicy(
  response: Response,
  chatwootBaseUrl: string | undefined,
) {
  const parentOrigin = crmDashboardParentOrigin(chatwootBaseUrl);
  const headers = new Headers(response.headers);

  headers.delete("x-frame-options");
  headers.append(
    "content-security-policy",
    `frame-ancestors ${parentOrigin ?? "'none'"};`,
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
