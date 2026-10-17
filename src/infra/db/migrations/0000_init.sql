CREATE TYPE "public"."category" AS ENUM('erp', 'access', 'data', 'inquiry', 'other');--> statement-breakpoint
CREATE TYPE "public"."classification_attempt_kind" AS ENUM('initial', 'repair', 'rerun');--> statement-breakpoint
CREATE TYPE "public"."classification_outcome" AS ENUM('valid', 'invalid_output', 'provider_error');--> statement-breakpoint
CREATE TYPE "public"."classification_source" AS ENUM('ai', 'human');--> statement-breakpoint
CREATE TYPE "public"."classification_state" AS ENUM('pending', 'classified', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."dispatch_attempt_outcome" AS ENUM('sent', 'succeeded', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."dispatch_status" AS ENUM('pending', 'sent', 'succeeded', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."dispatch_trigger" AS ENUM('auto', 'manual', 'reconcile');--> statement-breakpoint
CREATE TYPE "public"."event_actor" AS ENUM('system', 'ai', 'human', 'n8n');--> statement-breakpoint
CREATE TYPE "public"."impact_scope" AS ENUM('individual', 'team', 'organization');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('classify', 'dispatch', 'reconcile');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'dead');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."route" AS ENUM('standard', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."team" AS ENUM('it_systems', 'identity_access', 'data_team', 'service_desk');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'resolved', 'closed');--> statement-breakpoint
CREATE TABLE "classification_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"kind" "classification_attempt_kind" NOT NULL,
	"outcome" "classification_outcome" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"raw_output" text,
	"parsed" jsonb,
	"error" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classification_attempts_ticket_attempt_no_unique" UNIQUE("ticket_id","attempt_no")
);
--> statement-breakpoint
CREATE TABLE "dispatch_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"trigger" "dispatch_trigger" NOT NULL,
	"outcome" "dispatch_attempt_outcome" NOT NULL,
	"http_status" integer,
	"n8n_execution_id" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispatch_attempts_dispatch_attempt_no_unique" UNIQUE("dispatch_id","attempt_no")
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"category" "category" NOT NULL,
	"priority" "priority" NOT NULL,
	"team" "team" NOT NULL,
	"route" "route" NOT NULL,
	"status" "dispatch_status" DEFAULT 'pending' NOT NULL,
	"auto_attempts" integer DEFAULT 0 NOT NULL,
	"callback_deadline" timestamp with time zone,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispatches_ticket_sequence_unique" UNIQUE("ticket_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "job_kind" NOT NULL,
	"ticket_id" uuid NOT NULL,
	"dispatch_id" uuid,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requesters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"department" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requesters_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ticket_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ticket_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" "event_actor" NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "tickets_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"requester_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"classification_state" "classification_state" DEFAULT 'pending' NOT NULL,
	"category" "category",
	"summary" text,
	"blocks_work" boolean,
	"impact_scope" "impact_scope",
	"classification_source" "classification_source",
	"priority" "priority",
	"computed_priority" "priority",
	"priority_rule" text,
	"priority_override_reason" text,
	"team" "team",
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_number_unique" UNIQUE("number"),
	CONSTRAINT "tickets_requester_idempotency_key_unique" UNIQUE("requester_id","idempotency_key"),
	CONSTRAINT "tickets_title_length" CHECK (char_length("tickets"."title") between 3 and 200),
	CONSTRAINT "tickets_description_length" CHECK (char_length("tickets"."description") between 10 and 5000),
	CONSTRAINT "tickets_classified_has_facts" CHECK ("tickets"."classification_state" <> 'classified' or (
        "tickets"."category" is not null and "tickets"."summary" is not null
        and "tickets"."blocks_work" is not null and "tickets"."impact_scope" is not null
        and "tickets"."priority" is not null and "tickets"."computed_priority" is not null
        and "tickets"."team" is not null and "tickets"."classification_source" is not null
      )),
	CONSTRAINT "tickets_override_has_reason" CHECK (("tickets"."priority" is distinct from "tickets"."computed_priority") = ("tickets"."priority_override_reason" is not null)
        and ("tickets"."priority_override_reason" is null or btrim("tickets"."priority_override_reason") <> ''))
);
--> statement-breakpoint
ALTER TABLE "classification_attempts" ADD CONSTRAINT "classification_attempts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_attempts" ADD CONSTRAINT "dispatch_attempts_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_superseded_by_dispatches_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requester_id_requesters_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requesters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatches_one_active_per_ticket" ON "dispatches" USING btree ("ticket_id") WHERE "dispatches"."status" in ('pending', 'sent', 'unknown');--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_active_per_target" ON "jobs" USING btree ("kind","ticket_id",coalesce("dispatch_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_claimable_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_id_idx" ON "ticket_events" USING btree ("ticket_id","id");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tickets_classification_state_idx" ON "tickets" USING btree ("classification_state");--> statement-breakpoint
CREATE INDEX "tickets_category_idx" ON "tickets" USING btree ("category");--> statement-breakpoint
CREATE INDEX "tickets_priority_idx" ON "tickets" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "tickets_created_at_idx" ON "tickets" USING btree ("created_at" DESC NULLS LAST);