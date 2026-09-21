import assert from "node:assert/strict";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const DB = new LocalD1Database();
const originalFetch = globalThis.fetch;

let conversationAttributes = {};

globalThis.fetch = async (url, init = {}) => {
  const value = String(url);

  if (
    value.startsWith(
      "https://chatwoot.test/api/v1/accounts/1/conversations/900",
    )
  ) {
    if ((init.method || "GET") === "PATCH" || (init.method || "GET") === "POST") {
      const parsed = init.body ? JSON.parse(init.body) : {};
      if (parsed.custom_attributes) {
        conversationAttributes = {
          ...conversationAttributes,
          ...parsed.custom_attributes,
        };
      }
      return Response.json({});
    }

    return Response.json({
      id: 900,
      inbox_id: 2,
      meta: { sender: { id: 77 } },
      custom_attributes: conversationAttributes,
    });
  }

  throw new Error(`unexpected external fetch ${value}`);
};

const url = new URL("../dist/server/index.js", import.meta.url);
url.searchParams.set("meta-capi-orders", `${Date.now()}`);

const { default: worker } = await import(url.href);

const env = {
  DB,
  NUTRIPLUS_APP_AUTH_MODE: "disabled",
  CHATWOOT_BASE_URL: "https://chatwoot.test",
  CHATWOOT_API_TOKEN: "test-token",
  ASSETS: {
    fetch: async () =>
      new Response("Not found", { status: 404 }),
  },
  IMAGES: {
    input() {
      throw new Error("unused");
    },
  },
};

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
};

const agent = {
  "oai-authenticated-user-email": "agent@nutriplus.test",
};

async function call(path, init = {}) {
  const response = await worker.fetch(
    new Request(`http://local.test${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body
          ? { "content-type": "application/json" }
          : {}),
        ...(init.headers || {}),
      },
    }),
    env,
    ctx,
  );

  const body = await response.json();
  return { response, body };
}

await call("/api/settings");

const customerId = "cust-meta-capi";

await DB.prepare(`
  INSERT INTO customers (
    id,
    name,
    phone_raw,
    phone_normalized,
    customer_status,
    created_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`)
  .bind(
    customerId,
    "Cliente CAPI",
    "+50670001111",
    "+50670001111",
  )
  .run();

await DB.prepare(`
  INSERT INTO chatwoot_contact_links (
    id,
    chatwoot_account_id,
    chatwoot_contact_id,
    customer_id,
    created_at,
    updated_at
  )
  VALUES ('link-meta-capi', 1, 77, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`)
  .bind(customerId)
  .run();

async function product(name, code, quantity) {
  const result = await call("/api/products", {
    method: "POST",
    headers: agent,
    body: JSON.stringify({
      name,
      code,
      purchasePriceUsd: 10,
      weightLb: 0.5,
      quantityAvailable: quantity,
    }),
  });

  assert.equal(
    result.response.status,
    201,
    JSON.stringify(result.body),
  );

  return result.body.product;
}

async function draft(operationId, product, quantity, conversationId = 900) {
  const params = new URLSearchParams({
    account_id: "1",
    contact_id: "77",
  });

  if (conversationId != null) {
    params.set("conversation_id", String(conversationId));
  }

  const result = await call(
    `/api/operations/crm-panel/orders?${params}`,
    {
      method: "POST",
      headers: agent,
      body: JSON.stringify({
        operationId,
        deliveryAddress: "Dirección prueba CAPI",
        expectedPaymentMethod: "SINPE",
        lines: [
          {
            id: product.id,
            kind: "INVENTORY",
            quantity,
          },
        ],
      }),
    },
  );

  assert.equal(
    result.response.status,
    201,
    JSON.stringify(result.body),
  );

  return result.body.order;
}

async function confirm(order, suffix) {
  const result = await call(`/api/orders/${order.id}/confirm`, {
    method: "POST",
    headers: agent,
    body: JSON.stringify({
      operationId: `confirm-${suffix}`,
      version: order.version,
    }),
  });

  assert.equal(
    result.response.status,
    200,
    JSON.stringify(result.body),
  );

  return result.body.order;
}

async function prepare(order, suffix) {
  const result = await call(`/api/orders/${order.id}/prepare`, {
    method: "POST",
    headers: agent,
    body: JSON.stringify({
      operationId: `prepare-${suffix}`,
      version: order.version,
    }),
  });

  assert.equal(
    result.response.status,
    200,
    JSON.stringify(result.body),
  );

  return result.body.order;
}

async function purchaseCount(orderId) {
  const row = await DB.prepare(`
    SELECT COUNT(*) AS total
    FROM meta_capi_jobs
    WHERE order_id=?
      AND event_name='Purchase'
  `)
    .bind(orderId)
    .first();

  return Number(row.total);
}

/* ---------------------------------------------------------
 * 1. Full delivery + Chatwoot conversation => one Purchase
 * --------------------------------------------------------- */
const fullProduct = await product(
  "CAPI entrega completa",
  "CAPI-FULL",
  1,
);

let full = await draft(
  "capi-full-create",
  fullProduct,
  1,
  900,
);

full = await confirm(full, "capi-full");
full = await prepare(full, "capi-full");

const deliverPayload = {
  operationId: "deliver-capi-full",
  version: full.version,
};

let delivered = await call(`/api/orders/${full.id}/deliver`, {
  method: "POST",
  headers: agent,
  body: JSON.stringify(deliverPayload),
});

assert.equal(
  delivered.response.status,
  200,
  JSON.stringify(delivered.body),
);
assert.equal(delivered.body.order.status, "DELIVERED");
assert.equal(await purchaseCount(full.id), 1);

let job = await DB.prepare(`
  SELECT *
  FROM meta_capi_jobs
  WHERE order_id=?
`)
  .bind(full.id)
  .first();

assert.equal(job.event_name, "Purchase");
assert.equal(job.dedupe_key, `purchase:${full.id}`);
assert.equal(job.event_id, `np-purchase-${full.id}`);
assert.equal(job.order_number, full.orderNumber);
assert.equal(Number(job.value_crc), Number(full.total));
assert.equal(Number(job.chatwoot_account_id), 1);
assert.equal(Number(job.chatwoot_conversation_id), 900);

const replay = await call(`/api/orders/${full.id}/deliver`, {
  method: "POST",
  headers: agent,
  body: JSON.stringify(deliverPayload),
});

assert.equal(replay.response.status, 200);
assert.equal(replay.body.idempotent, true);
assert.equal(await purchaseCount(full.id), 1);

/* ---------------------------------------------------------
 * 2. Partial fulfillment => no Purchase until final delivery
 * --------------------------------------------------------- */
const partialProduct = await product(
  "CAPI entrega parcial",
  "CAPI-PARTIAL",
  2,
);

let partial = await draft(
  "capi-partial-create",
  partialProduct,
  2,
  900,
);

partial = await confirm(partial, "capi-partial");
partial = await prepare(partial, "capi-partial");

const lineId = partial.lines[0].id;

let firstFulfillment = await call(
  `/api/orders/${partial.id}/fulfillments`,
  {
    method: "POST",
    headers: agent,
    body: JSON.stringify({
      operationId: "fulfill-capi-partial-1",
      version: partial.version,
      lines: [
        {
          orderLineId: lineId,
          quantity: 1,
        },
      ],
    }),
  },
);

assert.equal(
  firstFulfillment.response.status,
  200,
  JSON.stringify(firstFulfillment.body),
);
assert.equal(firstFulfillment.body.order.status, "PREPARED");
assert.equal(await purchaseCount(partial.id), 0);

partial = firstFulfillment.body.order;

const finalFulfillment = await call(
  `/api/orders/${partial.id}/fulfillments`,
  {
    method: "POST",
    headers: agent,
    body: JSON.stringify({
      operationId: "fulfill-capi-partial-2",
      version: partial.version,
      lines: [
        {
          orderLineId: lineId,
          quantity: 1,
        },
      ],
    }),
  },
);

assert.equal(
  finalFulfillment.response.status,
  200,
  JSON.stringify(finalFulfillment.body),
);
assert.equal(finalFulfillment.body.order.status, "DELIVERED");
assert.equal(await purchaseCount(partial.id), 1);

/* ---------------------------------------------------------
 * 3. Delivered order without conversation => no Purchase
 * --------------------------------------------------------- */
const manualProduct = await product(
  "CAPI sin conversación",
  "CAPI-NO-CONV",
  1,
);

let noConversation = await draft(
  "capi-no-conv-create",
  manualProduct,
  1,
  null,
);

noConversation = await confirm(
  noConversation,
  "capi-no-conv",
);
noConversation = await prepare(
  noConversation,
  "capi-no-conv",
);

const noConversationDelivered = await call(
  `/api/orders/${noConversation.id}/deliver`,
  {
    method: "POST",
    headers: agent,
    body: JSON.stringify({
      operationId: "deliver-capi-no-conv",
      version: noConversation.version,
    }),
  },
);

assert.equal(
  noConversationDelivered.response.status,
  200,
  JSON.stringify(noConversationDelivered.body),
);
assert.equal(
  noConversationDelivered.body.order.status,
  "DELIVERED",
);
assert.equal(
  await purchaseCount(noConversation.id),
  0,
);

globalThis.fetch = originalFetch;

console.log(
  "Meta CAPI Purchase hooks: full delivery, partial completion, idempotency and no-conversation filtering pass locally",
);
