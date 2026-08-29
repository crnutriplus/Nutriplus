CREATE TABLE `finance_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`year_month` text NOT NULL,
	`amount_crc` integer NOT NULL,
	`operation_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "finance_budgets_amount_check" CHECK("finance_budgets"."amount_crc" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_budgets_category_month_unique` ON `finance_budgets` (`category`,`year_month`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_budgets_operation_unique` ON `finance_budgets` (`operation_id`);--> statement-breakpoint
CREATE TABLE `finance_expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`expense_date` text NOT NULL,
	`category` text NOT NULL,
	`description` text NOT NULL,
	`amount_crc` integer NOT NULL,
	`original_amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'CRC' NOT NULL,
	`exchange_rate_crc` integer DEFAULT 1 NOT NULL,
	`payment_method` text NOT NULL,
	`provider` text,
	`notes` text,
	`route_id` text,
	`order_id` text,
	`source_type` text DEFAULT 'MANUAL' NOT NULL,
	`source_id` text,
	`idempotency_key` text NOT NULL,
	`entry_type` text DEFAULT 'EXPENSE' NOT NULL,
	`reverses_expense_id` text,
	`business_scope` text DEFAULT 'BUSINESS' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "finance_expenses_amount_check" CHECK("finance_expenses"."amount_crc" > 0 AND "finance_expenses"."original_amount_minor" > 0 AND "finance_expenses"."exchange_rate_crc" > 0),
	CONSTRAINT "finance_expenses_currency_check" CHECK(length(trim("finance_expenses"."currency")) = 3),
	CONSTRAINT "finance_expenses_method_check" CHECK("finance_expenses"."payment_method" IN ('CASH','SINPE','CARD','OTHER')),
	CONSTRAINT "finance_expenses_entry_check" CHECK("finance_expenses"."entry_type" IN ('EXPENSE','REVERSAL')),
	CONSTRAINT "finance_expenses_scope_check" CHECK("finance_expenses"."business_scope" IN ('BUSINESS','PERSONAL')),
	CONSTRAINT "finance_expenses_reversal_check" CHECK(("finance_expenses"."entry_type" = 'EXPENSE' AND "finance_expenses"."reverses_expense_id" IS NULL) OR ("finance_expenses"."entry_type" = 'REVERSAL' AND "finance_expenses"."reverses_expense_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_expenses_idempotency_unique` ON `finance_expenses` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_expenses_reversal_unique` ON `finance_expenses` (`reverses_expense_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_expenses_source_unique` ON `finance_expenses` (`source_type`,`source_id`) WHERE "finance_expenses"."entry_type" = 'EXPENSE' AND "finance_expenses"."source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `finance_expenses_date_idx` ON `finance_expenses` (`expense_date`,`id`);--> statement-breakpoint
CREATE INDEX `finance_expenses_route_idx` ON `finance_expenses` (`route_id`,`expense_date`,`id`);--> statement-breakpoint
CREATE INDEX `finance_expenses_order_idx` ON `finance_expenses` (`order_id`,`expense_date`,`id`);--> statement-breakpoint
CREATE TABLE `finance_recurring_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`amount_crc` integer NOT NULL,
	`currency` text DEFAULT 'CRC' NOT NULL,
	`exchange_rate_crc` integer DEFAULT 1 NOT NULL,
	`payment_method` text NOT NULL,
	`frequency` text NOT NULL,
	`next_due_date` text NOT NULL,
	`provider` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "finance_recurring_amount_check" CHECK("finance_recurring_templates"."amount_crc" > 0 AND "finance_recurring_templates"."exchange_rate_crc" > 0),
	CONSTRAINT "finance_recurring_method_check" CHECK("finance_recurring_templates"."payment_method" IN ('CASH','SINPE','CARD','OTHER')),
	CONSTRAINT "finance_recurring_frequency_check" CHECK("finance_recurring_templates"."frequency" IN ('WEEKLY','MONTHLY','QUARTERLY','YEARLY'))
);
--> statement-breakpoint
CREATE INDEX `finance_recurring_due_idx` ON `finance_recurring_templates` (`active`,`next_due_date`,`id`);--> statement-breakpoint
CREATE TABLE `finance_sale_events` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`event_type` text NOT NULL,
	`source_operation_id` text NOT NULL,
	`reason` text,
	`previous_json` text DEFAULT '{}' NOT NULL,
	`next_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `finance_sales`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "finance_sale_events_type_check" CHECK("finance_sale_events"."event_type" IN ('RECOGNITION','REVERSAL'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_sale_events_operation_unique` ON `finance_sale_events` (`source_operation_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `finance_sale_events_sale_idx` ON `finance_sale_events` (`sale_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `finance_sale_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`order_line_id` text NOT NULL,
	`product_id` integer,
	`product_name_snapshot` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_real` integer NOT NULL,
	`gross_income` integer NOT NULL,
	`allocated_discount` integer DEFAULT 0 NOT NULL,
	`net_income` integer NOT NULL,
	`historical_unit_cost` integer,
	`historical_cogs` integer,
	`gross_profit` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `finance_sales`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`order_line_id`) REFERENCES `order_lines`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "finance_sale_lines_quantity_check" CHECK("finance_sale_lines"."quantity" > 0),
	CONSTRAINT "finance_sale_lines_money_check" CHECK("finance_sale_lines"."unit_price_real" >= 0 AND "finance_sale_lines"."gross_income" >= 0 AND "finance_sale_lines"."allocated_discount" >= 0 AND "finance_sale_lines"."net_income" >= 0 AND ("finance_sale_lines"."historical_unit_cost" IS NULL OR "finance_sale_lines"."historical_unit_cost" >= 0) AND ("finance_sale_lines"."historical_cogs" IS NULL OR "finance_sale_lines"."historical_cogs" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_sale_lines_sale_order_line_unique` ON `finance_sale_lines` (`sale_id`,`order_line_id`);--> statement-breakpoint
CREATE INDEX `finance_sale_lines_product_idx` ON `finance_sale_lines` (`product_id`,`sale_id`);--> statement-breakpoint
CREATE TABLE `finance_sales` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`order_number` text NOT NULL,
	`customer_name_snapshot` text NOT NULL,
	`delivered_at` text NOT NULL,
	`route_id` text,
	`currency` text DEFAULT 'CRC' NOT NULL,
	`product_gross_total` integer NOT NULL,
	`discount_total` integer DEFAULT 0 NOT NULL,
	`product_net_total` integer NOT NULL,
	`delivery_income` integer DEFAULT 0 NOT NULL,
	`total_income` integer NOT NULL,
	`historical_cogs_total` integer,
	`cost_status` text DEFAULT 'MISSING' NOT NULL,
	`source_operation_id` text NOT NULL,
	`status` text DEFAULT 'RECOGNIZED' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`reversed_at` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "finance_sales_status_check" CHECK("finance_sales"."status" IN ('RECOGNIZED','REVERSED')),
	CONSTRAINT "finance_sales_cost_status_check" CHECK("finance_sales"."cost_status" IN ('COMPLETE','MISSING')),
	CONSTRAINT "finance_sales_money_check" CHECK("finance_sales"."product_gross_total" >= 0 AND "finance_sales"."discount_total" >= 0 AND "finance_sales"."product_net_total" >= 0 AND "finance_sales"."delivery_income" >= 0 AND "finance_sales"."total_income" >= 0 AND ("finance_sales"."historical_cogs_total" IS NULL OR "finance_sales"."historical_cogs_total" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finance_sales_source_operation_unique` ON `finance_sales` (`source_operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `finance_sales_active_order_unique` ON `finance_sales` (`order_id`) WHERE "finance_sales"."status" = 'RECOGNIZED';--> statement-breakpoint
CREATE INDEX `finance_sales_delivered_idx` ON `finance_sales` (`delivered_at`,`id`);--> statement-breakpoint
CREATE INDEX `finance_sales_route_idx` ON `finance_sales` (`route_id`,`delivered_at`,`id`);