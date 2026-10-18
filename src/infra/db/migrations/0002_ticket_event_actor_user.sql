ALTER TYPE "public"."event_actor" ADD VALUE 'user';--> statement-breakpoint
ALTER TYPE "public"."event_actor" ADD VALUE 'integration';--> statement-breakpoint
ALTER TABLE "ticket_events" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_actor_user_check" CHECK (("ticket_events"."actor"::text = 'user') = ("ticket_events"."actor_user_id" is not null));