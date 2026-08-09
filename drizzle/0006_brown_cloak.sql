CREATE TABLE `mutation_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `non_inventory_quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`purchase_price_usd_cents` integer,
	`weight_milli_lb` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `non_inventory_quotes_updated_idx` ON `non_inventory_quotes` (`updated_at`,`id`);--> statement-breakpoint
ALTER TABLE `import_backup_products` ADD `restock_purchased_at` text;--> statement-breakpoint
ALTER TABLE `import_backup_products` ADD `zero_stock_since` text;--> statement-breakpoint
ALTER TABLE `import_backup_products` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `restock_purchased_at` text;--> statement-breakpoint
ALTER TABLE `products` ADD `zero_stock_since` text;--> statement-breakpoint
ALTER TABLE `products` ADD `version` integer DEFAULT 1 NOT NULL;