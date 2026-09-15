import assert from "node:assert/strict";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const DB=new LocalD1Database(); let patched=0, conversationAttributes={}; const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,init={})=>{if(String(url).startsWith("https://chatwoot.test/api/v1/accounts/1/conversations/900")){if((init.method||"GET")==="POST"){patched++;conversationAttributes=JSON.parse(init.body).custom_attributes;return Response.json({});}return Response.json({id:900,meta:{sender:{id:77}},custom_attributes:conversationAttributes});}throw new Error(`unexpected external fetch ${url}`);};
const url=new URL("../dist/server/index.js",import.meta.url);url.searchParams.set("mobile",Date.now());const {default:worker}=await import(url.href);
const env={DB,NUTRIPLUS_APP_AUTH_MODE:"disabled",CHATWOOT_BASE_URL:"https://chatwoot.test",CHATWOOT_API_TOKEN:"test-token",ASSETS:{fetch:async()=>new Response("Not found",{status:404})},IMAGES:{input(){throw new Error("unused");}}};const ctx={waitUntil(){},passThroughOnException(){}};
async function call(path,init={}){const r=await worker.fetch(new Request(`http://local.test${path}`,{...init,headers:{accept:"application/json",...(init.body?{"content-type":"application/json"}:{}),...(init.headers||{})}}),env,ctx);return {r,b:await r.json()};}
const agent={"oai-authenticated-user-email":"agent@nutriplus.test"};
await call("/api/settings");
const customer="cust-mobile";await DB.prepare("INSERT INTO customers(id,name,phone_raw,phone_normalized,customer_status,created_at,updated_at) VALUES(?,?,?,?,'ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(customer,"Cliente móvil","+50670000000","+50670000000").run();await DB.prepare("INSERT INTO chatwoot_contact_links(id,chatwoot_account_id,chatwoot_contact_id,customer_id,created_at,updated_at) VALUES('link-mobile',1,77,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(customer).run();
async function product(name,code,qty){const x=await call("/api/products",{method:"POST",headers:agent,body:JSON.stringify({name,code,purchasePriceUsd:10,weightLb:.5,quantityAvailable:qty})});assert.equal(x.r.status,201,JSON.stringify(x.b));return x.b.product;}
const stocked=await product("Móvil Stock","MOB-STOCK",1);await product("Móvil Agotado","MOB-EMPTY",0);const last=await product("Móvil Última","MOB-LAST",1);
let result=await call("/api/operations/crm-panel/products?account_id=1&contact_id=77&q=MOB-STOCK",{headers:agent});assert.equal(result.r.status,200);assert.equal(result.b.products[0].availability,"AVAILABLE");assert.equal("purchasePriceUsd" in result.b.products[0],false);
result=await call("/api/operations/crm-panel/products?account_id=1&contact_id=77&q=MOB-EMPTY",{headers:agent});assert.equal(result.b.products[0].availability,"OUT_OF_STOCK");
await DB.prepare("UPDATE products SET brand=?, presentation=? WHERE id=?").bind("Marca Buscable","60 cápsulas",stocked.id).run();
result=await call(`/api/operations/crm-panel/products?account_id=1&contact_id=77&q=${encodeURIComponent("Marca Buscable")}`,{headers:agent});
assert.equal(result.r.status,200);assert.equal(result.b.products[0].id,stocked.id);assert.equal(result.b.products[0].brand,"Marca Buscable");
result=await call(`/api/operations/crm-panel/products?account_id=1&contact_id=77&q=${encodeURIComponent("60 cápsulas")}`,{headers:agent});
assert.equal(result.r.status,200);assert.equal(result.b.products[0].id,stocked.id);

await DB.prepare("UPDATE products SET purchase_price_usd_cents=NULL WHERE code=?").bind("MOB-EMPTY").run();
result=await call(`/api/operations/crm-panel/products?account_id=1&contact_id=77&q=${encodeURIComponent("Móvil")}`,{headers:agent});
assert.equal(result.r.status,200,JSON.stringify(result.b));
assert.equal(result.b.products.some((item)=>item.code==="MOB-STOCK"),true);
const unavailable=result.b.products.find((item)=>item.code==="MOB-EMPTY");
assert.ok(unavailable);
assert.equal(unavailable.commercialPrice,null);
assert.equal(unavailable.availability,"PRICE_UNAVAILABLE");

const quote=await call("/api/quotes",{method:"POST",headers:agent,body:JSON.stringify({name:"Encargo móvil",code:"MOB-SPECIAL",purchasePriceUsd:12,weightLb:.5})});assert.equal(quote.r.status,201,JSON.stringify(quote.b));
async function draft(operationId,lines,extra={}){const {conversation_id,...payloadExtra}=extra;const query=new URLSearchParams({account_id:"1",contact_id:"77",...(conversation_id?{conversation_id:String(conversation_id)}:{})});return call(`/api/operations/crm-panel/orders?${query}`,{method:"POST",headers:agent,body:JSON.stringify({operationId,deliveryAddress:"Dirección prueba",expectedPaymentMethod:"SINPE",lines,...payloadExtra})});}
let created=await draft("mobile-order-1",[{id:stocked.id,kind:"INVENTORY",quantity:1,unitPriceSold:1,total:1,discountAmount:0}],{customerId:"other"});assert.equal(created.r.status,201,JSON.stringify(created.b));assert.equal(created.b.order.customerId,customer);assert.notEqual(created.b.order.lines[0].unitPriceSold,1);
let replay=await draft("mobile-order-1",[{id:stocked.id,kind:"INVENTORY",quantity:1}]);assert.equal(replay.r.status,200);assert.equal(replay.b.idempotent,true);
let conflict=await draft("mobile-order-1",[{id:stocked.id,kind:"INVENTORY",quantity:2}]);assert.equal(conflict.r.status,409);
let special=await draft("mobile-special-1",[{id:quote.b.quote.id,kind:"SPECIAL_ORDER",quantity:2}],{conversation_id:900});assert.equal(special.r.status,201,JSON.stringify(special.b));assert.equal(special.b.order.orderType,"SPECIAL_ORDER");assert.equal(patched,1);
let mixed=await draft("mobile-mixed-1",[{id:stocked.id,kind:"INVENTORY",quantity:1},{id:quote.b.quote.id,kind:"SPECIAL_ORDER",quantity:1}]);assert.equal(mixed.r.status,409);
const c1=await draft("mobile-last-1",[{id:last.id,kind:"INVENTORY",quantity:1}]);const c2=await draft("mobile-last-2",[{id:last.id,kind:"INVENTORY",quantity:1}]);assert.equal(c1.r.status,201);assert.equal(c2.r.status,201);
const confirms=await Promise.all([c1.b.order,c2.b.order].map(o=>call(`/api/orders/${o.id}/confirm`,{method:"POST",headers:agent,body:JSON.stringify({operationId:`confirm-${o.id}`,version:o.version})})));assert.deepEqual(confirms.map(x=>x.r.status).sort(),[200,409]);assert.equal(Number((await DB.prepare("SELECT quantity_available FROM products WHERE id=?").bind(last.id).first()).quantity_available),0);
assert.equal(Number((await DB.prepare("SELECT COUNT(*) c FROM chatwoot_conversation_order_links WHERE chatwoot_account_id=1 AND chatwoot_conversation_id=900").first()).c),1);
const denied=await call("/api/operations/crm-panel/products?q=x");assert.equal(denied.r.status,401);
globalThis.fetch=originalFetch; console.log("CRM mobile product search, secure draft creation, idempotency, Chatwoot links and stock concurrency pass locally");
