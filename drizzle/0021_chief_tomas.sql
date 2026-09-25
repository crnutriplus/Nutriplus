CREATE TABLE `runtime_schema_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
