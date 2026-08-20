DROP INDEX `inventory_movements_invoice_line_unique`;
--> statement-breakpoint
CREATE TRIGGER `inventory_movements_invoice_capacity_insert`
BEFORE INSERT ON `inventory_movements`
WHEN NEW.`document_line_id` LIKE 'iline-%' AND NEW.`quantity_change` > 0
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM `inventory_document_lines` WHERE `id` = NEW.`document_line_id`)
      THEN RAISE(ABORT, 'INVENTORY_LINE_NOT_FOUND')
    WHEN COALESCE((SELECT SUM(`quantity_change`) FROM `inventory_movements` WHERE `document_line_id` = NEW.`document_line_id`), 0) + NEW.`quantity_change` >
      COALESCE((SELECT `total_to_add` FROM `inventory_document_lines` WHERE `id` = NEW.`document_line_id`), 0)
      THEN RAISE(ABORT, 'INVENTORY_LINE_CAPACITY_EXCEEDED')
  END;
END;
--> statement-breakpoint
UPDATE `inventory_documents` SET `status` = CASE
  WHEN `status` IN ('credit_note', 'return') THEN `status`
  WHEN NOT EXISTS (SELECT 1 FROM `inventory_document_lines` WHERE `document_id` = `inventory_documents`.`id`)
    THEN CASE WHEN `status` = 'reviewing' THEN 'reviewing' ELSE 'draft' END
  WHEN NOT EXISTS (
    SELECT 1 FROM `inventory_document_lines` `l`
    WHERE `l`.`document_id` = `inventory_documents`.`id` AND `l`.`action` <> 'ignore'
      AND `l`.`total_to_add` > COALESCE((
        SELECT SUM(`m`.`quantity_change`) FROM `inventory_movements` `m`
        JOIN `inventory_operations` `o` ON `o`.`id` = `m`.`operation_id`
        WHERE `m`.`document_line_id` = `l`.`id` AND `o`.`status` = 'completed'
      ), 0)
  ) THEN 'processed'
  WHEN EXISTS (
    SELECT 1 FROM `inventory_movements` `m`
    JOIN `inventory_operations` `o` ON `o`.`id` = `m`.`operation_id`
    WHERE `o`.`document_id` = `inventory_documents`.`id` AND `o`.`status` = 'completed'
  ) OR EXISTS (
    SELECT 1 FROM `inventory_document_lines`
    WHERE `document_id` = `inventory_documents`.`id` AND `action` = 'ignore'
  ) THEN 'partial'
  WHEN EXISTS (
    SELECT 1 FROM `inventory_document_lines`
    WHERE `document_id` = `inventory_documents`.`id` AND `review_saved_at` IS NOT NULL
  ) THEN 'reviewing'
  ELSE 'draft'
END;
--> statement-breakpoint
CREATE TRIGGER `inventory_movements_invoice_active_nonnegative`
BEFORE INSERT ON `inventory_movements`
WHEN NEW.`document_line_id` LIKE 'iline-%' AND NEW.`quantity_change` < 0
BEGIN
  SELECT CASE
    WHEN COALESCE((SELECT SUM(`quantity_change`) FROM `inventory_movements` WHERE `document_line_id` = NEW.`document_line_id`), 0) + NEW.`quantity_change` < 0
      THEN RAISE(ABORT, 'INVENTORY_LINE_ACTIVE_NEGATIVE')
  END;
END;
