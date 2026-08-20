import { ensureDatabase, getD1 } from "@/db";
import { ChatGptImportError, parseChatGptInvoiceImport, type ChatGptInvoiceImportResult } from "@/lib/chatgpt-invoice-import";
import { validateBarcode } from "@/lib/barcodes";
import { loadIntakeDocument } from "@/lib/inventory-document";
import { resolveParsedLine } from "@/lib/inventory-intake";
import { duplicateForParsedInvoice, insertLineStatement, replaceDocumentLinesFromParsed } from "@/lib/invoice-lines-store";
import { deleteStoredInvoiceFiles, storePreparedInvoiceFiles, type StoredInvoiceFileRow } from "@/lib/invoice-storage";

function importError(error: unknown) {
  if (error instanceof ChatGptImportError) {
    return Response.json({ error: error.message, title: error.title, code: error.code }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "No se pudo importar el análisis de ChatGPT.";
  if (/inventory_documents_fingerprint_unique|UNIQUE constraint failed: inventory_documents\.file_fingerprint/i.test(message)) {
    return Response.json({
      error: "Esta factura ya existe, pero no fue posible recuperar su progreso en este momento. Intentá nuevamente; no se creó otra factura ni se modificó el inventario.",
      title: "Factura existente",
      code: "CHATGPT_DUPLICATE_RECOVERY_FAILED",
    }, { status: 409 });
  }
  const reference = crypto.randomUUID().slice(0, 8).toUpperCase();
  console.error("[CHATGPT_IMPORT]", { code: "DATABASE_WRITE_FAILED", reference, errorName: error instanceof Error ? error.name : typeof error });
  return Response.json({
    error: "No pudimos guardar los cambios en este momento. El progreso guardado anteriormente se conserva y no se realizaron cambios nuevos en el inventario. Intentá nuevamente.",
    title: "Problema temporal de NutriPlus",
    code: "DATABASE_WRITE_FAILED",
    reference,
  }, { status: 500 });
}

function countLabel(value: number, singular: string, plural: string) {
  return `${value} ${value === 1 ? singular : plural}`;
}

async function restoreMissingProcessedLines(db: D1Database, documentId: string, imported: ChatGptInvoiceImportResult) {
  const [existing, movements, products, quotes, aliases] = await Promise.all([
    db.prepare("SELECT id,line_key,canonical_barcode,secondary_id,processed_operation_id FROM inventory_document_lines WHERE document_id=?")
      .bind(documentId).all<Record<string, unknown>>(),
    db.prepare(`SELECT m.*,o.id AS ingress_operation_id
      FROM inventory_movements m JOIN inventory_operations o ON o.id=m.operation_id
      WHERE o.document_id=? AND o.operation_type='ingress' AND o.status='completed' AND m.original_movement_id IS NULL`)
      .bind(documentId).all<Record<string, unknown>>(),
    db.prepare("SELECT id,name,code,brand,presentation,quantity_available FROM products").all<Record<string, unknown>>(),
    db.prepare("SELECT id,name,code FROM non_inventory_quotes").all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM supplier_product_aliases").all<Record<string, unknown>>(),
  ]);
  const representedMovementLines = new Set(existing.results.filter((line) => line.processed_operation_id).map((line) => String(line.id)));
  const existingByKey = new Map(existing.results.map((line) => [String(line.line_key), line]));
  const claimedKeys = new Set(existing.results.filter((line) => line.processed_operation_id).map((line) => String(line.line_key)));
  const statements: D1PreparedStatement[] = [];
  const now = new Date().toISOString();

  for (const movement of movements.results) {
    const movementLineId = String(movement.document_line_id || "");
    if (!movementLineId || representedMovementLines.has(movementLineId)) continue;
    const movementBarcode = String(movement.canonical_barcode || validateBarcode(movement.barcode).canonical || "");
    const movementSecondary = String(movement.secondary_id || "").toLowerCase();
    const candidates = imported.parsedInvoice.lines.filter((line) => !claimedKeys.has(line.lineKey)).filter((line) => {
      const lineBarcode = String(validateBarcode(line.barcode).canonical || "");
      const lineSecondary = String(line.secondaryId || "").toLowerCase();
      return Boolean(movementBarcode && lineBarcode === movementBarcode || movementSecondary && lineSecondary === movementSecondary);
    });
    if (candidates.length !== 1) continue;
    const parsedLine = candidates[0];
    const prior = existingByKey.get(parsedLine.lineKey);
    const targetLineId = prior ? String(prior.id) : movementLineId;
    if (!prior) {
      const restored = resolveParsedLine({
        id: targetLineId,
        line: parsedLine,
        provider: imported.parsedInvoice.provider,
        products: products.results as never[],
        quotes: quotes.results as never[],
        aliases: aliases.results as never[],
      });
      statements.push(insertLineStatement(db, documentId, restored, now, imported.parsedInvoice.lines.indexOf(parsedLine)));
    } else if (movementLineId !== targetLineId) {
      statements.push(db.prepare("UPDATE inventory_movements SET document_line_id=? WHERE id=? AND document_line_id=?")
        .bind(targetLineId, String(movement.id), movementLineId));
    }
    statements.push(db.prepare(`UPDATE inventory_document_lines SET status='processed',selected_for_ingress=0,
      processed_operation_id=?,match_product_id=?,match_non_inventory_id=NULL,barcode_confirmed=1,updated_at=?
      WHERE id=? AND document_id=? AND processed_operation_id IS NULL`).bind(
      String(movement.ingress_operation_id || movement.operation_id), Number(movement.product_id), now, targetLineId, documentId,
    ));
    representedMovementLines.add(targetLineId);
    claimedKeys.add(parsedLine.lineKey);
  }
  if (statements.length) await db.batch(statements);
}

async function recoverExistingImport(db: D1Database, documentId: string, imported: ChatGptInvoiceImportResult) {
  await restoreMissingProcessedLines(db, documentId, imported);
  const loaded = await loadIntakeDocument(db, documentId);
  if (!loaded) throw new ChatGptImportError(
    "La factura existe, pero no pudimos recuperar su progreso en este momento. Intentá nuevamente; no se modificó el inventario.",
    409,
    "CHATGPT_DUPLICATE_RECOVERY_FAILED",
    "No se pudo recuperar la factura",
  );
  if (loaded.document.processingMode !== "chatgpt_import") {
    throw new ChatGptImportError(
      "Esta factura ya existe en NutriPlus mediante otro modo de procesamiento. Abrí el registro existente desde Facturas para continuar; no se creó otra factura ni se modificó el inventario.",
      409,
      "CHATGPT_ALREADY_EXISTS_OTHER_MODE",
      "Factura existente en otro modo",
    );
  }
  const storedSha256 = loaded.analysis?.importSummary?.sourceSha256 || "";
  if (storedSha256 && storedSha256 !== imported.summary.sourceSha256) {
    throw new ChatGptImportError(
      "El análisis guardado no corresponde a la factura incluida en este paquete. No se importó ningún producto ni se modificó el inventario.",
      409,
      "CHATGPT_HASH_MISMATCH",
      "El análisis no corresponde a la factura",
    );
  }
  const processedLines = loaded.lines.filter((line) => Boolean(line.processedOperationId) || line.status === "processed").length;
  const ignoredLines = loaded.lines.filter((line) => line.action === "ignore" || line.status === "ignored").length;
  const pendingLines = Math.max(0, loaded.lines.length - processedLines - ignoredLines);
  const recoveryState = pendingLines === 0 ? "completed" : processedLines > 0 || ignoredLines > 0 || loaded.document.status === "partial" ? "partial" : "draft";
  const notice = recoveryState === "completed" ? {
    type: "info",
    title: "Factura ya procesada",
    code: "CHATGPT_ALREADY_COMPLETED",
    message: "Esta factura ya fue procesada completamente. Todos sus productos ya fueron ingresados o resueltos y no se volverá a modificar el inventario. Podés consultar la factura y sus movimientos en el historial.",
  } : recoveryState === "partial" ? {
    type: "info",
    title: "Factura parcialmente procesada",
    code: "CHATGPT_ALREADY_PARTIAL",
    message: `Esta factura ya había sido iniciada. Tenés ${countLabel(processedLines, "producto ingresado", "productos ingresados")} y ${countLabel(pendingLines, "pendiente", "pendientes")}. Continuaremos desde donde la dejaste.`,
  } : {
    type: "info",
    title: "Borrador recuperado",
    code: "CHATGPT_DRAFT_RECOVERED",
    message: `Esta factura ya había sido iniciada. Recuperamos el borrador con ${countLabel(pendingLines, "producto pendiente", "productos pendientes")} y continuaremos desde donde la dejaste.`,
  };
  return Response.json({
    ...loaded,
    imported: false,
    recovered: true,
    resumed: true,
    duplicate: true,
    exactDuplicate: true,
    recoveryState,
    processedLines,
    ignoredLines,
    pendingLines,
    notice,
    apiCalls: 0,
    apiCostUsd: 0,
  });
}

export async function POST(request: Request) {
  let stored: StoredInvoiceFileRow[] = [];
  let documentId = "";
  let imported: ChatGptInvoiceImportResult | null = null;
  try {
    const form = await request.formData();
    const zipFiles = form.getAll("package").filter((value): value is File => value instanceof File);
    if (zipFiles.length !== 1) throw new ChatGptImportError(
      "Seleccioná un único archivo ZIP generado desde ChatGPT. No se creó ninguna factura ni se modificó el inventario.",
      400,
      "CHATGPT_ZIP_INVALID",
      "Paquete ZIP requerido",
    );
    imported = await parseChatGptInvoiceImport(zipFiles[0]);

    await ensureDatabase();
    const db = getD1();
    const exactDuplicate = await db.prepare("SELECT id FROM inventory_documents WHERE file_fingerprint=? LIMIT 1")
      .bind(imported.fingerprint).first<Record<string, unknown>>();
    if (exactDuplicate) return await recoverExistingImport(db, String(exactDuplicate.id), imported);
    const semanticDuplicate = await duplicateForParsedInvoice(db, `chatgpt-import-check-${crypto.randomUUID()}`, imported.parsedInvoice);
    if (semanticDuplicate.duplicateOf) throw new ChatGptImportError(
      "Ya existe una factura con el mismo pedido o rastreo, pero el archivo es diferente. Abrí el registro existente desde Facturas o verificá que seleccionaste el paquete correcto. No se creó otra factura ni se modificó el inventario.",
      409,
      "CHATGPT_INVOICE_ALREADY_EXISTS",
      "Factura posiblemente duplicada",
    );

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
    const message = error instanceof Error ? error.message : "";
    if (imported && /inventory_documents_fingerprint_unique|UNIQUE constraint failed: inventory_documents\.file_fingerprint/i.test(message)) {
      try {
        const db = getD1();
        const existing = await db.prepare("SELECT id FROM inventory_documents WHERE file_fingerprint=? LIMIT 1")
          .bind(imported.fingerprint).first<Record<string, unknown>>();
        if (existing) return await recoverExistingImport(db, String(existing.id), imported);
      } catch (recoveryError) { return importError(recoveryError); }
    }
    return importError(error);
  }
}
