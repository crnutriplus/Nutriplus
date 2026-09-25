import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const journal = JSON.parse(
  await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
);

for (const entry of journal.entries.filter((entry) => entry.idx <= 20)) {
  const sql = await readFile(
    new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
    "utf8",
  );
  for (const statement of sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean)) {
    db.exec(statement);
  }
}

db.prepare(
  "INSERT INTO crm_operations (operation_id,operation_type,request_hash,status) VALUES ('before-0021','TEST','hash','COMPLETED')",
).run();

const migration = await readFile(
  new URL("../drizzle/0021_chief_tomas.sql", import.meta.url),
  "utf8",
);

for (const statement of migration
  .split("--> statement-breakpoint")
  .map((part) => part.trim())
  .filter(Boolean)) {
  db.exec(statement);
}

assert.ok(
  db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_schema_state'",
  ).get(),
);

const columns = db
  .prepare("PRAGMA table_info(runtime_schema_state)")
  .all()
  .map((row) => row.name);

assert.deepEqual(columns, ["id", "version", "updated_at"]);

db.prepare(
  "INSERT INTO runtime_schema_state (id,version) VALUES (1,21)",
).run();

assert.equal(
  db.prepare("SELECT version FROM runtime_schema_state WHERE id=1").get().version,
  21,
);

assert.equal(
  db.prepare(
    "SELECT count(*) AS total FROM crm_operations WHERE operation_id='before-0021'",
  ).get().total,
  1,
);

db.close();
console.log("Migration 0021 adds persistent runtime schema version state");
