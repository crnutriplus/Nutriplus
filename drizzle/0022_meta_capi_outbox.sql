CREATE TABLE `meta_capi_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`event_id` text NOT NULL,
	`event_name` text NOT NULL,
	`event_time` text NOT NULL,
	`order_id` text,
	`order_number` text,
	`value_crc` integer,
	`chatwoot_account_id` integer NOT NULL,
	`chatwoot_conversation_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	CONSTRAINT "meta_capi_jobs_event_name_check" CHECK("meta_capi_jobs"."event_name" IN ('LeadSubmitted','Purchase')),
	CONSTRAINT "meta_capi_jobs_status_check" CHECK("meta_capi_jobs"."status" IN ('pending','processing','completed','failed')),
	CONSTRAINT "meta_capi_jobs_attempts_check" CHECK("meta_capi_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meta_capi_jobs_dedupe_unique` ON `meta_capi_jobs` (`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `meta_capi_jobs_event_id_unique` ON `meta_capi_jobs` (`event_id`);--> statement-breakpoint
CREATE INDEX `meta_capi_jobs_due_idx` ON `meta_capi_jobs` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `meta_capi_jobs_lease_idx` ON `meta_capi_jobs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `meta_capi_jobs_order_idx` ON `meta_capi_jobs` (`order_id`,`event_name`);