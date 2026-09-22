import type { MetaCapiJob } from "./meta-capi-outbox";

export const META_CAPI_DATASET_ID = "1975546549785142";
export const META_CAPI_PAGE_ID = "480150175175392";
export const META_CAPI_INSTAGRAM_ACCOUNT_ID = "17841470137882723";
export const META_CAPI_GRAPH_VERSION = "v26.0";

type JsonObject = Record<string, unknown>;

export type MetaMessagingIdentity =
  | {
      messagingChannel: "messenger";
      userData: {
        page_id: string;
        page_scoped_user_id: string;
      };
    }
  | {
      messagingChannel: "instagram";
      userData: {
        ig_account_id: string;
        ig_sid: string;
      };
    };

export type MetaCapiChatwootClient = {
  getConversation(
    accountId: number,
    conversationId: number,
  ): Promise<JsonObject>;

  getContact(
    accountId: number,
    contactId: number,
  ): Promise<JsonObject>;
};

export class MetaCapiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly terminal: boolean;

  constructor(
    code: string,
    status = 0,
    terminal = false,
  ) {
    super(code);
    this.name = "MetaCapiError";
    this.code = code;
    this.status = status;
    this.terminal = terminal;
  }
}

function record(value: unknown): JsonObject {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerForChannel(value: unknown): "messenger" | "instagram" | null {
  const channel = nonEmptyString(value).toLowerCase();

  if (channel.includes("instagram")) return "instagram";

  if (
    channel.includes("facebook") ||
    channel.includes("messenger")
  ) {
    return "messenger";
  }

  return null;
}

function conversationInboxId(conversation: JsonObject): number | null {
  return (
    positiveInteger(conversation.inbox_id) ??
    positiveInteger(record(conversation.inbox).id)
  );
}

function conversationContactId(conversation: JsonObject): number | null {
  const meta = record(conversation.meta);
  const sender = record(meta.sender);

  return (
    positiveInteger(sender.id) ??
    positiveInteger(record(conversation.contact).id) ??
    positiveInteger(conversation.contact_id)
  );
}

function contactInboxCandidates(contact: JsonObject): JsonObject[] {
  const candidates: JsonObject[] = [];

  const singular = record(contact.contact_inbox);
  if (Object.keys(singular).length) candidates.push(singular);

  if (Array.isArray(contact.contact_inboxes)) {
    for (const item of contact.contact_inboxes) {
      const candidate = record(item);
      if (Object.keys(candidate).length) candidates.push(candidate);
    }
  }

  return candidates;
}

function contactInboxId(candidate: JsonObject): number | null {
  return (
    positiveInteger(candidate.inbox_id) ??
    positiveInteger(record(candidate.inbox).id)
  );
}

function contactInboxProvider(
  candidate: JsonObject,
  conversation: JsonObject,
): "messenger" | "instagram" | null {
  return (
    providerForChannel(candidate.channel_type) ??
    providerForChannel(record(candidate.inbox).channel_type) ??
    providerForChannel(conversation.channel_type) ??
    providerForChannel(record(conversation.inbox).channel_type)
  );
}

export async function resolveMetaMessagingIdentity(
  client: MetaCapiChatwootClient,
  accountId: number,
  conversationId: number,
): Promise<MetaMessagingIdentity> {
  const conversation = await client.getConversation(
    accountId,
    conversationId,
  );

  const inboxId = conversationInboxId(conversation);
  const contactId = conversationContactId(conversation);

  if (!inboxId || !contactId) {
    throw new MetaCapiError(
      "META_CAPI_CONVERSATION_IDENTITY_MISSING",
    );
  }

  const contact = await client.getContact(accountId, contactId);

  const matched = contactInboxCandidates(contact).find(
    (candidate) => contactInboxId(candidate) === inboxId,
  );

  if (!matched) {
    throw new MetaCapiError(
      "META_CAPI_CONTACT_INBOX_NOT_FOUND",
    );
  }

  const sourceId = nonEmptyString(matched.source_id);
  const provider = contactInboxProvider(
    matched,
    conversation,
  );

  if (!sourceId) {
    throw new MetaCapiError(
      "META_CAPI_SOURCE_ID_MISSING",
    );
  }

  if (provider === "instagram") {
    return {
      messagingChannel: "instagram",
      userData: {
        ig_account_id:
          META_CAPI_INSTAGRAM_ACCOUNT_ID,
        ig_sid: sourceId,
      },
    };
  }

  if (provider === "messenger") {
    return {
      messagingChannel: "messenger",
      userData: {
        page_id: META_CAPI_PAGE_ID,
        page_scoped_user_id: sourceId,
      },
    };
  }

  throw new MetaCapiError(
    "META_CAPI_MESSAGING_CHANNEL_UNSUPPORTED",
    0,
    true,
  );
}

function eventTimeSeconds(value: string): number {
  const milliseconds = Date.parse(value);
  const seconds = Math.floor(milliseconds / 1000);

  if (
    !Number.isFinite(milliseconds) ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0
  ) {
    throw new MetaCapiError(
      "META_CAPI_EVENT_TIME_INVALID",
    );
  }

  return seconds;
}

export function buildMetaCapiPayload(
  job: MetaCapiJob,
  identity: MetaMessagingIdentity,
) {
  const event: Record<string, unknown> = {
    event_name: job.eventName,
    event_time: eventTimeSeconds(job.eventTime),
    event_id: job.eventId,
    action_source: "business_messaging",
    messaging_channel: identity.messagingChannel,
    user_data: identity.userData,
  };

  if (job.eventName === "Purchase") {
    if (
      !job.orderNumber ||
      job.valueCrc == null ||
      !Number.isFinite(job.valueCrc) ||
      job.valueCrc < 0
    ) {
      throw new MetaCapiError(
        "META_CAPI_PURCHASE_DATA_INVALID",
      );
    }

    event.custom_data = {
      currency: "CRC",
      value: job.valueCrc,
      order_id: job.orderNumber,
    };
  }

  return { data: [event] };
}

export class MetaCapiClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async send(
    job: MetaCapiJob,
    identity: MetaMessagingIdentity,
  ) {
    if (!this.accessToken.trim()) {
      throw new MetaCapiError(
        "META_CAPI_ACCESS_TOKEN_MISSING",
      );
    }

    const response = await this.fetchImplementation(
      `https://graph.facebook.com/${META_CAPI_GRAPH_VERSION}/${META_CAPI_DATASET_ID}/events`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(
          buildMetaCapiPayload(job, identity),
        ),
      },
    );

    if (!response.ok) {
      throw new MetaCapiError(
        `META_CAPI_HTTP_${response.status}`,
        response.status,
      );
    }

    let body: JsonObject;

    try {
      body = (await response.json()) as JsonObject;
    } catch {
      throw new MetaCapiError(
        "META_CAPI_RESPONSE_INVALID_JSON",
        502,
      );
    }

    if (Number(body.events_received) < 1) {
      throw new MetaCapiError(
        "META_CAPI_EVENT_NOT_RECEIVED",
        502,
      );
    }

    return body;
  }
}

export async function processMetaCapiJob(
  metaClient: MetaCapiClient,
  chatwootClient: MetaCapiChatwootClient,
  job: MetaCapiJob,
) {
  const identity = await resolveMetaMessagingIdentity(
    chatwootClient,
    job.accountId,
    job.conversationId,
  );

  return metaClient.send(job, identity);
}
