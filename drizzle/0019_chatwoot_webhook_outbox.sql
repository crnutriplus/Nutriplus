CREATE TABLE `chatwoot_webhook_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`event_type` text NOT NULL,
	`chatwoot_account_id` integer NOT NULL,
	`chatwoot_contact_id` integer,
	`chatwoot_conversation_id` integer,
	`status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending','processing','completed','failed')),
	`attempts` integer DEFAULT 0 NOT NULL CHECK (`attempts` >= 0),
	`last_error` text,
	`next_attempt_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chatwoot_webhook_jobs_delivery_unique` ON `chatwoot_webhook_jobs` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `chatwoot_webhook_jobs_due_idx` ON `chatwoot_webhook_jobs` (`status`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `chatwoot_webhook_jobs_lease_idx` ON `chatwoot_webhook_jobs` (`status`,`lease_expires_at`);
