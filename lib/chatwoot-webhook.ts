export class ChatwootWebhookError extends Error { constructor(readonly status:number, readonly code:string){super(code);} }
const encoder=new TextEncoder();
const hex=(bytes:ArrayBuffer)=>[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
const equal=(a:string,b:string)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;};
async function sign(secret:string,value:string){const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return `sha256=${hex(await crypto.subtle.sign("HMAC",key,encoder.encode(value)))}`;}
export async function verifyChatwootWebhook(request:Request,raw:string,secret:string,now=Date.now()){
 if(!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))throw new ChatwootWebhookError(415,"CHATWOOT_CONTENT_TYPE_INVALID");
 if(raw.length>262144)throw new ChatwootWebhookError(413,"CHATWOOT_PAYLOAD_TOO_LARGE"); const ts=request.headers.get("x-chatwoot-timestamp")??"";const supplied=request.headers.get("x-chatwoot-signature")??"";const seconds=Number(ts);
 if(!Number.isInteger(seconds)||Math.abs(now-seconds*1000)>300000)throw new ChatwootWebhookError(401,"CHATWOOT_TIMESTAMP_INVALID");
 if(!equal(supplied,await sign(secret,`${ts}.${raw}`)))throw new ChatwootWebhookError(401,"CHATWOOT_SIGNATURE_INVALID");
 let payload:Record<string,unknown>;try{payload=JSON.parse(raw);}catch{throw new ChatwootWebhookError(400,"CHATWOOT_JSON_INVALID");}
 const event=typeof payload.event==="string"?payload.event:"";const supported=new Set(["contact_created","contact_updated","conversation_created","conversation_updated"]); const account=payload.account&&typeof payload.account==="object"?(payload.account as Record<string,unknown>).id:""; const delivery=request.headers.get("x-chatwoot-delivery")||`fallback-${await sha(`${event}|${String(account)}|${raw}`)}`;
 return {payload,event,supported:supported.has(event),delivery};
}
export async function claimChatwootDelivery(db:D1Database,key:string){
 await db.prepare("DELETE FROM crm_operations WHERE operation_type='CHATWOOT_WEBHOOK' AND created_at < datetime('now','-7 days')").run();
 try{await db.prepare("INSERT INTO crm_operations (operation_id,operation_type,request_hash,status) VALUES (?, 'CHATWOOT_WEBHOOK', ?, 'COMPLETED')").bind(`chatwoot-${key}`,key).run();return true;}catch{return false;}
}
export async function releaseChatwootDelivery(db:D1Database,key:string){
 await db.prepare("DELETE FROM crm_operations WHERE operation_id=? AND operation_type='CHATWOOT_WEBHOOK'").bind(`chatwoot-${key}`).run();
}
async function sha(value:string){return hex(await crypto.subtle.digest("SHA-256",encoder.encode(value)));}
