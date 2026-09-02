import { CrmError } from "./crm";

const encoder = new TextEncoder();
async function sha256(value: string) { const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value)); return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2,"0")).join(""); }
async function hmac(secret: string, value: string) { const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]); const bytes=await crypto.subtle.sign("HMAC",key,encoder.encode(value)); return [...new Uint8Array(bytes)].map((byte)=>byte.toString(16).padStart(2,"0")).join(""); }
function safeEqual(a:string,b:string) { if(a.length!==b.length)return false; let diff=0; for(let i=0;i<a.length;i++) diff|=a.charCodeAt(i)^b.charCodeAt(i); return diff===0; }
export async function authenticateCrmRequest(request: Request, body: string) {
  const serviceId=request.headers.get("x-nutriplus-service-id")??""; const timestamp=request.headers.get("x-nutriplus-timestamp")??""; const requestId=request.headers.get("x-nutriplus-request-id")??""; const signature=request.headers.get("x-nutriplus-signature")??"";
  const expectedId=globalThis.__NUTRIPLUS_CRM_SERVICE_ID__; const secret=globalThis.__NUTRIPLUS_CRM_SERVICE_SECRET__;
  if(!expectedId || !secret) throw new CrmError("El servicio CRM no está configurado.",503,"CRM_SERVICE_NOT_CONFIGURED");
  const timestampNumber=Number(timestamp); if(!serviceId||!signature||!requestId||!Number.isInteger(timestampNumber)||Math.abs(Date.now()-timestampNumber*1000)>300000) throw new CrmError("Autenticación de servicio inválida o expirada.",401,"CRM_AUTH_INVALID");
  if(serviceId!==expectedId) throw new CrmError("Servicio no autorizado.",403,"CRM_SERVICE_FORBIDDEN");
  if(!/^[A-Za-z0-9_-]{8,160}$/.test(requestId)) throw new CrmError("request ID inválido.",401,"CRM_AUTH_INVALID");
  const path=new URL(request.url).pathname; const canonical=`${request.method.toUpperCase()}\n${path}\n${timestamp}\n${requestId}\n${await sha256(body)}`; const expected=await hmac(secret,canonical);
  if(!safeEqual(signature.toLowerCase(),expected)) throw new CrmError("Firma de servicio inválida.",401,"CRM_SIGNATURE_INVALID");
  return { requestId };
}
