import assert from "node:assert/strict";
import test from "node:test";
import { LocalD1Database } from "./helpers/local-bindings.mjs";
import { CRM_DATABASE_SQL } from "../lib/crm-database.ts";
import { ChatwootApiError, ChatwootClient } from "../lib/chatwoot-client.ts";
import { processChatwootWebhookJob, syncContact, syncConversation } from "../lib/chatwoot-sync.ts";

function db() {
  const value = new LocalD1Database();
  value.sqlite.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, customer_id TEXT, status TEXT, total INTEGER, expected_payment_method TEXT, scheduled_delivery_date TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  value.sqlite.exec("CREATE TABLE order_payments (id TEXT PRIMARY KEY, order_id TEXT, amount INTEGER, payment_type TEXT, status TEXT)");
  for (const statement of CRM_DATABASE_SQL) value.sqlite.exec(statement);
  return value;
}
function client() { const calls=[]; return { calls, async patchContactAttributes(...args){calls.push(["contact",...args]);return {};}, async patchConversationAttributes(...args){calls.push(["conversation",...args]);return {};}}; }
function contact(overrides={}) { return { id: 42, name: "Cliente prueba", phone_number: "7000-0000", channel_type: "Channel::Instagram", identifier: "ig-42", custom_attributes: {}, ...overrides }; }

test("resolves and links Instagram contacts, then converges without a second PATCH", async () => {
  const value=db(), api=client(); const first=await syncContact(value,api,1,contact()); assert.equal(first.patched,true); assert.equal(api.calls.length,1);
  const customer=value.sqlite.prepare("SELECT * FROM customers").get(); assert.equal(customer.phone_normalized,"+50670000000"); assert.equal(value.sqlite.prepare("SELECT provider FROM customer_external_identities").get().provider,"instagram"); assert.equal(value.sqlite.prepare("SELECT count(*) n FROM chatwoot_contact_links").get().n,1);
  const desired=api.calls[0][3]; const second=await syncContact(value,api,1,contact({custom_attributes:desired})); assert.equal(second.patched,false); assert.equal(api.calls.length,1); value.close();
});
test("supports Messenger identity and rejects contradictory customer signals", async () => {
  const value=db(), api=client(); const one=await syncContact(value,api,1,contact({channel_type:"Channel::Facebook",identifier:"messenger-1",phone_number:"7000-0001"})); assert.ok(one.customerId);
  const another=await syncContact(value,api,1,contact({id:43,channel_type:"Channel::Facebook",identifier:"messenger-2",phone_number:"7000-0002"})); await assert.rejects(()=>syncContact(value,api,1,contact({id:44,channel_type:"Channel::Facebook",identifier:"messenger-1",phone_number:"7000-0002"})),error=>error.code==="CRM_IDENTITY_CONFLICT"); assert.ok(another.customerId); value.close();
});
test("links conversation orders many-to-many and only PATCHes changed owned attributes", async () => {
  const value=db(), api=client(); value.sqlite.prepare("INSERT INTO orders (id,status,total,expected_payment_method,scheduled_delivery_date) VALUES ('o-1','CONFIRMED',1000,'SINPE','2026-09-03')").run();
  const input={id:91,custom_attributes:{nutriplus_order_id:"o-1"}}; assert.equal((await syncConversation(value,api,1,input)).patched,true); assert.equal(api.calls.length,1);
  await syncConversation(value,api,1,{id:92,custom_attributes:{nutriplus_order_id:"o-1"}}); assert.equal(value.sqlite.prepare("SELECT count(*) n FROM chatwoot_conversation_order_links").get().n,2);
  const desired=api.calls[0][3]; assert.equal((await syncConversation(value,api,1,{id:91,custom_attributes:{...input.custom_attributes,...desired}})).patched,false); assert.equal(api.calls.length,2); value.close();
});
test("adds the validated mobile CRM link without creating a conversation-order link", async () => {
  const value=db(), api=client(); const customer=await syncContact(value,api,1,contact());
  const input={id:93,meta:{sender:{id:42}},custom_attributes:{}};
  const result=await syncConversation(value,api,1,input);
  assert.equal(result.skipped,true); assert.equal(result.patched,true);
  const desired=api.calls.at(-1)[3];
  assert.match(desired.nutriplus_crm_url,/\/operations\/crm-panel\?account_id=1&contact_id=42&conversation_id=93$/);
  assert.equal(value.sqlite.prepare("SELECT count(*) n FROM chatwoot_conversation_order_links").get().n,0);
  await syncConversation(value,api,1,{...input,custom_attributes:desired});
  assert.equal(api.calls.length,2); assert.ok(customer.customerId); value.close();
});
test("Chatwoot client retries retryable failures and classifies API errors without exposing token", async () => {
  let count=0; const fetcher=async()=>{count++;return count===1?new Response("slow",{status:429}):new Response(JSON.stringify({payload:{id:1}}),{headers:{"content-type":"application/json"}});}; const api=new ChatwootClient("https://chatwoot.test","never-log-this-token",fetcher,1); assert.equal((await api.getContact(1,1)).id,1); assert.equal(count,2);
  for (const status of [401,403,404]) { const failing=new ChatwootClient("https://chatwoot.test","never-log-this-token",async()=>new Response("x",{status}),0); await assert.rejects(()=>failing.getConversation(1,1),error=>error instanceof ChatwootApiError&&error.status===status); }
  for (const status of [500,502,503]) { const failing=new ChatwootClient("https://chatwoot.test","never-log-this-token",async()=>new Response("x",{status}),0); await assert.rejects(()=>failing.getConversation(1,1),error=>error instanceof ChatwootApiError&&error.code==="CHATWOOT_API_RETRY_EXHAUSTED"); }
});
test("Chatwoot client gets conversations, PATCHes only through the scoped endpoints, and exhausts timeout retries", async () => {
  const requests=[]; const api=new ChatwootClient("https://chatwoot.test","never-log-this-token",async (url,init)=>{requests.push([String(url),init]);return new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json"}});},0);
  await api.getConversation(1,9); await api.patchContactAttributes(1,2,{province:"Alajuela"}); await api.patchConversationAttributes(1,9,{order_status:"CONFIRMED"}); assert.equal(requests.length,3); assert.equal(requests[1][1].method,"PATCH"); assert.match(requests[1][0],/contacts\/2$/); assert.match(requests[2][0],/conversations\/9$/);
  let attempts=0; const timeout=new ChatwootClient("https://chatwoot.test","never-log-this-token",async()=>{attempts++;throw new DOMException("timeout","AbortError");},1); await assert.rejects(()=>timeout.getContact(1,2),error=>error instanceof ChatwootApiError&&error.code==="CHATWOOT_API_RETRY_EXHAUSTED"); assert.equal(attempts,2);
});
test("creates an identity-only customer and refuses a contact without an identity signal", async () => {
  const value=db(), api=client(); const identityOnly=await syncContact(value,api,1,contact({id:88,phone_number:"",identifier:"ig-only"})); assert.ok(identityOnly.customerId); const skipped=await syncContact(value,api,1,contact({id:89,phone_number:"",identifier:"",channel_type:""})); assert.deepEqual(skipped,{skipped:true,reason:"INSUFFICIENT_IDENTITY"}); value.close();
});
test("outbox processing reloads the canonical Chatwoot contact instead of retaining webhook content", async () => {
  const value = db(), api = client(); let fetched = 0;
  api.getContact = async () => { fetched++; return contact({ custom_attributes: {} }); };
  await processChatwootWebhookJob(value, api, {
    id: "job-1", deliveryId: "delivery-1", eventType: "contact_updated", accountId: 1,
    contactId: 42, conversationId: null, status: "processing", attempts: 1, leaseToken: "lease",
  });
  assert.equal(fetched, 1); assert.equal(api.calls.length, 1);
  value.close();
});

test("outbox processing unwraps the Chatwoot 4.17 contacts#show payload before syncing", async () => {
  const value = db(); const requests = [];
  const api = new ChatwootClient("https://chatwoot.test", "never-log-this-token", async (url, init) => {
    requests.push([String(url), init]);
    if (String(url).endsWith("/contacts/42")) return new Response(JSON.stringify({ payload: contact({ custom_attributes: {} }) }), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } });
  }, 0);
  await processChatwootWebhookJob(value, api, {
    id: "job-envelope", deliveryId: "delivery-envelope", eventType: "contact_updated", accountId: 1,
    contactId: 42, conversationId: null, status: "processing", attempts: 1, leaseToken: "lease",
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0][0], /contacts\/42$/);
  assert.equal(requests[1][1].method, "PATCH");
  value.close();
});

test("supports the real Chatwoot 4.17 contact_inboxes identity shape", async () => {
  const value = db(), api = client();
  const result = await syncContact(value, api, 1, {
    id: 143,
    name: "Cliente Instagram real",
    phone_number: "",
    identifier: "",
    custom_attributes: {},
    contact_inboxes: [
      {
        source_id: "1626090009237784",
        inbox: {
          channel_type: "Channel::Instagram",
        },
      },
    ],
  });

  assert.ok(result.customerId);
  assert.equal(
    value.sqlite.prepare("SELECT provider FROM customer_external_identities").get().provider,
    "instagram",
  );
  assert.equal(
    value.sqlite.prepare("SELECT count(*) n FROM chatwoot_contact_links").get().n,
    1,
  );
  value.close();
});
