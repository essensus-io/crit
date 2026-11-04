CREATE TABLE `cache_entries` (
	`key` text PRIMARY KEY NOT NULL,
	`review_id` text,
	`value` text NOT NULL,
	`transcript_path` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cache_entries_created_idx` ON `cache_entries` (`created_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_review_idx` ON `events` (`review_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`shard_id` text,
	`fingerprint` text NOT NULL,
	`file` text NOT NULL,
	`range_start` integer NOT NULL,
	`range_end` integer NOT NULL,
	`anchor` text NOT NULL,
	`severity` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`explanation` text NOT NULL,
	`failure_scenario` text,
	`confidence` real NOT NULL,
	`rule_ids` text NOT NULL,
	`verdict` text,
	`verdict_reason` text,
	`status` text NOT NULL,
	`dismiss_reason` text,
	`selected` integer NOT NULL,
	`merged_from` text NOT NULL,
	`group_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `findings_review_idx` ON `findings` (`review_id`);--> statement-breakpoint
CREATE INDEX `findings_fingerprint_idx` ON `findings` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `fixes` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text NOT NULL,
	`author` text NOT NULL,
	`patch` text NOT NULL,
	`summary` text NOT NULL,
	`evaluation` text,
	`evaluation_reason` text,
	`overridden` integer NOT NULL,
	`verify` text,
	`active` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fixes_finding_idx` ON `fixes` (`finding_id`);--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text NOT NULL,
	`role` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_finding_idx` ON `messages` (`finding_id`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`root_path` text NOT NULL,
	`remote_url` text,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_root_path_idx` ON `repos` (`root_path`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_label` text NOT NULL,
	`branch` text,
	`base_sha` text,
	`head_sha` text,
	`provider` text NOT NULL,
	`model` text,
	`lenses` text NOT NULL,
	`status` text NOT NULL,
	`superseded_by` text,
	`summary` text,
	`rules_header` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reviews_repo_started_idx` ON `reviews` (`repo_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `reviews_branch_idx` ON `reviews` (`repo_id`,`branch`);--> statement-breakpoint
CREATE TABLE `shards` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`label` text NOT NULL,
	`files` text NOT NULL,
	`lenses` text NOT NULL,
	`status` text NOT NULL,
	`estimated_tokens` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`duration_ms` integer,
	`agent_session_id` text,
	`summary` text,
	`error` text,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shards_review_idx` ON `shards` (`review_id`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppressions_repo_fp_idx` ON `suppressions` (`repo_id`,`fingerprint`);