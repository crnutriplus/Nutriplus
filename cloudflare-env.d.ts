declare global {
  var __NUTRIPLUS_DB__: D1Database | undefined;
  var __NUTRIPLUS_BUCKET__: R2Bucket | undefined;
  var __NUTRIPLUS_OPENAI_API_KEY__: string | undefined;
  var __NUTRIPLUS_INVOICE_AI_ENABLED__: string | undefined;
  var __NUTRIPLUS_INVOICE_AI_MODEL__: string | undefined;
  var __NUTRIPLUS_INVOICE_AI_MONTHLY_LIMIT_USD__: string | undefined;
  var __NUTRIPLUS_INVOICE_AI_TEST_FETCH__: typeof fetch | undefined;

  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      BUCKET: R2Bucket;
      OPENAI_API_KEY?: string;
      INVOICE_AI_ENABLED?: string;
      INVOICE_AI_MODEL?: string;
      INVOICE_AI_MONTHLY_LIMIT_USD?: string;
    }
  }
}
export {};
