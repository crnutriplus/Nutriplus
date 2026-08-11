import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { importJobFromRow } from "@/lib/import-jobs";
import { createBackupForImport } from "@/lib/inventory-backups";

type ImportRow = {
  id: number;
  name: string;
  normalized_name: string;
  code: string | null;
  purchase_price_usd_cents: number | null;
  weight_milli_lb: number | null;
  quantity_available: number | null;
  minimum_stock: number | null;
  minimum_stock_enabled: number | null;
  has_code: number;
  has_purchase_price: number;
  has_weight: number;
  has_quantity: number;
  has_minimum_stock: number;
};

type ExistingProduct = Record<string, unknown> & { id: number; normalized_name: string; code: string | null };

function changes(result: unknown) {
  return Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0);
}

function claimToken() {
  return globalThis.crypto?.randomUUID?.() || `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function finishIfReady(db: D1Database, id: number) {
  const remaining = await db.prepare("SELECT COUNT(*) AS count FROM import_job_rows WHERE import_id=? AND processed<>1")
    .bind(id).first<{ count: number }>();
  if (Number(remaining?.count ?? 0) === 0) {
    await db.prepare(`UPDATE import_jobs SET status='completed',
      processed_rows=(SELECT COUNT(*) FROM import_job_rows WHERE import_id=? AND processed=1),
      completed_at=COALESCE(completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`)
      .bind(id, id).run();
  }
  return db.prepare("SELECT * FROM import_jobs WHERE id=?").bind(id).first<Record<string, unknown>>();
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  let id = 0;
  let token = "";
  try {
    id = Number((await context.params).id);
    if (!Number.isInteger(id) || id < 1) return Response.json({ error: "Importación inválida." }, { status: 400 });
    await ensureDatabase();
    const db = getD1();
    const job = await db.prepare("SELECT * FROM import_jobs WHERE id=? LIMIT 1").bind(id).first<Record<string, unknown>>();
    if (!job) return Response.json({ error: "No se encontró la importación." }, { status: 404 });
    if (job.status === "completed" || job.status === "failed") return Response.json({ job: importJobFromRow(job) });

    const activeDeletion = await db.prepare("SELECT id FROM product_deletion_jobs WHERE status IN ('queued','running') ORDER BY id LIMIT 1")
      .first<{ id: number }>();
    if (activeDeletion) return Response.json({ job: importJobFromRow(job), waitingForDeletion: true });

    await createBackupForImport(db, id);

    token = claimToken();
    const claimed = await db.prepare(`UPDATE import_job_rows SET
      processed=2,claim_token=?,claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id IN (
        SELECT id FROM import_job_rows
        WHERE import_id=? AND (
          processed=0 OR (processed=2 AND (claimed_at IS NULL OR julianday(claimed_at)<=julianday('now','-30 seconds')))
        ) ORDER BY id LIMIT 45
      ) AND import_id=? AND (
        processed=0 OR (processed=2 AND (claimed_at IS NULL OR julianday(claimed_at)<=julianday('now','-30 seconds')))
      ) RETURNING *`)
      .bind(token, id, id).all<ImportRow>();
    const rows = claimed.results;
    if (!rows.length) {
      const current = await finishIfReady(db, id);
      const busy = current?.status !== "completed";
      return Response.json({ job: importJobFromRow(current || job), busy });
    }

    const names = [...new Set(rows.map((row) => row.normalized_name))];
    const codes = [...new Set(rows.map((row) => row.code).filter((value): value is string => Boolean(value)))];
    const clauses: string[] = [];
    const bindings: unknown[] = [];
    if (names.length) { clauses.push(`normalized_name IN (${names.map(() => "?").join(",")})`); bindings.push(...names); }
    if (codes.length) { clauses.push(`code IN (${codes.map(() => "?").join(",")})`); bindings.push(...codes); }
    const existingResult = clauses.length
      ? await db.prepare(`SELECT * FROM products WHERE ${clauses.join(" OR ")}`).bind(...bindings).all<ExistingProduct>()
      : { results: [] as ExistingProduct[] };
    const byName = new Map(existingResult.results.map((product) => [product.normalized_name, product]));
    const byCode = new Map(existingResult.results.filter((product) => product.code).map((product) => [String(product.code), product]));

    const operations: D1PreparedStatement[] = [];
    const operationRows: Array<{ row: ImportRow; preset?: "skipped" | "error"; message?: string }> = [];
    for (const row of rows) {
      const nameMatch = byName.get(row.normalized_name);
      const codeMatch = row.code ? byCode.get(row.code) : undefined;
      if (nameMatch && codeMatch && Number(nameMatch.id) !== Number(codeMatch.id)) {
        operationRows.push({ row, preset: "error", message: "El nombre y el código pertenecen a productos distintos." });
        continue;
      }
      const existing = nameMatch || codeMatch;
      if (existing && job.strategy === "skip") {
        operationRows.push({ row, preset: "skipped" });
        continue;
      }
      if (existing) {
        operations.push(db.prepare(`UPDATE OR IGNORE products SET
          name=?,normalized_name=?,
          code=CASE WHEN ?=1 THEN ? ELSE code END,
          purchase_price_usd_cents=CASE WHEN ?=1 THEN ? ELSE purchase_price_usd_cents END,
          weight_milli_lb=CASE WHEN ?=1 THEN ? ELSE weight_milli_lb END,
          quantity_available=CASE WHEN ?=1 THEN ? ELSE quantity_available END,
          minimum_stock=CASE WHEN ?=1 THEN ? ELSE minimum_stock END,
          minimum_stock_enabled=CASE WHEN ?=1 THEN ? ELSE minimum_stock_enabled END,
          zero_stock_since=CASE
            WHEN ?=1 AND ?=0 AND quantity_available>0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHEN ?=1 AND ?>0 THEN NULL
            ELSE zero_stock_since END,
          restock_purchased_at=CASE WHEN
            (CASE WHEN ?=1 THEN ? ELSE quantity_available END)>0 AND
            ((CASE WHEN ?=1 THEN ? ELSE minimum_stock_enabled END)=0 OR
             (CASE WHEN ?=1 THEN ? ELSE quantity_available END)>(CASE WHEN ?=1 THEN ? ELSE minimum_stock END))
            THEN NULL ELSE restock_purchased_at END,
          version=version+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND julianday(replace(replace(updated_at,'T',' '),'Z','')) <= julianday(replace(replace(?,'T',' '),'Z',''))`)
          .bind(row.name,row.normalized_name,row.has_code,row.code,row.has_purchase_price,row.purchase_price_usd_cents,
            row.has_weight,row.weight_milli_lb,row.has_quantity,row.quantity_available,row.has_minimum_stock,row.minimum_stock,
            row.has_minimum_stock,row.minimum_stock_enabled,
            row.has_quantity,row.quantity_available,row.has_quantity,row.quantity_available,
            row.has_quantity,row.quantity_available,row.has_minimum_stock,row.minimum_stock_enabled,
            row.has_quantity,row.quantity_available,row.has_minimum_stock,row.minimum_stock,
            existing.id,job.created_at));
      } else {
        operations.push(db.prepare(`INSERT OR IGNORE INTO products (
          name,normalized_name,code,purchase_price_usd_cents,weight_milli_lb,quantity_available,
          minimum_stock,minimum_stock_enabled,zero_stock_since,version,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,CASE WHEN ?=1 AND ?=0 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,1,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
          .bind(row.name,row.normalized_name,row.has_code ? row.code : null,row.has_purchase_price ? row.purchase_price_usd_cents : null,
            row.has_weight ? row.weight_milli_lb : null,row.has_quantity ? row.quantity_available : 0,
            row.has_minimum_stock ? row.minimum_stock : 0,row.has_minimum_stock ? row.minimum_stock_enabled : 0,
            row.has_quantity,row.quantity_available));
      }
      operationRows.push({ row });
    }

    const operationResults = operations.length ? await db.batch(operations) : [];
    let operationIndex = 0;
    let imported = 0, updated = 0, skipped = 0, conflicts = 0, errors = 0;
    const outcomeUpdates: Array<{ id: number; outcome: string; message: string | null }> = [];
    for (const item of operationRows) {
      let outcome: "imported" | "updated" | "skipped" | "conflict" | "error";
      let message = item.message || null;
      if (item.preset) {
        outcome = item.preset;
      } else {
        const rowResult = operationResults[operationIndex++];
        const changed = changes(rowResult) > 0;
        const existed = Boolean(byName.get(item.row.normalized_name) || (item.row.code && byCode.get(item.row.code)));
        outcome = changed ? (existed ? "updated" : "imported") : "conflict";
        if (!changed) message = "Se conservó un cambio manual más reciente.";
      }
      if (outcome === "imported") imported += 1;
      else if (outcome === "updated") updated += 1;
      else if (outcome === "skipped") skipped += 1;
      else if (outcome === "conflict") conflicts += 1;
      else errors += 1;
      outcomeUpdates.push({ id: item.row.id, outcome, message });
    }
    const serializedOutcomes = JSON.stringify(outcomeUpdates);
    await db.batch([
      db.prepare(`UPDATE import_job_rows SET
        processed=1,claim_token=NULL,claimed_at=NULL,
        outcome=(SELECT json_extract(value,'$.outcome') FROM json_each(?) WHERE CAST(json_extract(value,'$.id') AS INTEGER)=import_job_rows.id),
        message=(SELECT json_extract(value,'$.message') FROM json_each(?) WHERE CAST(json_extract(value,'$.id') AS INTEGER)=import_job_rows.id)
        WHERE import_id=? AND claim_token=? AND processed=2
        AND id IN (SELECT CAST(json_extract(value,'$.id') AS INTEGER) FROM json_each(?))`)
        .bind(serializedOutcomes, serializedOutcomes, id, token, serializedOutcomes),
      db.prepare(`UPDATE import_jobs SET
        status=CASE WHEN NOT EXISTS (SELECT 1 FROM import_job_rows WHERE import_id=? AND processed<>1) THEN 'completed' ELSE 'running' END,
        processed_rows=(SELECT COUNT(*) FROM import_job_rows WHERE import_id=? AND processed=1),
        imported_count=imported_count+?,updated_count=updated_count+?,
        skipped_count=skipped_count+?,conflict_count=conflict_count+?,error_count=error_count+?,
        completed_at=CASE WHEN NOT EXISTS (SELECT 1 FROM import_job_rows WHERE import_id=? AND processed<>1)
          THEN COALESCE(completed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END
        WHERE id=? AND status IN ('queued','running')`)
        .bind(id, id, imported, updated, skipped, conflicts, errors, id, id),
    ]);

    const current = await db.prepare("SELECT * FROM import_jobs WHERE id=?").bind(id).first<Record<string, unknown>>();
    if (current?.status === "completed") {
      const count = await db.prepare(`SELECT COUNT(*) AS count FROM import_job_rows r
        JOIN products p ON p.normalized_name=r.normalized_name
        WHERE r.import_id=? AND r.outcome IN ('imported','updated')
        AND (p.purchase_price_usd_cents IS NULL OR p.weight_milli_lb IS NULL)`).bind(id).first<{ count: number }>();
      await db.prepare("UPDATE import_jobs SET incomplete_count=? WHERE id=?").bind(Number(count?.count ?? 0), id).run();
    }
    const refreshed = await db.prepare("SELECT * FROM import_jobs WHERE id=?").bind(id).first<Record<string, unknown>>();
    return Response.json({ job: importJobFromRow(refreshed!) });
  } catch (error) {
    try {
      if (id > 0 && token) {
        await getD1().prepare("UPDATE import_job_rows SET processed=0,claim_token=NULL,claimed_at=NULL WHERE import_id=? AND claim_token=? AND processed=2")
          .bind(id, token).run();
      }
      if (id > 0) {
        await getD1().prepare("UPDATE import_jobs SET status='failed',error_count=error_count+1,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .bind(id).run();
      }
    } catch { /* Preserve the original error. */ }
    return errorResponse(error);
  }
}
