import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { SOL_INVOICE_AI_MODEL } from "@/lib/invoice-ai";
import { processDocumentWithAi } from "@/lib/invoice-ai-service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const documentId = (await context.params).id;
    const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (payload.confirmed !== true) {
      return Response.json({ error: "Confirmá que entendés que analizar nuevamente genera un nuevo consumo." }, { status: 400 });
    }
    await ensureDatabase();
    const db = getD1();
    const document = await db.prepare("SELECT id,analysis_status FROM inventory_documents WHERE id=?").bind(documentId).first<Record<string, unknown>>();
    if (!document) return Response.json({ error: "No se encontró la factura." }, { status: 404 });
    if (String(document.analysis_status) === "processing") {
      return Response.json({ error: "Esta factura ya tiene un análisis en curso. No se inició otro consumo." }, { status: 409 });
    }
    const requestedModel = payload.model === "sol" ? SOL_INVOICE_AI_MODEL : undefined;
    const result = await processDocumentWithAi(db, documentId, { reanalysis: true, model: requestedModel });
    return Response.json(result, { status: result?.manualFallback ? 202 : 200 });
  } catch (error) { return errorResponse(error); }
}
