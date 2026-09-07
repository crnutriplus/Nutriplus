import { ChatwootWebhookError, verifyChatwootWebhook } from "@/lib/chatwoot-webhook";
import { getD1 } from "@/db";
import { chatwootWebhookJobFromPayload, enqueueChatwootWebhookJob, ensureChatwootWebhookOutboxSchema } from "@/lib/chatwoot-webhook-outbox";

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const secret = globalThis.__NUTRIPLUS_CHATWOOT_WEBHOOK_SECRET__;
    if (!secret) return Response.json({ error: { code: "CHATWOOT_WEBHOOK_NOT_CONFIGURED" } }, { status: 503 });
    const result = await verifyChatwootWebhook(request, raw, secret);
    if (!result.supported) return Response.json({ accepted: true, duplicate: false, event: result.event || "unknown", supported: false }, { status: 202 });
    const job = chatwootWebhookJobFromPayload(result.event, result.delivery, result.payload);
    if (!job) throw new ChatwootWebhookError(400, "CHATWOOT_RESOURCE_INVALID");
    const db = getD1();
    await ensureChatwootWebhookOutboxSchema(db);
    const queued = await enqueueChatwootWebhookJob(db, job);
    return Response.json({ accepted: true, duplicate: !queued.created, event: result.event, supported: true }, { status: 202 });
  } catch (error) {
    const webhookError = error instanceof ChatwootWebhookError ? error : new ChatwootWebhookError(500, "CHATWOOT_WEBHOOK_INTERNAL");
    return Response.json({ error: { code: webhookError.code } }, { status: webhookError.status });
  }
}
