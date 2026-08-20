CREATE TABLE `delivery_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`route_date` text NOT NULL,
	`label` text,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`closed_at` text,
	CONSTRAINT "delivery_routes_status_check" CHECK("delivery_routes"."status" IN ('OPEN','CLOSED'))
);
--> statement-breakpoint
CREATE INDEX `delivery_routes_date_idx` ON `delivery_routes` (`route_date`,`status`,`id`);--> statement-breakpoint
CREATE TABLE `order_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`operation_id` text NOT NULL,
	`actor_principal` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `order_events_order_idx` ON `order_events` (`order_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_events_operation_type_unique` ON `order_events` (`operation_id`,`event_type`);--> statement-breakpoint
CREATE TABLE `order_external_references` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider` text NOT NULL,
	`reference_type` text NOT NULL,
	`external_id` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `order_external_references_order_idx` ON `order_external_references` (`order_id`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_external_references_external_unique` ON `order_external_references` (`provider`,`reference_type`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_external_references_order_unique` ON `order_external_references` (`order_id`,`provider`,`reference_type`);--> statement-breakpoint
CREATE TABLE `order_fulfillment_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`fulfillment_id` text NOT NULL,
	`order_line_id` text NOT NULL,
	`quantity` integer NOT NULL,
	FOREIGN KEY (`fulfillment_id`) REFERENCES `order_fulfillments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_line_id`) REFERENCES `order_lines`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_fulfillment_lines_quantity_check" CHECK("order_fulfillment_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX `order_fulfillment_lines_fulfillment_idx` ON `order_fulfillment_lines` (`fulfillment_id`,`id`);--> statement-breakpoint
CREATE INDEX `order_fulfillment_lines_order_line_idx` ON `order_fulfillment_lines` (`order_line_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_fulfillment_lines_unique` ON `order_fulfillment_lines` (`fulfillment_id`,`order_line_id`);--> statement-breakpoint
CREATE TABLE `order_fulfillments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`status` text DEFAULT 'DELIVERED' NOT NULL,
	`operation_id` text NOT NULL,
	`delivered_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_fulfillments_status_check" CHECK("order_fulfillments"."status" IN ('PARTIAL','DELIVERED'))
);
--> statement-breakpoint
CREATE INDEX `order_fulfillments_order_idx` ON `order_fulfillments` (`order_id`,`delivered_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_fulfillments_operation_unique` ON `order_fulfillments` (`operation_id`);--> statement-breakpoint
CREATE TABLE `order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`position` integer NOT NULL,
	`product_id` integer,
	`quantity` integer NOT NULL,
	`product_name_snapshot` text NOT NULL,
	`presentation_snapshot` text,
	`barcode_snapshot` text,
	`unit_price_original` integer,
	`unit_price_sold` integer NOT NULL,
	`discount_amount` integer DEFAULT 0 NOT NULL,
	`line_subtotal` integer NOT NULL,
	`line_total` integer NOT NULL,
	`historical_cost_snapshot` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`removed_at` text,
	`removed_reason` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "order_lines_quantity_check" CHECK("order_lines"."quantity" > 0),
	CONSTRAINT "order_lines_position_check" CHECK("order_lines"."position" > 0),
	CONSTRAINT "order_lines_money_check" CHECK("order_lines"."unit_price_sold" >= 0 AND "order_lines"."discount_amount" >= 0 AND "order_lines"."line_subtotal" >= 0 AND "order_lines"."line_total" >= 0),
	CONSTRAINT "order_lines_totals_check" CHECK("order_lines"."line_subtotal" = "order_lines"."quantity" * "order_lines"."unit_price_sold" AND "order_lines"."discount_amount" <= "order_lines"."line_subtotal" AND "order_lines"."line_total" = "order_lines"."line_subtotal" - "order_lines"."discount_amount")
);
--> statement-breakpoint
CREATE INDEX `order_lines_order_idx` ON `order_lines` (`order_id`,`position`,`id`);--> statement-breakpoint
CREATE INDEX `order_lines_product_idx` ON `order_lines` (`product_id`,`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_lines_position_unique` ON `order_lines` (`order_id`,`position`) WHERE "order_lines"."removed_at" IS NULL;--> statement-breakpoint
CREATE TABLE `order_number_allocations` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`allocated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_number_allocations_order_unique` ON `order_number_allocations` (`order_id`);--> statement-breakpoint
CREATE TABLE `order_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`operation_type` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`response_json` text,
	`guard` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	CONSTRAINT "order_operations_status_check" CHECK("order_operations"."status" IN ('pending','completed')),
	CONSTRAINT "order_operations_guard_check" CHECK("order_operations"."guard" = 1)
);
--> statement-breakpoint
CREATE INDEX `order_operations_order_idx` ON `order_operations` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`method` text NOT NULL,
	`payment_type` text DEFAULT 'PAYMENT' NOT NULL,
	`status` text DEFAULT 'POSTED' NOT NULL,
	`reference` text,
	`reverses_payment_id` text,
	`reason` text,
	`operation_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_payments_amount_check" CHECK("order_payments"."amount" > 0),
	CONSTRAINT "order_payments_currency_check" CHECK(length(trim("order_payments"."currency")) = 3),
	CONSTRAINT "order_payments_method_check" CHECK("order_payments"."method" IN ('CASH','SINPE','CARD','OTHER')),
	CONSTRAINT "order_payments_type_check" CHECK("order_payments"."payment_type" IN ('PAYMENT','REVERSAL','REFUND','VOID')),
	CONSTRAINT "order_payments_status_check" CHECK("order_payments"."status" = 'POSTED'),
	CONSTRAINT "order_payments_reversal_check" CHECK(("order_payments"."payment_type" = 'PAYMENT' AND "order_payments"."reverses_payment_id" IS NULL) OR ("order_payments"."payment_type" <> 'PAYMENT' AND "order_payments"."reverses_payment_id" IS NOT NULL AND length(trim(COALESCE("order_payments"."reason",''))) >= 3))
);
--> statement-breakpoint
CREATE INDEX `order_payments_order_idx` ON `order_payments` (`order_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_payments_operation_unique` ON `order_payments` (`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_payments_reversal_unique` ON `order_payments` (`reverses_payment_id`);--> statement-breakpoint
CREATE TABLE `order_return_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`return_id` text NOT NULL,
	`order_line_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`reenter_inventory` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`return_id`) REFERENCES `order_returns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_line_id`) REFERENCES `order_lines`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_return_lines_quantity_check" CHECK("order_return_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX `order_return_lines_return_idx` ON `order_return_lines` (`return_id`,`id`);--> statement-breakpoint
CREATE INDEX `order_return_lines_order_line_idx` ON `order_return_lines` (`order_line_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_return_lines_unique` ON `order_return_lines` (`return_id`,`order_line_id`);--> statement-breakpoint
CREATE TABLE `order_returns` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'COMPLETED' NOT NULL,
	`operation_id` text NOT NULL,
	`actor_principal` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_returns_status_check" CHECK("order_returns"."status" IN ('COMPLETED','REVERSED')),
	CONSTRAINT "order_returns_reason_check" CHECK(length(trim("order_returns"."reason")) >= 3)
);
--> statement-breakpoint
CREATE INDEX `order_returns_order_idx` ON `order_returns` (`order_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_returns_operation_unique` ON `order_returns` (`operation_id`);--> statement-breakpoint
CREATE TABLE `order_status_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`reason` text,
	`operation_id` text NOT NULL,
	`actor_principal` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_status_events_reason_check" CHECK("order_status_events"."to_status" NOT IN ('CANCELLED','REOPENED') OR length(trim(COALESCE("order_status_events"."reason",''))) >= 3)
);
--> statement-breakpoint
CREATE INDEX `order_status_events_order_idx` ON `order_status_events` (`order_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_status_events_operation_unique` ON `order_status_events` (`operation_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`order_number` text NOT NULL,
	`order_type` text DEFAULT 'STANDARD' NOT NULL,
	`customer_id` text,
	`customer_name_snapshot` text NOT NULL,
	`phone_raw` text,
	`phone_normalized` text,
	`delivery_address` text,
	`delivery_instructions` text,
	`province` text,
	`canton` text,
	`district` text,
	`latitude` real,
	`longitude` real,
	`scheduled_delivery_date` text,
	`route_id` text,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`currency` text DEFAULT 'CRC' NOT NULL,
	`subtotal` integer DEFAULT 0 NOT NULL,
	`discount_total` integer DEFAULT 0 NOT NULL,
	`delivery_fee` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`internal_notes` text,
	`delivery_notes` text,
	`source` text DEFAULT 'MANUAL' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`confirmed_at` text,
	`prepared_at` text,
	`delivered_at` text,
	`cancelled_at` text,
	`reopened_at` text,
	CONSTRAINT "orders_type_check" CHECK("orders"."order_type" IN ('STANDARD','SPECIAL_ORDER')),
	CONSTRAINT "orders_status_check" CHECK("orders"."status" IN ('DRAFT','CONFIRMED','PREPARED','DELIVERED','CANCELLED','REOPENED')),
	CONSTRAINT "orders_currency_check" CHECK(length(trim("orders"."currency")) = 3),
	CONSTRAINT "orders_source_check" CHECK("orders"."source" IN ('MANUAL','WHATSAPP','INSTAGRAM_FACEBOOK','WEB','CRM','OTHER')),
	CONSTRAINT "orders_money_check" CHECK("orders"."subtotal" >= 0 AND "orders"."discount_total" >= 0 AND "orders"."delivery_fee" >= 0 AND "orders"."total" >= 0),
	CONSTRAINT "orders_total_check" CHECK("orders"."total" = "orders"."subtotal" - "orders"."discount_total" + "orders"."delivery_fee"),
	CONSTRAINT "orders_version_check" CHECK("orders"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_number_unique` ON `orders` (`order_number`);--> statement-breakpoint
CREATE INDEX `orders_delivery_date_idx` ON `orders` (`scheduled_delivery_date`,`id`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `orders_phone_idx` ON `orders` (`phone_normalized`,`id`);--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`,`id`);--> statement-breakpoint
CREATE INDEX `orders_route_idx` ON `orders` (`route_id`,`id`);--> statement-breakpoint
CREATE TABLE `route_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`route_id` text NOT NULL,
	`order_id` text NOT NULL,
	`position` integer NOT NULL,
	`assigned_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`route_id`) REFERENCES `delivery_routes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "route_orders_position_check" CHECK("route_orders"."position" > 0)
);
--> statement-breakpoint
CREATE INDEX `route_orders_route_idx` ON `route_orders` (`route_id`,`position`,`id`);--> statement-breakpoint
CREATE INDEX `route_orders_order_idx` ON `route_orders` (`order_id`,`removed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `route_orders_position_unique` ON `route_orders` (`route_id`,`position`) WHERE "route_orders"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `route_orders_active_order_unique` ON `route_orders` (`order_id`) WHERE "route_orders"."removed_at" IS NULL;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `order_id` text;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `order_line_id` text;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD `movement_type` text;--> statement-breakpoint
CREATE INDEX `inventory_movements_order_idx` ON `inventory_movements` (`order_id`,`order_line_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_movements_order_operation_line_unique` ON `inventory_movements` (`operation_id`,`order_line_id`,`movement_type`) WHERE "inventory_movements"."order_line_id" IS NOT NULL;
