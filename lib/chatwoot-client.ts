export class ChatwootApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

type FetchLike = typeof fetch;
type Attributes = Record<string, unknown>;
type JsonObject = Record<string, unknown>;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const retryable = (status: number) => status === 429 || status >= 500;

export class ChatwootClient {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetcher: FetchLike = fetch, private readonly retries = 2) {}

  private async request(path: string, init: RequestInit = {}) {
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await this.fetcher(new URL(path, this.baseUrl), {
          ...init,
          signal: controller.signal,
          headers: { api_access_token: this.token, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
        });
        if (response.ok) return response;
        if (!retryable(response.status) || attempt === this.retries) throw new ChatwootApiError(response.status, `CHATWOOT_API_${response.status}`);
        last = new ChatwootApiError(response.status, `CHATWOOT_API_${response.status}`);
      } catch (error) {
        if (error instanceof ChatwootApiError && !retryable(error.status)) throw error;
        last = error;
        if (attempt === this.retries) throw new ChatwootApiError(503, "CHATWOOT_API_RETRY_EXHAUSTED");
      } finally { clearTimeout(timeout); }
      await wait(25 * 2 ** attempt);
    }
    throw last instanceof Error ? last : new ChatwootApiError(503, "CHATWOOT_API_RETRY_EXHAUSTED");
  }

  /**
   * Chatwoot's authenticated contacts#show endpoint returns the resource as
   * `{ payload: { ...contact } }`, unlike conversations#show. Keep that
   * transport detail here so downstream CRM code always receives a contact.
   */
  async getContact(accountId: number, contactId: number) {
    const body = await this.json(await this.request(`/api/v1/accounts/${accountId}/contacts/${contactId}`));
    return this.contactFromShowResponse(body);
  }
  async getConversation(accountId: number, conversationId: number) { return this.json(await this.request(`/api/v1/accounts/${accountId}/conversations/${conversationId}`)); }
  async patchContactAttributes(accountId: number, contactId: number, customAttributes: Attributes) { return this.json(await this.request(`/api/v1/accounts/${accountId}/contacts/${contactId}`, { method: "PATCH", body: JSON.stringify({ custom_attributes: customAttributes }) })); }
  async patchConversationAttributes(accountId: number, conversationId: number, customAttributes: Attributes) { return this.json(await this.request(`/api/v1/accounts/${accountId}/conversations/${conversationId}`, { method: "PATCH", body: JSON.stringify({ custom_attributes: customAttributes }) })); }
  private contactFromShowResponse(body: JsonObject): JsonObject {
    const payload = body.payload;
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as JsonObject : body;
  }
  private async json(response: Response): Promise<JsonObject> { try { return await response.json() as JsonObject; } catch { throw new ChatwootApiError(502, "CHATWOOT_API_INVALID_JSON"); } }
}
