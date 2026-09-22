import assert from "node:assert/strict";
import test from "node:test";

import {
  META_CAPI_DATASET_ID,
  META_CAPI_INSTAGRAM_ACCOUNT_ID,
  META_CAPI_PAGE_ID,
  MetaCapiClient,
  MetaCapiError,
  buildMetaCapiPayload,
  resolveMetaMessagingIdentity,
} from "../lib/meta-capi.ts";

function job(overrides = {}) {
  return {
    id: "job-1",
    dedupeKey: "lead:1:75",
    eventId: "np-lead-1-75",
    eventName: "LeadSubmitted",
    eventTime: "2026-09-20T00:00:00.000Z",
    orderId: "order-1",
    orderNumber: null,
    valueCrc: null,
    accountId: 1,
    conversationId: 75,
    status: "processing",
    attempts: 1,
    leaseToken: "lease-1",
    ...overrides,
  };
}

test("resolves exact Messenger identity from the conversation inbox", async () => {
  const client = {
    async getConversation() {
      return {
        id: 75,
        inbox_id: 9,
        meta: { sender: { id: 37 } },
      };
    },
    async getContact() {
      return {
        id: 37,
        contact_inboxes: [
          {
            inbox_id: 8,
            source_id: "wrong-source",
            inbox: {
              id: 8,
              channel_type: "Channel::Instagram",
            },
          },
          {
            inbox_id: 9,
            source_id: "8902244863153351",
            inbox: {
              id: 9,
              channel_type: "Channel::FacebookPage",
            },
          },
        ],
      };
    },
  };

  assert.deepEqual(
    await resolveMetaMessagingIdentity(
      client,
      1,
      75,
    ),
    {
      messagingChannel: "messenger",
      userData: {
        page_id: META_CAPI_PAGE_ID,
        page_scoped_user_id: "8902244863153351",
      },
    },
  );
});

test("resolves exact Instagram identity from the conversation inbox", async () => {
  const client = {
    async getConversation() {
      return {
        id: 147,
        inbox: { id: 2 },
        meta: { sender: { id: 52 } },
      };
    },
    async getContact() {
      return {
        id: 52,
        contact_inboxes: [
          {
            inbox: {
              id: 2,
              channel_type: "Channel::Instagram",
            },
            source_id: "2149998669248187",
          },
        ],
      };
    },
  };

  assert.deepEqual(
    await resolveMetaMessagingIdentity(
      client,
      1,
      147,
    ),
    {
      messagingChannel: "instagram",
      userData: {
        ig_account_id:
          META_CAPI_INSTAGRAM_ACCOUNT_ID,
        ig_sid: "2149998669248187",
      },
    },
  );
});

test("does not choose an arbitrary external identity when conversation inbox is absent", async () => {
  const client = {
    async getConversation() {
      return {
        id: 75,
        meta: { sender: { id: 37 } },
      };
    },
    async getContact() {
      throw new Error(
        "contact must not be fetched",
      );
    },
  };

  await assert.rejects(
    () =>
      resolveMetaMessagingIdentity(
        client,
        1,
        75,
      ),
    (error) =>
      error instanceof MetaCapiError &&
      error.code ===
        "META_CAPI_CONVERSATION_IDENTITY_MISSING",
  );
});

test("LeadSubmitted payload contains messaging identity but no purchase custom_data", () => {
  const payload = buildMetaCapiPayload(
    job(),
    {
      messagingChannel: "messenger",
      userData: {
        page_id: META_CAPI_PAGE_ID,
        page_scoped_user_id: "psid-1",
      },
    },
  );

  const event = payload.data[0];

  assert.equal(
    event.event_name,
    "LeadSubmitted",
  );
  assert.equal(
    event.action_source,
    "business_messaging",
  );
  assert.equal(
    event.messaging_channel,
    "messenger",
  );
  assert.equal(
    Object.hasOwn(event, "custom_data"),
    false,
  );
});

test("Purchase payload contains CRC value and order identifier", () => {
  const payload = buildMetaCapiPayload(
    job({
      eventName: "Purchase",
      eventId: "np-purchase-order-1",
      orderNumber: "NP-0001",
      valueCrc: 23100,
    }),
    {
      messagingChannel: "instagram",
      userData: {
        ig_account_id:
          META_CAPI_INSTAGRAM_ACCOUNT_ID,
        ig_sid: "ig-user-1",
      },
    },
  );

  assert.deepEqual(
    payload.data[0].custom_data,
    {
      currency: "CRC",
      value: 23100,
      order_id: "NP-0001",
    },
  );
});

test("client posts only to canonical dataset endpoint using bearer auth", async () => {
  let capturedUrl;
  let capturedInit;

  const fakeFetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;

    return new Response(
      JSON.stringify({
        events_received: 1,
        messages: [],
        fbtrace_id: "test-trace",
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  };

  const client = new MetaCapiClient(
    "secret-test-token",
    fakeFetch,
  );

  await client.send(
    job(),
    {
      messagingChannel: "messenger",
      userData: {
        page_id: META_CAPI_PAGE_ID,
        page_scoped_user_id: "psid-1",
      },
    },
  );

  assert.equal(
    capturedUrl,
    `https://graph.facebook.com/v26.0/${META_CAPI_DATASET_ID}/events`,
  );

  assert.equal(
    capturedInit.method,
    "POST",
  );

  assert.equal(
    capturedInit.headers.authorization,
    "Bearer secret-test-token",
  );

  const body = JSON.parse(
    capturedInit.body,
  );

  assert.equal(
    body.data[0].event_name,
    "LeadSubmitted",
  );

  assert.equal(
    JSON.stringify(body).includes(
      "secret-test-token",
    ),
    false,
  );
});

test("Meta HTTP error exposes only a sanitized code, not response body", async () => {
  const fakeFetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          message:
            "access_token=super-secret",
        },
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
        },
      },
    );

  const client = new MetaCapiClient(
    "another-secret-token",
    fakeFetch,
  );

  await assert.rejects(
    () =>
      client.send(
        job(),
        {
          messagingChannel: "messenger",
          userData: {
            page_id: META_CAPI_PAGE_ID,
            page_scoped_user_id: "psid-1",
          },
        },
      ),
    (error) => {
      assert.ok(
        error instanceof MetaCapiError,
      );
      assert.equal(
        error.code,
        "META_CAPI_HTTP_401",
      );
      assert.equal(
        error.message.includes(
          "super-secret",
        ),
        false,
      );
      return true;
    },
  );
});
