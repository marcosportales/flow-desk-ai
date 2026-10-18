"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/infra/auth/session";
import { getDb } from "@/infra/db/client";
import { openNotification } from "@/services/notifications";

// Opening a Notification from the header bell: marks it read, then goes to
// its Ticket. The layout is revalidated so the unread count drops.
export async function openNotificationAction(data: FormData) {
  const user = await requireUser();
  const id = data.get("notificationId");
  const result = await openNotification(
    getDb(),
    user.id,
    typeof id === "string" ? id : "",
  );
  revalidatePath("/", "layout");
  redirect(result.kind === "ok" ? `/tickets/${result.ticketId}` : "/tickets");
}
