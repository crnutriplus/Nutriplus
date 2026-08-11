import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { lineFromRow, resolveParsedLine, type IntakeLineDto } from "@/lib/inventory-intake";
import { parseInvoicePages, type InvoicePageText } from "@/lib/invoice-parser";

type AnalyzePayload = {
  fingerprint?: unknown;
  fileName?: unknown;
  mimeTypes?: unknown;
  pages?: unknown;
  warnings?: unknown;
};

function safeJsonArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).slice(0, 100) : [];
}

function documentFromRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    fingerprint: String(row.file_fingerprint),
    fileName: String(row.file_name),
    mimeTypes: JSON.parse(String(row.mime_types_json || "[]")) as string[],
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
    confirmedBy: row.confirmed_by ? String(row.confirmed_by) : "",
  };
}

async function attachMatches(db: D1Database, lines: IntakeLineDto[]) {
  const productIds = [...new Set(lines.map((line) => line.matchProductId).filter((id): id is number => Boolean(id)))];
  const quoteIds = [...new Set(lines.map((line) => line.matchNonInventoryId).filter((id): id is number => Boolean(id)))];
  const products = productIds.length
    ? await db.prepare("SELECT id,name,code,quantity_available FROM products WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(productIds)).all<Record<string, unknown>>()
    : { results: [] as Record<string, unknown>[] };
  const quotes = quoteIds.length
    ? await db.prepare("SELECT id,name,code FROM non_inventory_quotes WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(quoteIds)).all<Record<string, unknown>>()
    : { results: [] as Record<string, unknown>[] };
  return lines.map((line) => {
    const product = products.results.find((row) => Number(row.id) === line.matchProductId);
    const quote = quotes.results.find((row) => Number(row.id) === line.matchNonInventoryId);
    return {
      ...line,
      match: product ? { source: "inventory" as const, id: Number(product.id), name: String(product.name), code: product.code ? String(product.code) : null, quantityAvailable: Number(product.quantity_available ?? 0) }
        : quote ? { source: "no_inventory" as const, id: Number(quote.id), name: String(quote.name), code: quote.code ? String(quote.code) : null, quantityAvailable: null }
          : null,
    };
  });
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const db = getD1();
    const url = new URL(request.url);
    if (url.searchParams.get("history") !== "1") {
      const documents = await db.prepare("SELECT * FROM inventory_documents ORDER BY created_at DESC,id DESC LIMIT 30").all<Record<string, unknown>>();
      return Response.json({ documents: documents.results.map(documentFromRow) });
    }
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
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as AnalyzePayload;
    const fingerprint = typeof payload.fingerprint === "string" ? payload.fingerprint.trim().toLowerCase() : "";
    const fileName = typeof payload.fileName === "string" ? payload.fileName.trim().slice(0, 500) : "";
    const mimeTypes = safeJsonArray(payload.mimeTypes).slice(0, 20);
    const pages = Array.isArray(payload.pages) ? payload.pages.slice(0, 100).map((page, index) => {
      const source = page && typeof page === "object" ? page as Record<string, unknown> : {};
      return {
        pageNumber: Number(source.pageNumber || index + 1),
        text: typeof source.text === "string" ? source.text.slice(0, 150000) : "",
        confidence: Math.max(0, Math.min(100, Number(source.confidence ?? 0))),
        source: source.source === "pdf_text" ? "pdf_text" : "ocr",
      } satisfies InvoicePageText;
    }) : [];
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) return Response.json({ error: "No se pudo verificar la huella digital de la factura." }, { status: 400 });
    if (!fileName || !pages.length) return Response.json({ error: "La factura no contiene páginas para analizar." }, { status: 400 });
    if (pages.reduce((total, page) => total + page.text.length, 0) > 1_500_000) return Response.json({ error: "La factura contiene demasiado texto para una sola carga." }, { status: 413 });

    await ensureDatabase();
    const db = getD1();
    const existing = await db.prepare("SELECT * FROM inventory_documents WHERE file_fingerprint=? LIMIT 1").bind(fingerprint).first<Record<string, unknown>>();
    if (existing) {
      const storedLines = await db.prepare("SELECT * FROM inventory_document_lines WHERE document_id=? ORDER BY page_number,id").bind(String(existing.id)).all<Record<string, unknown>>();
      const lines = await attachMatches(db, storedLines.results.map(lineFromRow));
      return Response.json({ document: documentFromRow(existing), lines, duplicate: true, exactDuplicate: true });
    }

    const parsed = parseInvoicePages(pages);
    const priorDocuments = await db.prepare(`SELECT * FROM inventory_documents WHERE provider=? AND (
      (?<>'' AND invoice_number=?) OR (?<>'' AND order_number=? AND COALESCE(shipment_number,'')=?) OR (?<>'' AND order_number=?))
      ORDER BY created_at DESC LIMIT 10`)
      .bind(parsed.provider, parsed.invoiceNumber, parsed.invoiceNumber, parsed.orderNumber, parsed.orderNumber, parsed.shipmentNumber, parsed.orderNumber, parsed.orderNumber)
      .all<Record<string, unknown>>();
    const sameInvoiceOrShipment = priorDocuments.results.find((row) =>
      (parsed.invoiceNumber && String(row.invoice_number || "") === parsed.invoiceNumber)
      || (parsed.orderNumber && parsed.shipmentNumber && String(row.order_number || "") === parsed.orderNumber && String(row.shipment_number || "") === parsed.shipmentNumber));
    const priorShipment = priorDocuments.results.find((row) => parsed.orderNumber && String(row.order_number || "") === parsed.orderNumber && String(row.shipment_number || "") !== parsed.shipmentNumber);
    const documentId = `doc-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const products = await db.prepare("SELECT id,name,code,brand,presentation,quantity_available FROM products").all<Record<string, unknown>>();
    const quotes = await db.prepare("SELECT id,name,code FROM non_inventory_quotes").all<Record<string, unknown>>();
    const aliases = await db.prepare("SELECT * FROM supplier_product_aliases").all<Record<string, unknown>>();
    const warnings = [...safeJsonArray(payload.warnings), ...parsed.warnings];
    if (sameInvoiceOrShipment) warnings.push("Ya existe una factura o envío con los mismos identificadores. Las líneas procesadas permanecerán bloqueadas.");
    else if (priorShipment) warnings.push("Ya existe otro envío del mismo pedido. Este documento puede procesarse como un envío parcial diferente.");

    const lines = parsed.lines.map((line) => resolveParsedLine({
      id: `iline-${crypto.randomUUID()}`,
      line,
      provider: parsed.provider,
      products: products.results as never[],
      quotes: quotes.results as never[],
      aliases: aliases.results as never[],
    })).map((line) => parsed.status === "draft" ? line : { ...line, status: "ignored" as const, action: "ignore" as const, warnings: [...line.warnings, "El documento completo está bloqueado porque parece una devolución o nota de crédito."] });

    const statements: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO inventory_documents (
        id,file_fingerprint,file_name,mime_types_json,provider,order_number,invoice_number,shipment_number,
        document_date,page_count,status,warnings_json,duplicate_of,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        documentId, fingerprint, fileName, JSON.stringify(mimeTypes), parsed.provider, parsed.orderNumber || null,
        parsed.invoiceNumber || null, parsed.shipmentNumber || null, parsed.documentDate || null, pages.length,
        parsed.status, JSON.stringify([...new Set(warnings)]), sameInvoiceOrShipment ? String(sameInvoiceOrShipment.id) : null, now, now,
      ),
    ];
    lines.forEach((line) => statements.push(db.prepare(`INSERT INTO inventory_document_lines (
      id,document_id,line_key,page_number,original_description,name,brand,presentation,flavor,concentration,
      billed_quantity,received_quantity,units_per_package,total_to_add,barcode,canonical_barcode,barcode_type,
      secondary_id,secondary_type,barcode_method,barcode_source,confidence,status,match_product_id,
      match_non_inventory_id,action,barcode_level,warnings_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      line.id, documentId, line.lineKey, line.pageNumber, line.originalDescription, line.name, line.brand || null,
      line.presentation || null, line.flavor || null, line.concentration || null, line.billedQuantity,
      line.receivedQuantity, line.unitsPerPackage, line.totalToAdd, line.barcode || null, line.canonicalBarcode || null,
      line.barcodeType || null, line.secondaryId || null, line.secondaryType || null, line.barcodeMethod || null,
      line.barcodeSource || null, line.confidence, line.status, line.matchProductId, line.matchNonInventoryId,
      line.action, line.barcodeLevel || null, JSON.stringify(line.warnings), now, now,
    )));
    await db.batch(statements);
    const stored = await db.prepare("SELECT * FROM inventory_documents WHERE id=?").bind(documentId).first<Record<string, unknown>>();
    return Response.json({ document: documentFromRow(stored!), lines, duplicate: Boolean(sameInvoiceOrShipment), exactDuplicate: false }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
