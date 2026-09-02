CREATE TABLE `chatwoot_contact_links` (
	`id` text PRIMARY KEY NOT NULL,
	`chatwoot_account_id` integer NOT NULL,
	`chatwoot_contact_id` integer NOT NULL,
	`customer_id` text NOT NULL,
	`source` text DEFAULT 'CRM' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chatwoot_contact_link_unique` ON `chatwoot_contact_links` (`chatwoot_account_id`,`chatwoot_contact_id`);--> statement-breakpoint
CREATE INDEX `chatwoot_contact_links_customer_idx` ON `chatwoot_contact_links` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `chatwoot_conversation_order_links` (
	`id` text PRIMARY KEY NOT NULL,
	`chatwoot_account_id` integer NOT NULL,
	`chatwoot_conversation_id` integer NOT NULL,
	`order_id` text NOT NULL,
	`link_role` text DEFAULT 'RELATED' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chatwoot_conversation_order_link_unique` ON `chatwoot_conversation_order_links` (`chatwoot_account_id`,`chatwoot_conversation_id`,`order_id`,`link_role`);--> statement-breakpoint
CREATE INDEX `chatwoot_conversation_order_links_order_idx` ON `chatwoot_conversation_order_links` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chatwoot_conversation_order_links_conversation_idx` ON `chatwoot_conversation_order_links` (`chatwoot_account_id`,`chatwoot_conversation_id`);--> statement-breakpoint
CREATE TABLE `crm_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`operation_type` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`response_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `customer_external_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_account` text DEFAULT '' NOT NULL,
	`external_id` text NOT NULL,
	`phone_normalized` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_external_identity_unique` ON `customer_external_identities` (`provider`,`external_account`,`external_id`);--> statement-breakpoint
CREATE INDEX `customer_external_identities_customer_idx` ON `customer_external_identities` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `customer_external_identities_phone_idx` ON `customer_external_identities` (`phone_normalized`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone_raw` text,
	`phone_normalized` text,
	`customer_status` text DEFAULT 'PROSPECT' NOT NULL,
	`province` text,
	`canton` text,
	`district` text,
	`default_delivery_address` text,
	`location_url` text,
	`location_reference` text,
	`latitude` real,
	`longitude` real,
	`preferred_payment_method` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_phone_normalized_unique` ON `customers` (`phone_normalized`);--> statement-breakpoint
CREATE INDEX `customers_updated_idx` ON `customers` (`updated_at`,`id`);