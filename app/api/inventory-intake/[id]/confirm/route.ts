import { ensureDatabase, getD1 } from "@/db";
import { validateBarcode } from "@/lib/barcodes";
import { descriptionSignature, descriptionsCompatible, lineFromRow, presentationSignature } from "@/lib/inventory-intake";
import { documentStatusStatement, loadDocumentMovementRows, progressForLine } from "@/lib/inventory-line-progress";
import { invoiceFinanceStatements } from "@/lib/inventory-invoice-finance";
import { normalizeName, productFromRow } from "@/lib/pricing";
import { requestUserLabel } from "@/lib/request-user";

type ConfirmLine = {
  id?: unknown;
  lineKey?: unknown;
  name?: unknown;
  brand?: unknown;
  presentation?: unknown;
  size?: unknown;
  flavor?: unknown;
  concentration?: unknown;
  originalDescription?: unknown;
  billedQuantity?: unknown;
  receivedQuantity?: unknown;
  unitsPerPackage?: unknown;
  barcode?: unknown;
  secondaryId?: unknown;
  secondaryType?: unknown;
  barcodeMethod?: unknown;
  barcodeSource?: unknown;
  barcodeSourceUrl?: unknown;
  barcodeSourceTitle?: unknown;
  barcodeDifferences?: unknown;
  barcodeLookupStatus?: unknown;
  fieldEvidence?: unknown;
  barcodeConfirmed?: unknown;
  barcodeLevel?: unknown;
  action?: unknown;
  matchProductId?: unknown;
  matchNonInventoryId?: unknown;
  selected?: unknown;
  requestedQuantity?: unknown;
};

type CleanLine = {
  id: string;
  lineKey: string;
  lineIndex: number;
  name: string;
  brand: string;
  presentation: string;
  size: string;
  flavor: string;
  concentration: string;
  originalDescription: string;
  billedQuantity: number | null;
  receivedQuantity: number;
  unitsPerPackage: number;
  totalToAdd: number;
  originalTotal: number;
  barcode: string;
  canonicalBarcode: string;
  barcodeType: string;
  secondaryId: string;
  secondaryType: string;
  barcodeMethod: string;
  barcodeSource: string;
  barcodeSourceUrl: string;
  barcodeSourceTitle: string;
  barcodeDifferences: string[];
  barcodeLookupStatus: string;
  fieldEvidence: Record<string, unknown>;
  barcodeConfirmed: boolean;
  barcodeLevel: string;
  action: "existing" | "move" | "create";
  matchProductId: number | null;
  matchNonInventoryId: number | null;
};

class InventoryConfirmError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "INVENTORY_REVIEW_REQUIRED",
    public title = "Revisión requerida",
  ) { super(message); }
}

function confirmErrorResponse(error: unknown) {
  if (error instanceof InventoryConfirmError) {
    return Response.json({ error: error.message, title: error.title, code: error.code }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "";
  if (/inventory_movements_invoice_line_unique|UNIQUE constraint failed: inventory_movements\.document_line_id/i.test(message)) {
    return Response.json({
      error: "Este producto ya fue agregado al inventario desde esta factura. No se volverá a sumar.",
      title: "Producto ya ingresado",
      code: "INVENTORY_LINE_ALREADY_CONFIRMED",
    }, { status: 409 });
  }
  if (/INVENTORY_LINE_CAPACITY_EXCEEDED/i.test(message)) {
    return Response.json({
      error: "La cantidad solicitada supera las unidades pendientes de esta factura. Volvé a cargar la factura para ver el saldo actual; no se realizaron cambios nuevos en el inventario.",
      title: "Cantidad mayor a la disponible",
      code: "INVENTORY_QUANTITY_EXCEEDS_AVAILABLE",
    }, { status: 409 });
  }
  if (/UNIQUE constraint failed/i.test(message)) {
    return Response.json({
      error: "Ya existe un producto con ese nombre o código. Seleccionalo para continuar; no se realizaron cambios nuevos en el inventario.",
      title: "Producto existente",
      code: "INVENTORY_PRODUCT_ALREADY_EXISTS",
    }, { status: 409 });
  }
  const reference = crypto.randomUUID().slice(0, 8).toUpperCase();
  console.error("[INVENTORY_CONFIRM]", { code: "DATABASE_WRITE_FAILED", reference, errorName: error instanceof Error ? error.name : typeof error });
  return Response.json({
    error: "No pudimos guardar los cambios en este momento. El progreso guardado anteriormente se conserva y no se realizaron cambios nuevos en el inventario. Intentá nuevamente.",
    title: "Problema temporal de NutriPlus",
    code: "DATABASE_WRITE_FAILED",
    reference,
  }, { status: 500 });
}

function cleanText(value: unknown, max = 500) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function cleanInteger(value: unknown, label: string, minimum = 0, maximum = 1_000_000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new InventoryConfirmError(
      `${label} tiene una cantidad inválida. Corregila antes de continuar. El inventario no fue modificado.`,
      400,
      "INVENTORY_INVALID_QUANTITY",
      "Cantidad inválida",
    );
  }
  return number;
}

function operationResult(operation: Record<string, unknown>, products: Record<string, unknown>[], movements: Record<string, unknown>[]) {
  return {
    operation: {
      id: String(operation.id),
      documentId: operation.document_id ? String(operation.document_id) : "",
      status: String(operation.status),
      operationType: String(operation.operation_type),
      lineCount: Number(operation.line_count),
      totalUnits: Number(operation.total_units),
      confirmedAt: operation.confirmed_at ? String(operation.confirmed_at) : "",
      confirmedBy: operation.confirmed_by ? String(operation.confirmed_by) : "",
      verificationStatus: String(operation.verification_status),
    },
    products: products.map(productFromRow),
    movements: movements.map((movement) => ({
      id: String(movement.id),
      productId: Number(movement.product_id),
      productName: String(movement.product_name),
      previousQuantity: Number(movement.previous_quantity),
      quantityAdded: Number(movement.quantity_change),
      resultingQuantity: Number(movement.resulting_quantity),
    })),
  };
}

async function loadOperationResult(db: D1Database, operationId: string) {
  const operation = await db.prepare("SELECT * FROM inventory_operations WHERE id=? LIMIT 1").bind(operationId).first<Record<string, unknown>>();
  if (!operation) return null;
  const movements = await db.prepare("SELECT * FROM inventory_movements WHERE operation_id=? ORDER BY id").bind(operationId).all<Record<string, unknown>>();
  const productIds = [...new Set(movements.results.map((movement) => Number(movement.product_id)))];
  const products = productIds.length
    ? await db.prepare("SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(productIds)).all<Record<string, unknown>>()
    : { results: [] as Record<string, unknown>[] };
  return operationResult(operation, products.results, movements.results);
}

function canonicalOwners(rows: Record<string, unknown>[]) {
  const result = new Map<string, Record<string, unknown>[]>();
  rows.forEach((row) => {
    const barcode = validateBarcode(row.code);
    if (!barcode.valid || !barcode.canonical) return;
    result.set(barcode.canonical, [...(result.get(barcode.canonical) || []), row]);
  });
  return result;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let operationId = "";
  try {
    const documentId = (await context.params).id;
    const payload = await request.json() as Record<string, unknown> & { lines?: ConfirmLine[] };
    operationId = cleanText(payload.operationId, 160);
    if (!/^[A-Za-z0-9:_-]{8,160}$/.test(operationId)) return Response.json({ error: "La confirmación no tiene un identificador seguro." }, { status: 400 });
    const sourceLines = Array.isArray(payload.lines) ? payload.lines.filter((line) => line?.selected !== false).slice(0, 500) : [];
    if (!sourceLines.length) return Response.json({ error: "Seleccioná al menos una línea confirmada para ingresar." }, { status: 400 });

    await ensureDatabase();
    const db = getD1();
    const priorResult = await loadOperationResult(db, operationId);
    if (priorResult?.operation.status === "completed") return Response.json({ ...priorResult, idempotent: true });
    if (priorResult) return Response.json({ operation: priorResult.operation, pendingVerification: true }, { status: 202 });

    const document = await db.prepare("SELECT * FROM inventory_documents WHERE id=? LIMIT 1").bind(documentId).first<Record<string, unknown>>();
    if (!document) return Response.json({ error: "No se encontró la factura que intentás confirmar." }, { status: 404 });
    if (["credit_note", "return"].includes(String(document.status))) return Response.json({ error: "Una devolución o nota de crédito no puede procesarse como ingreso de inventario." }, { status: 409 });

    const storedLines = await db.prepare("SELECT * FROM inventory_document_lines WHERE document_id=?").bind(documentId).all<Record<string, unknown>>();
    const movementRows = await loadDocumentMovementRows(db, [documentId]);
    const storedById = new Map(storedLines.results.map((line) => [String(line.id), line]));
    const progressById = new Map(storedLines.results.map((line) => {
      const dto = lineFromRow(line);
      return [dto.id, progressForLine(dto, movementRows)] as const;
    }));
    const productsResult = await db.prepare("SELECT * FROM products").all<Record<string, unknown>>();
    const quotesResult = await db.prepare("SELECT * FROM non_inventory_quotes").all<Record<string, unknown>>();
    const aliasesResult = await db.prepare("SELECT * FROM supplier_product_aliases").all<Record<string, unknown>>();
    const productCodes = canonicalOwners(productsResult.results);
    const quoteCodes = canonicalOwners(quotesResult.results);
    const errors: string[] = [];
    const alreadyProcessed = sourceLines.flatMap((source) => {
      const id = cleanText(source.id, 100);
      const progress = progressById.get(id);
      return progress && progress.originalQuantity > 0 && progress.availableQuantity === 0 ? [id] : [];
    });
    if (alreadyProcessed.length) return Response.json({
      error: "Este producto ya fue agregado completamente al inventario desde esta factura. No quedan unidades pendientes y no se volverá a sumar.",
      title: "Producto ya ingresado",
      code: "INVENTORY_LINE_ALREADY_CONFIRMED",
      lineIds: alreadyProcessed,
    }, { status: 409 });
    const pendingCodeNames: string[] = [];

    const lines: CleanLine[] = sourceLines.map((source, index) => {
      const id = cleanText(source.id, 100) || `iline-${crypto.randomUUID()}`;
      const lineKey = cleanText(source.lineKey, 150) || `manual-${id}`;
      const stored = storedById.get(id);
      const name = cleanText(source.name, 500);
      const originalDescription = cleanText(source.originalDescription, 1000) || name;
      if (!name) errors.push(`La línea ${index + 1} no tiene nombre de producto.`);
      const quantityLabel = `El producto “${name || `línea ${index + 1}`}”`;
      const receivedQuantity = cleanInteger(source.receivedQuantity, quantityLabel, 0, 100000);
      const unitsPerPackage = cleanInteger(source.unitsPerPackage, quantityLabel, 1, 10000);
      const invoiceTotal = receivedQuantity * unitsPerPackage;
      const progress = progressById.get(id);
      if (progress?.progressInconsistent) {
        throw new InventoryConfirmError(
          `El historial de cantidades de “${name || `línea ${index + 1}`}” no es consistente con la factura. Revisá sus movimientos antes de continuar; el inventario no fue modificado.`,
          409,
          "INVENTORY_LINE_PROGRESS_INCONSISTENT",
          "Historial de cantidades por revisar",
        );
      }
      const requestedQuantity = source.requestedQuantity == null
        ? invoiceTotal
        : cleanInteger(source.requestedQuantity, quantityLabel, 1, 1_000_000);
      const originalTotal = progress && progress.ingressQuantity > 0 ? progress.originalQuantity : invoiceTotal;
      const totalToAdd = requestedQuantity;
      if (totalToAdd <= 0) errors.push(`La línea ${index + 1} no agrega ninguna unidad.`);
      if (progress && totalToAdd > progress.availableQuantity) {
        throw new InventoryConfirmError(
          `Intentaste ingresar ${totalToAdd} unidades de “${name || `línea ${index + 1}`}”, pero solo quedan ${progress.availableQuantity} pendientes. Volvé a cargar la factura y confirmá únicamente el saldo disponible. El inventario no fue modificado.`,
          409,
          "INVENTORY_QUANTITY_EXCEEDS_AVAILABLE",
          "Cantidad mayor a la disponible",
        );
      }
      if (!progress && totalToAdd > originalTotal) {
        throw new InventoryConfirmError(
          `Intentaste ingresar más unidades que las registradas en la factura para “${name || `línea ${index + 1}`}”. Corregí la cantidad antes de continuar. El inventario no fue modificado.`,
          409,
          "INVENTORY_QUANTITY_EXCEEDS_AVAILABLE",
          "Cantidad mayor a la factura",
        );
      }
      const billedRaw = source.billedQuantity;
      const billedQuantity = billedRaw == null || billedRaw === "" ? null : cleanInteger(billedRaw, quantityLabel, 0, 100000);
      const barcode = validateBarcode(source.barcode);
      if (!barcode.valid || !barcode.normalized || !barcode.canonical) errors.push(`Línea ${index + 1}: ${barcode.error || "el código de barras no es válido"}`);
      const barcodeConfirmed = source.barcodeConfirmed === true;
      if (!barcodeConfirmed) {
        pendingCodeNames.push(name || `línea ${index + 1}`);
        errors.push(`El código de barras de la línea ${index + 1} todavía no está confirmado.`);
      }
      const action = cleanText(source.action, 20) as CleanLine["action"];
      if (!["existing", "move", "create"].includes(action)) errors.push(`La línea ${index + 1} todavía no tiene una acción confirmada.`);
      const barcodeLevel = cleanText(source.barcodeLevel, 30) || (unitsPerPackage === 1 ? "unit" : "");
      if (unitsPerPackage > 1 && !["unit", "package", "distribution", "set"].includes(barcodeLevel)) errors.push(`La línea ${index + 1} necesita definir si el código es de unidad, paquete, caja o set.`);
      return {
        id,
        lineKey,
        lineIndex: stored ? Number(stored.line_index || 0) : storedLines.results.length + index,
        name,
        brand: cleanText(source.brand, 200),
        presentation: cleanText(source.presentation, 250),
        size: cleanText(source.size, 200),
        flavor: cleanText(source.flavor, 150),
        concentration: cleanText(source.concentration, 100),
        originalDescription,
        billedQuantity,
        receivedQuantity,
        unitsPerPackage,
        totalToAdd,
        originalTotal,
        barcode: barcode.normalized || "",
        canonicalBarcode: barcode.canonical || "",
        barcodeType: barcode.type || "",
        secondaryId: cleanText(source.secondaryId, 200),
        secondaryType: cleanText(source.secondaryType, 40),
        barcodeMethod: cleanText(source.barcodeMethod, 80) || "manual",
        barcodeSource: cleanText(source.barcodeSource, 500) || "Confirmado por el usuario",
        barcodeSourceUrl: cleanText(source.barcodeSourceUrl, 2000),
        barcodeSourceTitle: cleanText(source.barcodeSourceTitle, 500),
        barcodeDifferences: Array.isArray(source.barcodeDifferences) ? source.barcodeDifferences.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, 20) : [],
        barcodeLookupStatus: ["found_exact", "suggestion", "pending"].includes(cleanText(source.barcodeLookupStatus, 30)) ? cleanText(source.barcodeLookupStatus, 30) : "pending",
        fieldEvidence: source.fieldEvidence && typeof source.fieldEvidence === "object" && !Array.isArray(source.fieldEvidence) ? source.fieldEvidence as Record<string, unknown> : {},
        barcodeConfirmed,
        barcodeLevel,
        action,
        matchProductId: Number.isInteger(Number(source.matchProductId)) && Number(source.matchProductId) > 0 ? Number(source.matchProductId) : null,
        matchNonInventoryId: Number.isInteger(Number(source.matchNonInventoryId)) && Number(source.matchNonInventoryId) > 0 ? Number(source.matchNonInventoryId) : null,
      };
    });

    const duplicateDocumentId = document.duplicate_of ? String(document.duplicate_of) : "";
    if (duplicateDocumentId) {
      const prior = await db.prepare(`SELECT m.canonical_barcode,m.secondary_id,l.original_description
        FROM inventory_movements m LEFT JOIN inventory_document_lines l ON l.id=m.document_line_id
        JOIN inventory_operations o ON o.id=m.operation_id
        WHERE o.document_id=? AND o.status='completed' AND o.operation_type='ingress'`).bind(duplicateDocumentId).all<Record<string, unknown>>();
      lines.forEach((line, index) => {
        if (prior.results.some((movement) => String(movement.canonical_barcode || "") === line.canonicalBarcode
          && (!line.secondaryId || !movement.secondary_id || String(movement.secondary_id).toLowerCase() === line.secondaryId.toLowerCase()))) {
          errors.push(`La línea ${index + 1} coincide con un producto ya ingresado desde la factura anterior.`);
        }
      });
    }

    lines.forEach((line, index) => {
      const productOwners = productCodes.get(line.canonicalBarcode) || [];
      const quoteOwners = quoteCodes.get(line.canonicalBarcode) || [];
      if (productOwners.length + quoteOwners.length > 1) errors.push(`La línea ${index + 1} tiene un código asignado a más de un registro.`);
      const selectedProduct = line.matchProductId ? productsResult.results.find((product) => Number(product.id) === line.matchProductId) : null;
      const selectedQuote = line.matchNonInventoryId ? quotesResult.results.find((quote) => Number(quote.id) === line.matchNonInventoryId) : null;
      if (line.action === "existing") {
        if (!selectedProduct) errors.push(`No se encontró el producto seleccionado en la línea ${index + 1}.`);
        else {
          const currentBarcode = validateBarcode(selectedProduct.code);
          if (currentBarcode.valid && currentBarcode.canonical !== line.canonicalBarcode) errors.push(`El producto seleccionado en la línea ${index + 1} tiene otro código de barras.`);
          if (productOwners.length && !productOwners.some((product) => Number(product.id) === line.matchProductId)) errors.push(`El código de la línea ${index + 1} pertenece a otro producto.`);
          if (!descriptionsCompatible(String(selectedProduct.name), line.name, String(selectedProduct.presentation || ""), line.presentation)) errors.push(`El nombre o la presentación de la línea ${index + 1} no coincide con el producto seleccionado.`);
        }
      } else if (line.action === "move") {
        if (!selectedQuote) errors.push(`No se encontró el producto de No inventario de la línea ${index + 1}.`);
        else {
          const currentBarcode = validateBarcode(selectedQuote.code);
          if (currentBarcode.valid && currentBarcode.canonical !== line.canonicalBarcode) errors.push(`El registro de No inventario de la línea ${index + 1} tiene otro código.`);
          if (!descriptionsCompatible(String(selectedQuote.name), line.name, "", line.presentation)) errors.push(`La presentación de la línea ${index + 1} no coincide con No inventario.`);
        }
      } else if (line.action === "create") {
        if (productOwners.length || quoteOwners.length) errors.push(`La línea ${index + 1} no puede crear un producto porque el código ya existe.`);
        if (productsResult.results.some((product) => normalizeName(String(product.name)) === normalizeName(line.name))) errors.push(`Ya existe un producto con el mismo nombre que la línea ${index + 1}; seleccioná ese producto para revisarlo.`);
      }

      if (line.secondaryId) {
        const alias = aliasesResult.results.find((candidate) => String(candidate.provider) === String(document.provider)
          && String(candidate.secondary_type) === line.secondaryType
          && String(candidate.secondary_id).toLowerCase() === line.secondaryId.toLowerCase());
        const progress = progressById.get(line.id);
        const sameHistoricalProduct = Boolean(alias && progress?.ingressQuantity
          && Number(alias.product_id) === line.matchProductId
          && String(alias.canonical_barcode) === line.canonicalBarcode);
        if (alias && !sameHistoricalProduct && (String(alias.canonical_barcode) !== line.canonicalBarcode
          || !descriptionsCompatible(String(alias.description_signature), line.name, String(alias.presentation_signature || ""), line.presentation))) {
          errors.push(`El identificador secundario de la línea ${index + 1} corresponde a otra presentación o código.`);
        }
      }
    });
    if (errors.length) {
      const codePending = pendingCodeNames.length > 0;
      return Response.json({
        error: codePending
          ? `No encontramos un código de barras confirmado para “${pendingCodeNames[0]}”. Podés escanearlo, escribirlo o dejarlo pendiente para revisión. El inventario no fue modificado.`
          : "El ingreso está bloqueado hasta resolver los conflictos. Revisá los productos indicados; el inventario no fue modificado.",
        title: codePending ? "Código pendiente" : "Revisión requerida",
        code: codePending ? "INVENTORY_CODE_PENDING" : "INVENTORY_REVIEW_REQUIRED",
        errors: [...new Set(errors)],
      }, { status: 409 });
    }

    const user = requestUserLabel(request);
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO inventory_operations (
        id,document_id,operation_type,status,confirmed_by,line_count,total_units,created_at,confirmed_at,verification_status
      ) VALUES (?,?,'ingress','pending',?,?,?,?,?,'pending')`).bind(
        operationId, documentId, user, lines.length, lines.reduce((total, line) => total + line.totalToAdd, 0), now, now,
      ),
    ];

    lines.forEach((line) => {
      const barcodeAuditSource = [line.barcodeSource, line.barcodeSourceTitle, line.barcodeSourceUrl].filter(Boolean).join(" · ").slice(0, 2500);
      const stored = storedById.get(line.id);
      if (!stored) {
        statements.push(db.prepare(`INSERT INTO inventory_document_lines (
          id,document_id,line_key,line_index,original_description,name,brand,presentation,size,flavor,concentration,billed_quantity,
          received_quantity,units_per_package,total_to_add,barcode,canonical_barcode,barcode_type,secondary_id,
          secondary_type,barcode_method,barcode_source,barcode_source_url,barcode_source_title,barcode_differences_json,
          barcode_lookup_status,field_evidence_json,barcode_confirmed,selected_for_ingress,review_saved_at,confidence,status,match_product_id,match_non_inventory_id,
          action,barcode_level,warnings_json,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          line.id, documentId, line.lineKey, line.lineIndex, line.originalDescription, line.name, line.brand || null, line.presentation || null,
          line.size || null, line.flavor || null, line.concentration || null, line.billedQuantity, line.receivedQuantity, line.unitsPerPackage,
          line.originalTotal, line.barcode, line.canonicalBarcode, line.barcodeType, line.secondaryId || null,
          line.secondaryType || null, line.barcodeMethod, line.barcodeSource, line.barcodeSourceUrl || null,
          line.barcodeSourceTitle || null, JSON.stringify(line.barcodeDifferences), line.barcodeLookupStatus,
          JSON.stringify(line.fieldEvidence), line.barcodeConfirmed ? 1 : 0, 1, now,
          100, "confirmed", line.matchProductId, line.matchNonInventoryId, line.action, line.barcodeLevel, "[]", now, now,
        ));
      } else {
        statements.push(db.prepare(`UPDATE inventory_document_lines SET
          original_description=?,name=?,brand=?,presentation=?,size=?,flavor=?,concentration=?,billed_quantity=?,received_quantity=?,
          units_per_package=?,total_to_add=?,barcode=?,canonical_barcode=?,barcode_type=?,secondary_id=?,secondary_type=?,
          barcode_method=?,barcode_source=?,barcode_source_url=?,barcode_source_title=?,barcode_differences_json=?,
          barcode_lookup_status=?,field_evidence_json=?,barcode_confirmed=1,selected_for_ingress=1,review_saved_at=COALESCE(review_saved_at,?),
          status='confirmed',match_product_id=?,match_non_inventory_id=?,action=?,barcode_level=?,
          updated_at=? WHERE id=? AND document_id=? AND processed_operation_id IS NULL`).bind(
          line.originalDescription, line.name, line.brand || null, line.presentation || null, line.size || null, line.flavor || null,
          line.concentration || null, line.billedQuantity, line.receivedQuantity, line.unitsPerPackage, line.originalTotal,
          line.barcode, line.canonicalBarcode, line.barcodeType, line.secondaryId || null, line.secondaryType || null,
          line.barcodeMethod, line.barcodeSource, line.barcodeSourceUrl || null, line.barcodeSourceTitle || null,
          JSON.stringify(line.barcodeDifferences), line.barcodeLookupStatus, JSON.stringify(line.fieldEvidence), now,
          line.matchProductId, line.matchNonInventoryId, line.action, line.barcodeLevel,
          now, line.id, documentId,
        ));
      }

      let productLookupSql = "SELECT id FROM products WHERE id=?";
      let productLookupValue: number | string = line.matchProductId || 0;
      if (line.action === "existing") {
        statements.push(db.prepare("UPDATE products SET code=CASE WHEN code IS NULL OR trim(code)='' THEN ? ELSE code END WHERE id=?").bind(line.barcode, line.matchProductId));
      } else if (line.action === "move") {
        const movingQuote = quotesResult.results.find((quote) => Number(quote.id) === line.matchNonInventoryId);
        statements.push(db.prepare(`INSERT INTO products (
          name,normalized_name,code,brand,presentation,purchase_price_usd_cents,weight_milli_lb,quantity_available,
          minimum_stock,minimum_stock_enabled,restock_purchased_at,zero_stock_since,version,created_at,updated_at
        ) SELECT name,?,?,?,?,purchase_price_usd_cents,weight_milli_lb,0,0,0,NULL,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')
          FROM non_inventory_quotes WHERE id=?`).bind(normalizeName(String(movingQuote?.name || line.name)), line.barcode, line.brand || null, line.presentation || null, line.matchNonInventoryId));
        statements.push(db.prepare("DELETE FROM non_inventory_quotes WHERE id=?").bind(line.matchNonInventoryId));
        productLookupSql = "SELECT id FROM products WHERE code=?";
        productLookupValue = line.barcode;
      } else {
        statements.push(db.prepare(`INSERT INTO products (
          name,normalized_name,code,brand,presentation,purchase_price_usd_cents,weight_milli_lb,quantity_available,
          minimum_stock,minimum_stock_enabled,restock_purchased_at,zero_stock_since,version,created_at,updated_at
        ) VALUES (?,?,?,?,?,NULL,NULL,0,0,0,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
          .bind(line.name, normalizeName(line.name), line.barcode, line.brand || null, line.presentation || null));
        productLookupSql = "SELECT id FROM products WHERE code=?";
        productLookupValue = line.barcode;
      }

      const movementId = `mov-${crypto.randomUUID()}`;
      statements.push(db.prepare(`INSERT INTO inventory_movements (
        id,operation_id,document_line_id,product_id,product_name,barcode,canonical_barcode,secondary_id,secondary_type,
        previous_quantity,quantity_change,conversion,resulting_quantity,barcode_method,barcode_source,confirmed_by,created_at
      ) VALUES (?,?,?,
        (${productLookupSql}),
        (SELECT name FROM products WHERE id=(${productLookupSql})),?,?,?,?,
        (SELECT quantity_available FROM products WHERE id=(${productLookupSql})),?,?,
        (SELECT quantity_available+? FROM products WHERE id=(${productLookupSql})),?,?,?,?)`).bind(
        movementId, operationId, line.id,
        productLookupValue, productLookupValue, line.barcode, line.canonicalBarcode, line.secondaryId || null, line.secondaryType || null,
        productLookupValue, line.totalToAdd, line.unitsPerPackage, line.totalToAdd, productLookupValue,
        line.barcodeMethod, barcodeAuditSource, user, now,
      ));
      statements.push(db.prepare(`UPDATE products SET quantity_available=quantity_available+?,zero_stock_since=NULL,
        restock_purchased_at=CASE WHEN quantity_available+?>0 AND (minimum_stock_enabled=0 OR quantity_available+?>minimum_stock) THEN NULL ELSE restock_purchased_at END,
        version=version+1,updated_at=? WHERE id=(${productLookupSql})`).bind(
        line.totalToAdd, line.totalToAdd, line.totalToAdd, now, productLookupValue,
      ));
      statements.push(db.prepare(`UPDATE inventory_document_lines SET
        processed_operation_id=?,
        status=CASE WHEN COALESCE((SELECT SUM(quantity_change) FROM inventory_movements WHERE document_line_id=?),0)>=total_to_add
          THEN 'processed' ELSE 'confirmed' END,
        selected_for_ingress=CASE WHEN COALESCE((SELECT SUM(quantity_change) FROM inventory_movements WHERE document_line_id=?),0)>=total_to_add
          THEN 0 ELSE 1 END,
        match_product_id=(${productLookupSql}),match_non_inventory_id=NULL,action='existing',updated_at=?
        WHERE id=? AND document_id=?`).bind(
        operationId, line.id, line.id, productLookupValue, now, line.id, documentId,
      ));
      if (line.secondaryId) {
        statements.push(db.prepare(`INSERT INTO supplier_product_aliases (
          provider,secondary_type,secondary_id,barcode,canonical_barcode,product_id,description_signature,
          presentation_signature,units_per_package,barcode_level,source,confirmed_at,confirmed_by,updated_at
        ) VALUES (?,?,?,?,?,(${productLookupSql}),?,?,?,?,?,?,?,?)
        ON CONFLICT(provider,secondary_type,secondary_id) DO UPDATE SET
          barcode=excluded.barcode,canonical_barcode=excluded.canonical_barcode,product_id=excluded.product_id,
          description_signature=excluded.description_signature,presentation_signature=excluded.presentation_signature,
          units_per_package=excluded.units_per_package,barcode_level=excluded.barcode_level,source=excluded.source,
          confirmed_by=excluded.confirmed_by,updated_at=excluded.updated_at`).bind(
          String(document.provider), line.secondaryType || "other", line.secondaryId, line.barcode, line.canonicalBarcode,
          productLookupValue, descriptionSignature(line.name), presentationSignature(line.name, line.presentation, line.flavor, line.concentration),
          line.unitsPerPackage, line.barcodeLevel, barcodeAuditSource, now, user, now,
        ));
      }
    });

    statements.push(...await invoiceFinanceStatements(db, document, storedLines.results, now));

    statements.push(documentStatusStatement(db, documentId, now));
    statements.push(db.prepare("UPDATE inventory_documents SET confirmed_at=COALESCE(confirmed_at,?),confirmed_by=COALESCE(confirmed_by,?) WHERE id=?")
      .bind(now, user, documentId));
    statements.push(db.prepare("UPDATE inventory_operations SET status='completed',verification_status='verified',confirmed_at=? WHERE id=?").bind(now, operationId));

    try { await db.batch(statements); }
    catch (error) {
      const raced = await loadOperationResult(db, operationId);
      if (raced?.operation.status === "completed") return Response.json({ ...raced, idempotent: true });
      throw error;
    }
    const result = await loadOperationResult(db, operationId);
    if (!result || result.movements.length !== lines.length) throw new Error("No se pudo verificar que todas las líneas fueran guardadas. Ninguna línea debe volver a confirmarse hasta revisar el historial.");
    return Response.json(result);
  } catch (error) {
    if (operationId) {
      try {
        await ensureDatabase();
        const existing = await loadOperationResult(getD1(), operationId);
        if (existing?.operation.status === "completed") return Response.json({ ...existing, recoveredAfterConnectionCheck: true });
      } catch { /* Se devuelve el error original. */ }
    }
    return confirmErrorResponse(error);
  }
}
