import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { LocalD1Database } from "./helpers/local-bindings.mjs";

const db = new LocalD1Database();

let batchCalls = 0;
const originalBatch = db.batch.bind(db);
db.batch = async (...args) => {
  batchCalls += 1;
  return originalBatch(...args);
};

globalThis.__NUTRIPLUS_DB__ = db;

const dbModuleUrl = pathToFileURL(
  new URL("../db/index.ts", import.meta.url).pathname,
);

dbModuleUrl.searchParams.set("cold", "1");
const firstRuntime = await import(dbModuleUrl.href);

await firstRuntime.ensureDatabase();

assert.ok(batchCalls > 0, "first cold start must run full reconciliation");

const state = await db
  .prepare("SELECT version FROM runtime_schema_state WHERE id = 1")
  .first();

assert.equal(state?.version, 21);

const batchesAfterFirstColdStart = batchCalls;

const secondUrl = pathToFileURL(
  new URL("../db/index.ts", import.meta.url).pathname,
);
secondUrl.searchParams.set("cold", "2");

const secondRuntime = await import(secondUrl.href);

await secondRuntime.ensureDatabase();

assert.equal(
  batchCalls,
  batchesAfterFirstColdStart,
  "second cold start must not execute reconciliation batches",
);

db.close();
delete globalThis.__NUTRIPLUS_DB__;

console.log(
  `Runtime schema fast-path PASS | first_batches=${batchesAfterFirstColdStart} | second_added_batches=${batchCalls - batchesAfterFirstColdStart}`,
);
