ALTER TABLE `import_job_rows` ADD `claim_token` text;--> statement-breakpoint
ALTER TABLE `import_job_rows` ADD `claimed_at` text;--> statement-breakpoint
CREATE INDEX `import_job_rows_claim_idx` ON `import_job_rows` (`import_id`,`processed`,`claimed_at`,`id`);--> statement-breakpoint
ALTER TABLE `product_deletion_rows` ADD `claim_token` text;--> statement-breakpoint
ALTER TABLE `product_deletion_rows` ADD `claimed_at` text;--> statement-breakpoint
CREATE INDEX `product_deletion_rows_claim_idx` ON `product_deletion_rows` (`deletion_id`,`processed`,`claimed_at`,`id`);