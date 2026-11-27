CREATE TABLE `day_plan` (
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`slot` text NOT NULL,
	`position` integer NOT NULL,
	`item_id` text NOT NULL,
	`state` text DEFAULT 'offered' NOT NULL,
	`replacements` integer DEFAULT 0 NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `date`, `slot`, `position`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `day_plan_item` ON `day_plan` (`item_id`);