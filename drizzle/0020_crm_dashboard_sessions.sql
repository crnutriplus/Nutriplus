CREATE TABLE `crm_dashboard_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`bootstrap_jti` text NOT NULL,
	`chatwoot_account_id` integer NOT NULL,
	`chatwoot_contact_id` integer NOT NULL,
	`chatwoot_conversation_id` integer NOT NULL,
	`chatwoot_agent_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crm_dashboard_sessions_jti_unique` ON `crm_dashboard_sessions` (`bootstrap_jti`);--> statement-breakpoint
CREATE INDEX `crm_dashboard_sessions_expiry_idx` ON `crm_dashboard_sessions` (`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `crm_dashboard_sessions_context_idx` ON `crm_dashboard_sessions` (`chatwoot_account_id`,`chatwoot_conversation_id`,`expires_at`);