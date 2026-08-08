ALTER TABLE `products` ADD `quantity_available` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `minimum_stock` integer DEFAULT 0 NOT NULL;