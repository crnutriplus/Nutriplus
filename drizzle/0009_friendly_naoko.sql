ALTER TABLE `inventory_document_lines` ADD `barcode_confirmed` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
PRAGMA user_version = 9;
