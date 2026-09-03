const CHATGPT_EMAIL_HEADER = "oai-authenticated-user-email";

export type SiteAccessDecision =
  | { allowed: true; reason: "not_enforced" | "static" | "chatgpt_auth" | "webhook" | "crm" | "user" }
  | { allowed: false; reason: "anonymous" | "not_allowed" | "misconfigured" };

export type SiteAccessOptions = {
  mode?: string;
  allowedEmails?: string;
};

const CHATGPT_AUTH_PATHS = new Set([
  "/signin-with-chatgpt",
  "/signout-with-chatgpt",
  "/callback",
]);

const PUBLIC_STATIC_PATHS = new Set([
  "/manifest.webmanifest",
  "/favicon.ico",
  "/robots.txt",
]);

const STATIC_EXTENSION = /\.(?:avif|css|gif|ico|jpe?g|js|map|mjs|png|svg|webp|woff2?)$/i;

export function siteAccessDecision(
  request: Request,
  options: SiteAccessOptions,
): SiteAccessDecision {
  // The public Site must never become usable merely because an environment
  // variable was omitted. Local test fixtures opt out explicitly with
  // NUTRIPLUS_APP_AUTH_MODE=disabled.
  if (options.mode === "disabled") return { allowed: true, reason: "not_enforced" };

  const pathname = new URL(request.url).pathname;
  if (CHATGPT_AUTH_PATHS.has(pathname)) return { allowed: true, reason: "chatgpt_auth" };
  if (PUBLIC_STATIC_PATHS.has(pathname) || STATIC_EXTENSION.test(pathname)) return { allowed: true, reason: "static" };
  if (pathname === "/api/integrations/chatwoot/webhook") return { allowed: true, reason: "webhook" };
  if (pathname === "/api/crm" || pathname.startsWith("/api/crm/")) return { allowed: true, reason: "crm" };

  const allowed = parseAllowedEmails(options.allowedEmails);
  if (allowed.size === 0) return { allowed: false, reason: "misconfigured" };

  const email = request.headers.get(CHATGPT_EMAIL_HEADER)?.trim().toLowerCase();
  if (!email) return { allowed: false, reason: "anonymous" };
  return allowed.has(email)
    ? { allowed: true, reason: "user" }
    : { allowed: false, reason: "not_allowed" };
}

export function siteUnauthorizedResponse(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: { code: "NUTRIPLUS_AUTH_REQUIRED" } }, { status: 401 });
  }

  const returnTo = `${url.pathname}${url.search}`;
  const signIn = new URL("/signin-with-chatgpt", url.origin);
  signIn.searchParams.set("return_to", returnTo);
  return Response.redirect(signIn, 302);
}

function parseAllowedEmails(value: string | undefined): Set<string> {
  return new Set(
    (value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)),
  );
}
