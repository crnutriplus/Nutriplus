/// <reference lib="webworker" />

import {
  isSpreadsheetWorkerRequest,
  parseSpreadsheetBuffer,
  workerErrorResponse,
} from "./spreadsheet-import-parser.ts";
import { SpreadsheetImportError } from "./spreadsheet-import-security.ts";

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<unknown>) => {
  if (!isSpreadsheetWorkerRequest(event.data)) {
    worker.postMessage(workerErrorResponse(new SpreadsheetImportError("INVALID_WORKER_RESPONSE")));
    return;
  }
  try {
    const result = parseSpreadsheetBuffer(event.data.buffer, event.data.selectedSheet);
    worker.postMessage({ ok: true, ...result });
  } catch (error) {
    worker.postMessage(workerErrorResponse(error));
  }
};

worker.onmessageerror = () => {
  worker.postMessage(workerErrorResponse(new SpreadsheetImportError("INVALID_WORKER_RESPONSE")));
};
