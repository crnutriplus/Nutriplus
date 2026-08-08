/// <reference lib="webworker" />

import * as XLSX from "xlsx";

const worker = self as unknown as DedicatedWorkerGlobalScope;

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}

worker.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer }>) => {
  try {
    const book = XLSX.read(event.data.buffer, { type: "array", dense: true });
    const sheetName = book.SheetNames.find((name) => normalize(name) === "compu") || book.SheetNames[0];
    if (!sheetName) throw new Error("El archivo no contiene hojas.");
    const data = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheetName], { header: 1, defval: "", raw: true });
    if (data.length < 2) throw new Error("El archivo no contiene productos.");
    const headerIndex = data.findIndex((row) => row.some((cell) => normalize(String(cell)) === "producto"));
    if (headerIndex < 0) throw new Error("No se encontró la columna Producto.");
    const headers = data[headerIndex].map((cell, index) => String(cell || `Columna ${index + 1}`).trim());
    const rows = data.slice(headerIndex + 1).filter((row) => row.some((cell) => String(cell).trim()));
    worker.postMessage({ ok: true, sheetName, headers, rows, firstDataRow: headerIndex + 2 });
  } catch (error) {
    worker.postMessage({ ok: false, error: error instanceof Error ? error.message : "No se pudo leer el archivo." });
  }
};
