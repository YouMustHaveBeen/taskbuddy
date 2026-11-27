CREATE TABLE `action_kinds` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_kinds_user_name` ON `action_kinds` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_name` ON `categories` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `category_compat` (
	`user_id` text NOT NULL,
	`category_a` text NOT NULL,
	`category_b` text NOT NULL,
	PRIMARY KEY(`user_id`, `category_a`, `category_b`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_a`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_b`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `insight_spheres` (
	`insight_id` text NOT NULL,
	`sphere_id` text NOT NULL,
	PRIMARY KEY(`insight_id`, `sphere_id`),
	FOREIGN KEY (`insight_id`) REFERENCES `insights`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sphere_id`) REFERENCES `spheres`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `insights` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `insights_user` ON `insights` (`user_id`);--> statement-breakpoint
CREATE TABLE `item_spheres` (
	`item_id` text NOT NULL,
	`sphere_id` text NOT NULL,
	PRIMARY KEY(`item_id`, `sphere_id`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sphere_id`) REFERENCES `spheres`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `item_spheres_sphere` ON `item_spheres` (`sphere_id`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`owner_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`household_id` text NOT NULL,
	`source` text NOT NULL,
	`assign_state` text DEFAULT 'none' NOT NULL,
	`archived_at` integer,
	`archive_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `items_owner_kind` ON `items` (`owner_id`,`kind`,`archived_at`);--> statement-breakpoint
CREATE INDEX `items_creator` ON `items` (`creator_id`);--> statement-breakpoint
CREATE INDEX `items_archived_at` ON `items` (`archived_at`);--> statement-breakpoint
CREATE TABLE `practices` (
	`id` text PRIMARY KEY NOT NULL,
	`unit` text,
	`goal_total` integer,
	`min_value` integer,
	`min_period` text,
	FOREIGN KEY (`id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rewards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`minutes` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rewards_user` ON `rewards` (`user_id`);--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`period` text NOT NULL,
	`part_of_day` text,
	`weekday` integer,
	`zone_no` integer,
	`position` integer NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `spheres` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spheres_user_name` ON `spheres` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`important` integer,
	`urgent` integer,
	`impactful` integer,
	`easy` integer,
	`why` text,
	`action_kind_id` text,
	`category_id` text,
	`deadline` integer,
	`remind_at` integer,
	`project_id` text,
	`is_project` integer DEFAULT false NOT NULL,
	`step_pos` integer,
	`parent_task_id` text,
	`deferred` integer DEFAULT false NOT NULL,
	`deferred_until` integer,
	`queued` integer DEFAULT false NOT NULL,
	`queued_after_id` text,
	`waiting_for` text,
	`waiting_since` integer,
	`flavor` text,
	`frog_auto` integer DEFAULT false NOT NULL,
	`skip_count` integer DEFAULT 0 NOT NULL,
	`last_shown_at` integer,
	`first_step_voice_id` text,
	`first_step_text` text,
	`in_focus` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`action_kind_id`) REFERENCES `action_kinds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`queued_after_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_project` ON `tasks` (`project_id`,`step_pos`);--> statement-breakpoint
CREATE INDEX `tasks_deadline` ON `tasks` (`deadline`);--> statement-breakpoint
CREATE INDEX `tasks_remind_at` ON `tasks` (`remind_at`);--> statement-breakpoint
CREATE TABLE `zones` (
	`user_id` text NOT NULL,
	`no` integer NOT NULL,
	`name` text NOT NULL,
	`current_round` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`user_id`, `no`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
