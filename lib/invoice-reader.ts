import type { InvoicePageText } from "./invoice-parser";

export type InvoiceReadProgress = {
  stage: "opening" | "reading" | "ocr" | "complete";
  current: number;
  total: number;
  message: string;
};

export type ReadInvoiceFilesResult = {
  fingerprint: string;
  fileName: string;
  mimeTypes: string[];
  pages: InvoicePageText[];
  warnings: string[];
};

export type InvoiceFileKind = "pdf" | "image";

const IMAGE_EXTENSIONS = new Set(["bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp"]);

export function invoiceFileKind(file: Pick<File, "name" | "type">): InvoiceFileKind | null {
  const mimeType = (file.type || "").trim().toLowerCase().split(";")[0];
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  if (mimeType === "application/pdf" || extension === "pdf") return "pdf";
  if (mimeType.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) return "image";
  return null;
}

function looksSpanish(value: string) {
  return /\b(?:archivo|factura|página|imagen|código|leer|lectura|permitido|encontró|preparar|seleccioná|reconocer|protegido|dañado)\b/i.test(value);
}

export function invoiceReadErrorMessage(error: unknown, fileName = "la factura") {
  const raw = error instanceof Error ? error.message.trim() : "";
  const errorName = error instanceof Error ? error.name : "";
  const source = `${errorName} ${raw}`.toLowerCase();
  const label = fileName ? `“${fileName}”` : "la factura";

  if (/notfounderror|requested file or directory could not be found|no such file|file.*not found|archivo.*no.*disponible/.test(source)) {
    return `El archivo ${label} dejó de estar disponible antes de terminar la lectura. Volvé a seleccionarlo y mantené abierta la aplicación mientras se procesa.`;
  }
  if (/notallowederror|permission|permiso|access.*denied/.test(source)) {
    return `El teléfono no permitió leer ${label}. Revisá el permiso de archivos del navegador y volvé a seleccionarlo.`;
  }
  if (/password|encrypted|contraseña/.test(source)) {
    return `No se pudo abrir ${label} porque el PDF está protegido con contraseña.`;
  }
  if (/invalidpdf|invalid pdf|pdf structure|format error|unexpected response|dañado|corrupt/.test(source)) {
    return `No se pudo abrir ${label}: el PDF está dañado o no tiene un formato válido.`;
  }
  if (/worker|fake worker|loading.*module|dynamically imported module/.test(source)) {
    return `No se pudo iniciar el lector de PDF para ${label}. Cerrá y abrí la aplicación e intentá nuevamente.`;
  }
  if (/failed to fetch|networkerror|network error|load failed|internet|conexión/.test(source)) {
    return `No se pudo completar la lectura de ${label} por un problema de conexión. Verificá Internet e intentá nuevamente.`;
  }
  if (/out of memory|memory|memoria/.test(source)) {
    return `No se pudo procesar ${label} porque el archivo es demasiado pesado para la memoria disponible del teléfono.`;
  }
  if (raw && looksSpanish(raw)) return raw;
  return `No se pudo leer ${label}. El archivo puede estar dañado, protegido o no ser compatible.`;
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, shift: number) {
  return (value >>> shift) | (value << (32 - shift));
}

export function sha256Fallback(bytes: Uint8Array) {
  const bitLength = bytes.byteLength * 8;
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
      const choice = ((e & f) ^ (~e & g)) >>> 0;
      const temporary1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return [...hash].map((value) => value.toString(16).padStart(8, "0")).join("");
}

async function sha256(value: ArrayBuffer | Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  try {
    if (globalThis.crypto?.subtle) return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy.buffer)));
  } catch {
    // Algunos navegadores móviles y vistas instaladas no exponen Web Crypto.
  }
  return sha256Fallback(copy);
}

function textFromPdfItems(items: unknown[]) {
  const positioned = items
    .filter((item): item is { str: string; transform?: number[]; width?: number } => Boolean(item && typeof item === "object" && "str" in item && typeof (item as { str?: unknown }).str === "string"))
    .map((item) => ({
      text: item.str.trim(),
      x: Number(item.transform?.[4] ?? 0),
      y: Number(item.transform?.[5] ?? 0),
      width: Number(item.width ?? 0),
    }))
    .filter((item) => item.text);
  positioned.sort((left, right) => Math.abs(right.y - left.y) > 3 ? right.y - left.y : left.x - right.x);
  const rows: Array<{ y: number; parts: Array<{ text: string; x: number; width: number }> }> = [];
  positioned.forEach((item) => {
    let row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 3);
    if (!row) {
      row = { y: item.y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ text: item.text, x: item.x, width: item.width });
  });
  rows.sort((left, right) => right.y - left.y);
  return rows.map((row) => row.parts.sort((left, right) => left.x - right.x).map((part) => part.text).join("  ")).join("\n");
}

function enoughText(value: string) {
  return value.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9]/g, "").length >= 70;
}

export async function readInvoiceFiles(files: File[], onProgress?: (progress: InvoiceReadProgress) => void): Promise<ReadInvoiceFilesResult> {
  if (!files.length) throw new Error("Seleccioná al menos una factura en PDF o imagen.");
  const kinds = files.map(invoiceFileKind);
  const invalidFiles = files.filter((_, index) => !kinds[index]);
  if (invalidFiles.length) throw new Error(`Solo se permiten archivos PDF o imágenes. Revisá: ${invalidFiles.map((file) => file.name).join(", ")}.`);
  const emptyFiles = files.filter((file) => file.size === 0);
  if (emptyFiles.length) throw new Error(`El archivo está vacío y no se puede leer: ${emptyFiles.map((file) => file.name).join(", ")}.`);
  const warnings: string[] = [];
  const fileDigests: string[] = [];
  const pages: InvoicePageText[] = [];
  let totalUnits = files.length;
  let completedUnits = 0;
  let ocrWorker: {
    recognize: (image: File | HTMLCanvasElement) => Promise<{ data: { text: string; confidence: number } }>;
    setParameters: (values: Record<string, string>) => Promise<unknown>;
    terminate: () => Promise<unknown>;
  } | null = null;

  const recognize = async (image: File | HTMLCanvasElement) => {
    if (!ocrWorker) {
      onProgress?.({ stage: "ocr", current: completedUnits, total: totalUnits, message: "Preparando lectura de imágenes…" });
      const { createWorker } = await import("tesseract.js");
      ocrWorker = await createWorker(["eng", "spa"], 1, {
        workerPath: "/ocr/worker.min.js",
        corePath: "/ocr",
        langPath: "/ocr",
        gzip: true,
        logger: () => undefined,
      });
      await ocrWorker.setParameters({ preserve_interword_spaces: "1" });
    }
    const result = await ocrWorker.recognize(image);
    return { text: result.data.text.trim(), confidence: Math.round(result.data.confidence || 0) };
  };

  try {
    onProgress?.({ stage: "opening", current: 0, total: totalUnits, message: "Abriendo la factura…" });
    for (const [fileIndex, file] of files.entries()) {
      try {
        const buffer = await file.arrayBuffer();
        fileDigests.push(await sha256(buffer));
        if (kinds[fileIndex] === "pdf") {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
          const pdfDocument = await loadingTask.promise;
          try {
            totalUnits += Math.max(0, pdfDocument.numPages - 1);
            for (let pageIndex = 1; pageIndex <= pdfDocument.numPages; pageIndex += 1) {
              const page = await pdfDocument.getPage(pageIndex);
              try {
                const content = await page.getTextContent();
                let text = textFromPdfItems(content.items as unknown[]);
                let confidence = 100;
                let source: InvoicePageText["source"] = "pdf_text";
                if (!enoughText(text)) {
                  onProgress?.({ stage: "ocr", current: completedUnits, total: totalUnits, message: `Leyendo imagen de la página ${pages.length + 1}…` });
                  const baseViewport = page.getViewport({ scale: 1 });
                  const scale = Math.min(2.2, 2400 / Math.max(baseViewport.width, baseViewport.height));
                  const viewport = page.getViewport({ scale: Math.max(1.4, scale) });
                  const canvas = globalThis.document.createElement("canvas");
                  canvas.width = Math.ceil(viewport.width);
                  canvas.height = Math.ceil(viewport.height);
                  const context = canvas.getContext("2d", { willReadFrequently: true });
                  if (!context) throw new Error("No se pudo preparar una página de la factura.");
                  await page.render({ canvasContext: context, viewport, canvas }).promise;
                  const ocr = await recognize(canvas);
                  text = ocr.text;
                  confidence = ocr.confidence;
                  source = "ocr";
                }
                completedUnits += 1;
                pages.push({ pageNumber: pages.length + 1, text, confidence, source });
                onProgress?.({ stage: "reading", current: completedUnits, total: totalUnits, message: `Página ${completedUnits} de ${totalUnits} leída.` });
              } finally {
                page.cleanup();
              }
            }
          } finally {
            await loadingTask.destroy().catch(() => undefined);
          }
        } else {
          onProgress?.({ stage: "ocr", current: completedUnits, total: totalUnits, message: `Leyendo ${file.name}…` });
          const ocr = await recognize(file);
          pages.push({ pageNumber: pages.length + 1, text: ocr.text, confidence: ocr.confidence, source: "ocr" });
          completedUnits += 1;
          onProgress?.({ stage: "reading", current: completedUnits, total: totalUnits, message: `${file.name} leído.` });
        }
      } catch (error) {
        throw new Error(invoiceReadErrorMessage(error, file.name));
      }
    }
  } finally {
    const worker = ocrWorker as unknown as { terminate: () => Promise<unknown> } | null;
    if (worker) await worker.terminate().catch(() => undefined);
  }

  const readableCharacters = pages.reduce((total, page) => total + page.text.replace(/\s/g, "").length, 0);
  if (!pages.length || readableCharacters < 10) {
    throw new Error("No se pudo reconocer texto en la factura. Probá con un PDF original o una foto más clara y completa.");
  }
  pages.forEach((page) => {
    if (!page.text.trim()) warnings.push(`No se pudo reconocer texto en la página ${page.pageNumber}.`);
    else if (page.source === "ocr" && page.confidence < 45) warnings.push(`La página ${page.pageNumber} tiene baja seguridad de lectura y requiere revisión.`);
  });

  const fingerprint = await sha256(fileDigests.map((digest, index) => `${index}:${digest}`).join("|"));
  onProgress?.({ stage: "complete", current: totalUnits, total: totalUnits, message: "Factura lista para revisar." });
  return {
    fingerprint,
    fileName: files.map((file) => file.name).join(" + "),
    mimeTypes: [...new Set(files.map((file) => file.type || "application/octet-stream"))],
    pages,
    warnings: [...new Set(warnings)],
  };
}
