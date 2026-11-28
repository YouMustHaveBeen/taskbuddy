CREATE TABLE `day_rewards` (
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`position` integer NOT NULL,
	`reward_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `date`, `position`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reward_id`) REFERENCES `rewards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `day_rewards_reward` ON `day_rewards` (`reward_id`);