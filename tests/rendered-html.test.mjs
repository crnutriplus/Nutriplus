import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

const publicVersionSource = await readFile(
  new URL("../lib/public-version.ts", import.meta.url),
  "utf8",
);
const publicVersion = publicVersionSource.match(
  /NUTRIPLUS_PUBLIC_VERSION\s*=\s*["']([^"']+)["']/,
)?.[1];

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      NUTRIPLUS_APP_AUTH_MODE: "disabled",
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, developmentPreviewMeta);
  assert.ok(publicVersion, "the public NutriPlus version must be declared");
  assert.match(
    html,
    new RegExp(
      `<meta(?=[^>]*\\bname=["']nutriplus-public-version["'])(?=[^>]*\\bcontent=["']${publicVersion.replaceAll(".", "\\.")}["'])[^>]*>`,
      "i",
    ),
  );
  assert.match(html, new RegExp(`NutriPlus v${publicVersion.replaceAll(".", "\\.")}`));
});

test("keeps the public version independent from technical checkpoints", async () => {
  assert.ok(publicVersion, "the public NutriPlus version must be declared");
  assert.match(publicVersion, /^2\.\d+$/);

  const packageMetadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageMetadata.version, `${publicVersion}.0`);
  assert.doesNotMatch(publicVersion, /^(18|19|20|21|22)$/);
});

test("exposes all three invoice modes in the client interface", async () => {
  const source = await readFile(new URL("../app/inventory-intake.tsx", import.meta.url), "utf8");
  assert.match(source, />Automático con IA</);
  assert.match(source, />Manual</);
  assert.match(source, />Importar análisis de ChatGPT</);
  assert.match(source, /\/api\/inventory-intake\/import-chatgpt/);
});

test("keeps actionable recovery and authentication messages in the invoice interface", async () => {
  const source = await readFile(new URL("../app/inventory-intake.tsx", import.meta.url), "utf8");
  assert.match(source, /result\.recovered/);
  assert.match(source, /Factura ya procesada/);
  assert.match(source, /AUTH_SESSION_EXPIRED/);
  assert.match(source, /Tu sesión venció/);
  assert.match(source, /AUTH_FORBIDDEN/);
  assert.match(source, /No tenés permiso/);
});
