import type { IntakeLineDto, IntakeLineStatus } from "./inventory-intake";

export type IntakeMovementAudit = {
  id: string;
  operationId: string;
  documentLineId: string;
  operationType: string;
  reversalOf: string;
  originalMovementId: string;
  productId: number;
  productName: string;
  barcode: string;
  previousQuantity: number;
  quantityChange: number;
  resultingQuantity: number;
  reason: string;
  confirmedBy: string;
  confirmedAt: string;
};

export type IntakeLineProgress = {
  originalQuantity: number;
  activeQuantity: number;
  availableQuantity: number;
  reversedQuantity: number;
  ingressQuantity: number;
  hasReversals: boolean;
  progressInconsistent: boolean;
  lastProductId: number | null;
  lastIngressOperationId: string;
  movements: IntakeMovementAudit[];
};

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function movementAuditFromRow(row: Record<string, unknown>): IntakeMovementAudit {
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    documentLineId: row.document_line_id ? String(row.document_line_id) : "",
    operationType: row.operation_type ? String(row.operation_type) : "ingress",
    reversalOf: row.reversal_of ? String(row.reversal_of) : "",
    originalMovementId: row.original_movement_id ? String(row.original_movement_id) : "",
    productId: number(row.product_id),
    productName: String(row.product_name || ""),
    barcode: row.barcode ? String(row.barcode) : "",
    previousQuantity: number(row.previous_quantity),
    quantityChange: number(row.quantity_change),
    resultingQuantity: number(row.resulting_quantity),
    reason: row.operation_reason ? String(row.operation_reason) : row.reason ? String(row.reason) : "",
    confirmedBy: row.operation_confirmed_by ? String(row.operation_confirmed_by) : row.confirmed_by ? String(row.confirmed_by) : "",
    confirmedAt: row.operation_confirmed_at ? String(row.operation_confirmed_at) : row.created_at ? String(row.created_at) : "",
  };
}

export async function loadDocumentMovementRows(db: D1Database, documentIds: string[]) {
  const ids = [...new Set(documentIds.filter(Boolean))];
  if (!ids.length) return [] as Record<string, unknown>[];
  const result = await db.prepare(`SELECT m.*,o.document_id AS operation_document_id,o.operation_type,
      o.reversal_of,o.reason AS operation_reason,o.confirmed_by AS operation_confirmed_by,
      o.confirmed_at AS operation_confirmed_at
    FROM inventory_movements m
    JOIN inventory_operations o ON o.id=m.operation_id
    WHERE o.status='completed' AND o.document_id IN (SELECT value FROM json_each(?))
    ORDER BY o.confirmed_at,m.created_at,m.id`).bind(JSON.stringify(ids)).all<Record<string, unknown>>();
  return result.results;
}

function availableStatus(line: IntakeLineDto): IntakeLineStatus {
  if (line.action === "existing") return "confirmed";
  if (line.action === "move") return "non_inventory";
  if (line.action === "create") return "new_product";
  if (line.receivedQuantity === null) return "pending_receive";
  if (!line.barcodeConfirmed) return "requires_confirm_code";
  return line.status === "processed" ? "requires_select_product" : line.status;
}

export function progressForLine(line: IntakeLineDto, rows: Record<string, unknown>[]): IntakeLineProgress {
  const movements = rows
    .filter((row) => String(row.document_line_id || "") === line.id)
    .map(movementAuditFromRow);
  const netQuantity = movements.reduce((total, movement) => total + movement.quantityChange, 0);
  const originalQuantity = Math.max(0, Number(line.totalToAdd || 0));
  const activeQuantity = Math.max(0, netQuantity);
  const reversedQuantity = movements.reduce((total, movement) => total + Math.max(0, -movement.quantityChange), 0);
  const ingressMovements = movements.filter((movement) => movement.quantityChange > 0);
  const ingressQuantity = ingressMovements.reduce((total, movement) => total + movement.quantityChange, 0);
  const lastIngress = ingressMovements.at(-1);
  return {
    originalQuantity,
    activeQuantity,
    availableQuantity: Math.max(0, originalQuantity - activeQuantity),
    reversedQuantity,
    ingressQuantity,
    hasReversals: reversedQuantity > 0,
    progressInconsistent: netQuantity < 0 || activeQuantity > originalQuantity,
    lastProductId: lastIngress?.productId || null,
    lastIngressOperationId: lastIngress?.operationId || "",
    movements,
  };
}

export function applyLineProgress(lines: IntakeLineDto[], movementRows: Record<string, unknown>[]) {
  return lines.map((source) => {
    const progress = progressForLine(source, movementRows);
    const hasHistoricalIngress = progress.ingressQuantity > 0;
    const line = hasHistoricalIngress && progress.lastProductId && source.action !== "ignore"
      ? { ...source, action: "existing" as const, matchProductId: progress.lastProductId, matchNonInventoryId: null }
      : source;
    const omitted = line.action === "ignore" || line.status === "ignored";
    const complete = progress.originalQuantity > 0 && progress.availableQuantity === 0;
    const status: IntakeLineStatus = omitted && progress.activeQuantity === 0
      ? "ignored"
      : complete ? "processed" : source.status === "processed" || hasHistoricalIngress ? availableStatus(line) : source.status;
    return {
      ...line,
      status,
      selectedForIngress: status !== "processed" && status !== "ignored" && (line.selectedForIngress || progress.hasReversals),
      processedOperationId: progress.lastIngressOperationId || line.processedOperationId,
      originalQuantity: progress.originalQuantity,
      activeQuantity: progress.activeQuantity,
      availableQuantity: progress.availableQuantity,
      reversedQuantity: progress.reversedQuantity,
      hasReversals: progress.hasReversals,
      progressInconsistent: progress.progressInconsistent,
      isOriginalLine: !line.lineKey.startsWith("manual-"),
      movementHistory: progress.movements,
    };
  });
}

export function conceptualDocumentStatus(lines: IntakeLineDto[], storedStatus = "draft") {
  if (["credit_note", "return"].includes(storedStatus)) return storedStatus;
  if (!lines.length) return storedStatus === "reviewing" ? "reviewing" : "draft";
  const pending = lines.some((line) => line.status !== "ignored" && Number(line.availableQuantity ?? line.totalToAdd) > 0);
  if (!pending) return "processed";
  const hasProgress = lines.some((line) => Number(line.activeQuantity || 0) > 0
    || Number(line.reversedQuantity || 0) > 0
    || line.status === "ignored");
  if (hasProgress) return "partial";
  if (lines.some((line) => Boolean(line.reviewSavedAt)) || storedStatus === "reviewing") return "reviewing";
  return "draft";
}

export function documentStatusStatement(db: D1Database, documentId: string, now = new Date().toISOString()) {
  return db.prepare(`UPDATE inventory_documents SET status=CASE
      WHEN status IN ('credit_note','return') THEN status
      WHEN NOT EXISTS (SELECT 1 FROM inventory_document_lines WHERE document_id=?)
        THEN CASE WHEN status='reviewing' THEN 'reviewing' ELSE 'draft' END
      WHEN NOT EXISTS (
        SELECT 1 FROM inventory_document_lines l
        WHERE l.document_id=? AND l.action<>'ignore' AND l.total_to_add>
          COALESCE((SELECT SUM(m.quantity_change) FROM inventory_movements m
            JOIN inventory_operations o ON o.id=m.operation_id
            WHERE m.document_line_id=l.id AND o.status IN ('pending','completed')),0)
      ) THEN 'processed'
      WHEN EXISTS (
        SELECT 1 FROM inventory_movements m JOIN inventory_operations o ON o.id=m.operation_id
        WHERE o.document_id=? AND o.status IN ('pending','completed')
      ) OR EXISTS (SELECT 1 FROM inventory_document_lines WHERE document_id=? AND action='ignore')
        THEN 'partial'
      WHEN EXISTS (SELECT 1 FROM inventory_document_lines WHERE document_id=? AND review_saved_at IS NOT NULL)
        THEN 'reviewing'
      ELSE 'draft' END,
    updated_at=? WHERE id=?`).bind(
    documentId,
    documentId,
    documentId,
    documentId,
    documentId,
    now,
    documentId,
  );
}
