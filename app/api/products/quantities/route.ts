import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { runIdempotentMutation } from "@/lib/mutations";
import { productFromRow } from "@/lib/pricing";
import { requestUserLabel } from "@/lib/request-user";

type QuantityEntry = { code?: unknown; quantityAdded?: unknown; quantityAvailable?: unknown };

function normalizedCode(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, "") : "";
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown> & { entries?: QuantityEntry[] };
    const source = Array.isArray(payload.entries) ? payload.entries.slice(0, 2000) : [];
    const entries = new Map<string, number>();
    const invalid: number[] = [];
    source.forEach((entry, index) => {
      const code = normalizedCode(entry.code);
      const quantity = Number(entry.quantityAdded ?? entry.quantityAvailable);
      if (!code || !Number.isInteger(quantity) || quantity < 0) invalid.push(index + 1);
      else entries.set(code, (entries.get(code) ?? 0) + quantity);
    });
    if (!entries.size) return Response.json({ error: "No se encontró ninguna cantidad válida." }, { status: 400 });

    await ensureDatabase();
    const db = getD1();
    const mutation = await runIdempotentMutation(db, request, payload, async () => {
      const operationId = (request.headers.get("x-mutation-id") || (typeof payload.mutationId === "string" ? payload.mutationId : "") || `quick-${crypto.randomUUID()}`).trim();
      const user = requestUserLabel(request);
      const now = new Date().toISOString();
      const requestedCodes = [...entries.keys()];
      const existing = await db.prepare(`SELECT * FROM products
        WHERE lower(replace(code,' ','')) IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(requestedCodes)).all<Record<string, unknown>>();
      const byCode = new Map(existing.results.map((row) => [normalizedCode(row.code), row]));
      const foundEntries = [...entries.entries()].filter(([code]) => byCode.has(code));
      const statements: D1PreparedStatement[] = [
        db.prepare(`INSERT INTO inventory_operations (
          id,document_id,operation_type,status,confirmed_by,line_count,total_units,created_at,confirmed_at,verification_status
        ) VALUES (?,NULL,'quick','pending',?,?,?,?,?,'pending')`).bind(
          operationId, user, foundEntries.length, foundEntries.reduce((total, [, quantity]) => total + quantity, 0), now, now,
        ),
      ];
      for (const [code, quantity] of entries) {
        const row = byCode.get(code);
        if (!row) continue;
        statements.push(db.prepare(`INSERT INTO inventory_movements (
          id,operation_id,document_line_id,product_id,product_name,barcode,canonical_barcode,previous_quantity,
          quantity_change,conversion,resulting_quantity,barcode_method,barcode_source,confirmed_by,created_at
        ) VALUES (?,?,?,(SELECT id FROM products WHERE id=?),(SELECT name FROM products WHERE id=?),?,?,
          (SELECT quantity_available FROM products WHERE id=?),?,1,
          (SELECT quantity_available+? FROM products WHERE id=?),'manual','Ingreso rápido por código',?,?)`).bind(
          `mov-${crypto.randomUUID()}`, operationId, `quick:${code}`, Number(row.id), Number(row.id), row.code || code, null,
          Number(row.id), quantity, quantity, Number(row.id), user, now,
        ));
        statements.push(db.prepare(`UPDATE products SET
          quantity_available=quantity_available+?,
          zero_stock_since=CASE WHEN quantity_available+?=0 THEN COALESCE(zero_stock_since,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END,
          restock_purchased_at=CASE WHEN quantity_available+?>0 AND (minimum_stock_enabled=0 OR quantity_available+?>minimum_stock) THEN NULL ELSE restock_purchased_at END,
          version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? RETURNING *`).bind(quantity, quantity, quantity, quantity, Number(row.id)));
      }
      statements.push(db.prepare("UPDATE inventory_operations SET status='completed',verification_status='verified',confirmed_at=? WHERE id=?").bind(now, operationId));
      const results = await db.batch<Record<string, unknown>>(statements);
      const products = results.flatMap((result) => result.results || []).map(productFromRow);
      const foundCodes = new Set(products.map((product) => normalizedCode(product.code)));
      const notFound = requestedCodes.filter((code) => !foundCodes.has(code));
      return {
        body: {
          products,
          updated: products.length,
          addedTotal: [...entries.entries()].reduce((total, [code, quantity]) => total + (foundCodes.has(code) ? quantity : 0), 0),
          notFound,
          invalid,
          operationId,
        },
      };
    });
    return Response.json(mutation.body, { status: mutation.status ?? 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
