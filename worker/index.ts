/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { ensureDatabase } from "../db";
import { reconcileNotifications } from "../lib/notifications";
import { siteAccessDecision, siteUnauthorizedResponse } from "../lib/site-access";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BUCKET: R2Bucket;
  OPENAI_API_KEY?: string;
  INVOICE_AI_ENABLED?: string;
  INVOICE_AI_MODEL?: string;
  INVOICE_AI_MONTHLY_LIMIT_USD?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  CRM_SERVICE_ID?: string;
  CRM_SERVICE_SECRET?: string;
  CHATWOOT_WEBHOOK_SECRET?: string;
  CHATWOOT_BASE_URL?: string;
  CHATWOOT_API_TOKEN?: string;
  NUTRIPLUS_APP_AUTH_MODE?: string;
  NUTRIPLUS_ALLOWED_USER_EMAILS?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    globalThis.__NUTRIPLUS_DB__ = env.DB;
    globalThis.__NUTRIPLUS_BUCKET__ = env.BUCKET;
    globalThis.__NUTRIPLUS_OPENAI_API_KEY__ = env.OPENAI_API_KEY;
    globalThis.__NUTRIPLUS_INVOICE_AI_ENABLED__ = env.INVOICE_AI_ENABLED;
    globalThis.__NUTRIPLUS_INVOICE_AI_MODEL__ = env.INVOICE_AI_MODEL;
    globalThis.__NUTRIPLUS_INVOICE_AI_MONTHLY_LIMIT_USD__ = env.INVOICE_AI_MONTHLY_LIMIT_USD;
    globalThis.__NUTRIPLUS_VAPID_PUBLIC_KEY__ = env.VAPID_PUBLIC_KEY;
    globalThis.__NUTRIPLUS_VAPID_PRIVATE_KEY__ = env.VAPID_PRIVATE_KEY;
    globalThis.__NUTRIPLUS_VAPID_SUBJECT__ = env.VAPID_SUBJECT;
    globalThis.__NUTRIPLUS_CRM_SERVICE_ID__ = env.CRM_SERVICE_ID;
    globalThis.__NUTRIPLUS_CRM_SERVICE_SECRET__ = env.CRM_SERVICE_SECRET;
    globalThis.__NUTRIPLUS_CHATWOOT_WEBHOOK_SECRET__ = env.CHATWOOT_WEBHOOK_SECRET;
    globalThis.__NUTRIPLUS_CHATWOOT_BASE_URL__ = env.CHATWOOT_BASE_URL;
    globalThis.__NUTRIPLUS_CHATWOOT_API_TOKEN__ = env.CHATWOOT_API_TOKEN;
    const url = new URL(request.url);

    const access = siteAccessDecision(request, {
      mode: env.NUTRIPLUS_APP_AUTH_MODE,
      allowedEmails: env.NUTRIPLUS_ALLOWED_USER_EMAILS,
    });
    if (!access.allowed) return siteUnauthorizedResponse(request);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const response = await handler.fetch(request, env, ctx);
    const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase());
    const isNavigation = request.method === "GET" && request.headers.get("accept")?.includes("text/html");
    if ((isMutation || isNavigation) && url.pathname !== "/api/notifications/reconcile") {
      ctx.waitUntil((async () => {
        await ensureDatabase();
        await reconcileNotifications(env.DB, { evaluateScheduled: isNavigation });
      })().catch(() => undefined));
    }
    return response;
  },
};

export default worker;
