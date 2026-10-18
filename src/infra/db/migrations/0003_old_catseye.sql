ALTER TABLE "tickets" ADD COLUMN "assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tickets_assignee_id_idx" ON "tickets" USING btree ("assignee_id");