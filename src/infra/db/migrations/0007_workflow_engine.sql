CREATE TYPE "public"."workflow_engine" AS ENUM('n8n', 'power_automate');--> statement-breakpoint
ALTER TABLE "dispatch_attempts" ADD COLUMN "workflow_engine" "workflow_engine";--> statement-breakpoint
-- Before there was a choice, every attempt that reached an engine went to n8n.
UPDATE "dispatch_attempts" SET "workflow_engine" = 'n8n' WHERE "trigger" <> 'reconcile';
