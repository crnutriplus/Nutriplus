import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { deleteStoredInvoiceFiles, type StoredInvoiceFileRow } from "@/lib/invoice-storage";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const documentId = (await context.params).id;
    await ensureDatabase();
    const db = getD1();
    const document = await db.prepare("SELECT id FROM inventory_documents WHERE id=? LIMIT 1").bind(documentId).first<{ id: string }>();
    if (!document) return Response.json({ canceled: true, alreadyRemoved: true });

    const operation = await db.prepare("SELECT id FROM inventory_operations WHERE document_id=? LIMIT 1").bind(documentId).first<{ id: string }>();
    if (operation) {
      return Response.json({ error: "Esta factura ya tiene un ingreso iniciado o confirmado y no puede borrarse." }, { status: 409 });
    }

    const files = await db.prepare("SELECT storage_key FROM inventory_document_files WHERE document_id=?")
      .bind(documentId).all<StoredInvoiceFileRow>();
    await deleteStoredInvoiceFiles(files.results);
    await db.batch([
      db.prepare("DELETE FROM inventory_document_lines WHERE document_id=?").bind(documentId),
      db.prepare("DELETE FROM inventory_document_files WHERE document_id=?").bind(documentId),
      db.prepare("DELETE FROM inventory_documents WHERE id=?").bind(documentId),
    ]);
    return Response.json({ canceled: true });
  } catch (error) {
    return errorResponse(error);
  }
}
