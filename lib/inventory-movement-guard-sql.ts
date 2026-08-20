/**
 * D1 guard statements for invoice-line movement balance.
 *
 * Sites applies Drizzle files through a migration executor that does not accept
 * trigger bodies containing internal statement terminators. Each API route
 * calls ensureDatabase() before a mutation, so these single prepared
 * statements install the guards before invoice inventory can be changed.
 */
export const INVENTORY_MOVEMENT_CAPACITY_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS inventory_movements_invoice_capacity_insert
  BEFORE INSERT ON inventory_movements
  WHEN NEW.document_line_id LIKE 'iline-%' AND NEW.quantity_change>0
  BEGIN
    SELECT CASE
      WHEN NOT EXISTS (SELECT 1 FROM inventory_document_lines WHERE id=NEW.document_line_id)
        THEN RAISE(ABORT,'INVENTORY_LINE_NOT_FOUND')
      WHEN COALESCE((SELECT SUM(quantity_change) FROM inventory_movements WHERE document_line_id=NEW.document_line_id),0)+NEW.quantity_change>
        COALESCE((SELECT total_to_add FROM inventory_document_lines WHERE id=NEW.document_line_id),0)
        THEN RAISE(ABORT,'INVENTORY_LINE_CAPACITY_EXCEEDED')
    END;
  END`;

export const INVENTORY_MOVEMENT_NONNEGATIVE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS inventory_movements_invoice_active_nonnegative
  BEFORE INSERT ON inventory_movements
  WHEN NEW.document_line_id LIKE 'iline-%' AND NEW.quantity_change<0
  BEGIN
    SELECT CASE
      WHEN COALESCE((SELECT SUM(quantity_change) FROM inventory_movements WHERE document_line_id=NEW.document_line_id),0)+NEW.quantity_change<0
        THEN RAISE(ABORT,'INVENTORY_LINE_ACTIVE_NEGATIVE')
    END;
  END`;
