import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { processDocumentWithAi } from "@/lib/invoice-ai-service";
import { intakeDocumentFromRow, loadIntakeDocument } from "@/lib/inventory-document";
import { duplicateForParsedInvoice, replaceDocumentLinesFromParsed } from "@/lib/invoice-lines-store";
import { parseInvoicePages, type InvoicePageText } from "@/lib/invoice-parser";
import {
  deleteStoredInvoiceFiles,
  prepareInvoiceUploads,
  storePreparedInvoiceFiles,
} from "@/lib/invoice-storage";

type LegacyAnalyzePayload = {
  fingerprint?: unknown;
  fileName?: unknown;
  mimeTypes?: unknown;
  pages?: unknown;
  warnings?: unknown;
};

function safeJsonArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).slice(0, 100) : [];
}

async function historyResponse(db: D1Database) {
  const operations = await db.prepare(`SELECT o.*,d.file_name,d.provider,d.invoice_number,d.order_number,d.shipment_number
    FROM inventory_operations o LEFT JOIN inventory_documents d ON d.id=o.document_id
    WHERE o.status='completed' ORDER BY o.confirmed_at DESC,o.id DESC LIMIT 40`).all<Record<string, unknown>>();
  const ids = operations.results.map((row) => String(row.id));
  const movements = ids.length
    ? await db.prepare(`SELECT * FROM inventory_movements WHERE operation_id IN (SELECT value FROM json_each(?))
        ORDER BY created_at,id`).bind(JSON.stringify(ids)).all<Record<string, unknown>>()
    : { results: [] as Record<string, unknown>[] };
  const reversed = new Set(operations.results.filter((row) => row.reversal_of).map((row) => String(row.reversal_of)));
  return Response.json({
    operations: operations.results.map((row) => ({
      id: String(row.id),
      documentId: row.document_id ? String(row.document_id) : "",
      operationType: String(row.operation_type),
      reversalOf: row.reversal_of ? String(row.reversal_of) : "",
      reason: row.reason ? String(row.reason) : "",
      confirmedBy: row.confirmed_by ? String(row.confirmed_by) : "",
      lineCount: Number(row.line_count),
      totalUnits: Number(row.total_units),
      confirmedAt: row.confirmed_at ? String(row.confirmed_at) : "",
      fileName: row.file_name ? String(row.file_name) : "Ingreso rápido por código",
      provider: row.provider ? String(row.provider) : "manual",
      invoiceNumber: row.invoice_number ? String(row.invoice_number) : "",
      orderNumber: row.order_number ? String(row.order_number) : "",
      shipmentNumber: row.shipment_number ? String(row.shipment_number) : "",
      reversed: reversed.has(String(row.id)),
      movements: movements.results.filter((movement) => String(movement.operation_id) === String(row.id)).map((movement) => ({
        id: String(movement.id),
        productId: Number(movement.product_id),
        productName: String(movement.product_name),
        barcode: movement.barcode ? String(movement.barcode) : "",
        previousQuantity: Number(movement.previous_quantity),
        quantityChange: Number(movement.quantity_change),
        resultingQuantity: Number(movement.resulting_quantity),
      })),
    })),
  });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const db = getD1();
    if (new URL(request.url).searchParams.get("history") === "1") return historyResponse(db);
    const documents = await db.prepare("SELECT * FROM inventory_documents ORDER BY created_at DESC,id DESC LIMIT 30").all<Record<string, unknown>>();
    return Response.json({ documents: documents.results.map(intakeDocumentFromRow) });
  } catch (error) { return errorResponse(error); }
}

async function existingUploadResponse(db: D1Database, existing: Record<string, unknown>, requestedMode: "ai" | "manual") {
  const documentId = String(existing.id);
  const operation = await db.prepare("SELECT id FROM inventory_operations WHERE document_id=? LIMIT 1").bind(documentId).first<Record<string, unknown>>();
  const loaded = await loadIntakeDocument(db, documentId);
  if (!loaded) throw new Error("No se pudo recuperar la factura guardada.");
  if (operation || ["partial", "processed"].includes(String(existing.status))) {
    return Response.json({ ...loaded, duplicate: true, exactDuplicate: true, cachedAnalysis: true });
  }
  if (String(existing.analysis_status) === "completed") {
    return Response.json({ ...loaded, duplicate: false, exactDuplicate: false, resumed: true, cachedAnalysis: true });
  }
  if (requestedMode === "ai" && String(existing.analysis_status) === "not_requested") {
    const analyzed = await processDocumentWithAi(db, documentId);
    return Response.json({ ...analyzed, duplicate: false, exactDuplicate: false, resumed: true }, { status: analyzed?.manualFallback ? 202 : 200 });
  }
  return Response.json({
    ...loaded,
    duplicate: false,
    exactDuplicate: false,
    resumed: true,
    cachedAnalysis: false,
    manualFallback: requestedMode === "ai",
    aiErrorMessage: requestedMode === "ai"
      ? "El análisis anterior no se repitió automáticamente para evitar un nuevo cobro. Usá “Analizar nuevamente” si querés intentarlo."
      : "",
  });
}

async function uploadInvoice(request: Request) {
  const form = await request.formData();
  const mode = form.get("mode") === "manual" ? "manual" : "ai";
  const files = form.getAll("files").filter((value): value is File => value instanceof File);
  const prepared = await prepareInvoiceUploads(files);
  await ensureDatabase();
  const db = getD1();
  const existing = await db.prepare("SELECT * FROM inventory_documents WHERE file_fingerprint=? LIMIT 1")
    .bind(prepared.fingerprint).first<Record<string, unknown>>();
  if (existing) return existingUploadResponse(db, existing, mode);

  const documentId = `doc-${crypto.randomUUID()}`;
  const stored = await storePreparedInvoiceFiles(documentId, prepared.files);
  const now = new Date().toISOString();
  try {
    const statements: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO inventory_documents (
        id,file_fingerprint,file_name,mime_types_json,provider,order_number,invoice_number,shipment_number,
        document_date,page_count,file_count,processing_mode,analysis_status,field_evidence_json,status,warnings_json,
        duplicate_of,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        documentId, prepared.fingerprint, prepared.files.map((file) => file.fileName).join(" + "),
        JSON.stringify([...new Set(prepared.files.map((file) => file.mimeType))]), "other", null, null, null, null,
        Math.max(1, prepared.files.length), prepared.files.length, mode, mode === "ai" ? "queued" : "not_requested",
        "{}", "draft", "[]", null, now, now,
      ),
    ];
    stored.forEach((file) => statements.push(db.prepare(`INSERT INTO inventory_document_files (
      id,document_id,file_index,storage_key,file_name,mime_type,size_bytes,file_sha256,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
      file.id, documentId, file.file_index, file.storage_key, file.file_name, file.mime_type, file.size_bytes, file.file_sha256, now,
    )));
    await db.batch(statements);
  } catch (error) {
    await deleteStoredInvoiceFiles(stored);
    const raced = await db.prepare("SELECT * FROM inventory_documents WHERE file_fingerprint=? LIMIT 1")
      .bind(prepared.fingerprint).first<Record<string, unknown>>();
    if (raced) return existingUploadResponse(db, raced, mode);
    throw error;
  }

  if (mode === "ai") {
    const analyzed = await processDocumentWithAi(db, documentId);
    return Response.json({ ...analyzed, duplicate: false, exactDuplicate: false }, { status: analyzed?.manualFallback ? 202 : 201 });
  }
  const loaded = await loadIntakeDocument(db, documentId);
  return Response.json({ ...loaded, duplicate: false, exactDuplicate: false, manualFallback: false }, { status: 201 });
}

function legacyPages(payload: LegacyAnalyzePayload) {
  return Array.isArray(payload.pages) ? payload.pages.slice(0, 100).map((page, index) => {
    const source = page && typeof page === "object" ? page as Record<string, unknown> : {};
    return {
      pageNumber: Number(source.pageNumber || index + 1),
      text: typeof source.text === "string" ? source.text.slice(0, 150000) : "",
      confidence: Math.max(0, Math.min(100, Number(source.confidence || 0))),
      source: source.source === "pdf_text" ? "pdf_text" : "ocr",
    } satisfies InvoicePageText;
  }) : [];
}

async function legacyOcrInvoice(request: Request) {
  const payload = await request.json() as LegacyAnalyzePayload;
  const fingerprint = typeof payload.fingerprint === "string" ? payload.fingerprint.trim().toLowerCase() : "";
  const fileName = typeof payload.fileName === "string" ? payload.fileName.trim().slice(0, 500) : "";
  const pages = legacyPages(payload);
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return Response.json({ error: "No se pudo verificar la huella digital de la factura." }, { status: 400 });
  if (!fileName || !pages.length) return Response.json({ error: "La factura no contiene páginas para analizar." }, { status: 400 });
  if (pages.reduce((total, page) => total + page.text.length, 0) > 1_500_000) return Response.json({ error: "La factura contiene demasiado texto para una sola carga." }, { status: 413 });
  await ensureDatabase();
  const db = getD1();
  const existing = await db.prepare("SELECT * FROM inventory_documents WHERE file_fingerprint=? LIMIT 1").bind(fingerprint).first<Record<string, unknown>>();
  if (existing) return existingUploadResponse(db, existing, "manual");
  const parsed = parseInvoicePages(pages);
  const documentId = `doc-${crypto.randomUUID()}`;
  const duplicate = await duplicateForParsedInvoice(db, documentId, parsed);
  const warnings = [...new Set([...safeJsonArray(payload.warnings), ...parsed.warnings, ...(duplicate.warning ? [duplicate.warning] : [])])];
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO inventory_documents (
    id,file_fingerprint,file_name,mime_types_json,provider,order_number,invoice_number,shipment_number,document_date,
    page_count,file_count,processing_mode,analysis_status,field_evidence_json,status,warnings_json,duplicate_of,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    documentId, fingerprint, fileName, JSON.stringify(safeJsonArray(payload.mimeTypes)), parsed.provider, parsed.orderNumber || null,
    parsed.invoiceNumber || null, parsed.shipmentNumber || null, parsed.documentDate || null, pages.length, 0, "manual",
    "ocr_fallback", "{}", parsed.status, JSON.stringify(warnings), duplicate.duplicateOf || null, now, now,
  ).run();
  await replaceDocumentLinesFromParsed(db, documentId, parsed, { preserveReviewed: true });
  const loaded = await loadIntakeDocument(db, documentId);
  return Response.json({ ...loaded, duplicate: Boolean(duplicate.duplicateOf), exactDuplicate: false, manualFallback: true }, { status: 201 });
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    return contentType.includes("multipart/form-data") ? await uploadInvoice(request) : await legacyOcrInvoice(request);
  } catch (error) { return errorResponse(error); }
}
