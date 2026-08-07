declare global {
  var __NUTRIPLUS_DB__: D1Database | undefined;

  namespace Cloudflare {
    interface Env { DB: D1Database; }
  }
}
export {};
