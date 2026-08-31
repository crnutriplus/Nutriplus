import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { validateBarcode } from "@/lib/barcodes";
import { loadIntakeDocument } from "@/lib/inventory-document";
import { normalizePresentation } from "@/lib/product-presentation";
import { lineFromRow } from "@/lib/inventory-intake";
import { documentStatusStatement, loadDocumentMovementRows, progressForLine } from "@/lib/inventory-line-progress";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = (await context.params).id;
    await ensureDatabase();
    const db = getD1();
    const loaded = await loadIntakeDocument(db, id);
    if (!loaded) return Response.json({ error: "No se encontró la factura." }, { status: 404 });
    return Response.json(loaded);
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const documentId = (await context.params).id;
    const payload = await request.json() as Record<string, unknown> & {
      lines?: Array<Record<string, unknown>>;
      deletedLineIds?: unknown[];
      reviewedLineIds?: unknown[];
    };
    await ensureDatabase();
    const db = getD1();
    const document = await db.prepare("SELECT * FROM inventory_documents WHERE id=?").bind(documentId).first<Record<string, unknown>>();
    if (!document) return Response.json({ error: "No se encontró la factura." }, { status: 404 });
    const storedLines = await db.prepare("SELECT * FROM inventory_document_lines WHERE document_id=?")
      .bind(documentId).all<Record<string, unknown>>();
    const storedById = new Map(storedLines.results.map((line) => [String(line.id), line]));
    const storedByLineKey = new Map(storedLines.results.map((line) => [String(line.line_key), line]));
    const movementRows = await loadDocumentMovementRows(db, [documentId]);
    const progressById = new Map(storedLines.results.map((line) => {
      const dto = lineFromRow(line);
      return [dto.id, progressForLine(dto, movementRows)] as const;
    }));
    const now = new Date().toISOString();
    const text = (value: unknown, max = 500) => typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
    const storedForReference = (sourceId: string, sourceLineKey: string) => {
      const byId = sourceId ? storedById.get(sourceId) : undefined;
      const byLineKey = sourceLineKey ? storedByLineKey.get(sourceLineKey) : undefined;
      if (byId && byLineKey && String(byId.id) !== String(byLineKey.id)) {
        throw new Error("INVENTORY_LINE_REFERENCE_CONFLICT");
      }
      return byId || byLineKey;
    };
    const statements: D1PreparedStatement[] = [];
    if (payload.metadataChanged !== false) {
      statements.push(db.prepare(`UPDATE inventory_documents SET provider=?,order_number=?,shipment_number=?,document_date=?,updated_at=? WHERE id=?`)
        .bind(text(payload.provider, 40) || document.provider, text(payload.orderNumber, 160) || null,
          text(payload.shipmentNumber, 160) || null, text(payload.documentDate, 80) || null, now, documentId));
    }
    const deletedLineIds = Array.isArray(payload.deletedLineIds)
      ? [...new Set(payload.deletedLineIds.map((value) => text(value, 100)).filter(Boolean))].slice(0, 500)
      : [];
    const requestedReviewedLineIds = new Set(Array.isArray(payload.reviewedLineIds)
      ? payload.reviewedLineIds.map((value) => text(value, 100)).filter(Boolean).slice(0, 500)
      : []);
    const reviewedLineIds = new Set<string>();
    const protectedOriginalIds = deletedLineIds.filter((id) => {
      const line = storedById.get(id);
      return line && !String(line.line_key || "").startsWith("manual-");
    });
    if (protectedOriginalIds.length) return Response.json({
      error: "Una línea original de factura no se puede eliminar. Usá “Omitir” para conservarla en el historial y poder reactivarla después. No se modificó el inventario.",
      title: "La línea original debe conservarse",
      code: "INVENTORY_ORIGINAL_LINE_DELETE_BLOCKED",
      lineIds: protectedOriginalIds,
    }, { status: 409 });
    deletedLineIds.forEach((id) => statements.push(db.prepare(`DELETE FROM inventory_document_lines
      WHERE id=? AND document_id=? AND processed_operation_id IS NULL AND line_key LIKE 'manual-%'`).bind(id, documentId)));
    const lines = Array.isArray(payload.lines) ? payload.lines.slice(0, 500) : [];
    const responseIds = new Set<string>();
    const seenLineIds = new Set<string>();
    const seenLineKeys = new Set<string>();
    lines.forEach((line, lineIndex) => {
      const storedLineIndex = Number(line.lineIndex);
      const orderedLineIndex = Number.isInteger(storedLineIndex) && storedLineIndex >= 0 && storedLineIndex < 10_000 ? storedLineIndex : lineIndex;
      const sourceId = text(line.id, 100);
      const sourceLineKey = text(line.lineKey, 150);
      const stored = storedForReference(sourceId, sourceLineKey);
      const id = stored ? String(stored.id) : sourceId || `iline-${crypto.randomUUID()}`;
      const lineKey = stored ? text(stored.line_key, 150) || sourceLineKey || `manual-${id}` : sourceLineKey || `manual-${id}`;
      if (seenLineIds.has(id) || seenLineKeys.has(lineKey)) throw new Error("INVENTORY_LINE_REFERENCE_DUPLICATE");
      seenLineIds.add(id);
      seenLineKeys.add(lineKey);
      responseIds.add(id);
      const progress = progressById.get(id);
      const name = text(line.name, 500) || "Producto pendiente de identificar";
      const received = line.receivedQuantity == null || line.receivedQuantity === "" ? null : Number(line.receivedQuantity);
      const billed = line.billedQuantity == null || line.billedQuantity === "" ? null : Number(line.billedQuantity);
      const units = Math.max(1, Number(line.unitsPerPackage) || 1);
      const total = received == null || !Number.isInteger(received) || received < 0 ? 0 : received * units;
      const barcode = validateBarcode(line.barcode);
      const values = {
        id,
        lineKey,
        original: text(line.originalDescription, 1000) || name,
        name,
        brand: text(line.brand, 200),
        presentation: normalizePresentation(text(line.presentation, 250)),
        size: text(line.size, 200),
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
        sourceUrl: text(line.barcodeSourceUrl, 2000),
        sourceTitle: text(line.barcodeSourceTitle, 500),
        differences: Array.isArray(line.barcodeDifferences) ? line.barcodeDifferences.map(String).slice(0, 20) : [],
        lookupStatus: ["found_exact", "suggestion", "pending"].includes(String(line.barcodeLookupStatus)) ? String(line.barcodeLookupStatus) : "pending",
        evidence: line.fieldEvidence && typeof line.fieldEvidence === "object" ? line.fieldEvidence : {},
        confirmed: line.barcodeConfirmed === true && barcode.valid ? 1 : 0,
        selected: line.selectedForIngress !== false && line.selected !== false ? 1 : 0,
        reviewSavedAt: requestedReviewedLineIds.has(sourceId) || requestedReviewedLineIds.has(id) ? now : null,
        status: text(line.status, 50) || "requires_confirm_code",
        productId: Number(line.matchProductId) > 0 ? Number(line.matchProductId) : null,
        quoteId: Number(line.matchNonInventoryId) > 0 ? Number(line.matchNonInventoryId) : null,
        action: text(line.action, 20) || "pending",
        level: text(line.barcodeLevel, 30),
        warnings: Array.isArray(line.warnings) ? line.warnings.map(String).slice(0, 30) : [],
      };
      if (values.action === "ignore" && progress && progress.activeQuantity > 0) {
        throw new Error(`INVENTORY_ACTIVE_LINE_CANNOT_BE_OMITTED:${name}`);
      }
      if (values.reviewSavedAt) reviewedLineIds.add(id);
      if (stored?.processed_operation_id && (progress?.activeQuantity || 0) > 0) {
        statements.push(db.prepare(`UPDATE inventory_document_lines SET
          selected_for_ingress=?,review_saved_at=COALESCE(review_saved_at,?),status=?,action=?,
          match_product_id=COALESCE(?,match_product_id),match_non_inventory_id=?,updated_at=?
          WHERE id=? AND document_id=?`).bind(
          values.selected, values.reviewSavedAt, values.status, values.action,
          values.productId, values.quoteId, now, values.id, documentId,
        ));
        return;
      }
      if (stored?.processed_operation_id) {
        // A completed reversal returns the active quantity to zero. Keep the
        // original operation id as audit evidence, but release the invoice
        // line for a corrected, future ingress instead of leaving a stale lock.
        statements.push(db.prepare(`UPDATE inventory_document_lines SET
          line_index=?,original_description=?,name=?,brand=?,presentation=?,size=?,flavor=?,concentration=?,billed_quantity=?,
          received_quantity=?,units_per_package=?,total_to_add=?,barcode=?,canonical_barcode=?,barcode_type=?,secondary_id=?,secondary_type=?,
          barcode_method=?,barcode_source=?,barcode_source_url=?,barcode_source_title=?,barcode_differences_json=?,barcode_lookup_status=?,
          field_evidence_json=?,barcode_confirmed=?,selected_for_ingress=?,review_saved_at=CASE WHEN ? IS NOT NULL THEN ? ELSE review_saved_at END,
          status=?,match_product_id=?,match_non_inventory_id=?,action=?,barcode_level=?,warnings_json=?,updated_at=?
          WHERE id=? AND document_id=?`).bind(
          orderedLineIndex, values.original, values.name, values.brand || null, values.presentation || null, values.size || null,
          values.flavor || null, values.concentration || null, values.billed, values.received, values.units, values.total,
          values.barcode, values.canonical, values.type, values.secondaryId || null, values.secondaryType || null,
          values.method || null, values.source || null, values.sourceUrl || null, values.sourceTitle || null,
          JSON.stringify(values.differences), values.lookupStatus, JSON.stringify(values.evidence), values.confirmed, values.selected,
          values.reviewSavedAt, values.reviewSavedAt, values.status === "processed" ? "confirmed" : values.status,
          values.productId, values.quoteId, values.action, values.level || null, JSON.stringify(values.warnings), now, values.id, documentId,
        ));
        return;
      }
      statements.push(db.prepare(`INSERT INTO inventory_document_lines (
        id,document_id,line_key,line_index,original_description,name,brand,presentation,size,flavor,concentration,billed_quantity,
        received_quantity,units_per_package,total_to_add,barcode,canonical_barcode,barcode_type,secondary_id,secondary_type,
        barcode_method,barcode_source,barcode_source_url,barcode_source_title,barcode_differences_json,barcode_lookup_status,
        field_evidence_json,barcode_confirmed,selected_for_ingress,review_saved_at,confidence,status,match_product_id,match_non_inventory_id,action,barcode_level,warnings_json,
        created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        line_index=excluded.line_index,original_description=excluded.original_description,name=excluded.name,brand=excluded.brand,presentation=excluded.presentation,
        size=excluded.size,flavor=excluded.flavor,concentration=excluded.concentration,billed_quantity=excluded.billed_quantity,
        received_quantity=excluded.received_quantity,units_per_package=excluded.units_per_package,total_to_add=excluded.total_to_add,
        barcode=excluded.barcode,canonical_barcode=excluded.canonical_barcode,barcode_type=excluded.barcode_type,
        secondary_id=excluded.secondary_id,secondary_type=excluded.secondary_type,barcode_method=excluded.barcode_method,
        barcode_source=excluded.barcode_source,barcode_source_url=excluded.barcode_source_url,
        barcode_source_title=excluded.barcode_source_title,barcode_differences_json=excluded.barcode_differences_json,
        barcode_lookup_status=excluded.barcode_lookup_status,field_evidence_json=excluded.field_evidence_json,
        barcode_confirmed=excluded.barcode_confirmed,
        selected_for_ingress=excluded.selected_for_ingress,
        review_saved_at=CASE WHEN excluded.review_saved_at IS NOT NULL THEN excluded.review_saved_at ELSE inventory_document_lines.review_saved_at END,
        status=CASE WHEN inventory_document_lines.processed_operation_id IS NULL THEN excluded.status ELSE inventory_document_lines.status END,
        match_product_id=excluded.match_product_id,match_non_inventory_id=excluded.match_non_inventory_id,
        action=excluded.action,barcode_level=excluded.barcode_level,warnings_json=excluded.warnings_json,updated_at=excluded.updated_at
      WHERE inventory_document_lines.processed_operation_id IS NULL`).bind(
        values.id, documentId, values.lineKey, orderedLineIndex, values.original, values.name, values.brand || null, values.presentation || null,
        values.size || null, values.flavor || null, values.concentration || null, values.billed, values.received, values.units, values.total,
        values.barcode, values.canonical, values.type, values.secondaryId || null, values.secondaryType || null,
        values.method || null, values.source || null, values.sourceUrl || null, values.sourceTitle || null,
        JSON.stringify(values.differences), values.lookupStatus, JSON.stringify(values.evidence), values.confirmed, values.selected, values.reviewSavedAt, 100,
        values.status, values.productId, values.quoteId, values.action,
        values.level || null, JSON.stringify(values.warnings), now, now,
      ));
    });
    if (statements.length) {
      statements.push(documentStatusStatement(db, documentId, now));
      await db.batch(statements);
    }
    const loaded = await loadIntakeDocument(db, documentId);
    const updated = loaded?.lines.filter((line) => responseIds.has(line.id)) || [];
    return Response.json({ saved: true, document: loaded?.document, lines: updated, reviewedLineIds: [...reviewedLineIds] });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "INVENTORY_LINE_REFERENCE_CONFLICT") {
      return Response.json({
        error: "La factura reanudada mezcla referencias de dos líneas distintas. Recargala antes de guardar; no se modificó el inventario.",
        title: "Factura desactualizada",
        code: "INVENTORY_LINE_REFERENCE_CONFLICT",
      }, { status: 409 });
    }
    if (message === "INVENTORY_LINE_REFERENCE_DUPLICATE") {
      return Response.json({
        error: "La misma línea aparece más de una vez en esta actualización. Recargala antes de guardar; no se modificó el inventario.",
        title: "Línea repetida",
        code: "INVENTORY_LINE_REFERENCE_DUPLICATE",
      }, { status: 409 });
    }
    if (message.startsWith("INVENTORY_ACTIVE_LINE_CANNOT_BE_OMITTED:")) {
      const name = message.slice("INVENTORY_ACTIVE_LINE_CANNOT_BE_OMITTED:".length);
      return Response.json({
        error: `“${name}” todavía tiene unidades activas en inventario. Revertí primero su ingreso si necesitás dejarla como omitida. No se modificó el inventario.`,
        title: "La línea ya tiene inventario ingresado",
        code: "INVENTORY_ACTIVE_LINE_CANNOT_BE_OMITTED",
      }, { status: 409 });
    }
    return errorResponse(error);
  }
}
