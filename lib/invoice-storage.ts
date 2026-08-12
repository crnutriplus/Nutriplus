export type PreparedInvoiceFile = {
  index: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  bytes: Uint8Array;
};

export type StoredInvoiceFileRow = {
  id: string;
  document_id: string;
  file_index: number;
  storage_key: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  file_sha256: string;
};

const IMAGE_EXTENSIONS = new Set(["bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 45 * 1024 * 1024;
const MAX_FILES = 20;

export function getInvoiceBucket() {
  if (!globalThis.__NUTRIPLUS_BUCKET__) throw new Error("El almacenamiento de facturas no está disponible.");
  return globalThis.__NUTRIPLUS_BUCKET__;
}

function extensionOf(name: string) {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
}

export function normalizedInvoiceMime(file: Pick<File, "name" | "type">) {
  const supplied = (file.type || "").trim().toLowerCase().split(";")[0];
  const extension = extensionOf(file.name);
  if (supplied === "application/pdf" || extension === "pdf") return "application/pdf";
  if (supplied.startsWith("image/")) return supplied;
  if (IMAGE_EXTENSIONS.has(extension)) return extension === "jpg" ? "image/jpeg" : `image/${extension}`;
  return "";
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Bytes(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)));
}

export async function prepareInvoiceUploads(files: File[]) {
  if (!files.length) throw new Error("Seleccioná al menos una factura en PDF o imagen.");
  if (files.length > MAX_FILES) throw new Error(`Podés cargar un máximo de ${MAX_FILES} archivos por factura.`);
  const prepared: PreparedInvoiceFile[] = [];
  let totalBytes = 0;
  for (const [index, file] of files.entries()) {
    const mimeType = normalizedInvoiceMime(file);
    if (!mimeType) throw new Error(`Solo se permiten PDF o imágenes. Revisá “${file.name}”.`);
    if (!file.size) throw new Error(`El archivo “${file.name}” está vacío.`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`“${file.name}” supera el máximo de 20 MB.`);
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("La carga completa supera el máximo de 45 MB.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    prepared.push({
      index,
      fileName: file.name.trim().slice(0, 500) || `factura-${index + 1}`,
      mimeType,
      sizeBytes: bytes.byteLength,
      sha256: await sha256Bytes(bytes),
      bytes,
    });
  }
  const fingerprintSource = new TextEncoder().encode(prepared.map((file) => `${file.index}:${file.sha256}`).join("|"));
  return {
    files: prepared,
    fingerprint: await sha256Bytes(fingerprintSource),
    totalBytes,
  };
}

export function storageKeyFor(documentId: string, index: number) {
  return `inventory-invoices/${documentId}/${String(index).padStart(3, "0")}`;
}

export async function storePreparedInvoiceFiles(documentId: string, files: PreparedInvoiceFile[]) {
  const bucket = getInvoiceBucket();
  const stored: StoredInvoiceFileRow[] = [];
  try {
    for (const file of files) {
      const storageKey = storageKeyFor(documentId, file.index);
      await bucket.put(storageKey, file.bytes, {
        httpMetadata: { contentType: file.mimeType },
        customMetadata: {
          documentId,
          fileName: file.fileName,
          sha256: file.sha256,
        },
      });
      stored.push({
        id: `ifile-${crypto.randomUUID()}`,
        document_id: documentId,
        file_index: file.index,
        storage_key: storageKey,
        file_name: file.fileName,
        mime_type: file.mimeType,
        size_bytes: file.sizeBytes,
        file_sha256: file.sha256,
      });
    }
    return stored;
  } catch (error) {
    await Promise.allSettled(stored.map((file) => bucket.delete(file.storage_key)));
    throw error;
  }
}

export async function deleteStoredInvoiceFiles(rows: Array<Pick<StoredInvoiceFileRow, "storage_key">>) {
  if (!rows.length) return;
  const bucket = getInvoiceBucket();
  await Promise.all(rows.map((row) => bucket.delete(row.storage_key)));
}

export async function readStoredInvoiceFile(row: Pick<StoredInvoiceFileRow, "storage_key" | "size_bytes">) {
  const object = await getInvoiceBucket().get(row.storage_key);
  if (!object) throw new Error("El archivo de la factura ya no está disponible.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== Number(row.size_bytes)) throw new Error("El archivo guardado no coincide con su registro.");
  return bytes;
}

export function dataUrl(mimeType: string, bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunk)));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}
