import { invoiceAiUsageSummary } from "./invoice-ai";
import { lineFromRow, type IntakeLineDto } from "./inventory-intake";
import { applyLineProgress, conceptualDocumentStatus, loadDocumentMovementRows } from "./inventory-line-progress";

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

function chatGptImportSummary(value: unknown) {
  const extraction = jsonObject(value);
  const invoice = extraction.invoice && typeof extraction.invoice === "object" && !Array.isArray(extraction.invoice)
    ? extraction.invoice as Record<string, unknown> : {};
  const source = extraction.source && typeof extraction.source === "object" && !Array.isArray(extraction.source)
    ? extraction.source as Record<string, unknown> : {};
  const amount = (entry: unknown) => Number.isFinite(Number(entry)) ? Number(entry) : 0;
  return {
    pageCount: Number(source.page_count || 0),
    currency: invoice.currency ? String(invoice.currency) : "",
    subtotal: amount(invoice.subtotal),
    shipping: amount(invoice.shipping),
    tax: amount(invoice.tax),
    total: amount(invoice.total),
    lineCount: Number(invoice.line_count || 0),
    inventoryUnits: Number(invoice.inventory_units || 0),
    sourceSha256: source.sha256 ? String(source.sha256) : "",
  };
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

export function invoiceAnalysisFromRow(row: Record<string, unknown> | null | undefined, cumulativeCostUsd = 0) {
  if (!row) return null;
  const analysisOrigin = row.analysis_origin ? String(row.analysis_origin) : "OPENAI_API";
  return {
    id: String(row.id),
    analysisNumber: Number(row.analysis_number || 0),
    model: String(row.model),
    analysisOrigin,
    apiCalls: Number(row.api_calls ?? (analysisOrigin === "OPENAI_API" ? 1 : 0)),
    apiCostUsd: Number(row.api_cost_microusd ?? row.estimated_cost_microusd ?? 0) / 1_000_000,
    status: String(row.status),
    inputTokens: Number(row.input_tokens || 0),
    cachedInputTokens: Number(row.cached_input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    totalTokens: Number(row.input_tokens || 0) + Number(row.output_tokens || 0),
    webSearchCount: Number(row.web_search_count || 0),
    estimatedCostUsd: Number(row.estimated_cost_microusd || 0) / 1_000_000,
    cumulativeCostUsd,
    reanalysis: Number(row.reanalysis || 0) === 1,
    reviewRequired: String(row.status) === "review_required" || String(row.error_code || "") === "review_required",
    errorCode: row.error_code ? String(row.error_code) : "",
    errorMessage: row.error_message ? String(row.error_message) : "",
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : "",
    importSummary: analysisOrigin === "CHATGPT_IMPORT" ? chatGptImportSummary(row.extraction_json) : null,
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
  const [lineRows, fileRows, analysisRows, usage, movementRows] = await Promise.all([
    db.prepare("SELECT * FROM inventory_document_lines WHERE document_id=? ORDER BY line_index,page_number,id").bind(documentId).all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM inventory_document_files WHERE document_id=? ORDER BY file_index").bind(documentId).all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM invoice_ai_analyses WHERE document_id=? ORDER BY analysis_number,created_at,id")
      .bind(documentId).all<Record<string, unknown>>(),
    invoiceAiUsageSummary(db),
    loadDocumentMovementRows(db, [documentId]),
  ]);
  const lines = await attachInventoryMatches(db, applyLineProgress(lineRows.results.map(lineFromRow), movementRows));
  const document = intakeDocumentFromRow(documentRow);
  document.status = conceptualDocumentStatus(lines, document.status);
  let documentAnalysisCostUsd = 0;
  const analyses = analysisRows.results.map((row) => {
    documentAnalysisCostUsd += Number(row.estimated_cost_microusd || 0) / 1_000_000;
    return invoiceAnalysisFromRow(row, documentAnalysisCostUsd);
  }).filter((row): row is NonNullable<ReturnType<typeof invoiceAnalysisFromRow>> => Boolean(row));
  const activeAnalysis = analyses.find((row) => row.id === String(documentRow.active_analysis_id || "")) || analyses.at(-1) || null;
  return {
    document,
    lines,
    files: fileRows.results.map((row) => ({
      id: String(row.id),
      index: Number(row.file_index),
      fileName: String(row.file_name),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes),
      viewUrl: `/api/inventory-intake/${encodeURIComponent(documentId)}/file?index=${Number(row.file_index)}`,
    })),
    analysis: activeAnalysis,
    analyses,
    usage: {
      cumulativeCostUsd: usage.cumulativeMicrousd / 1_000_000,
      currentMonthCostUsd: usage.currentMonthMicrousd / 1_000_000,
      billedAnalyses: usage.billedAnalyses,
      month: usage.month,
    },
  };
}
