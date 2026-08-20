import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { processDocumentWithAi } from "@/lib/invoice-ai-service";
import { intakeDocumentFromRow, loadIntakeDocument } from "@/lib/inventory-document";
import { lineFromRow } from "@/lib/inventory-intake";
import { applyLineProgress, conceptualDocumentStatus, loadDocumentMovementRows } from "@/lib/inventory-line-progress";
import { duplicateForParsedInvoice, replaceDocumentLinesFromParsed } from "@/lib/invoice-lines-store";
import { parseInvoicePages, type InvoicePageText } from "@/lib/invoice-parser";
import {
  deleteStoredInvoiceFiles,
  prepareInvoiceUploads,
  storePreparedInvoiceFiles,
  type PreparedInvoiceFile,
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

function storedWarnings(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 100) : [];
  } catch { return []; }
}

function storedFilesMatch(rows: Record<string, unknown>[], files: PreparedInvoiceFile[]) {
  return rows.length === files.length && files.every((file) => rows.some((row) => (
    Number(row.file_index) === file.index && String(row.file_sha256) === file.sha256
  )));
}

async function restoreMissingFiles(
  db: D1Database,
  existing: Record<string, unknown>,
  files: PreparedInvoiceFile[],
) {
  const documentId = String(existing.id);
  const currentFiles = await db.prepare(
    "SELECT file_index,file_sha256 FROM inventory_document_files WHERE document_id=? ORDER BY file_index",
  ).bind(documentId).all<Record<string, unknown>>();
  if (currentFiles.results.length) return;

  const stored = await storePreparedInvoiceFiles(documentId, files);
  const now = new Date().toISOString();
  const warnings = storedWarnings(existing.warnings_json)
    .filter((warning) => !/No se encontr[oó] el archivo guardado/i.test(warning));
  try {
    const statements: D1PreparedStatement[] = [
      db.prepare(`UPDATE inventory_documents SET
        file_name=?,mime_types_json=?,page_count=?,file_count=?,warnings_json=?,updated_at=?
        WHERE id=?`).bind(
        files.map((file) => file.fileName).join(" + "),
        JSON.stringify([...new Set(files.map((file) => file.mimeType))]),
        Math.max(1, files.length), files.length, JSON.stringify(warnings), now, documentId,
      ),
    ];
    stored.forEach((file) => statements.push(db.prepare(`INSERT OR IGNORE INTO inventory_document_files (
      id,document_id,file_index,storage_key,file_name,mime_type,size_bytes,file_sha256,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
      file.id, documentId, file.file_index, file.storage_key, file.file_name, file.mime_type,
      file.size_bytes, file.file_sha256, now,
    )));
    await db.batch(statements);
  } catch (error) {
    const racedFiles = await db.prepare(
      "SELECT file_index,file_sha256 FROM inventory_document_files WHERE document_id=? ORDER BY file_index",
    ).bind(documentId).all<Record<string, unknown>>();
    if (storedFilesMatch(racedFiles.results, files)) return;
    if (!racedFiles.results.length) await deleteStoredInvoiceFiles(stored);
    throw error;
  }

  const restoredFiles = await db.prepare(
    "SELECT file_index,file_sha256 FROM inventory_document_files WHERE document_id=? ORDER BY file_index",
  ).bind(documentId).all<Record<string, unknown>>();
  if (!storedFilesMatch(restoredFiles.results, files)) {
    if (!restoredFiles.results.length) await deleteStoredInvoiceFiles(stored);
    throw new Error("No se pudo volver a guardar el archivo de la factura.");
  }
}

async function historyResponse(db: D1Database) {
  const documentRows = await db.prepare(`SELECT * FROM inventory_documents
    ORDER BY COALESCE(updated_at,created_at) DESC,id DESC LIMIT 40`).all<Record<string, unknown>>();
  const documentIds = documentRows.results.map((row) => String(row.id));
  const lineRows = documentIds.length
    ? await db.prepare(`SELECT * FROM inventory_document_lines
        WHERE document_id IN (SELECT value FROM json_each(?))
        ORDER BY document_id,line_index,page_number,id`).bind(JSON.stringify(documentIds)).all<Record<string, unknown>>()
    : { results: [] as Record<string, unknown>[] };
  const documentMovementRows = await loadDocumentMovementRows(db, documentIds);
  const operations = await db.prepare(`SELECT o.*,d.file_name,d.provider,d.invoice_number,d.order_number,d.shipment_number
    FROM inventory_operations o LEFT JOIN inventory_documents d ON d.id=o.document_id
    WHERE o.status='completed' ORDER BY o.confirmed_at DESC,o.id DESC LIMIT 120`).all<Record<string, unknown>>();
  const ids = operations.results.map((row) => String(row.id));
  const movements = ids.length
    ? await db.prepare(`SELECT * FROM inventory_movements WHERE operation_id IN (SELECT value FROM json_each(?))
        ORDER BY created_at,id`).bind(JSON.stringify(ids)).all<Record<string, unknown>>()
    : { results: [] as Record<string, unknown>[] };
  const reversed = new Set(operations.results.filter((row) => row.reversal_of).map((row) => String(row.reversal_of)));
  const documents = documentRows.results.map((row) => {
    const document = intakeDocumentFromRow(row);
    const lines = applyLineProgress(
      lineRows.results.filter((line) => String(line.document_id) === document.id).map(lineFromRow),
      documentMovementRows,
    );
    document.status = conceptualDocumentStatus(lines, document.status);
    const omittedLines = lines.filter((line) => line.status === "ignored").length;
    const pendingLines = lines.filter((line) => line.status !== "ignored" && Number(line.availableQuantity || 0) > 0).length;
    const ingressedLines = lines.filter((line) => Number(line.activeQuantity || 0) > 0).length;
    const reversedLines = lines.filter((line) => line.hasReversals).length;
    return {
      ...document,
      lineCount: lines.length,
      ingressedLines,
      pendingLines,
      omittedLines,
      reversedLines,
      activeUnits: lines.reduce((total, line) => total + Number(line.activeQuantity || 0), 0),
      pendingUnits: lines.reduce((total, line) => total + (line.status === "ignored" ? 0 : Number(line.availableQuantity || 0)), 0),
      lines,
    };
  });
  return Response.json({
    documents,
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

async function existingUploadResponse(
  db: D1Database,
  existing: Record<string, unknown>,
  requestedMode: "ai" | "manual",
  uploadedFiles?: PreparedInvoiceFile[],
) {
  const documentId = String(existing.id);
  const operation = await db.prepare("SELECT id FROM inventory_operations WHERE document_id=? LIMIT 1").bind(documentId).first<Record<string, unknown>>();
  if (!operation && !["partial", "processed"].includes(String(existing.status)) && uploadedFiles?.length) {
    await restoreMissingFiles(db, existing, uploadedFiles);
    existing = await db.prepare("SELECT * FROM inventory_documents WHERE id=?").bind(documentId).first<Record<string, unknown>>() || existing;
  }
  const loaded = await loadIntakeDocument(db, documentId);
  if (!loaded) throw new Error("No se pudo recuperar la factura guardada.");
  if (operation || ["partial", "processed"].includes(String(existing.status))) {
    const processedLines = loaded.lines.filter((line) => line.status === "processed").length;
    const ignoredLines = loaded.lines.filter((line) => line.status === "ignored").length;
    const pendingLines = loaded.lines.filter((line) => line.status !== "ignored" && Number(line.availableQuantity ?? line.totalToAdd) > 0).length;
    const recoveryState = pendingLines === 0 ? "completed" : processedLines > 0 || ignoredLines > 0 || loaded.document.status === "partial" ? "partial" : "draft";
    return Response.json({
      ...loaded,
      duplicate: true,
      exactDuplicate: true,
      cachedAnalysis: true,
      resumed: true,
      recoveryState,
      processedLines,
      ignoredLines,
      pendingLines,
      notice: recoveryState === "completed" ? {
        type: "info",
        title: "Factura procesada",
        code: "INVENTORY_INVOICE_COMPLETED",
        message: "Esta factura no tiene cantidades pendientes. Podés consultar todas sus líneas y movimientos en el historial; el inventario no se modificó.",
      } : {
        type: "info",
        title: "Factura recuperada",
        code: "INVENTORY_INVOICE_RESUMED",
        message: `Recuperamos el progreso real de la factura. Hay ${pendingLines} línea${pendingLines === 1 ? "" : "s"} con cantidades pendientes; el inventario no se modificó al abrirla.`,
      },
    });
  }
  if (["completed", "review_required"].includes(String(existing.analysis_status))) {
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
  if (existing) return existingUploadResponse(db, existing, mode, prepared.files);

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
    if (raced) return existingUploadResponse(db, raced, mode, prepared.files);
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
