import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { validateBarcode } from "@/lib/barcodes";
import { lineFromRow } from "@/lib/inventory-intake";

function documentFromRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    fingerprint: String(row.file_fingerprint),
    fileName: String(row.file_name),
    provider: String(row.provider),
    orderNumber: row.order_number ? String(row.order_number) : "",
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : "",
    shipmentNumber: row.shipment_number ? String(row.shipment_number) : "",
    documentDate: row.document_date ? String(row.document_date) : "",
    pageCount: Number(row.page_count),
    status: String(row.status),
    warnings: JSON.parse(String(row.warnings_json || "[]")) as string[],
    duplicateOf: row.duplicate_of ? String(row.duplicate_of) : "",
    createdAt: String(row.created_at),
    confirmedAt: row.confirmed_at ? String(row.confirmed_at) : "",
  };
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = (await context.params).id;
    await ensureDatabase();
    const db = getD1();
    const document = await db.prepare("SELECT * FROM inventory_documents WHERE id=?").bind(id).first<Record<string, unknown>>();
    if (!document) return Response.json({ error: "No se encontró la factura." }, { status: 404 });
    const lines = await db.prepare("SELECT * FROM inventory_document_lines WHERE document_id=? ORDER BY page_number,id").bind(id).all<Record<string, unknown>>();
    return Response.json({ document: documentFromRow(document), lines: lines.results.map(lineFromRow) });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const documentId = (await context.params).id;
    const payload = await request.json() as Record<string, unknown> & { lines?: Array<Record<string, unknown>> };
    await ensureDatabase();
    const db = getD1();
    const document = await db.prepare("SELECT * FROM inventory_documents WHERE id=?").bind(documentId).first<Record<string, unknown>>();
    if (!document) return Response.json({ error: "No se encontró la factura." }, { status: 404 });
    const now = new Date().toISOString();
    const text = (value: unknown, max = 500) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
    const statements: D1PreparedStatement[] = [
      db.prepare(`UPDATE inventory_documents SET provider=?,order_number=?,invoice_number=?,shipment_number=?,document_date=?,updated_at=? WHERE id=?`)
        .bind(text(payload.provider, 40) || document.provider, text(payload.orderNumber, 160) || null, text(payload.invoiceNumber, 160) || null,
          text(payload.shipmentNumber, 160) || null, text(payload.documentDate, 80) || null, now, documentId),
    ];
    const lines = Array.isArray(payload.lines) ? payload.lines.slice(0, 500) : [];
    lines.forEach((line) => {
      const id = text(line.id, 100) || `iline-${crypto.randomUUID()}`;
      const name = text(line.name, 500) || "Producto pendiente de identificar";
      const received = line.receivedQuantity == null || line.receivedQuantity === "" ? null : Number(line.receivedQuantity);
      const billed = line.billedQuantity == null || line.billedQuantity === "" ? null : Number(line.billedQuantity);
      const units = Math.max(1, Number(line.unitsPerPackage) || 1);
      const total = received == null || !Number.isInteger(received) || received < 0 ? 0 : received * units;
      const barcode = validateBarcode(line.barcode);
      const values = {
        id,
        lineKey: text(line.lineKey, 150) || `manual-${id}`,
        original: text(line.originalDescription, 1000) || name,
        name,
        brand: text(line.brand, 200),
        presentation: text(line.presentation, 250),
        flavor: text(line.flavor, 150),
        concentration: text(line.concentration, 100),
        billed: Number.isInteger(billed) && Number(billed) >= 0 ? billed : null,
        received: Number.isInteger(received) && Number(received) >= 0 ? received : null,
        units,
        total,
        barcode: barcode.valid ? barcode.normalized : null,
        canonical: barcode.valid ? barcode.canonical : null,
        type: barcode.valid ? barcode.type : null,
        secondaryId: text(line.secondaryId, 200),
        secondaryType: text(line.secondaryType, 40),
        method: text(line.barcodeMethod, 80),
        source: text(line.barcodeSource, 500),
        status: text(line.status, 50) || "requires_confirm_code",
        productId: Number(line.matchProductId) > 0 ? Number(line.matchProductId) : null,
        quoteId: Number(line.matchNonInventoryId) > 0 ? Number(line.matchNonInventoryId) : null,
        action: text(line.action, 20) || "pending",
        level: text(line.barcodeLevel, 30),
        warnings: Array.isArray(line.warnings) ? line.warnings.map(String).slice(0, 30) : [],
      };
      statements.push(db.prepare(`INSERT INTO inventory_document_lines (
        id,document_id,line_key,original_description,name,brand,presentation,flavor,concentration,billed_quantity,
        received_quantity,units_per_package,total_to_add,barcode,canonical_barcode,barcode_type,secondary_id,secondary_type,
        barcode_method,barcode_source,confidence,status,match_product_id,match_non_inventory_id,action,barcode_level,warnings_json,
        created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,100,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        original_description=excluded.original_description,name=excluded.name,brand=excluded.brand,presentation=excluded.presentation,
        flavor=excluded.flavor,concentration=excluded.concentration,billed_quantity=excluded.billed_quantity,
        received_quantity=excluded.received_quantity,units_per_package=excluded.units_per_package,total_to_add=excluded.total_to_add,
        barcode=excluded.barcode,canonical_barcode=excluded.canonical_barcode,barcode_type=excluded.barcode_type,
        secondary_id=excluded.secondary_id,secondary_type=excluded.secondary_type,barcode_method=excluded.barcode_method,
        barcode_source=excluded.barcode_source,status=CASE WHEN inventory_document_lines.processed_operation_id IS NULL THEN excluded.status ELSE inventory_document_lines.status END,
        match_product_id=excluded.match_product_id,match_non_inventory_id=excluded.match_non_inventory_id,
        action=excluded.action,barcode_level=excluded.barcode_level,warnings_json=excluded.warnings_json,updated_at=excluded.updated_at`).bind(
        values.id, documentId, values.lineKey, values.original, values.name, values.brand || null, values.presentation || null,
        values.flavor || null, values.concentration || null, values.billed, values.received, values.units, values.total,
        values.barcode, values.canonical, values.type, values.secondaryId || null, values.secondaryType || null,
        values.method || null, values.source || null, values.status, values.productId, values.quoteId, values.action,
        values.level || null, JSON.stringify(values.warnings), now, now,
      ));
    });
    await db.batch(statements);
    const updated = await db.prepare("SELECT * FROM inventory_document_lines WHERE document_id=? ORDER BY page_number,id").bind(documentId).all<Record<string, unknown>>();
    return Response.json({ saved: true, lines: updated.results.map(lineFromRow) });
  } catch (error) { return errorResponse(error); }
}
