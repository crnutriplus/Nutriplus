import {
  isSpreadsheetWorkerResponse,
  type SpreadsheetWorkerSuccess,
} from "./spreadsheet-import-parser.ts";
import {
  SPREADSHEET_IMPORT_LIMITS,
  SpreadsheetImportError,
} from "./spreadsheet-import-security.ts";

type SpreadsheetWorkerLike = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror" | "onmessageerror">;

export type SpreadsheetWorkerFactory = () => SpreadsheetWorkerLike;

function defaultWorkerFactory(): SpreadsheetWorkerLike {
  return new Worker(new URL("./import-worker.ts", import.meta.url), { type: "module" });
}

export function runSpreadsheetWorker(
  buffer: ArrayBuffer,
  selectedSheet?: string,
  workerFactory: SpreadsheetWorkerFactory = defaultWorkerFactory,
  timeoutMs = SPREADSHEET_IMPORT_LIMITS.workerTimeoutMs,
) {
  return new Promise<SpreadsheetWorkerSuccess>((resolve, reject) => {
    let settled = false;
    let parser: SpreadsheetWorkerLike | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parser?.terminate();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new SpreadsheetImportError("WORKER_TIMEOUT")));
    }, timeoutMs);

    try {
      parser = workerFactory();
    } catch {
      clearTimeout(timer);
      reject(new SpreadsheetImportError("WORKER_FAILURE"));
      return;
    }
    parser.onmessage = (message: MessageEvent<unknown>) => {
      const data = message.data;
      if (!isSpreadsheetWorkerResponse(data)) {
        finish(() => reject(new SpreadsheetImportError("INVALID_WORKER_RESPONSE")));
        return;
      }
      if (!data.ok) {
        finish(() => reject(new Error(data.error)));
        return;
      }
      const result: SpreadsheetWorkerSuccess = data.status === "select_sheet"
        ? { status: "select_sheet", sheetNames: data.sheetNames }
        : {
          status: "ready",
          sheetName: data.sheetName,
          headers: data.headers,
          rows: data.rows,
          formattedRows: data.formattedRows,
          rowNumbers: data.rowNumbers,
          warnings: data.warnings,
        };
      finish(() => resolve(result));
    };
    parser.onerror = () => finish(() => reject(new SpreadsheetImportError("WORKER_FAILURE")));
    parser.onmessageerror = () => finish(() => reject(new SpreadsheetImportError("INVALID_WORKER_RESPONSE")));
    parser.postMessage({ type: "parse", buffer, selectedSheet }, [buffer]);
  });
}
