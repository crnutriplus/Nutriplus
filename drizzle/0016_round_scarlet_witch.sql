CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`channel` text DEFAULT 'PUSH' NOT NULL,
	`state` text DEFAULT 'PENDING' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`response_status` integer,
	`error_code` text,
	`last_attempt_at` text,
	`delivered_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `push_subscriptions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "notification_deliveries_channel_check" CHECK("notification_deliveries"."channel" = 'PUSH'),
	CONSTRAINT "notification_deliveries_state_check" CHECK("notification_deliveries"."state" IN ('PENDING','SENT','FAILED','DISABLED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_target_unique` ON `notification_deliveries` (`notification_id`,`subscription_id`,`channel`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_state_idx` ON `notification_deliveries` (`state`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`source_operation_id` text,
	`dedupe_key` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`processing_state` text DEFAULT 'PENDING' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`processed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "notification_events_state_check" CHECK("notification_events"."processing_state" IN ('PENDING','MATERIALIZED','SKIPPED','FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_dedupe_unique` ON `notification_events` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notification_events_pending_idx` ON `notification_events` (`processing_state`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `notification_events_entity_idx` ON `notification_events` (`entity_type`,`entity_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` integer PRIMARY KEY NOT NULL,
	`principal_id` text,
	`push_enabled` integer DEFAULT false NOT NULL,
	`low_stock_enabled` integer DEFAULT true NOT NULL,
	`out_of_stock_enabled` integer DEFAULT true NOT NULL,
	`orders_enabled` integer DEFAULT true NOT NULL,
	`special_orders_enabled` integer DEFAULT true NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "notification_preferences_singleton_check" CHECK("notification_preferences"."id" = 1),
	CONSTRAINT "notification_preferences_boolean_check" CHECK("notification_preferences"."push_enabled" IN (0,1) AND "notification_preferences"."low_stock_enabled" IN (0,1) AND "notification_preferences"."out_of_stock_enabled" IN (0,1) AND "notification_preferences"."orders_enabled" IN (0,1) AND "notification_preferences"."special_orders_enabled" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `notification_resource_states` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`state_key` text NOT NULL,
	`state_value` text NOT NULL,
	`cycle` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "notification_resource_states_cycle_check" CHECK("notification_resource_states"."cycle" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_resource_states_unique` ON `notification_resource_states` (`entity_type`,`entity_id`,`state_key`);--> statement-breakpoint
CREATE INDEX `notification_resource_states_value_idx` ON `notification_resource_states` (`entity_type`,`state_key`,`state_value`,`updated_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`severity` text DEFAULT 'INFO' NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`target_url` text,
	`delivery_state` text DEFAULT 'IN_APP_ONLY' NOT NULL,
	`dedupe_key` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`read_at` text,
	`dismissed_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "notifications_severity_check" CHECK("notifications"."severity" IN ('INFO','WARNING','CRITICAL')),
	CONSTRAINT "notifications_delivery_state_check" CHECK("notifications"."delivery_state" IN ('IN_APP_ONLY','PUSH_PENDING','PUSH_SENT','PUSH_PARTIAL','PUSH_FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_event_unique` ON `notifications` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_unique` ON `notifications` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notifications_unread_idx` ON `notifications` (`dismissed_at`,`read_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `notifications_entity_idx` ON `notifications` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_id` text,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`content_encoding` text DEFAULT 'aes128gcm' NOT NULL,
	`device_label` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`disabled_at` text,
	`disabled_reason` text,
	CONSTRAINT "push_subscriptions_encoding_check" CHECK("push_subscriptions"."content_encoding" = 'aes128gcm')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_active_idx` ON `push_subscriptions` (`disabled_at`,`last_seen_at`,`id`);--> statement-breakpoint
INSERT OR IGNORE INTO `notification_preferences` (
	`id`,`principal_id`,`push_enabled`,`low_stock_enabled`,`out_of_stock_enabled`,`orders_enabled`,`special_orders_enabled`
) VALUES (1,NULL,0,1,1,1,1);--> statement-breakpoint
INSERT OR IGNORE INTO `notification_resource_states` (
	`id`,`entity_type`,`entity_id`,`state_key`,`state_value`,`cycle`,`updated_at`
)
SELECT
	'nstate-product-stock-'||`id`,
	'product',
	CAST(`id` AS TEXT),
	'stock',
	CASE
		WHEN `quantity_available`<=0 THEN 'OUT_OF_STOCK'
		WHEN `minimum_stock_enabled`=1 AND `quantity_available`<=`minimum_stock` THEN 'LOW_STOCK'
		ELSE 'NORMAL'
	END,
	0,
	COALESCE(`updated_at`,CURRENT_TIMESTAMP)
FROM `products`;
