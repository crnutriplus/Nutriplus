DROP INDEX IF EXISTS `inventory_movements_invoice_line_unique`;
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
