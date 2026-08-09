import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { importJobFromRow } from "@/lib/import-jobs";
import { normalizeName } from "@/lib/pricing";

type SourceRow = Record<string, unknown> & { rowNumber?: number };

function optionalNumber(value: unknown, label: string) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} no es válido.`);
  return parsed;
}

function optionalInventory(value: unknown, label: string) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} debe ser un número entero igual o mayor que cero.`);
  return parsed;
}

function hasValue(value: unknown) {
  return value !== undefined && value !== null && !(typeof value === "string" && !value.trim());
}

function sanitizeRow(source: SourceRow, index: number) {
  const name = typeof source.name === "string" ? source.name.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new Error("La fila no tiene nombre de producto.");
  const hasCode = source.hasCode === true;
  const hasPurchasePrice = source.hasPurchasePrice === true;
  const hasWeight = source.hasWeight === true;
  const hasQuantity = source.hasQuantity === true && hasValue(source.quantityAvailable);
  const hasMinimumStock = source.hasMinimumStock === true && hasValue(source.minimumStock);
  const code = hasCode && typeof source.code === "string" ? source.code.trim().slice(0, 256) || null : null;
  const purchasePriceUsd = hasPurchasePrice ? optionalNumber(source.purchasePriceUsd, "El precio de compra") : null;
  const weightLb = hasWeight ? optionalNumber(source.weightLb, "El peso") : null;
  const quantityAvailable = hasQuantity ? optionalInventory(source.quantityAvailable, "La cantidad disponible") : null;
  const minimumStock = hasMinimumStock ? optionalInventory(source.minimumStock, "El stock mínimo") : null;
  return {
    rowNumber: Number(source.rowNumber) || index + 2,
    name,
    normalizedName: normalizeName(name),
    code,
    purchasePriceUsdCents: purchasePriceUsd === null ? null : Math.round(purchasePriceUsd * 100),
    weightMilliLb: weightLb === null ? null : Math.round(weightLb * 1000),
    quantityAvailable,
    minimumStock,
    minimumStockEnabled: hasMinimumStock ? 1 : null,
    hasCode: hasCode ? 1 : 0,
    hasPurchasePrice: hasPurchasePrice ? 1 : 0,
    hasWeight: hasWeight ? 1 : 0,
    hasQuantity: hasQuantity ? 1 : 0,
    hasMinimumStock: hasMinimumStock ? 1 : 0,
  };
}

export async function GET() {
  try {
    await ensureDatabase();
    const result = await getD1().prepare(`SELECT j.*,
      COALESCE((SELECT b.product_count FROM import_backups b WHERE b.import_id=j.id ORDER BY b.id LIMIT 1),j.total_rows,0) AS backup_product_count
      FROM import_jobs j ORDER BY j.id DESC LIMIT 25`).all();
    return Response.json({ jobs: result.results.map(importJobFromRow) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      rows?: SourceRow[];
      strategy?: "skip" | "update";
      fileName?: string;
      sheetName?: string;
    };
    const sourceRows = Array.isArray(payload.rows) ? payload.rows.slice(0, 5000) : [];
    if (!sourceRows.length) return Response.json({ error: "No hay filas con producto para importar." }, { status: 400 });

    const sanitized: ReturnType<typeof sanitizeRow>[] = [];
    let initialErrors = 0;
    sourceRows.forEach((source, index) => {
      try { sanitized.push(sanitizeRow(source, index)); } catch { initialErrors += 1; }
    });
    const unique = new Map<string, ReturnType<typeof sanitizeRow>>();
    sanitized.forEach((row) => unique.set(row.normalizedName, row));
    const rows = [...unique.values()];
    const duplicates = sanitized.length - rows.length;
    if (!rows.length) return Response.json({ error: "No se encontró ningún producto válido para importar." }, { status: 400 });

    await ensureDatabase();
    const db = getD1();
    const strategy = payload.strategy === "skip" ? "skip" : "update";
    const jobRow = await db.prepare(`INSERT INTO import_jobs (
      file_name,sheet_name,strategy,status,total_rows,skipped_count,error_count,created_at
    ) VALUES (?,?,?,'queued',?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING *`)
      .bind(String(payload.fileName || "Importación Excel").slice(0, 220), String(payload.sheetName || "").slice(0, 120) || null, strategy, rows.length, duplicates, initialErrors)
      .first<Record<string, unknown>>();
    if (!jobRow) throw new Error("No se pudo iniciar la importación.");
    const jobId = Number(jobRow.id);

    const serializedRows = JSON.stringify(rows);
    await db.prepare(`INSERT INTO import_job_rows (
      import_id,row_number,name,normalized_name,code,purchase_price_usd_cents,weight_milli_lb,
      quantity_available,minimum_stock,minimum_stock_enabled,has_code,has_purchase_price,has_weight,
      has_quantity,has_minimum_stock
    ) SELECT ?,
      CAST(json_extract(value,'$.rowNumber') AS INTEGER),json_extract(value,'$.name'),json_extract(value,'$.normalizedName'),
      json_extract(value,'$.code'),CAST(json_extract(value,'$.purchasePriceUsdCents') AS INTEGER),
      CAST(json_extract(value,'$.weightMilliLb') AS INTEGER),CAST(json_extract(value,'$.quantityAvailable') AS INTEGER),
      CAST(json_extract(value,'$.minimumStock') AS INTEGER),CAST(json_extract(value,'$.minimumStockEnabled') AS INTEGER),
      CAST(json_extract(value,'$.hasCode') AS INTEGER),CAST(json_extract(value,'$.hasPurchasePrice') AS INTEGER),
      CAST(json_extract(value,'$.hasWeight') AS INTEGER),CAST(json_extract(value,'$.hasQuantity') AS INTEGER),
      CAST(json_extract(value,'$.hasMinimumStock') AS INTEGER)
      FROM json_each(?)`)
      .bind(jobId, serializedRows).run();

    return Response.json({ job: importJobFromRow(jobRow), duplicates, initialErrors }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
