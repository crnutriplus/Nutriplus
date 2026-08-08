CREATE TABLE `import_backup_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`backup_id` integer NOT NULL,
	`original_id` integer NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`code` text,
	`purchase_price_usd_cents` integer,
	`weight_milli_lb` integer,
	`quantity_available` integer DEFAULT 0 NOT NULL,
	`minimum_stock` integer DEFAULT 0 NOT NULL,
	`minimum_stock_enabled` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` integer NOT NULL,
	`product_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_job_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` integer NOT NULL,
	`row_number` integer NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`code` text,
	`purchase_price_usd_cents` integer,
	`weight_milli_lb` integer,
	`quantity_available` integer,
	`minimum_stock` integer,
	`minimum_stock_enabled` integer,
	`has_code` integer DEFAULT false NOT NULL,
	`has_purchase_price` integer DEFAULT false NOT NULL,
	`has_weight` integer DEFAULT false NOT NULL,
	`has_quantity` integer DEFAULT false NOT NULL,
	`has_minimum_stock` integer DEFAULT false NOT NULL,
	`processed` integer DEFAULT false NOT NULL,
	`outcome` text,
	`message` text
);
--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_name` text NOT NULL,
	`sheet_name` text,
	`strategy` text DEFAULT 'update' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`processed_rows` integer DEFAULT 0 NOT NULL,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`updated_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`conflict_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`incomplete_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	`restored_at` text
);
--> statement-breakpoint
ALTER TABLE `products` ADD `minimum_stock_enabled` integer DEFAULT false NOT NULL;