import { resolveParsedLine, type IntakeLineDto } from "./inventory-intake";
import type { ParsedInvoice } from "./invoice-parser";

type ReplaceLinesOptions = {
  preserveReviewed?: boolean;
};

export async function replaceDocumentLinesFromParsed(
  db: D1Database,
  documentId: string,
  parsed: ParsedInvoice,
  options: ReplaceLinesOptions = {},
) {
  const preserveReviewed = options.preserveReviewed !== false;
  const [products, quotes, aliases, existing] = await Promise.all([
    db.prepare("SELECT id,name,code,brand,presentation,quantity_available FROM products").all<Record<string, unknown>>(),
    db.prepare("SELECT id,name,code FROM non_inventory_quotes").all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM supplier_product_aliases").all<Record<string, unknown>>(),
    db.prepare("SELECT id,line_key,review_saved_at,processed_operation_id FROM inventory_document_lines WHERE document_id=?").bind(documentId).all<Record<string, unknown>>(),
  ]);
  const preservedKeys = new Set(existing.results.filter((line) => Boolean(line.processed_operation_id) || preserveReviewed && Boolean(line.review_saved_at)).map((line) => String(line.line_key)));
  const lines = parsed.lines.map((line) => resolveParsedLine({
    id: `iline-${crypto.randomUUID()}`,
    line,
    provider: parsed.provider,
    products: products.results as never[],
    quotes: quotes.results as never[],
    aliases: aliases.results as never[],
  })).map((line) => parsed.status === "draft" ? line : {
    ...line,
    selectedForIngress: false,
    status: "ignored" as const,
    action: "ignore" as const,
    warnings: [...line.warnings, "El documento completo está bloqueado porque parece una devolución o nota de crédito."],
  }).filter((line) => !preservedKeys.has(line.lineKey));

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM inventory_document_lines WHERE document_id=? AND processed_operation_id IS NULL
      ${preserveReviewed ? "AND review_saved_at IS NULL" : ""}`).bind(documentId),
  ];
  lines.forEach((line, lineIndex) => statements.push(insertLineStatement(db, documentId, line, now, lineIndex)));
  await db.batch(statements);
  return lines;
}

export function insertLineStatement(db: D1Database, documentId: string, line: IntakeLineDto, now = new Date().toISOString(), lineIndex = 0) {
  return db.prepare(`INSERT INTO inventory_document_lines (
    id,document_id,line_key,line_index,page_number,original_description,name,brand,presentation,size,flavor,concentration,
    billed_quantity,received_quantity,units_per_package,total_to_add,barcode,canonical_barcode,barcode_type,
    secondary_id,secondary_type,barcode_method,barcode_source,barcode_source_url,barcode_source_title,
    barcode_differences_json,barcode_lookup_status,field_evidence_json,barcode_confirmed,selected_for_ingress,
    review_saved_at,confidence,status,match_product_id,match_non_inventory_id,action,barcode_level,warnings_json,
    created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    line.id, documentId, line.lineKey, lineIndex, line.pageNumber, line.originalDescription, line.name, line.brand || null,
    line.presentation || null, line.size || null, line.flavor || null, line.concentration || null,
    line.billedQuantity, line.receivedQuantity, line.unitsPerPackage, line.totalToAdd, line.barcode || null,
    line.canonicalBarcode || null, line.barcodeType || null, line.secondaryId || null, line.secondaryType || null,
    line.barcodeMethod || null, line.barcodeSource || null, line.barcodeSourceUrl || null, line.barcodeSourceTitle || null,
    JSON.stringify(line.barcodeDifferences || []), line.barcodeLookupStatus || "pending", JSON.stringify(line.fieldEvidence || {}),
    line.barcodeConfirmed ? 1 : 0, line.selectedForIngress ? 1 : 0, line.reviewSavedAt || null, line.confidence,
    line.status, line.matchProductId, line.matchNonInventoryId, line.action, line.barcodeLevel || null,
    JSON.stringify(line.warnings), now, now,
  );
}

export async function duplicateForParsedInvoice(db: D1Database, documentId: string, parsed: ParsedInvoice) {
  if (!parsed.orderNumber) return { duplicateOf: "", warning: "" };
  const prior = await db.prepare(`SELECT * FROM inventory_documents
    WHERE id<>? AND provider=? AND order_number=? AND status IN ('draft','reviewing','partial','processed')
    ORDER BY created_at DESC LIMIT 10`).bind(documentId, parsed.provider, parsed.orderNumber).all<Record<string, unknown>>();
  const sameInvoiceOrShipment = prior.results.find((row) => {
    const previousTracking = String(row.shipment_number || "");
    return !parsed.shipmentNumber || !previousTracking || previousTracking === parsed.shipmentNumber;
  });
  if (sameInvoiceOrShipment) {
    return {
      duplicateOf: String(sameInvoiceOrShipment.id),
      warning: "Ya existe una factura o envío con los mismos identificadores. Las líneas procesadas permanecerán bloqueadas.",
    };
  }
  const otherShipment = prior.results.find((row) => {
    const previousTracking = String(row.shipment_number || "");
    return Boolean(parsed.shipmentNumber && previousTracking && previousTracking !== parsed.shipmentNumber);
  });
  return {
    duplicateOf: "",
    warning: otherShipment ? "Ya existe otro envío del mismo pedido. Este documento puede procesarse como un envío parcial diferente." : "",
  };
}
