CREATE TABLE `inventory_document_files` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`file_index` integer NOT NULL,
	`storage_key` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`file_sha256` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_document_files_order_unique` ON `inventory_document_files` (`document_id`,`file_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_document_files_storage_unique` ON `inventory_document_files` (`storage_key`);--> statement-breakpoint
CREATE INDEX `inventory_document_files_document_idx` ON `inventory_document_files` (`document_id`,`file_index`);--> statement-breakpoint
CREATE TABLE `invoice_ai_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`file_fingerprint` text NOT NULL,
	`analysis_number` integer NOT NULL,
	`model` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`response_id` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`web_search_count` integer DEFAULT 0 NOT NULL,
	`estimated_cost_microusd` integer DEFAULT 0 NOT NULL,
	`extraction_json` text DEFAULT '{}' NOT NULL,
	`error_code` text,
	`error_message` text,
	`reanalysis` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_ai_analyses_number_unique` ON `invoice_ai_analyses` (`document_id`,`analysis_number`);--> statement-breakpoint
CREATE INDEX `invoice_ai_analyses_document_idx` ON `invoice_ai_analyses` (`document_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `invoice_ai_analyses_usage_idx` ON `invoice_ai_analyses` (`created_at`,`estimated_cost_microusd`);--> statement-breakpoint
ALTER TABLE `inventory_document_lines` ADD `size` text;--> statement-breakpoint
ALTER TABLE `inventory_document_lines` ADD `barcode_source_url` text;--> statement-breakpoint
ALTER TABLE `inventory_document_lines` ADD `barcode_source_title` text;--> statement-breakpoint
ALTER TABLE `inventory_document_lines` ADD `barcode_differences_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_document_lines` ADD `barcode_lookup_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_document_lines` ADD `field_evidence_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_document_lines` ADD `selected_for_ingress` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_document_lines` ADD `review_saved_at` text;--> statement-breakpoint
ALTER TABLE `inventory_documents` ADD `file_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_documents` ADD `processing_mode` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_documents` ADD `analysis_status` text DEFAULT 'not_requested' NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_documents` ADD `active_analysis_id` text;--> statement-breakpoint
ALTER TABLE `inventory_documents` ADD `field_evidence_json` text DEFAULT '{}' NOT NULL;