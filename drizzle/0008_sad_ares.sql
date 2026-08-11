CREATE TABLE `inventory_document_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`line_key` text NOT NULL,
	`page_number` integer,
	`original_description` text NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`presentation` text,
	`flavor` text,
	`concentration` text,
	`billed_quantity` integer,
	`received_quantity` integer,
	`units_per_package` integer DEFAULT 1 NOT NULL,
	`total_to_add` integer DEFAULT 0 NOT NULL,
	`barcode` text,
	`canonical_barcode` text,
	`barcode_type` text,
	`secondary_id` text,
	`secondary_type` text,
	`barcode_method` text,
	`barcode_source` text,
	`confidence` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'requires_confirm_code' NOT NULL,
	`match_product_id` integer,
	`match_non_inventory_id` integer,
	`action` text DEFAULT 'pending' NOT NULL,
	`barcode_level` text,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`processed_operation_id` text,
	`ignored_reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_document_lines_key_unique` ON `inventory_document_lines` (`document_id`,`line_key`);--> statement-breakpoint
CREATE INDEX `inventory_document_lines_document_idx` ON `inventory_document_lines` (`document_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `inventory_document_lines_barcode_idx` ON `inventory_document_lines` (`canonical_barcode`);--> statement-breakpoint
CREATE TABLE `inventory_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`file_fingerprint` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_types_json` text DEFAULT '[]' NOT NULL,
	`provider` text DEFAULT 'other' NOT NULL,
	`order_number` text,
	`invoice_number` text,
	`shipment_number` text,
	`document_date` text,
	`page_count` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`duplicate_of` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`confirmed_at` text,
	`confirmed_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_documents_fingerprint_unique` ON `inventory_documents` (`file_fingerprint`);--> statement-breakpoint
CREATE INDEX `inventory_documents_history_idx` ON `inventory_documents` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `inventory_documents_order_idx` ON `inventory_documents` (`provider`,`order_number`,`shipment_number`);--> statement-breakpoint
CREATE TABLE `inventory_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`original_movement_id` text,
	`document_line_id` text,
	`product_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`barcode` text,
	`canonical_barcode` text,
	`secondary_id` text,
	`secondary_type` text,
	`previous_quantity` integer NOT NULL,
	`quantity_change` integer NOT NULL,
	`conversion` integer DEFAULT 1 NOT NULL,
	`resulting_quantity` integer NOT NULL,
	`barcode_method` text,
	`barcode_source` text,
	`confirmed_by` text,
	`reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_movements_operation_line_unique` ON `inventory_movements` (`operation_id`,`document_line_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_product_idx` ON `inventory_movements` (`product_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `inventory_movements_operation_idx` ON `inventory_movements` (`operation_id`,`id`);--> statement-breakpoint
CREATE TABLE `inventory_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text,
	`operation_type` text DEFAULT 'ingress' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reversal_of` text,
	`reason` text,
	`confirmed_by` text,
	`line_count` integer DEFAULT 0 NOT NULL,
	`total_units` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`confirmed_at` text,
	`verification_status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inventory_operations_history_idx` ON `inventory_operations` (`confirmed_at`,`id`);--> statement-breakpoint
CREATE INDEX `inventory_operations_document_idx` ON `inventory_operations` (`document_id`,`status`);--> statement-breakpoint
CREATE TABLE `supplier_product_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`secondary_type` text NOT NULL,
	`secondary_id` text NOT NULL,
	`barcode` text NOT NULL,
	`canonical_barcode` text NOT NULL,
	`product_id` integer NOT NULL,
	`description_signature` text NOT NULL,
	`presentation_signature` text,
	`units_per_package` integer DEFAULT 1 NOT NULL,
	`barcode_level` text DEFAULT 'unit' NOT NULL,
	`source` text,
	`confirmed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`confirmed_by` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_product_aliases_identity_unique` ON `supplier_product_aliases` (`provider`,`secondary_type`,`secondary_id`);--> statement-breakpoint
CREATE INDEX `supplier_product_aliases_barcode_idx` ON `supplier_product_aliases` (`canonical_barcode`,`product_id`);--> statement-breakpoint
ALTER TABLE `products` ADD `brand` text;--> statement-breakpoint
ALTER TABLE `products` ADD `presentation` text;