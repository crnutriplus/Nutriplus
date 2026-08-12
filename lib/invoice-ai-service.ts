import {
  analyzeStoredInvoice,
  invoiceAiConfig,
  invoiceAiUsageSummary,
  InvoiceAiError,
  metadataEvidenceFromAi,
  parsedInvoiceFromAi,
} from "./invoice-ai";
import { loadIntakeDocument } from "./inventory-document";
import { duplicateForParsedInvoice, replaceDocumentLinesFromParsed } from "./invoice-lines-store";
import type { StoredInvoiceFileRow } from "./invoice-storage";

function warningList(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

function cleanSuccessfulWarnings(value: unknown) {
  return warningList(value).filter((warning) => !/(?:OpenAI|modo Manual|análisis con IA|clave de OpenAI|límite mensual)/i.test(warning));
}

async function manualFallback(
  db: D1Database,
  documentId: string,
  code: string,
  message: string,
) {
  const document = await db.prepare("SELECT warnings_json FROM inventory_documents WHERE id=?").bind(documentId).first<Record<string, unknown>>();
  const warnings = [...new Set([...warningList(document?.warnings_json), message])];
  await db.prepare(`UPDATE inventory_documents SET processing_mode='manual',analysis_status=?,warnings_json=?,updated_at=? WHERE id=?`)
    .bind(code, JSON.stringify(warnings), new Date().toISOString(), documentId).run();
  const loaded = await loadIntakeDocument(db, documentId);
  return { ...loaded, manualFallback: true, aiErrorCode: code, aiErrorMessage: message };
}

export async function processDocumentWithAi(
  db: D1Database,
  documentId: string,
  options: { reanalysis?: boolean } = {},
) {
  const config = invoiceAiConfig();
  if (!config.enabled) {
    return manualFallback(db, documentId, "ai_disabled", "El análisis con IA está desactivado. La factura continúa disponible en modo Manual.");
  }
  if (!config.keyConfigured) {
    return manualFallback(db, documentId, "missing_key", "Falta la clave de OpenAI. La factura continúa disponible en modo Manual.");
  }
  const usageBefore = await invoiceAiUsageSummary(db);
  const limitMicrousd = Math.round(config.monthlyLimitUsd * 1_000_000);
  if (usageBefore.currentMonthMicrousd >= limitMicrousd) {
    return manualFallback(db, documentId, "spend_limit", `Se alcanzó el límite mensual de análisis con IA ($${config.monthlyLimitUsd.toFixed(2)}). La factura continúa disponible en modo Manual.`);
  }

  const document = await db.prepare("SELECT * FROM inventory_documents WHERE id=?").bind(documentId).first<Record<string, unknown>>();
  if (!document) throw new Error("No se encontró la factura para analizar.");
  const fileRows = await db.prepare("SELECT * FROM inventory_document_files WHERE document_id=? ORDER BY file_index")
    .bind(documentId).all<StoredInvoiceFileRow>();
  if (!fileRows.results.length) return manualFallback(db, documentId, "missing_file", "No se encontró el archivo guardado. Podés continuar agregando los productos manualmente.");

  const numberRow = await db.prepare("SELECT COALESCE(MAX(analysis_number),0)+1 AS next_number FROM invoice_ai_analyses WHERE document_id=?")
    .bind(documentId).first<Record<string, unknown>>();
  const analysisNumber = Number(numberRow?.next_number || 1);
  const analysisId = `ianalysis-${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO invoice_ai_analyses (
      id,document_id,file_fingerprint,analysis_number,model,status,reanalysis,created_at
    ) VALUES (?,?,?,?,?,'processing',?,?)`).bind(
      analysisId, documentId, String(document.file_fingerprint), analysisNumber, config.model, options.reanalysis ? 1 : 0, startedAt,
    ),
    db.prepare(`UPDATE inventory_documents SET processing_mode='ai',analysis_status='processing',active_analysis_id=?,updated_at=? WHERE id=?`)
      .bind(analysisId, startedAt, documentId),
  ]);

  try {
    const run = await analyzeStoredInvoice(fileRows.results);
    const parsed = parsedInvoiceFromAi(run.analysis);
    const duplicate = await duplicateForParsedInvoice(db, documentId, parsed);
    await replaceDocumentLinesFromParsed(db, documentId, parsed, { preserveReviewed: true });
    const warnings = [...new Set([
      ...cleanSuccessfulWarnings(document.warnings_json),
      ...parsed.warnings,
      ...(duplicate.warning ? [duplicate.warning] : []),
    ])];
    const completedAt = new Date().toISOString();
    await db.batch([
      db.prepare(`UPDATE invoice_ai_analyses SET
        model=?,status='completed',response_id=?,input_tokens=?,cached_input_tokens=?,output_tokens=?,web_search_count=?,
        estimated_cost_microusd=?,extraction_json=?,completed_at=? WHERE id=?`).bind(
        run.model, run.responseId || null, run.usage.inputTokens, run.usage.cachedInputTokens, run.usage.outputTokens,
        run.usage.webSearchCount, run.usage.estimatedCostMicrousd, JSON.stringify(run.analysis), completedAt, analysisId,
      ),
      db.prepare(`UPDATE inventory_documents SET
        provider=?,order_number=?,invoice_number=?,shipment_number=?,document_date=?,processing_mode='ai',
        analysis_status='completed',active_analysis_id=?,field_evidence_json=?,
        status=CASE WHEN status IN ('partial','processed') THEN status ELSE ? END,
        warnings_json=?,duplicate_of=?,updated_at=? WHERE id=?`).bind(
        parsed.provider, parsed.orderNumber || null, parsed.invoiceNumber || null, parsed.shipmentNumber || null,
        parsed.documentDate || null, analysisId, JSON.stringify(metadataEvidenceFromAi(run.analysis)), parsed.status,
        JSON.stringify(warnings), duplicate.duplicateOf || null, completedAt, documentId,
      ),
    ]);
    const loaded = await loadIntakeDocument(db, documentId);
    return { ...loaded, manualFallback: false, cachedAnalysis: false };
  } catch (error) {
    const aiError = error instanceof InvoiceAiError
      ? error
      : new InvoiceAiError("analysis_failed", "No se pudo completar el análisis con OpenAI. La factura continúa en modo Manual.");
    const completedAt = new Date().toISOString();
    const warnings = [...new Set([...warningList(document.warnings_json), aiError.message])];
    const failedUsage = aiError.usage;
    await db.batch([
      db.prepare(`UPDATE invoice_ai_analyses SET
        model=?,status='failed',response_id=?,input_tokens=?,cached_input_tokens=?,output_tokens=?,web_search_count=?,
        estimated_cost_microusd=?,error_code=?,error_message=?,completed_at=? WHERE id=?`).bind(
        aiError.model || config.model, aiError.responseId || null, failedUsage?.inputTokens || 0,
        failedUsage?.cachedInputTokens || 0, failedUsage?.outputTokens || 0, failedUsage?.webSearchCount || 0,
        failedUsage?.estimatedCostMicrousd || 0, aiError.code, aiError.message, completedAt, analysisId,
      ),
      db.prepare(`UPDATE inventory_documents SET processing_mode='manual',analysis_status='failed',active_analysis_id=?,warnings_json=?,updated_at=? WHERE id=?`)
        .bind(analysisId, JSON.stringify(warnings), completedAt, documentId),
    ]);
    const loaded = await loadIntakeDocument(db, documentId);
    return { ...loaded, manualFallback: true, aiErrorCode: aiError.code, aiErrorMessage: aiError.message };
  }
}
