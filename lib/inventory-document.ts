import { invoiceAiUsageSummary } from "./invoice-ai";
import { lineFromRow, type IntakeLineDto } from "./inventory-intake";

function jsonObject(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function jsonArray(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function intakeDocumentFromRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    fingerprint: String(row.file_fingerprint),
    fileName: String(row.file_name),
    mimeTypes: jsonArray(row.mime_types_json).map(String),
    provider: String(row.provider),
    orderNumber: row.order_number ? String(row.order_number) : "",
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : "",
    shipmentNumber: row.shipment_number ? String(row.shipment_number) : "",
    documentDate: row.document_date ? String(row.document_date) : "",
    pageCount: Number(row.page_count || 1),
    fileCount: Number(row.file_count || 0),
    processingMode: row.processing_mode ? String(row.processing_mode) : "manual",
    analysisStatus: row.analysis_status ? String(row.analysis_status) : "not_requested",
    activeAnalysisId: row.active_analysis_id ? String(row.active_analysis_id) : "",
    fieldEvidence: jsonObject(row.field_evidence_json),
    status: String(row.status),
    warnings: jsonArray(row.warnings_json).map(String),
    duplicateOf: row.duplicate_of ? String(row.duplicate_of) : "",
    createdAt: String(row.created_at),
    confirmedAt: row.confirmed_at ? String(row.confirmed_at) : "",
    confirmedBy: row.confirmed_by ? String(row.confirmed_by) : "",
  };
}

export function invoiceAnalysisFromRow(row: Record<string, unknown> | null | undefined) {
  if (!row) return null;
  return {
    id: String(row.id),
    model: String(row.model),
    status: String(row.status),
    inputTokens: Number(row.input_tokens || 0),
    cachedInputTokens: Number(row.cached_input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    totalTokens: Number(row.input_tokens || 0) + Number(row.output_tokens || 0),
    webSearchCount: Number(row.web_search_count || 0),
    estimatedCostUsd: Number(row.estimated_cost_microusd || 0) / 1_000_000,
    reanalysis: Number(row.reanalysis || 0) === 1,
    errorCode: row.error_code ? String(row.error_code) : "",
    errorMessage: row.error_message ? String(row.error_message) : "",
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : "",
  };
}

export async function attachInventoryMatches(db: D1Database, lines: IntakeLineDto[]) {
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
      match: product ? {
        source: "inventory" as const,
        id: Number(product.id),
        name: String(product.name),
        code: product.code ? String(product.code) : null,
        quantityAvailable: Number(product.quantity_available || 0),
      } : quote ? {
        source: "no_inventory" as const,
        id: Number(quote.id),
        name: String(quote.name),
        code: quote.code ? String(quote.code) : null,
        quantityAvailable: null,
      } : null,
    };
  });
}

export async function loadIntakeDocument(db: D1Database, documentId: string) {
  const documentRow = await db.prepare("SELECT * FROM inventory_documents WHERE id=?").bind(documentId).first<Record<string, unknown>>();
  if (!documentRow) return null;
  const [lineRows, fileRows, analysisRow, usage] = await Promise.all([
    db.prepare("SELECT * FROM inventory_document_lines WHERE document_id=? ORDER BY line_index,page_number,id").bind(documentId).all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM inventory_document_files WHERE document_id=? ORDER BY file_index").bind(documentId).all<Record<string, unknown>>(),
    documentRow.active_analysis_id
      ? db.prepare("SELECT * FROM invoice_ai_analyses WHERE id=?").bind(String(documentRow.active_analysis_id)).first<Record<string, unknown>>()
      : Promise.resolve(null),
    invoiceAiUsageSummary(db),
  ]);
  const lines = await attachInventoryMatches(db, lineRows.results.map(lineFromRow));
  return {
    document: intakeDocumentFromRow(documentRow),
    lines,
    files: fileRows.results.map((row) => ({
      id: String(row.id),
      index: Number(row.file_index),
      fileName: String(row.file_name),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes),
      viewUrl: `/api/inventory-intake/${encodeURIComponent(documentId)}/file?index=${Number(row.file_index)}`,
    })),
    analysis: invoiceAnalysisFromRow(analysisRow),
    usage: {
      cumulativeCostUsd: usage.cumulativeMicrousd / 1_000_000,
      currentMonthCostUsd: usage.currentMonthMicrousd / 1_000_000,
      billedAnalyses: usage.billedAnalyses,
      month: usage.month,
    },
  };
}
