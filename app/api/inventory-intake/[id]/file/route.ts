import { ensureDatabase, getD1 } from "@/db";
import { errorResponse } from "@/lib/api-helpers";
import { getInvoiceBucket } from "@/lib/invoice-storage";

function contentDisposition(fileName: string) {
  const safe = fileName.replace(/[\r\n"\\]/g, "_").slice(0, 180) || "factura";
  return `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function fileHeaders(file: Record<string, unknown>, size: number) {
  return new Headers({
    "Content-Type": String(file.mime_type),
    "Content-Disposition": contentDisposition(String(file.file_name)),
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "Content-Length": String(size),
    "X-Content-Type-Options": "nosniff",
  });
}

async function storedInvoiceFile(request: Request, context: { params: Promise<{ id: string }> }) {
  const documentId = (await context.params).id;
  const index = Number(new URL(request.url).searchParams.get("index") || 0);
  if (!Number.isInteger(index) || index < 0) return { error: Response.json({ error: "El archivo solicitado no es válido." }, { status: 400 }) };
  await ensureDatabase();
  const file = await getD1().prepare(`SELECT * FROM inventory_document_files WHERE document_id=? AND file_index=? LIMIT 1`)
    .bind(documentId, index).first<Record<string, unknown>>();
  if (!file) return { error: Response.json({ error: "No se encontró el archivo de la factura." }, { status: 404 }) };
  return { file };
}

export async function HEAD(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const stored = await storedInvoiceFile(request, context);
    if (stored.error) return stored.error;
    const object = await getInvoiceBucket().head(String(stored.file.storage_key));
    if (!object) return Response.json({ error: "El archivo guardado ya no está disponible." }, { status: 404 });
    return new Response(null, { headers: fileHeaders(stored.file, object.size) });
  } catch (error) { return errorResponse(error); }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const stored = await storedInvoiceFile(request, context);
    if (stored.error) return stored.error;
    const file = stored.file;
    const size = Number(file.size_bytes);
    const rangeHeader = request.headers.get("range") || "";
    const range = rangeHeader.match(/^bytes=(\d+)-(\d*)$/i);
    let object: R2ObjectBody | null;
    let status = 200;
    let start = 0;
    let end = Math.max(0, size - 1);
    if (range) {
      start = Math.min(size - 1, Number(range[1]));
      end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      if (start > end || !Number.isFinite(start) || !Number.isFinite(end)) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      object = await getInvoiceBucket().get(String(file.storage_key), { range: { offset: start, length: end - start + 1 } });
      status = 206;
    } else {
      object = await getInvoiceBucket().get(String(file.storage_key));
    }
    if (!object) return Response.json({ error: "El archivo guardado ya no está disponible." }, { status: 404 });
    const headers = fileHeaders(file, end - start + 1);
    if (status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    return new Response(object.body, { status, headers });
  } catch (error) { return errorResponse(error); }
}
