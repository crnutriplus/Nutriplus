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

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: ArrayBuffer | Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)));
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
  const allowed = files.every((file) => file.type === "application/pdf" || file.type.startsWith("image/"));
  if (!allowed) throw new Error("Solo se permiten archivos PDF o imágenes.");
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
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      fileDigests.push(await sha256(buffer));
      if (file.type === "application/pdf") {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
        totalUnits += Math.max(0, document.numPages - 1);
        for (let pageIndex = 1; pageIndex <= document.numPages; pageIndex += 1) {
          const page = await document.getPage(pageIndex);
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
          page.cleanup();
        }
        await (document as unknown as { destroy: () => Promise<void> }).destroy();
      } else {
        onProgress?.({ stage: "ocr", current: completedUnits, total: totalUnits, message: `Leyendo ${file.name}…` });
        try {
          const ocr = await recognize(file);
          pages.push({ pageNumber: pages.length + 1, text: ocr.text, confidence: ocr.confidence, source: "ocr" });
        } catch {
          pages.push({ pageNumber: pages.length + 1, text: "", confidence: 0, source: "ocr" });
          warnings.push(`No se pudo leer claramente ${file.name}.`);
        }
        completedUnits += 1;
        onProgress?.({ stage: "reading", current: completedUnits, total: totalUnits, message: `${file.name} leído.` });
      }
    }
  } finally {
    const worker = ocrWorker as unknown as { terminate: () => Promise<unknown> } | null;
    if (worker) await worker.terminate().catch(() => undefined);
  }

  const fingerprint = await sha256(fileDigests.map((digest, index) => `${index}:${digest}`).join("|"));
  onProgress?.({ stage: "complete", current: totalUnits, total: totalUnits, message: "Factura lista para revisar." });
  return {
    fingerprint,
    fileName: files.map((file) => file.name).join(" + "),
    mimeTypes: [...new Set(files.map((file) => file.type || "application/octet-stream"))],
    pages,
    warnings,
  };
}
