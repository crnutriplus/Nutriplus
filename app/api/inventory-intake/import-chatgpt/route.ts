import { ensureDatabase, getD1 } from "@/db";
import { ChatGptImportError, parseChatGptInvoiceImport } from "@/lib/chatgpt-invoice-import";
import { loadIntakeDocument } from "@/lib/inventory-document";
import { duplicateForParsedInvoice, replaceDocumentLinesFromParsed } from "@/lib/invoice-lines-store";
import { deleteStoredInvoiceFiles, storePreparedInvoiceFiles, type StoredInvoiceFileRow } from "@/lib/invoice-storage";

function importError(error: unknown) {
  if (error instanceof ChatGptImportError) return Response.json({ error: error.message }, { status: error.status });
  const message = error instanceof Error ? error.message : "No se pudo importar el análisis de ChatGPT.";
  if (/inventory_documents_fingerprint_unique|UNIQUE constraint failed: inventory_documents\.file_fingerprint/i.test(message)) {
    return Response.json({ error: "Esta factura ya fue procesada." }, { status: 409 });
  }
  return Response.json({ error: message }, { status: 500 });
}

export async function POST(request: Request) {
  let stored: StoredInvoiceFileRow[] = [];
  let documentId = "";
  try {
    const form = await request.formData();
    const zipFiles = form.getAll("package").filter((value): value is File => value instanceof File);
    if (zipFiles.length !== 1) throw new ChatGptImportError("Seleccioná un único archivo ZIP generado desde ChatGPT.");
    const imported = await parseChatGptInvoiceImport(zipFiles[0]);

    await ensureDatabase();
    const db = getD1();
    const exactDuplicate = await db.prepare("SELECT id FROM inventory_documents WHERE file_fingerprint=? LIMIT 1")
      .bind(imported.fingerprint).first<Record<string, unknown>>();
    if (exactDuplicate) throw new ChatGptImportError("Esta factura ya fue procesada.", 409);
    const semanticDuplicate = await duplicateForParsedInvoice(db, `chatgpt-import-check-${crypto.randomUUID()}`, imported.parsedInvoice);
    if (semanticDuplicate.duplicateOf) throw new ChatGptImportError("Esta factura ya fue procesada.", 409);

    documentId = `doc-${crypto.randomUUID()}`;
    const analysisId = `ianalysis-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    stored = await storePreparedInvoiceFiles(documentId, [imported.preparedFile]);
    const analysisStatus = imported.reviewRequired ? "review_required" : "completed";
    const invoice = imported.analysis.invoice && typeof imported.analysis.invoice === "object"
      ? imported.analysis.invoice as Record<string, unknown> : {};
    const fieldEvidence = {
      provider: { value: String(invoice.supplier || ""), confidence: 100, page: 1, source: "chatgpt_import" },
      order_number: { value: imported.parsedInvoice.orderNumber, confidence: 100, page: 1, source: "chatgpt_import" },
      invoice_number: { value: imported.parsedInvoice.invoiceNumber, confidence: 100, page: 1, source: "chatgpt_import" },
      document_date: { value: imported.parsedInvoice.documentDate, confidence: 100, page: 1, source: "chatgpt_import" },
      shipment_number: { value: imported.parsedInvoice.shipmentNumber, confidence: 100, page: 1, source: "chatgpt_import" },
      currency: { value: imported.summary.currency, confidence: 100, page: 1, source: "chatgpt_import" },
      total: { value: imported.summary.total.toFixed(2), confidence: 100, page: 1, source: "chatgpt_import" },
    };
    const file = stored[0];
    await db.batch([
      db.prepare(`INSERT INTO inventory_documents (
        id,file_fingerprint,file_name,mime_types_json,provider,order_number,invoice_number,shipment_number,
        document_date,page_count,file_count,processing_mode,analysis_status,active_analysis_id,field_evidence_json,
        status,warnings_json,duplicate_of,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        documentId, imported.fingerprint, imported.preparedFile.fileName, JSON.stringify([imported.preparedFile.mimeType]),
        imported.parsedInvoice.provider, imported.parsedInvoice.orderNumber, imported.parsedInvoice.invoiceNumber || null,
        imported.parsedInvoice.shipmentNumber || null, imported.parsedInvoice.documentDate, imported.summary.pageCount, 1,
        "chatgpt_import", analysisStatus, analysisId, JSON.stringify(fieldEvidence), "draft",
        JSON.stringify(imported.parsedInvoice.warnings), null, now, now,
      ),
      db.prepare(`INSERT INTO inventory_document_files (
        id,document_id,file_index,storage_key,file_name,mime_type,size_bytes,file_sha256,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
        file.id, documentId, file.file_index, file.storage_key, file.file_name, file.mime_type, file.size_bytes, file.file_sha256, now,
      ),
      db.prepare(`INSERT INTO invoice_ai_analyses (
        id,document_id,file_fingerprint,analysis_number,model,analysis_origin,api_calls,status,response_id,
        input_tokens,cached_input_tokens,output_tokens,web_search_count,estimated_cost_microusd,api_cost_microusd,
        extraction_json,error_code,error_message,reanalysis,created_at,completed_at
      ) VALUES (?,?,?,?,?,'CHATGPT_IMPORT',0,?,NULL,0,0,0,0,0,0,?,?,?,?,?,?)`).bind(
        analysisId, documentId, imported.fingerprint, 1, "ChatGPT Import", analysisStatus,
        JSON.stringify(imported.analysis), imported.reviewRequired ? "review_required" : null,
        imported.reviewRequired ? imported.reviewIssues.join(" ") : null, 0, now, now,
      ),
    ]);
    await replaceDocumentLinesFromParsed(db, documentId, imported.parsedInvoice, { preserveReviewed: false });
    const loaded = await loadIntakeDocument(db, documentId);
    if (!loaded) throw new Error("No se pudo recuperar el borrador importado.");
    return Response.json({
      ...loaded,
      imported: true,
      duplicate: false,
      exactDuplicate: false,
      reviewRequired: imported.reviewRequired,
      apiCalls: 0,
      apiCostUsd: 0,
    }, { status: 201 });
  } catch (error) {
    if (documentId) {
      try {
        const db = getD1();
        await db.batch([
          db.prepare("DELETE FROM inventory_document_lines WHERE document_id=?").bind(documentId),
          db.prepare("DELETE FROM invoice_ai_analyses WHERE document_id=?").bind(documentId),
          db.prepare("DELETE FROM inventory_document_files WHERE document_id=?").bind(documentId),
          db.prepare("DELETE FROM inventory_documents WHERE id=?").bind(documentId),
        ]);
      } catch { /* Best-effort rollback; the original error remains authoritative. */ }
    }
    if (stored.length) await deleteStoredInvoiceFiles(stored).catch(() => undefined);
    return importError(error);
  }
}
