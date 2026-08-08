import type { ProductRecord } from "./pricing";

export type ImportJobStatus = "queued" | "running" | "completed" | "failed";

export type ImportJobRecord = {
  id: number;
  fileName: string;
  sheetName: string | null;
  strategy: "update" | "skip" | "backup";
  status: ImportJobStatus;
  totalRows: number;
  processedRows: number;
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  conflictCount: number;
  errorCount: number;
  incompleteCount: number;
  createdAt: string;
  completedAt: string | null;
  restoredAt: string | null;
};

export type ImportChangedProduct = {
  outcome: "imported" | "updated";
  product: ProductRecord;
};

export function importJobFromRow(row: Record<string, unknown>): ImportJobRecord {
  return {
    id: Number(row.id),
    fileName: String(row.file_name),
    sheetName: row.sheet_name ? String(row.sheet_name) : null,
    strategy: (row.strategy === "skip" || row.strategy === "backup" ? row.strategy : "update"),
    status: (row.status === "running" || row.status === "completed" || row.status === "failed" ? row.status : "queued"),
    totalRows: Number(row.total_rows ?? 0),
    processedRows: Number(row.processed_rows ?? 0),
    importedCount: Number(row.imported_count ?? 0),
    updatedCount: Number(row.updated_count ?? 0),
    skippedCount: Number(row.skipped_count ?? 0),
    conflictCount: Number(row.conflict_count ?? 0),
    errorCount: Number(row.error_count ?? 0),
    incompleteCount: Number(row.incomplete_count ?? 0),
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    restoredAt: row.restored_at ? String(row.restored_at) : null,
  };
}
