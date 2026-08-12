import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { loadIntakeDocument } from "@/lib/inventory-document";
import { duplicateForParsedInvoice, replaceDocumentLinesFromParsed } from "@/lib/invoice-lines-store";
import { parseInvoicePages, type InvoicePageText } from "@/lib/invoice-parser";

function warnings(value: unknown) {
  return Array.isArray(value) ? value.map(String).slice(0, 100) : [];
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const documentId = (await context.params).id;
    const payload = await request.json() as Record<string, unknown>;
    const pages = Array.isArray(payload.pages) ? payload.pages.slice(0, 100).map((page, index) => {
      const row = page && typeof page === "object" ? page as Record<string, unknown> : {};
      return {
        pageNumber: Number(row.pageNumber || index + 1),
        text: typeof row.text === "string" ? row.text.slice(0, 150000) : "",
        confidence: Math.max(0, Math.min(100, Number(row.confidence || 0))),
        source: row.source === "pdf_text" ? "pdf_text" : "ocr",
      } satisfies InvoicePageText;
    }) : [];
    if (!pages.length) return Response.json({ error: "No se recibió texto de respaldo para la factura." }, { status: 400 });
    if (pages.reduce((total, page) => total + page.text.length, 0) > 1_500_000) {
      return Response.json({ error: "La lectura de respaldo es demasiado grande." }, { status: 413 });
    }
    await ensureDatabase();
    const db = getD1();
    const document = await db.prepare("SELECT * FROM inventory_documents WHERE id=?").bind(documentId).first<Record<string, unknown>>();
    if (!document) return Response.json({ error: "No se encontró la factura." }, { status: 404 });
    const parsed = parseInvoicePages(pages);
    const duplicate = await duplicateForParsedInvoice(db, documentId, parsed);
    await replaceDocumentLinesFromParsed(db, documentId, parsed, { preserveReviewed: true });
    let storedWarnings: string[] = [];
    try { storedWarnings = JSON.parse(String(document.warnings_json || "[]")) as string[]; } catch { storedWarnings = []; }
    const mergedWarnings = [...new Set([
      ...storedWarnings,
      ...warnings(payload.warnings),
      ...parsed.warnings,
      ...(duplicate.warning ? [duplicate.warning] : []),
    ])];
    await db.prepare(`UPDATE inventory_documents SET
      provider=?,order_number=COALESCE(NULLIF(?,''),order_number),invoice_number=COALESCE(NULLIF(?,''),invoice_number),
      shipment_number=COALESCE(NULLIF(?,''),shipment_number),document_date=COALESCE(NULLIF(?,''),document_date),
      page_count=?,processing_mode='manual',analysis_status='ocr_fallback',
      status=CASE WHEN status IN ('partial','processed') THEN status ELSE ? END,warnings_json=?,duplicate_of=?,updated_at=?
      WHERE id=?`).bind(
      parsed.provider, parsed.orderNumber, parsed.invoiceNumber, parsed.shipmentNumber, parsed.documentDate, pages.length,
      parsed.status, JSON.stringify(mergedWarnings), duplicate.duplicateOf || null, new Date().toISOString(), documentId,
    ).run();
    const loaded = await loadIntakeDocument(db, documentId);
    return Response.json({ ...loaded, manualFallback: true, ocrFallbackApplied: true });
  } catch (error) { return errorResponse(error); }
}
