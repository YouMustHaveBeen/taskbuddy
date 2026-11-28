CREATE TABLE `bot_prompts` (
	`user_id` text NOT NULL,
	`message_id` integer NOT NULL,
	`card_message_id` integer NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`slot` text NOT NULL,
	`position` integer NOT NULL,
	`action` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `message_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `last_fail_on` text;--> statement-breakpoint
ALTER TABLE `users` ADD `survey_on` text;--> statement-breakpoint
ALTER TABLE `users` ADD `morning_on` text;--> statement-breakpoint
ALTER TABLE `users` ADD `reprompt_on` text;--> statement-breakpoint
ALTER TABLE `users` ADD `deadline_on` text;--> statement-breakpoint
ALTER TABLE `users` ADD `night_on` text;--> statement-breakpoint
ALTER TABLE `users` ADD `list_message_id` integer;