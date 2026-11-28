CREATE TABLE `timers` (
	`user_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`item_id` text NOT NULL,
	`minutes` integer NOT NULL,
	`started_at` integer NOT NULL,
	`paused_at` integer,
	`remaining_sec` integer,
	`ends_at` integer,
	`started_in` text NOT NULL,
	`bot_message_id` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
