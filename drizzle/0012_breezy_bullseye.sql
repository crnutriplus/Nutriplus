ALTER TABLE `invoice_ai_analyses` ADD `analysis_origin` text DEFAULT 'OPENAI_API' NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice_ai_analyses` ADD `api_calls` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoice_ai_analyses` ADD `api_cost_microusd` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `invoice_ai_analyses` SET `api_cost_microusd`=`estimated_cost_microusd`;
