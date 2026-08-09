CREATE TABLE `product_deletion_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`total_products` integer DEFAULT 0 NOT NULL,
	`processed_products` integer DEFAULT 0 NOT NULL,
	`deleted_products` integer DEFAULT 0 NOT NULL,
	`preserved_products` integer DEFAULT 0 NOT NULL,
	`backup_import_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `product_deletion_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deletion_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`processed` integer DEFAULT false NOT NULL,
	`outcome` text
);
--> statement-breakpoint
CREATE INDEX `product_deletion_rows_pending_idx` ON `product_deletion_rows` (`deletion_id`,`processed`,`id`);