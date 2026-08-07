CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`code` text,
	`purchase_price_usd_cents` integer NOT NULL,
	`weight_milli_lb` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_normalized_name_unique` ON `products` (`normalized_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_code_unique` ON `products` (`code`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`exchange_rate_crc` integer DEFAULT 520 NOT NULL,
	`courier_rate_usd_cents` integer DEFAULT 550 NOT NULL,
	`extra_weight_milli_lb` integer DEFAULT 100 NOT NULL,
	`delivery_crc` integer DEFAULT 1000 NOT NULL,
	`correos_crc` integer DEFAULT 500 NOT NULL,
	`gam_profit_crc` integer DEFAULT 5000 NOT NULL,
	`puerto_profit_crc` integer DEFAULT 4000 NOT NULL,
	`rounding_crc` integer DEFAULT 100 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
