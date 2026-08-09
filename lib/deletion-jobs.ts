export type ProductDeletionJobRecord = {
  id: number;
  status: "queued" | "running" | "completed" | "failed";
  totalProducts: number;
  processedProducts: number;
  deletedProducts: number;
  preservedProducts: number;
  backupImportId: number | null;
  createdAt: string;
  completedAt: string | null;
};

export function productDeletionJobFromRow(row: Record<string, unknown>): ProductDeletionJobRecord {
  return {
    id: Number(row.id),
    status: String(row.status) as ProductDeletionJobRecord["status"],
    totalProducts: Number(row.total_products ?? 0),
    processedProducts: Number(row.processed_products ?? 0),
    deletedProducts: Number(row.deleted_products ?? 0),
    preservedProducts: Number(row.preserved_products ?? 0),
    backupImportId: row.backup_import_id == null ? null : Number(row.backup_import_id),
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}
